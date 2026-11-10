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
} from '../services/automation.js';
import { decrypt, encrypt, phone } from '../utils/security.js';
import {
  checkShopify,
  checkWhatsapp,
  sendHelloWorldTest,
  request as providerRequest,
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
import { planOrderMessage } from '../services/order-ingestion.js';
import { validateConfirmationTemplate } from '../services/order-confirmation.js';

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
  await validateConfirmationTemplate(req.store.workspace.integration);
  res.json({
    message:
      'Approved six-variable template and Confirm/Cancel buttons verified. Configure and verify the Meta reply webhook before enabling the order test.',
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
    else {
      if (o.status === 'CANCELLED')
        throw new InputError('A cancelled order cannot be moved to review');
      o.status = 'NEEDS_REVIEW';
      activity(s.workspace, `${o.number} moved to review`);
    }
  });
  res.json({ ok: true });
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
    })
    .parse(req.body);
  await mutate(req.merchantId, (s) => {
    Object.assign(s.workspace.settings, input);
    activity(s.workspace, 'Automation preferences updated');
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
      action: z.enum(['takeover', 'resume', 'reply', 'simulate']),
      text: z.string().trim().min(1).max(2000).optional(),
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
      action: z.enum(['confirm', 'review', 'remove']),
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
  res.json({
    ok: true,
    ...result,
    message:
      result.affected +
      ' order(s) ' +
      (input.action === 'remove'
        ? 'removed from Relay'
        : input.action === 'confirm'
          ? 'confirmed; Shopify tags queued'
          : 'marked for review') +
      (result.skipped ? '; ' + result.skipped + ' already in that state' : ''),
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
  await mutate(req.merchantId, (s) =>
    activity(
      s.workspace,
      'Manual Shopify order sync requested for ' +
        input.lookbackDays +
        ' days' +
        (input.restoreRemoved ? ' including removed orders' : ''),
    ),
  );
  res.json({
    ok: true,
    message: 'Shopify sync queued. Missing COD orders will be imported without duplicates.',
  });
}
