import { customerConversation } from '../services/automation.js';
import { sendLiveInboxReply } from '../services/inbox-replies.js';
import { conversationPhone, customerThreads } from '../models/customer-conversations.js';
import { approveCancellation } from '../services/cancellation.js';
import { applyBulkOrderAction } from '../services/order-operations.js';
import type { Request, Response } from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { mutate, publicMerchant, publicWorkspace } from '../services/repository.js';
import {
  activity,
  append,
  confirm,
  conversation,
  enqueue,
  handleIncoming,
  markForReview,
  queueShopifyOrderAction,
} from '../services/automation.js';
import { decrypt, encrypt, phone } from '../utils/security.js';
import {
  checkShopify,
  checkWhatsapp,
  sendHelloWorldTest,
  request as providerRequest,
  validateUtilityTemplate,
} from '../services/providers.js';
import { InputError } from '../utils/errors.js';
import { freshShopifyIntegration } from '../services/shopify-tokens.js';
import { beginMessage, updateMessage } from '../services/message-history.js';
import { ProviderError } from '../services/providers.js';
import { metaCallbackUrl, metaWebhookReady } from '../services/meta-webhook-settings.js';
import { reliability } from '../services/reliability-settings.js';
import {
  getSyncState,
  inboxSummary,
  requestSync,
  requestFullSync,
  retryInbox,
} from '../services/reliability-repository.js';
import { planOrderMessage, repairMissingConfirmations } from '../services/order-ingestion.js';
import { validateConfirmationTemplate } from '../services/order-confirmation.js';
import { dispatchSettings } from '../models/workspace-defaults.js';
import { reconcileMerchant } from '../services/shopify-reconciliation.js';

export function snapshot(req: Request, res: Response): void {
  res.json({
    merchant: publicMerchant(req.store.merchant),
    workspace: publicWorkspace(req.store.workspace),
    mode: config.demo ? 'demo' : 'connected',
    outboundEnabled: config.outbound,
    metaWebhookConfigured: metaWebhookReady(req.store),
    metaCallbackUrl: metaCallbackUrl(req.merchantId),
    orderTest: {
      enabled:
        !!reliability(req.store.workspace).testMode &&
        Date.parse(reliability(req.store.workspace).testMode!.until) > Date.now() &&
        (req.store.workspace.integration.templateName === 'hello_world' ||
          metaWebhookReady(req.store)),
      until: reliability(req.store.workspace).testMode?.until,
      template: reliability(req.store.workspace).testMode?.template,
    },
  });
}

export async function testOrderTemplate(req: Request, res: Response): Promise<void> {
  if (config.demo)
    throw new InputError('Save a real WhatsApp connection to validate the approved template');
  const input = z
    .object({
      kind: z
        .enum(['confirmation', 'dispatch', 'delivery', 'paid', 'in_progress', 'on_hold'])
        .default('confirmation'),
      templateName: z
        .string()
        .trim()
        .regex(/^[a-z0-9_]{1,100}$/)
        .optional(),
      languageCode: z
        .string()
        .trim()
        .regex(/^[a-z]{2}(?:_[A-Z]{2})?$/)
        .optional(),
      variables: z.array(z.string()).max(7).optional(),
      includeTrackingButtonUrl: z.boolean().optional(),
    })
    .default({})
    .parse(req.body ?? {});

  if (input.kind === 'confirmation') {
    await validateConfirmationTemplate(req.store.workspace.integration);
    res.json({
      message:
        'Approved six-variable template and Confirm/Cancel buttons verified. Configure and verify the Meta reply webhook before enabling the order test.',
    });
    return;
  }

  const saved = dispatchSettings(req.store.workspace);
  const templateDefaults = {
    dispatch: {
      name: saved.templateName,
      lang: saved.languageCode,
      vars: saved.variables,
      urlBtn: saved.includeTrackingButtonUrl,
    },
    delivery: {
      name: saved.deliveredTemplateName,
      lang: saved.deliveredLanguageCode,
      vars: saved.deliveredVariables,
      urlBtn: false,
    },
    paid: {
      name: saved.paidTemplateName,
      lang: saved.paidLanguageCode,
      vars: saved.paidVariables,
      urlBtn: false,
    },
    in_progress: {
      name: saved.inProgressTemplateName,
      lang: saved.inProgressLanguageCode,
      vars: saved.inProgressVariables,
      urlBtn: false,
    },
    on_hold: {
      name: saved.onHoldTemplateName,
      lang: saved.onHoldLanguageCode,
      vars: saved.onHoldVariables,
      urlBtn: false,
    },
  }[input.kind];
  const templateName = input.templateName ?? templateDefaults.name;
  const languageCode = input.languageCode ?? templateDefaults.lang;
  const vars = input.variables ?? templateDefaults.vars;
  const requireUrlButton =
    input.kind === 'dispatch' ? (input.includeTrackingButtonUrl ?? templateDefaults.urlBtn) : false;
  const result = await validateUtilityTemplate(req.store.workspace.integration, {
    templateName,
    languageCode,
    expectedVariables: vars.length,
    requireUrlButton,
  });
  res.json({
    ok: true,
    hasUrlButton: result.hasUrlButton,
    message: `Approved ${input.kind} template "${templateName}" verified with ${vars.length} positional variable(s)${requireUrlButton ? ' and dynamic tracking URL button' : ''}.`,
  });
}

const testSendTimes = new Map<string, number>();
export async function sendWhatsappTest(req: Request, res: Response): Promise<void> {
  const input = z
    .object({ recipient: z.string().min(10).max(20), ownVerifiedNumber: z.literal(true) })
    .parse(req.body);
  if (config.demo) throw new InputError('Live test messages are unavailable in demo mode');
  let recipient: string;
  try {
    recipient = phone(input.recipient);
  } catch {
    throw new InputError('Enter your verified test number with its country code');
  }
  const now = Date.now();
  if (now - (testSendTimes.get(req.merchantId) ?? 0) < 60000) {
    const retryAfterSeconds = Math.ceil(
      (60000 - (now - testSendTimes.get(req.merchantId)!)) / 1000,
    );
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({
      retryAfterSeconds,
      error:
        'A test was already attempted. Wait for the countdown and check WhatsApp before retrying.',
    });
    return;
  }
  testSendTimes.set(req.merchantId, now);
  const historyId = await beginMessage(req.merchantId, {
    kind: 'SAMPLE',
    recipient,
    templateName: 'hello_world',
    languageCode: 'en_US',
    preview: 'Meta hello_world sample (no order details).',
  });
  let messageId: string;
  try {
    messageId = await sendHelloWorldTest(req.store.workspace.integration, recipient, historyId);
    await updateMessage(req.merchantId, historyId, { status: 'ACCEPTED', messageId });
  } catch (error) {
    await updateMessage(req.merchantId, historyId, {
      status: error instanceof ProviderError && error.ambiguous ? 'UNKNOWN' : 'FAILED',
      error: error instanceof Error ? error.message : 'Message request failed',
    });
    throw error;
  }
  res.json({
    messageId,
    message:
      'Meta accepted the test request. Check your WhatsApp for delivery; this is not a delivery confirmation.',
  });
}
export async function orderAction(req: Request, res: Response): Promise<void> {
  const { action } = z.object({ action: z.enum(['confirm', 'review']) }).parse(req.body);
  await mutate(req.merchantId, (s) => {
    const o = s.workspace.orders.find((o) => o.id === req.params.id && !o.archivedAt);
    if (!o) throw Object.assign(new Error('Order not found'), { status: 404 });
    if (action === 'confirm') confirm(s.workspace, o);
    else markForReview(s.workspace, o, 'moved to review');
  });
  res.json({ ok: true });
}
export async function shopifyOrderAction(req: Request, res: Response): Promise<void> {
  const input = z
    .object({
      action: z.enum([
        'mark_paid',
        'mark_in_progress',
        'reopen',
        'hold',
        'release_hold',
        'fulfill',
        'update_tracking',
        'mark_delivered',
      ]),
      trackingCompany: z.string().trim().max(100).optional(),
      trackingNumber: z.string().trim().max(100).optional(),
      trackingUrl: z
        .union([
          z.literal(''),
          z
            .string()
            .trim()
            .url()
            .max(500)
            .refine((v) => v.startsWith('https://'), 'Tracking URL must start with https://'),
        ])
        .optional(),
      notifyCustomer: z.boolean().optional(),
      reasonNotes: z.string().trim().max(250).optional(),
    })
    .parse(req.body);
  const result = await mutate(req.merchantId, (s) => {
    const o = s.workspace.orders.find((o) => o.id === req.params.id && !o.archivedAt);
    if (!o) throw Object.assign(new Error('Order not found'), { status: 404 });
    return queueShopifyOrderAction(s.workspace, o, input.action, {
      trackingCompany: input.trackingCompany,
      trackingNumber: input.trackingNumber,
      trackingUrl: input.trackingUrl || undefined,
      notifyCustomer: input.notifyCustomer,
      reasonNotes: input.reasonNotes,
    });
  });
  res.json({ ok: true, ...result });
}
export async function simulate(req: Request, res: Response): Promise<void> {
  if (!config.demo) {
    res.status(403).json({ error: 'Simulation is only available in demo mode' });
    return;
  }
  const { scenario } = z
    .object({ scenario: z.enum(['order', 'confirm', 'address', 'tracking']).default('order') })
    .parse(req.body);
  await mutate(req.merchantId, (s) => {
    const w = s.workspace;
    let o = w.orders.find((o) => o.status === 'PENDING');
    if (scenario === 'order' || !o) {
      const number = Math.max(1048, ...w.orders.map((o) => Number(o.number.slice(1)) || 0)) + 1;
      o = {
        id: randomUUID(),
        shopifyOrderId: `demo-${number}`,
        number: `#${number}`,
        name: 'Ahmed Siddiqui',
        phone: '923001234599',
        amount: 3750,
        currency: 'PKR',
        status: 'PENDING',
        delivery: 'Unfulfilled',
        consent: true,
        tags: [],
        createdAt: new Date().toISOString(),
      };
      w.orders.unshift(o);
      conversation(w, o);
      if (w.settings.confirmations) enqueue(w, o, 'CONFIRMATION');
      activity(w, `Test order ${o.number} received from Shopify simulator`);
    }
    if (scenario !== 'order')
      handleIncoming(
        w,
        o,
        scenario === 'confirm'
          ? 'Confirm'
          : scenario === 'address'
            ? 'Please change my delivery address to my office.'
            : 'Where is my parcel?',
        true,
      );
  });
  res.json({ ok: true, message: 'Simulation recorded. No external message was sent.' });
}
const templateInput = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]+$/)
    .max(100),
  language: z
    .string()
    .trim()
    .regex(/^[a-z]{2}(?:_[A-Z]{2})?$/),
});
export async function saveTemplate(req: Request, res: Response): Promise<void> {
  const input = templateInput.parse(req.body);
  const id = input.name + ':' + input.language;
  await mutate(req.merchantId, (s) => {
    const templates = (s.workspace.settings.savedTemplates ??= []);
    if (!templates.some((t) => t.id === id)) {
      if (templates.length >= 100) throw new InputError('A maximum of 100 templates can be saved');
      templates.push({ id, ...input });
    }
  });
  res.json({ ok: true, id, message: 'Template saved. Select it and save integrations to use it.' });
}
export async function saveIntegration(req: Request, res: Response): Promise<void> {
  const input = z
    .object({
      shopDomain: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^$|^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
      shopifyToken: z.string().max(2000).optional(),
      phoneNumberId: z.string().regex(/^\d*$/),
      wabaId: z.string().regex(/^\d*$/),
      whatsappToken: z.string().trim().max(4000).optional(),
      metaAppSecret: z.string().trim().max(256).optional(),
      templateName: z
        .string()
        .regex(/^[a-z0-9_]+$/)
        .max(100),
      languageCode: z.string().regex(/^[a-z]{2}(?:_[A-Z]{2})?$/),
      testRecipient: z.string().max(20).optional(),
    })
    .parse(req.body);
  if (
    !config.demo &&
    (input.shopifyToken || input.shopDomain !== req.store.workspace.integration.shopDomain)
  )
    throw new InputError(
      'Use Connect Shopify to authorize or change a store. Manual merchant tokens are not accepted.',
    );
  let testRecipient: string | undefined;
  if (input.testRecipient?.trim()) {
    try {
      testRecipient = '+' + phone(input.testRecipient.trim());
    } catch {
      throw new InputError(
        'Enter the test number with its country code, for example +923001234567',
      );
    }
  }
  await mutate(req.merchantId, (s) => {
    if (input.testRecipient !== undefined) s.workspace.settings.testRecipient = testRecipient ?? '';
    const i = s.workspace.integration;
    if (input.shopDomain !== i.shopDomain || input.shopifyToken) i.shopifyVerifiedAt = undefined;
    if (input.phoneNumberId !== i.phoneNumberId || input.wabaId !== i.wabaId || input.whatsappToken)
      i.whatsappVerifiedAt = undefined;
    if (input.phoneNumberId !== i.phoneNumberId || input.wabaId !== i.wabaId || input.metaAppSecret)
      s.workspace.settings.metaSubscription = undefined;
    const {
      shopifyToken,
      whatsappToken,
      metaAppSecret,
      testRecipient: _testRecipient,
      ...rest
    } = input;
    Object.assign(i, rest);
    const templates = (s.workspace.settings.savedTemplates ??= []);
    const templateId = input.templateName + ':' + input.languageCode;
    if (!templates.some((t) => t.id === templateId) && templates.length < 100)
      templates.push({ id: templateId, name: input.templateName, language: input.languageCode });
    if (shopifyToken) i.shopifyToken = encrypt(shopifyToken);
    if (whatsappToken) i.whatsappToken = encrypt(whatsappToken);
    if (metaAppSecret) {
      if (!/^[a-f0-9]{32,128}$/i.test(metaAppSecret))
        throw new InputError('Copy the App Secret from the working Meta app settings');
      i.metaAppSecret = encrypt(metaAppSecret);
      i.metaWebhookVerifiedAt = undefined;
    }
    activity(s.workspace, 'Integration settings updated');
  });
  res.json({
    ok: true,
    message: config.demo
      ? 'Saved for this demo session. Connections have not been verified.'
      : 'Integration settings saved securely.',
  });
}
export async function testIntegration(req: Request, res: Response): Promise<void> {
  const { provider } = z.object({ provider: z.enum(['shopify', 'whatsapp']) }).parse(req.body);
  if (config.demo) {
    res.json({
      ok: true,
      simulated: true,
      message: 'Demo adapter is working. No external credentials were tested.',
    });
    return;
  }
  const i =
    provider === 'shopify'
      ? await freshShopifyIntegration(req.merchantId)
      : req.store.workspace.integration;
  const label = await (provider === 'shopify' ? checkShopify(i) : checkWhatsapp(i));
  await mutate(req.merchantId, (s) => {
    if (JSON.stringify(s.workspace.integration) !== JSON.stringify(i))
      throw new Error('Settings changed during verification. Please test again.');
    if (provider === 'shopify')
      s.workspace.integration.shopifyVerifiedAt = new Date().toISOString();
    else s.workspace.integration.whatsappVerifiedAt = new Date().toISOString();
  });
  res.json({ ok: true, message: `Connection verified: ${label}` });
}
const dispatchVarEnum = z.enum([
  'customer_name',
  'brand_name',
  'order_number',
  'courier',
  'tracking_number',
  'tracking_url',
  'total_amount',
]);

export async function saveSettings(req: Request, res: Response): Promise<void> {
  const input = z
    .object({
      confirmations: z.boolean(),
      reminders: z.boolean(),
      faqs: z.boolean(),
      tracking: z.boolean(),
      reminderHours: z.number().int().min(1).max(72),
      timezone: z.string().refine((v) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }),
      policy: z.string().trim().min(1).max(3000),
      shopifySync: z
        .object({
          importNonCodOrders: z.boolean(),
          codGatewayKeywords: z.array(z.string().trim().min(1).max(60)).min(1).max(20),
          confirmedTag: z.string().trim().min(1).max(60),
          reviewTag: z.string().trim().min(1).max(60),
          cancellationRequestedTag: z.string().trim().min(1).max(60),
          tagOnReview: z.boolean(),
          autoHoldUnconfirmed: z.boolean(),
          holdOnReview: z.boolean(),
          holdOnCancellationRequest: z.boolean(),
          releaseHoldOnConfirm: z.boolean(),
          holdReasonNotes: z.string().trim().min(1).max(250),
          syncCustomerSmsConsent: z.boolean().optional(),
          checkoutConsentAttributeKey: z.string().trim().max(60).optional(),
          checkoutConsentValues: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
          requireExplicitConsent: z.boolean().optional(),
        })
        .optional(),
      dispatchNotifications: z
        .object({
          enabled: z.boolean(),
          templateName: z
            .string()
            .trim()
            .regex(/^$|^[a-z0-9_]{1,100}$/),
          languageCode: z
            .string()
            .trim()
            .regex(/^[a-z]{2}(?:_[A-Z]{2})?$/),
          variables: z.array(dispatchVarEnum).max(7),
          includeTrackingButtonUrl: z.boolean(),
          notifyOnPartial: z.boolean(),
          deliveredEnabled: z.boolean(),
          deliveredTemplateName: z
            .string()
            .trim()
            .regex(/^$|^[a-z0-9_]{1,100}$/),
          deliveredLanguageCode: z
            .string()
            .trim()
            .regex(/^[a-z]{2}(?:_[A-Z]{2})?$/),
          deliveredVariables: z.array(dispatchVarEnum).max(7),
          paidEnabled: z.boolean().optional(),
          paidTemplateName: z
            .string()
            .trim()
            .regex(/^$|^[a-z0-9_]{1,100}$/)
            .optional(),
          paidLanguageCode: z
            .string()
            .trim()
            .regex(/^[a-z]{2}(?:_[A-Z]{2})?$/)
            .optional(),
          paidVariables: z.array(dispatchVarEnum).max(7).optional(),
          inProgressEnabled: z.boolean().optional(),
          inProgressTemplateName: z
            .string()
            .trim()
            .regex(/^$|^[a-z0-9_]{1,100}$/)
            .optional(),
          inProgressLanguageCode: z
            .string()
            .trim()
            .regex(/^[a-z]{2}(?:_[A-Z]{2})?$/)
            .optional(),
          inProgressVariables: z.array(dispatchVarEnum).max(7).optional(),
          onHoldEnabled: z.boolean().optional(),
          onHoldTemplateName: z
            .string()
            .trim()
            .regex(/^$|^[a-z0-9_]{1,100}$/)
            .optional(),
          onHoldLanguageCode: z
            .string()
            .trim()
            .regex(/^[a-z]{2}(?:_[A-Z]{2})?$/)
            .optional(),
          onHoldVariables: z.array(dispatchVarEnum).max(7).optional(),
        })
        .refine(
          (d) => !d.enabled || !!d.templateName,
          'Dispatch notifications require an approved template name',
        )
        .refine(
          (d) => !d.deliveredEnabled || !!d.deliveredTemplateName,
          'Delivery notifications require an approved template name',
        )
        .refine(
          (d) => !d.paidEnabled || !!d.paidTemplateName,
          'Payment notifications require an approved template name',
        )
        .refine(
          (d) => !d.inProgressEnabled || !!d.inProgressTemplateName,
          'In-progress notifications require an approved template name',
        )
        .refine(
          (d) => !d.onHoldEnabled || !!d.onHoldTemplateName,
          'On-hold notifications require an approved template name',
        )
        .optional(),
      support: z
        .object({
          menuBody: z.string().trim().min(1).max(1024),
          menuFooter: z.string().trim().max(60),
          statusButtonTitle: z.string().trim().min(1).max(20),
          policyButtonTitle: z.string().trim().min(1).max(20),
          humanButtonTitle: z.string().trim().min(1).max(20),
          menuCooldownHours: z.number().int().min(1).max(72),
          handoffText: z.string().trim().min(1).max(1000),
          noOrderText: z.string().trim().min(1).max(1000),
          clarifyText: z.string().trim().min(1).max(1000),
          optOutKeywords: z.array(z.string().trim().toLowerCase().min(1).max(40)).min(1).max(20),
          optInKeywords: z.array(z.string().trim().toLowerCase().min(1).max(40)).min(1).max(20),
          optOutConfirmationText: z.string().trim().min(1).max(1000),
          optedOutPhones: z
            .array(
              z
                .string()
                .trim()
                .regex(/^\d{10,15}$/),
            )
            .max(1000)
            .optional(),
        })
        .optional(),
      quickReplies: z
        .array(
          z.object({
            label: z.string().trim().min(1).max(40),
            body: z.string().trim().min(1).max(1000),
          }),
        )
        .max(20)
        .optional(),
      orderViews: z
        .array(
          z.object({
            id: z.string().trim().min(1).max(60),
            name: z.string().trim().min(1).max(40),
            tab: z.string().trim().min(1).max(40),
            paymentFilter: z.string().trim().max(40),
            fulfillmentFilter: z.string().trim().max(40),
            search: z.string().trim().max(100),
          }),
        )
        .max(20)
        .optional(),
    })
    .parse(req.body);
  await mutate(req.merchantId, (s) => {
    const prevOptOut = s.workspace.settings.support?.optedOutPhones ?? [];
    const prevViews = s.workspace.settings.orderViews;
    Object.assign(s.workspace.settings, {
      ...input,
      ...(input.orderViews === undefined && prevViews !== undefined
        ? { orderViews: prevViews }
        : {}),
      ...(input.support
        ? {
            support: {
              ...input.support,
              optedOutPhones: input.support.optedOutPhones ?? prevOptOut,
            },
          }
        : {}),
    });
    repairMissingConfirmations(s);
    activity(s.workspace, 'Workspace preferences updated');
  });
  res.json({ ok: true });
}
export async function taskAction(req: Request, res: Response): Promise<void> {
  const { action, reason, confirmed } = z
    .object({
      action: z.enum(['approve', 'verify', 'cancel']),
      evidence: z.string().max(1000).optional(),
      reason: z.string().trim().min(1).max(255).optional(),
      confirmed: z.boolean().optional(),
    })
    .parse(req.body);
  const evidence = req.body.evidence as string | undefined;
  await mutate(req.merchantId, (s) => {
    const t = s.workspace.tasks.find((t) => t.id === req.params.id);
    if (!t) throw Object.assign(new Error('Request not found'), { status: 404 });
    if (action === 'cancel') {
      approveCancellation(s.workspace, t.id, reason ?? '', confirmed === true);
      return;
    }
    if (t.kind === 'Cancellation')
      throw new InputError('Use Approve & cancel in Shopify to complete this request');
    if (action === 'approve') {
      if (t.status !== 'OPEN') throw new InputError('Only open requests can be approved');
      t.status = 'APPROVED';
    } else {
      if (t.status !== 'APPROVED')
        throw new InputError('Approve the request before recording completion');
      if (!evidence?.trim())
        throw new InputError('Record the completed action and verification reference');
      t.status = 'VERIFIED';
      t.detail += `\nMerchant verification: ${evidence.trim()}`;
    }
    activity(
      s.workspace,
      `${t.kind} ${action === 'approve' ? 'approved for manual action' : 'marked complete by merchant'} for ${s.workspace.orders.find((o) => o.id === t.orderId)?.number ?? 'order'}`,
    );
  });
  res.json({ ok: true });
}
export async function conversationAction(req: Request, res: Response): Promise<void> {
  const input = z
    .object({
      action: z.enum(['takeover', 'resume', 'reply', 'simulate', 'link_order', 'unlink_order']),
      text: z.string().trim().min(1).max(2000).optional(),
      orderId: z.string().uuid().optional(),
    })
    .parse(req.body);
  if (input.action === 'simulate' && !config.demo) {
    res.status(403).json({ error: 'Simulation is disabled' });
    return;
  }
  if (input.action === 'reply') {
    if (!input.text) throw new InputError('Message is required');
    if (!config.demo) {
      await sendLiveInboxReply(req.store, String(req.params.id), input.text);
      res.json({
        ok: true,
        message: 'Message sent to WhatsApp (Meta accepted; delivery pending).',
      });
      return;
    }
  }
  await mutate(req.merchantId, (s) => {
    const c = s.workspace.conversations.find((c) => c.id === req.params.id);
    if (!c) throw Object.assign(new Error('Conversation not found'), { status: 404 });
    for (const thread of customerThreads(s.workspace, c)) thread.unread = false;
    if (input.action === 'takeover')
      for (const thread of customerThreads(s.workspace, c)) thread.human = true;
    if (input.action === 'resume')
      for (const thread of customerThreads(s.workspace, c)) thread.human = false;
    if (input.action === 'link_order' || input.action === 'unlink_order') {
      if (!input.orderId) throw new InputError('Order selection is required');
      const o = s.workspace.orders.find((ord) => ord.id === input.orderId && !ord.archivedAt);
      if (!o) throw Object.assign(new Error('Order not found in workspace'), { status: 404 });
      const digits = conversationPhone(s.workspace, c);
      if (!digits) throw new InputError('Conversation has no customer WhatsApp number to link');
      if (input.action === 'link_order') {
        const list = [...new Set([...(o.linkedPhones ?? []), digits])];
        o.linkedPhones = list;
        append(
          c,
          'note',
          `Linked order ${o.number} to WhatsApp number +${digits} for support tracking lookup.`,
        );
        activity(s.workspace, `Linked ${o.number} to customer ${digits} in Inbox`);
      } else {
        if (o.phone === digits)
          throw new InputError('Primary order phone number cannot be unlinked from this thread');
        o.linkedPhones = (o.linkedPhones ?? []).filter((p) => p !== digits);
        append(c, 'note', `Unlinked order ${o.number} from WhatsApp number +${digits}.`);
        activity(s.workspace, `Unlinked ${o.number} from customer ${digits} in Inbox`);
      }
      return;
    }
    if (input.action === 'reply') {
      if (!input.text) throw new InputError('Message is required');
      for (const thread of customerThreads(s.workspace, c)) thread.human = true;
      const phoneNumber = conversationPhone(s.workspace, c);
      const target = phoneNumber ? customerConversation(s.workspace, phoneNumber) : c;
      target.human = true;
      target.unread = false;
      append(target, 'out', input.text);
    }
    if (input.action === 'simulate') {
      if (!input.text) throw new InputError('Message is required');
      const o = s.workspace.orders.find((o) => o.id === c.orderId);
      if (o) handleIncoming(s.workspace, o, input.text, true);
      else append(c, 'in', input.text);
    }
  });
  res.json({ ok: true });
}

export async function readConversation(req: Request, res: Response): Promise<void> {
  await mutate(req.merchantId, (s) => {
    const c = s.workspace.conversations.find((c) => c.id === req.params.id);
    if (!c) throw Object.assign(new Error('Conversation not found'), { status: 404 });
    for (const thread of customerThreads(s.workspace, c)) thread.unread = false;
  });
  res.json({ ok: true });
}

export async function retryJob(req: Request, res: Response): Promise<void> {
  await mutate(req.merchantId, (s) => {
    const j = s.workspace.jobs.find((j) => j.id === req.params.id);
    if (!j) throw Object.assign(new Error('Job not found'), { status: 404 });
    if (j.state !== 'FAILED')
      throw new InputError(
        'Only definitively failed jobs can be retried. Uncertain sends require provider reconciliation.',
      );
    if (j.attempts >= 8)
      throw new InputError(
        'Retry limit reached. Resolve the underlying issue before creating a new action.',
      );
    j.state = 'QUEUED';
    j.dueAt = new Date(Date.now() + 1000 * 2 ** j.attempts).toISOString();
    j.error = undefined;
    activity(s.workspace, `Retry scheduled for ${j.kind.toLowerCase()}`);
  });
  res.json({ ok: true });
}

export async function reliabilityStatus(req: Request, res: Response): Promise<void> {
  const sync = await getSyncState(req.merchantId);
  res.json({
    settings: reliability(req.store.workspace),
    sync: {
      checkpoint: sync.checkpoint,
      manualRequested: sync.manualRequested,
      lastSuccessAt: sync.lastSuccessAt,
      nextRunAt: sync.nextRunAt,
      error: sync.error,
      recovering: !!sync.windowEnd,
    },
    inbox: await inboxSummary(req.merchantId),
  });
}
export async function saveReliability(req: Request, res: Response): Promise<void> {
  const input = z
    .object({
      syncEnabled: z.boolean(),
      syncIntervalMinutes: z.number().int().min(1).max(60),
      initialLookbackDays: z.number().int().min(1).max(60),
      maxMessageAgeHours: z.number().int().min(1).max(72),
      recoveryMessaging: z.enum(['REVIEW', 'SEND_ELIGIBLE']),
      testEnabled: z.boolean(),
      testRecipient: z.string().max(20).optional(),
      ownNumberConfirmed: z.boolean().optional(),
    })
    .parse(req.body);
  let recipient = '';
  if (input.testEnabled) {
    if (!input.ownNumberConfirmed)
      throw new InputError(
        'Confirm ownership and Meta recipient verification before enabling the test',
      );
    try {
      recipient = phone(input.testRecipient ?? '');
    } catch {
      throw new InputError('Enter the owned test recipient with its country code');
    }
    if (!req.store.workspace.integration.whatsappVerifiedAt)
      throw new InputError('Verify the saved WhatsApp connection first');
    if (
      !config.demo &&
      req.store.workspace.integration.templateName !== 'hello_world' &&
      !metaWebhookReady(req.store)
    )
      throw new InputError(
        'Complete incoming Meta webhook setup in Integrations before enabling order confirmation tests.',
      );
    if (!config.demo && req.store.workspace.integration.templateName !== 'hello_world')
      await validateConfirmationTemplate(req.store.workspace.integration);
  }
  await mutate(req.merchantId, (s) => {
    s.workspace.settings.reliability = {
      syncEnabled: input.syncEnabled,
      syncIntervalMinutes: input.syncIntervalMinutes,
      initialLookbackDays: input.initialLookbackDays,
      maxMessageAgeHours: input.maxMessageAgeHours,
      recoveryMessaging: input.recoveryMessaging,
      ...(input.testEnabled
        ? {
            testMode: {
              recipient,
              template: s.workspace.integration.templateName,
              until: new Date(Date.now() + 24 * 3600000).toISOString(),
            },
          }
        : {}),
    };
    activity(s.workspace, 'Recovery and messaging settings updated');
  });
  res.json({
    ok: true,
    message: 'Tenant recovery settings saved. Own-number tests expire after 24 hours.',
  });
}
export async function generateMetaVerifyToken(req: Request, res: Response): Promise<void> {
  if (!config.appUrl.startsWith('https://'))
    throw new InputError('A public HTTPS app URL is required for the Meta callback.');
  const token = randomBytes(32).toString('hex');
  await mutate(req.merchantId, (s) => {
    s.workspace.integration.metaVerifyTokenHash = createHash('sha256').update(token).digest('hex');
    s.workspace.integration.metaWebhookVerifiedAt = undefined;
  });
  res.json({
    token,
    callbackUrl: (config.webhookUrl || config.appUrl) + '/api/webhooks/meta/' + req.merchantId,
    message: 'Copy this token into Meta webhook verification. It is shown only once.',
  });
}
export async function syncNow(req: Request, res: Response): Promise<void> {
  await requestSync(req.merchantId);
  res.json({
    ok: true,
    message: 'Shopify catch-up sync scheduled. Check Reliability for progress.',
  });
}
export async function retryIncoming(req: Request, res: Response): Promise<void> {
  await retryInbox(req.merchantId);
  res.json({ ok: true, message: 'Failed incoming events scheduled for retry.' });
}
export async function readNotification(req: Request, res: Response): Promise<void> {
  await mutate(req.merchantId, (s) => {
    const n = s.workspace.notifications?.find((n) => n.id === req.params.id);
    if (!n) throw Object.assign(new Error('Notification not found'), { status: 404 });
    n.readAt = new Date().toISOString();
    n.updatedAt = n.readAt;
  });
  res.json({ ok: true });
}
export async function queueOrderConfirmation(req: Request, res: Response): Promise<void> {
  await mutate(req.merchantId, (s) => {
    const o = s.workspace.orders.find((o) => o.id === req.params.id);
    if (!o) throw Object.assign(new Error('Order not found'), { status: 404 });
    planOrderMessage(s, o, false);
    if (o.messageBlockedReason) throw new InputError(o.messageBlockedReason);
  });
  res.json({ ok: true, message: 'Eligible confirmation queued. No duplicate job is created.' });
}
export async function recordPermission(req: Request, res: Response): Promise<void> {
  const input = z
    .object({ granted: z.boolean(), evidence: z.string().trim().min(10).max(1000) })
    .parse(req.body);
  await mutate(req.merchantId, (s) => {
    const o = s.workspace.orders.find((o) => o.id === req.params.id);
    if (!o) throw Object.assign(new Error('Order not found'), { status: 404 });
    o.consent = input.granted;
    if (input.granted) {
      planOrderMessage(s, o);
    } else {
      o.messageBlockedReason = 'Customer messaging permission has not been recorded';
    }
    activity(
      s.workspace,
      'Messaging permission ' +
        (input.granted ? 'recorded' : 'revoked') +
        ' for ' +
        o.number +
        ': ' +
        input.evidence,
    );
  });
  res.json({ ok: true });
}
export async function retryFailedMessage(req: Request, res: Response): Promise<void> {
  await mutate(req.merchantId, (s) => {
    const m = s.workspace.outboundMessages?.find((m) => m.id === req.params.id);
    if (!m || m.status !== 'FAILED' || !m.jobId)
      throw new InputError('Only failed order messages can be retried here');
    const latest = s.workspace.outboundMessages?.find((v) => v.jobId === m.jobId);
    if (latest?.id !== m.id) throw new InputError('A newer attempt already exists');
    const j = s.workspace.jobs.find((j) => j.id === m.jobId);
    if (!j || !['DONE', 'FAILED'].includes(j.state) || j.attempts >= 8)
      throw new InputError('This message cannot be safely retried');
    j.state = 'QUEUED';
    j.dueAt = new Date().toISOString();
    j.error = undefined;
  });
  res.json({
    ok: true,
    message: 'Failed message queued for a new eligibility check and tracked attempt.',
  });
}

export async function subscribeMetaAccount(req: Request, res: Response): Promise<void> {
  const i = req.store.workspace.integration;
  if (
    !i.metaAppSecret ||
    !i.whatsappVerifiedAt ||
    !i.metaWebhookVerifiedAt ||
    i.metaWebhookUrl !== metaCallbackUrl(req.merchantId)
  )
    throw new InputError(
      'Save the App Secret, verify the WhatsApp connection, and complete callback verification in Meta first.',
    );
  if (!/^\d+$/.test(i.wabaId))
    throw new InputError('A valid WhatsApp Business Account ID is required');
  const result = z
    .object({ success: z.union([z.boolean(), z.literal('true')]) })
    .parse(
      await providerRequest(
        'https://graph.facebook.com/' + config.metaVersion + '/' + i.wabaId + '/subscribed_apps',
        { method: 'POST', headers: { Authorization: 'Bearer ' + decrypt(i.whatsappToken) } },
        true,
      ),
    );
  if (!result.success) throw new ProviderError('Meta did not confirm the account subscription');
  await mutate(req.merchantId, (s) => {
    if (
      s.workspace.integration.wabaId !== i.wabaId ||
      s.workspace.integration.metaAppSecret !== i.metaAppSecret ||
      s.workspace.integration.whatsappToken !== i.whatsappToken
    )
      throw new InputError('Credentials changed during subscription. Try again.');
    s.workspace.settings.metaSubscription = {
      wabaId: i.wabaId,
      verifiedAt: new Date().toISOString(),
    };
    activity(s.workspace, 'WhatsApp sender account subscription confirmed by Meta');
  });
  res.json({
    ok: true,
    message:
      'Meta confirmed the account subscription. Also enable the messages field in the Meta app webhook configuration.',
  });
}

export async function bulkOrders(req: Request, res: Response): Promise<void> {
  const input = z
    .object({
      action: z.enum([
        'confirm',
        'review',
        'remove',
        'mark_paid',
        'mark_delivered',
        'mark_in_progress',
        'hold',
        'release_hold',
      ]),
      ids: z.array(z.string().uuid()).max(500).default([]),
      all: z.boolean().default(false),
      expectedCount: z.number().int().nonnegative().optional(),
      confirmed: z.boolean().default(false),
    })
    .parse(req.body);
  if (input.action === 'remove' && !input.confirmed)
    throw new InputError('Confirm removal from Relay first. Shopify orders will remain unchanged.');
  const result = await mutate(req.merchantId, (s) =>
    applyBulkOrderAction(s, input.action, input.ids, input.all, input.expectedCount),
  );
  const actionLabel: Record<typeof input.action, string> = {
    remove: 'removed from Relay',
    confirm: 'confirmed; Shopify tags queued',
    review: 'marked for review',
    mark_paid: 'queued to mark paid in Shopify',
    mark_delivered: 'queued to mark delivered in Shopify',
    mark_in_progress: 'queued to mark in progress in Shopify',
    hold: 'queued to place Relay hold in Shopify',
    release_hold: 'queued to release Relay hold in Shopify',
  };
  res.json({
    ok: true,
    ...result,
    message:
      result.affected +
      ' order(s) ' +
      actionLabel[input.action] +
      (result.skipped ? '; ' + result.skipped + ' skipped or already in that state' : ''),
  });
}
export async function syncOrders(req: Request, res: Response): Promise<void> {
  const input = z
    .object({
      lookbackDays: z.number().int().min(1).max(60).default(60),
      restoreRemoved: z.boolean().default(false),
    })
    .parse(req.body);
  if (!req.store.workspace.integration.shopifyToken)
    throw new InputError('Connect Shopify before synchronizing orders');
  await requestFullSync(req.merchantId, input.lookbackDays, input.restoreRemoved);
  void reconcileMerchant(req.merchantId).catch(() => {});
  await mutate(req.merchantId, (s) => {
    repairMissingConfirmations(s);
    activity(
      s.workspace,
      'Manual Shopify order sync requested for ' +
        input.lookbackDays +
        ' days' +
        (input.restoreRemoved ? ' including removed orders' : ''),
    );
  });
  res.json({
    ok: true,
    message:
      'Shopify sync queued. Missing orders and fulfillment updates will synchronize without duplicates.',
  });
}
