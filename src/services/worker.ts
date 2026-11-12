import { config } from '../config.js';
import type { DispatchVariableKey, Job, Order, Store } from '../models/types.js';
import {
  dispatchSettings,
  isPhoneOptedOut,
  shopifySyncSettings,
} from '../models/workspace-defaults.js';
import {
  isMenuIntent,
  isSupportReply,
  menuPromptDetails,
  supportReplyContext,
  supportReplyText,
} from './support-replies.js';
import { readyStores, mutate, getStore } from './repository.js';
import { activity, append, canSend, conversation, enqueue } from './automation.js';
import { planDispatchNotification } from './order-ingestion.js';
import {
  addOrderTag,
  createFulfillmentDeliveredEvent,
  createShopifyFulfillment,
  markShopifyOrderPaid,
  placeOrderFulfillmentHold,
  releaseOrderFulfillmentHold,
  reopenFulfillmentOrder,
  reportFulfillmentProgress,
  sendUtilityNotification,
  syncCancellationTags,
  updateFulfillmentTracking,
  ProviderError,
  sendHelloWorldTest,
  sendSupportInteractiveMenu,
  sendSupportText,
  validateUtilityTemplate,
} from './providers.js';
import { dispatchTestAllowed, orderTestAllowed } from './order-test.js';
import { freshShopifyIntegration } from './shopify-tokens.js';
import { cancelUnpaidCodOrder, sendOrderConfirmation } from './order-confirmation.js';

import { metaWebhookReady } from './meta-webhook-settings.js';
import { jobRetry } from './retry-policy.js';
import { notify, resolveNotification } from './notifications.js';
import { reliability } from './reliability-settings.js';
import { beginMessage, updateMessage } from './message-history.js';

const SHOPIFY_JOB_KINDS = new Set([
  'TAG',
  'REVIEW_TAG',
  'FULFILLMENT_HOLD',
  'FULFILLMENT_RELEASE',
  'MARK_PAID',
  'MARK_IN_PROGRESS',
  'MARK_OPEN',
  'FULFILL_ORDER',
  'UPDATE_TRACKING',
  'MARK_DELIVERED',
  'CANCEL',
  'CANCEL_TAGS',
  'CANCEL_CLEANUP',
]);

const RECOVERABLE_SHOPIFY_KINDS = new Set([
  'TAG',
  'REVIEW_TAG',
  'FULFILLMENT_HOLD',
  'FULFILLMENT_RELEASE',
  'CANCEL_TAGS',
  'CANCEL_CLEANUP',
]);

const NOTICE_KINDS = new Set([
  'DISPATCH_NOTICE',
  'DELIVERY_NOTICE',
  'PAYMENT_NOTICE',
  'IN_PROGRESS_NOTICE',
  'ON_HOLD_NOTICE',
]);

type NoticeMeta = {
  enabled: boolean;
  templateName: string;
  languageCode: string;
  variables: DispatchVariableKey[];
  requireUrlButton: boolean;
  disabledReason: string;
  ineligibleReason: string;
  eligible: (o: Order) => boolean;
  preparingText: (o: Order) => string;
  demoText: (o: Order, brand: string) => string;
  noteText: (o: Order, tpl: string) => string;
};

function getNoticeMeta(
  kind: Job['kind'],
  d: ReturnType<typeof dispatchSettings>,
): NoticeMeta | undefined {
  switch (kind) {
    case 'DISPATCH_NOTICE':
      return {
        enabled: d.enabled && !!d.templateName,
        templateName: d.templateName,
        languageCode: d.languageCode,
        variables: d.variables,
        requireUrlButton: d.includeTrackingButtonUrl,
        disabledReason: 'Dispatch notifications are disabled',
        ineligibleReason: 'Order is not in a dispatched state',
        eligible: (o) => ['In transit', 'Partially fulfilled', 'Delivered'].includes(o.delivery),
        preparingText: (o) => `Order ${o.number} — preparing dispatch notice`,
        demoText: (o) => {
          const courier = o.trackingCompany ? ` via ${o.trackingCompany}` : '';
          const track = o.trackingUrl || o.trackingNumber;
          return `Hi ${o.name.split(' ')[0]}, order ${o.number} has been dispatched${courier}.${track ? ` Track here: ${track}` : ''}`;
        },
        noteText: (o, tpl) =>
          `Meta accepted dispatch template ${tpl} for ${o.number}. Delivery not yet confirmed.`,
      };
    case 'DELIVERY_NOTICE':
      return {
        enabled: d.deliveredEnabled && !!d.deliveredTemplateName,
        templateName: d.deliveredTemplateName,
        languageCode: d.deliveredLanguageCode,
        variables: d.deliveredVariables,
        requireUrlButton: false,
        disabledReason: 'Delivery notifications are disabled',
        ineligibleReason: 'Order has not reached Delivered state',
        eligible: (o) => o.delivery === 'Delivered',
        preparingText: (o) => `Order ${o.number} — preparing delivery confirmation`,
        demoText: (o, brand) =>
          `Hi ${o.name.split(' ')[0]}, order ${o.number} from ${brand} has been delivered!`,
        noteText: (o, tpl) =>
          `Meta accepted delivery confirmation template ${tpl} for ${o.number}.`,
      };
    case 'PAYMENT_NOTICE':
      return {
        enabled: d.paidEnabled && !!d.paidTemplateName,
        templateName: d.paidTemplateName,
        languageCode: d.paidLanguageCode,
        variables: d.paidVariables,
        requireUrlButton: false,
        disabledReason: 'Payment confirmation notifications are disabled',
        ineligibleReason: 'Order is not marked paid',
        eligible: (o) => (o.financialStatus ?? '').toLowerCase() === 'paid',
        preparingText: (o) => `Order ${o.number} — preparing payment confirmation`,
        demoText: (o, brand) =>
          `Hi ${o.name.split(' ')[0]}, payment of ${o.currency} ${o.amount.toLocaleString()} for order ${o.number} at ${brand} has been recorded. Thank you!`,
        noteText: (o, tpl) => `Meta accepted payment confirmation template ${tpl} for ${o.number}.`,
      };
    case 'IN_PROGRESS_NOTICE':
      return {
        enabled: d.inProgressEnabled && !!d.inProgressTemplateName,
        templateName: d.inProgressTemplateName,
        languageCode: d.inProgressLanguageCode,
        variables: d.inProgressVariables,
        requireUrlButton: false,
        disabledReason: 'In-progress notifications are disabled',
        ineligibleReason: 'Order is not currently In progress',
        eligible: (o) => o.delivery === 'In progress',
        preparingText: (o) => `Order ${o.number} — preparing packing notice`,
        demoText: (o, brand) =>
          `Hi ${o.name.split(' ')[0]}, your order ${o.number} at ${brand} is now being packed and prepared for dispatch.`,
        noteText: (o, tpl) => `Meta accepted in-progress template ${tpl} for ${o.number}.`,
      };
    case 'ON_HOLD_NOTICE':
      return {
        enabled: d.onHoldEnabled && !!d.onHoldTemplateName,
        templateName: d.onHoldTemplateName,
        languageCode: d.onHoldLanguageCode,
        variables: d.onHoldVariables,
        requireUrlButton: false,
        disabledReason: 'On-hold notifications are disabled',
        ineligibleReason: 'Order is not currently On hold',
        eligible: (o) => o.delivery === 'On hold',
        preparingText: (o) => `Order ${o.number} — preparing hold notice`,
        demoText: (o, brand) =>
          `Hi ${o.name.split(' ')[0]}, your order ${o.number} at ${brand} is currently on hold. Reply here if you have any questions.`,
        noteText: (o, tpl) => `Meta accepted on-hold template ${tpl} for ${o.number}.`,
      };
    default:
      return undefined;
  }
}

function dispatchValues(keys: DispatchVariableKey[], store: Store, order: Order): string[] {
  const brand = store.merchant.brandName.trim() || 'our store';
  return keys.map((key) => {
    switch (key) {
      case 'customer_name':
        return order.name || 'Customer';
      case 'brand_name':
        return brand;
      case 'order_number':
        return order.number;
      case 'courier':
        return order.trackingCompany?.trim() || 'Courier';
      case 'tracking_number':
        return order.trackingNumber?.trim() || 'Unavailable';
      case 'tracking_url':
        return order.trackingUrl?.trim() || 'Unavailable';
      case 'total_amount':
        return `${order.currency} ${order.amount}`;
    }
  });
}

let running = false;
export async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const store of await readyStores()) {
      const id = store.merchant.id;
      const stale = store.workspace.jobs.find(
        (j) =>
          j.state === 'UNKNOWN' && j.claimedAt && Date.parse(j.claimedAt) < Date.now() - 120000,
      );
      if (stale) {
        await mutate(id, (s) => {
          const j = s.workspace.jobs.find((j) => j.id === stale.id)!;
          j.claimedAt = undefined;
          const receipt = s.workspace.outboundMessages?.find((m) => m.jobId === j.id);
          if (receipt?.messageId) {
            j.state = 'DONE';
            j.messageId = receipt.messageId;
            j.error = undefined;
            resolveNotification(s.workspace, 'job:' + j.id);
            const o = s.workspace.orders.find((o) => o.id === j.orderId);
            if (o && !isSupportReply(j.kind) && !o.confirmationExpiresAt)
              o.confirmationExpiresAt = new Date(
                Date.parse(receipt.createdAt) +
                  reliability(s.workspace).maxMessageAgeHours * 3600000,
              ).toISOString();
          } else if (RECOVERABLE_SHOPIFY_KINDS.has(j.kind) && j.attempts < 8) {
            j.state = 'QUEUED';
            j.dueAt = new Date().toISOString();
          } else {
            j.error =
              'Worker stopped before the provider result was safely recorded. Reconcile before retrying.';
            notify(
              s.workspace,
              'job:' + j.id,
              'Uncertain action needs review',
              j.error,
              'Check provider history before retrying to avoid duplicate messages.',
            );
            for (const m of s.workspace.outboundMessages ?? [])
              if (m.jobId === j.id && m.status === 'SENDING') {
                m.status = 'UNKNOWN';
                m.error = j.error;
                m.updatedAt = new Date().toISOString();
              }
          }
        });
        continue;
      }
      let processedInStore = 0;
      while (processedInStore < 25) {
        const currentStore = (await getStore(id))!;
        if (!currentStore) break;
        const candidate = currentStore.workspace.jobs.find(
          (j) => j.state === 'QUEUED' && Date.parse(j.dueAt) <= Date.now(),
        );
        if (!candidate) break;
        processedInStore++;
        const claimed = await mutate(id, (s) => {
          const j = s.workspace.jobs.find((j) => j.id === candidate.id);
          if (!j || j.state !== 'QUEUED') return false;
          // Persist an uncertain state before an external call to prevent duplicate
          // sends after a crash. Unknown outcomes require operator reconciliation.
          j.state = 'UNKNOWN';
          j.claimedAt = new Date().toISOString();
          j.attempts++;
          return structuredClone(s);
        });
        if (!claimed) continue;
        const order = claimed.workspace.orders.find((o) => o.id === candidate.orderId);
        let historyId: string | undefined;
        try {
        if (isSupportReply(candidate.kind)) {
          const context = supportReplyContext(claimed, candidate, order);
          if (isMenuIntent(context.intent)) {
            const menu = menuPromptDetails(claimed.merchant.brandName, claimed.workspace.settings);
            historyId = await beginMessage(id, {
              orderId: undefined,
              jobId: candidate.id,
              kind: 'SUPPORT_MENU',
              recipient: context.phone,
              templateName: '',
              languageCode: '',
              preview: menu.preview,
            });
            const current = (await getStore(id))!;
            supportReplyContext(
              current,
              candidate,
              current.workspace.orders.find((o) => o.id === candidate.orderId),
            );
            const messageId = await sendSupportInteractiveMenu(
              current.workspace.integration,
              context.phone,
              menu.body,
              menu.buttons,
              historyId,
              menu.footer,
            );
            await updateMessage(id, historyId, { status: 'ACCEPTED', messageId });
            await mutate(id, (s) => {
              const job = s.workspace.jobs.find((j) => j.id === candidate.id)!;
              Object.assign(job, {
                state: 'DONE',
                messageId,
                claimedAt: undefined,
                error: undefined,
                retryable: false,
              });
              const thread = s.workspace.conversations.find((c) => c.id === context.conversationId);
              if (thread) append(thread, 'out', menu.preview);
              resolveNotification(s.workspace, 'job:' + job.id);
            });
            continue;
          }
          const reply = await supportReplyText(claimed, context.intent, order, context.phone);
          historyId = await beginMessage(id, {
            orderId:
              context.intent === 'clarify' ||
              context.intent === 'no_order' ||
              context.intent === 'handoff'
                ? undefined
                : order?.id,
            jobId: candidate.id,
            kind: 'SUPPORT_REPLY',
            recipient: context.phone,
            templateName: '',
            languageCode: '',
            preview: reply,
          });
          const current = (await getStore(id))!;
          supportReplyContext(
            current,
            candidate,
            current.workspace.orders.find((o) => o.id === candidate.orderId),
          );
          const messageId = await sendSupportText(
            current.workspace.integration,
            context.phone,
            reply,
            historyId,
          );
          await updateMessage(id, historyId, { status: 'ACCEPTED', messageId });
          await mutate(id, (s) => {
            const job = s.workspace.jobs.find((j) => j.id === candidate.id)!;
            Object.assign(job, {
              state: 'DONE',
              messageId,
              claimedAt: undefined,
              error: undefined,
              retryable: false,
            });
            const thread = s.workspace.conversations.find((c) => c.id === context.conversationId);
            if (thread) append(thread, 'out', reply);
            resolveNotification(s.workspace, 'job:' + job.id);
          });
          continue;
        }
        const d = dispatchSettings(claimed.workspace);
        const sync = shopifySyncSettings(claimed.workspace);
        const isNotice = NOTICE_KINDS.has(candidate.kind);
        const noticeMeta = isNotice ? getNoticeMeta(candidate.kind, d) : undefined;
        if (order && !SHOPIFY_JOB_KINDS.has(candidate.kind) && !config.demo) {
          const tplName =
            candidate.kind === 'TEST_HELLO'
              ? 'hello_world'
              : noticeMeta
                ? noticeMeta.templateName
                : claimed.workspace.integration.templateName;
          const tplLang =
            candidate.kind === 'TEST_HELLO'
              ? 'en_US'
              : noticeMeta
                ? noticeMeta.languageCode
                : claimed.workspace.integration.languageCode;
          historyId = await beginMessage(id, {
            orderId: order.id,
            jobId: candidate.id,
            kind: candidate.kind,
            recipient: order.phone,
            templateName: tplName,
            languageCode: tplLang,
            preview:
              candidate.kind === 'TEST_HELLO'
                ? 'Meta hello_world sample (no order details).'
                : noticeMeta
                  ? noticeMeta.preparingText(order)
                  : 'Order ' + order.number + ' — preparing confirmation',
          });
        }
        if (!order) throw new Error('Order no longer exists');
        if (order.archivedAt)
          throw new Error('Order was removed from Relay. Automation is stopped for this order.');
        const ageRef = isNotice ? (order.sourceUpdatedAt ?? order.createdAt) : order.createdAt;
        if (
          !SHOPIFY_JOB_KINDS.has(candidate.kind) &&
          Date.now() - Date.parse(ageRef) >
            reliability(claimed.workspace).maxMessageAgeHours * 3600000
        )
          throw new Error(
            isNotice
              ? 'Order update is outside the messaging freshness window'
              : 'Order is too old for automatic confirmation messaging',
          );
        if (
          !SHOPIFY_JOB_KINDS.has(candidate.kind) &&
          isPhoneOptedOut(claimed.workspace, order.phone)
        )
          throw new Error('Customer opted out of automated WhatsApp messages (STOP)');
        if (candidate.kind === 'TEST_HELLO' || candidate.kind === 'TEST_CONFIRMATION') {
          if (!orderTestAllowed(claimed, order.phone))
            throw new Error(
              'Order test authorization expired or does not match this merchant and recipient',
            );
          if (order.status !== 'PENDING') throw new Error('Order is no longer pending');
          if (claimed.workspace.conversations.some((c) => c.orderId === order.id && c.human))
            throw new Error('Assistant paused for human handling');
        } else if (candidate.kind === 'CANCEL') {
          if (
            order.status !== 'NEEDS_REVIEW' ||
            !claimed.workspace.tasks.some(
              (t) => t.orderId === order.id && t.kind === 'Cancellation' && t.status === 'APPROVED',
            )
          )
            throw new Error('No pending customer cancellation decision');
        } else if (isNotice && noticeMeta) {
          if (order.status === 'CANCELLED') throw new Error('Cancelled orders do not send notices');
          if (!dispatchTestAllowed(claimed, order.phone)) {
            if (!canSend(claimed)) throw new Error('Trial expired or subscription inactive');
            if (shopifySyncSettings(claimed.workspace).requireExplicitConsent && !order.consent)
              throw new Error('Messaging permission is not recorded');
          }
          if (!noticeMeta.enabled) throw new Error(noticeMeta.disabledReason);
          if (!noticeMeta.eligible(order)) throw new Error(noticeMeta.ineligibleReason);
        } else if (!SHOPIFY_JOB_KINDS.has(candidate.kind)) {
          if (order.isCod === false) throw new Error('Non-COD orders do not send COD confirmation');
          if ((order.financialStatus ?? 'pending').toLowerCase() !== 'pending')
            throw new Error('Order is no longer payment pending');
          if (!canSend(claimed)) throw new Error('Trial expired or subscription inactive');
          if (claimed.workspace.conversations.some((c) => c.orderId === order.id && c.human))
            throw new Error('Assistant paused for human handling');
          if (shopifySyncSettings(claimed.workspace).requireExplicitConsent && !order.consent)
            throw new Error('Messaging permission is not recorded');
          if (order.status !== 'PENDING') throw new Error('Order no longer requires confirmation');
          if (
            !claimed.workspace.settings.confirmations ||
            (candidate.kind === 'REMINDER' && !claimed.workspace.settings.reminders)
          )
            throw new Error('Automation is disabled');
        }
        if (
          !config.demo &&
          ['CONFIRMATION', 'REMINDER'].includes(candidate.kind) &&
          !metaWebhookReady(claimed)
        )
          throw new Error(
            'Incoming WhatsApp replies are not configured for the current callback URL. Complete Meta webhook setup in Integrations.',
          );
        let messageId: string | undefined;
        let releaseOutcome: 'RELEASED' | 'NONE' | undefined;
        if (!config.demo) {
          if (candidate.kind === 'TAG') {
            if (order.status === 'CONFIRMED')
              await addOrderTag(await freshShopifyIntegration(id), order, [sync.confirmedTag]);
          } else if (candidate.kind === 'REVIEW_TAG') {
            if (order.status === 'NEEDS_REVIEW')
              await addOrderTag(await freshShopifyIntegration(id), order, [sync.reviewTag]);
          } else if (candidate.kind === 'FULFILLMENT_HOLD') {
            if (order.status !== 'CANCELLED')
              await placeOrderFulfillmentHold(
                await freshShopifyIntegration(id),
                order,
                candidate.payload?.reasonNotes || sync.holdReasonNotes,
              );
          } else if (candidate.kind === 'FULFILLMENT_RELEASE') {
            if (
              order.status !== 'CANCELLED' &&
              (order.status === 'CONFIRMED' || order.delivery === 'On hold')
            ) {
              releaseOutcome = await releaseOrderFulfillmentHold(
                await freshShopifyIntegration(id),
                order,
              );
            }
          } else if (candidate.kind === 'MARK_PAID') {
            await markShopifyOrderPaid(await freshShopifyIntegration(id), order);
          } else if (candidate.kind === 'MARK_IN_PROGRESS') {
            await reportFulfillmentProgress(
              await freshShopifyIntegration(id),
              order,
              candidate.payload?.reasonNotes,
            );
          } else if (candidate.kind === 'MARK_OPEN') {
            await reopenFulfillmentOrder(await freshShopifyIntegration(id), order);
          } else if (candidate.kind === 'FULFILL_ORDER') {
            await createShopifyFulfillment(
              await freshShopifyIntegration(id),
              order,
              candidate.payload,
            );
          } else if (candidate.kind === 'UPDATE_TRACKING') {
            await updateFulfillmentTracking(
              await freshShopifyIntegration(id),
              order,
              candidate.payload ?? {},
            );
          } else if (candidate.kind === 'MARK_DELIVERED') {
            await createFulfillmentDeliveredEvent(await freshShopifyIntegration(id), order);
          } else if (candidate.kind === 'CANCEL_TAGS' || candidate.kind === 'CANCEL_CLEANUP')
            await syncCancellationTags(
              await freshShopifyIntegration(id),
              order,
              order.status === 'CANCELLED',
              sync.confirmedTag,
              sync.cancellationRequestedTag,
            );
          else if (candidate.kind === 'CANCEL')
            await cancelUnpaidCodOrder(
              await freshShopifyIntegration(id),
              order,
              claimed.workspace.tasks.find(
                (t) =>
                  t.orderId === order.id && t.kind === 'Cancellation' && t.status === 'APPROVED',
              )?.detail,
              sync.codGatewayKeywords,
            );
          else if (isNotice && noticeMeta) {
            const isDispatch = candidate.kind === 'DISPATCH_NOTICE';
            if (!dispatchTestAllowed(claimed, order.phone) && !config.outbound)
              throw new ProviderError('Outbound messaging is disabled');
            const integration = await freshShopifyIntegration(id);
            const validated = await validateUtilityTemplate(integration, {
              templateName: noticeMeta.templateName,
              languageCode: noticeMeta.languageCode,
              expectedVariables: noticeMeta.variables.length,
              requireUrlButton: noticeMeta.requireUrlButton,
            });
            const values = dispatchValues(noticeMeta.variables, claimed, order);
            if (historyId) {
              const preview = validated.body.replace(
                /\{\{(\d+)\}\}/g,
                (_, n: string) => values[Number(n) - 1] ?? '',
              );
              await updateMessage(id, historyId, { preview });
            }
            messageId = await sendUtilityNotification(integration, {
              recipient: order.phone,
              templateName: noticeMeta.templateName,
              languageCode: noticeMeta.languageCode,
              bodyValues: values,
              dynamicUrlSuffix:
                isDispatch && d.includeTrackingButtonUrl
                  ? order.trackingNumber?.trim() || order.number.replace(/^#/, '')
                  : undefined,
              correlationId: historyId,
            });
          } else if (candidate.kind === 'TEST_CONFIRMATION') {
            const integration = await freshShopifyIntegration(id);
            messageId = await sendOrderConfirmation(
              integration,
              order,
              claimed.merchant.brandName,
              async (preview) => {
                if (historyId) await updateMessage(id, historyId, { preview });
              },
              historyId,
            );
          } else if (candidate.kind === 'TEST_HELLO')
            messageId = await sendHelloWorldTest(
              claimed.workspace.integration,
              order.phone,
              historyId,
            );
          else {
            if (!config.outbound) throw new ProviderError('Outbound messaging is disabled');
            const integration = await freshShopifyIntegration(id);
            messageId = await sendOrderConfirmation(
              integration,
              order,
              claimed.merchant.brandName,
              async (preview) => {
                if (historyId) await updateMessage(id, historyId, { preview });
              },
              historyId,
            );
          }
        } else if (!SHOPIFY_JOB_KINDS.has(candidate.kind)) messageId = `demo-${candidate.id}`;
        if (historyId && messageId)
          await updateMessage(id, historyId, { status: 'ACCEPTED', messageId });
        await mutate(id, (s) => {
          const j = s.workspace.jobs.find((j) => j.id === candidate.id)!;
          const o = s.workspace.orders.find((o) => o.id === order.id)!;
          j.state = 'DONE';
          j.error = undefined;
          j.claimedAt = undefined;
          j.retryable = false;
          resolveNotification(s.workspace, 'job:' + j.id);
          if (
            messageId &&
            ['CONFIRMATION', 'REMINDER', 'TEST_CONFIRMATION'].includes(j.kind) &&
            !o.confirmationExpiresAt
          )
            o.confirmationExpiresAt = new Date(
              Date.now() + reliability(s.workspace).maxMessageAgeHours * 3600000,
            ).toISOString();
          j.messageId = messageId;
          if (j.kind === 'TAG') {
            if (order.status === 'CONFIRMED' && !o.tags.includes(sync.confirmedTag))
              o.tags.push(sync.confirmedTag);
            if (o.status !== 'CONFIRMED') {
              const tagJob = s.workspace.jobs.find(
                (job) => job.orderId === o.id && job.kind === 'CANCEL_TAGS',
              );
              if (tagJob && tagJob.state !== 'UNKNOWN') {
                tagJob.state = 'QUEUED';
                tagJob.attempts = 0;
                tagJob.dueAt = new Date().toISOString();
              }
            }
          } else if (j.kind === 'REVIEW_TAG') {
            if (order.status === 'NEEDS_REVIEW' && !o.tags.includes(sync.reviewTag))
              o.tags.push(sync.reviewTag);
          } else if (j.kind === 'FULFILLMENT_HOLD') {
            if (o.status !== 'CANCELLED') {
              o.delivery = 'On hold';
              o.fulfillmentStatus = 'ON_HOLD';
              append(
                conversation(s.workspace, o),
                'note',
                'Shopify fulfillment hold placed by Relay (handle: relay-hold).',
              );
              planDispatchNotification(s, o, false, true);
            }
          } else if (j.kind === 'FULFILLMENT_RELEASE') {
            if (o.delivery === 'On hold') {
              if (config.demo || releaseOutcome === 'RELEASED') {
                o.delivery = 'Unfulfilled';
                o.fulfillmentStatus = 'UNFULFILLED';
                append(
                  conversation(s.workspace, o),
                  'note',
                  'Relay-owned fulfillment hold released in Shopify.',
                );
              } else if (releaseOutcome === 'NONE') {
                append(
                  conversation(s.workspace, o),
                  'note',
                  'No Relay-owned hold was found on this order. Third-party holds must be released in Shopify.',
                );
              }
            }
          } else if (j.kind === 'MARK_PAID') {
            o.financialStatus = 'paid';
            o.messageBlockedReason = undefined;
            if (o.status === 'PENDING') o.status = 'CONFIRMED';
            for (const qJob of s.workspace.jobs.filter(
              (job) =>
                job.orderId === o.id &&
                ['CONFIRMATION', 'REMINDER'].includes(job.kind) &&
                job.state === 'QUEUED',
            )) {
              qJob.state = 'FAILED';
              qJob.retryable = false;
              qJob.error = 'Stopped after order was marked paid';
              resolveNotification(s.workspace, 'job:' + qJob.id);
            }
            append(conversation(s.workspace, o), 'note', 'Order marked paid in Shopify.');
            planDispatchNotification(s, o, false, true);
          } else if (j.kind === 'MARK_IN_PROGRESS') {
            o.delivery = 'In progress';
            o.fulfillmentStatus = 'IN_PROGRESS';
            append(
              conversation(s.workspace, o),
              'note',
              'Fulfillment marked In progress in Shopify.',
            );
            planDispatchNotification(s, o, false, true);
          } else if (j.kind === 'MARK_OPEN') {
            o.delivery = 'Unfulfilled';
            o.fulfillmentStatus = 'UNFULFILLED';
            append(
              conversation(s.workspace, o),
              'note',
              'Fulfillment reopened (Unfulfilled) in Shopify.',
            );
          } else if (j.kind === 'FULFILL_ORDER') {
            o.delivery = 'In transit';
            o.fulfillmentStatus = 'FULFILLED';
            if (j.payload?.trackingCompany) o.trackingCompany = j.payload.trackingCompany;
            if (j.payload?.trackingNumber) o.trackingNumber = j.payload.trackingNumber;
            if (j.payload?.trackingUrl) o.trackingUrl = j.payload.trackingUrl;
            const trackSummary = [o.trackingCompany, o.trackingNumber].filter(Boolean).join(' · ');
            append(
              conversation(s.workspace, o),
              'note',
              `Order fulfilled in Shopify${trackSummary ? ` (${trackSummary})` : ''}.`,
            );
            planDispatchNotification(s, o, false, true);
          } else if (j.kind === 'UPDATE_TRACKING') {
            if (j.payload?.trackingCompany) o.trackingCompany = j.payload.trackingCompany;
            if (j.payload?.trackingNumber) o.trackingNumber = j.payload.trackingNumber;
            if (j.payload?.trackingUrl) o.trackingUrl = j.payload.trackingUrl;
            const trackSummary = [o.trackingCompany, o.trackingNumber].filter(Boolean).join(' · ');
            append(
              conversation(s.workspace, o),
              'note',
              `Tracking updated in Shopify${trackSummary ? `: ${trackSummary}` : ''}.`,
            );
          } else if (j.kind === 'MARK_DELIVERED') {
            o.delivery = 'Delivered';
            o.fulfillmentStatus = 'DELIVERED';
            append(
              conversation(s.workspace, o),
              'note',
              'Fulfillment marked Delivered in Shopify.',
            );
            planDispatchNotification(s, o, false, true);
          } else if (j.kind === 'CANCEL_TAGS' || j.kind === 'CANCEL_CLEANUP') {
            o.tags = o.tags.filter(
              (tag) => tag !== sync.confirmedTag && tag !== sync.cancellationRequestedTag,
            );
            if (order.status !== 'CANCELLED') o.tags.push(sync.cancellationRequestedTag);
            if (o.status === 'CANCELLED' && order.status !== 'CANCELLED') {
              enqueue(s.workspace, o, 'CANCEL_CLEANUP');
              const cleanup = s.workspace.jobs.find(
                (job) => job.orderId === o.id && job.kind === 'CANCEL_CLEANUP',
              )!;
              cleanup.state = 'QUEUED';
              cleanup.attempts = 0;
              cleanup.dueAt = new Date().toISOString();
            }
          } else if (j.kind === 'CANCEL') {
            o.status = 'CANCELLED';
            enqueue(s.workspace, o, 'CANCEL_CLEANUP');
            const task = s.workspace.tasks.find(
              (t) => t.orderId === o.id && t.kind === 'Cancellation' && t.status === 'APPROVED',
            );
            if (task) {
              task.status = 'VERIFIED';
              task.detail += '\nShopify cancelledAt verified by Relay.';
            }
            append(
              conversation(s.workspace, o),
              'note',
              'Shopify cancellation confirmed. No order was deleted.',
            );
          } else if (isNotice && noticeMeta) {
            append(
              conversation(s.workspace, o),
              config.demo ? 'out' : 'note',
              config.demo
                ? noticeMeta.demoText(o, claimed.merchant.brandName)
                : noticeMeta.noteText(o, noticeMeta.templateName),
            );
          } else if (j.kind === 'TEST_CONFIRMATION') {
            append(
              conversation(s.workspace, o),
              'note',
              `Meta accepted the order confirmation template for ${o.number}. Delivery not yet confirmed. Buttons: Confirm order / Cancel order.`,
            );
          } else if (j.kind === 'TEST_HELLO') {
            append(
              conversation(s.workspace, o),
              'note',
              'Meta accepted a hello_world test request triggered by this order. Delivery is not confirmed. The sample contains no order details or confirmation buttons.',
            );
          } else {
            append(
              conversation(s.workspace, o),
              config.demo ? 'out' : 'note',
              config.demo
                ? `${j.kind === 'REMINDER' ? 'A quick reminder: ' : ''}Hi ${o.name.split(' ')[0]}, please confirm order ${o.number} (${o.currency} ${o.amount.toLocaleString()}). Reply Confirm, Change, or Cancel.`
                : `Meta accepted template ${s.workspace.integration.templateName} for ${o.number}. Confirm/Cancel buttons included. Delivery not yet confirmed.`,
            );
            if (j.kind === 'CONFIRMATION' && s.workspace.settings.reminders)
              enqueue(s.workspace, o, 'REMINDER', s.workspace.settings.reminderHours * 3600000);
          }
          activity(
            s.workspace,
            `${config.demo ? 'Simulated' : 'Completed'} ${j.kind.toLowerCase()} for ${o.number}`,
          );
        });
      } catch (error) {
        if (historyId)
          await updateMessage(id, historyId, {
            status: error instanceof ProviderError && error.ambiguous ? 'UNKNOWN' : 'FAILED',
            error: error instanceof Error ? error.message : 'Operation failed',
          });
        await mutate(id, (s) => {
          const j = s.workspace.jobs.find((j) => j.id === candidate.id)!;
          if (j.state === 'DONE' && !j.claimedAt) return; // Reconciliation already proved completion.
          j.error = error instanceof Error ? error.message : 'Operation failed';
          const policy = jobRetry(j.kind, error, j.attempts);
          j.state = policy.retry ? 'QUEUED' : policy.unknown ? 'UNKNOWN' : 'FAILED';
          j.claimedAt = undefined;
          j.retryable = policy.retry;
          if (policy.retry) j.dueAt = new Date(Date.now() + policy.delay).toISOString();
          notify(
            s.workspace,
            'job:' + j.id,
            policy.unknown
              ? 'Action outcome is uncertain'
              : policy.retry
                ? 'Action scheduled for retry'
                : 'Action failed',
            j.error,
            policy.unknown
              ? 'Check provider history. Relay will not blindly resend.'
              : policy.retry
                ? 'Relay will retry after ' + new Date(j.dueAt).toLocaleString() + '.'
                : 'Review credentials, permissions, or the order, then retry from Automations.',
          );
          if (j.kind === 'CANCEL') {
            conversation(
              s.workspace,
              s.workspace.orders.find((o) => o.id === candidate.orderId)!,
            ).human = true;
          }
          activity(
            s.workspace,
            `${candidate.kind.toLowerCase()} needs attention for ${order?.number ?? 'support reply'}`,
          );
        });
      }
      }
    }
  } finally {
    running = false;
  }
}
