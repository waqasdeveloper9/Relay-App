import {
  handleOptKeyword,
  humanHandling,
  queueSupportHandoff,
  queueSupportReply,
} from './support-replies.js';
import { customerThreads } from '../models/customer-conversations.js';
import { customerConversation } from './automation.js';
import { z } from 'zod';
import { getStore, mutate } from './repository.js';
import {
  activity,
  append,
  conversation,
  handleIncoming,
  handleOrderDecision,
} from './automation.js';
import { parseOrderButton } from './order-confirmation.js';
import { applyDeliveryStatus } from './message-history.js';
import {
  shopifyOrderSchema,
  ingestOrder,
  snapshotToIncomingOrder,
  type IncomingShopifyOrder,
} from './order-ingestion.js';
import { config } from '../config.js';
import { freshShopifyIntegration } from './shopify-tokens.js';
import { notify, resolveNotification } from './notifications.js';
import {
  ProviderError,
  fetchShopifyOrderSnapshot,
  resolveOrderIdFromFulfillmentOrder,
  shopifyGraphql,
} from './providers.js';
import { supportSettings } from '../models/workspace-defaults.js';

export const SHOPIFY_ORDER_TOPICS = new Set([
  'orders/create',
  'orders/updated',
  'orders/cancelled',
  'orders/fulfilled',
  'orders/partially_fulfilled',
  'orders/paid',
]);
export const SHOPIFY_FULFILLMENT_TOPICS = new Set(['fulfillments/create', 'fulfillments/update']);
export const SHOPIFY_FULFILLMENT_EVENT_TOPICS = new Set(['fulfillment_events/create']);
export const SHOPIFY_FULFILLMENT_ORDER_TOPICS = new Set([
  'fulfillment_orders/placed_on_hold',
  'fulfillment_orders/hold_released',
  'fulfillment_orders/progress_reported',
  'fulfillment_orders/manually_reported_progress_stopped',
]);

export function isSupportedShopifyTopic(topic: string): boolean {
  return (
    topic === 'app/uninstalled' ||
    SHOPIFY_ORDER_TOPICS.has(topic) ||
    SHOPIFY_FULFILLMENT_TOPICS.has(topic) ||
    SHOPIFY_FULFILLMENT_EVENT_TOPICS.has(topic) ||
    SHOPIFY_FULFILLMENT_ORDER_TOPICS.has(topic)
  );
}

const idScalar = z.union([z.string(), z.number().safe()]).transform(String);

export const shopifyFulfillmentWebhookSchema = z.object({
  order_id: idScalar,
  status: z.string().nullish(),
  shipment_status: z.string().nullish(),
  tracking_number: z.string().nullish(),
  tracking_numbers: z.array(z.string()).optional(),
  tracking_url: z.string().nullish(),
  tracking_urls: z.array(z.string()).optional(),
  tracking_company: z.string().nullish(),
});

export const shopifyFulfillmentEventWebhookSchema = z.object({
  order_id: idScalar,
  status: z.string(),
  fulfillment_id: idScalar.optional(),
});

export const shopifyFulfillmentOrderWebhookSchema = z.union([
  z.object({
    fulfillment_order: z.object({
      id: idScalar,
      order_id: idScalar.nullish(),
      status: z.string().nullish(),
    }),
  }),
  z.object({
    id: idScalar,
    order_id: idScalar.nullish(),
    status: z.string().nullish(),
  }),
]);

export function validateShopifyWebhookPayload(topic: string, payload: unknown): void {
  if (topic === 'app/uninstalled') return;
  if (SHOPIFY_ORDER_TOPICS.has(topic)) {
    shopifyOrderSchema.parse(payload);
    return;
  }
  if (SHOPIFY_FULFILLMENT_TOPICS.has(topic)) {
    shopifyFulfillmentWebhookSchema.parse(payload);
    return;
  }
  if (SHOPIFY_FULFILLMENT_EVENT_TOPICS.has(topic)) {
    shopifyFulfillmentEventWebhookSchema.parse(payload);
    return;
  }
  if (SHOPIFY_FULFILLMENT_ORDER_TOPICS.has(topic)) {
    shopifyFulfillmentOrderWebhookSchema.parse(payload);
    return;
  }
  throw new Error('Unsupported Shopify topic: ' + topic);
}

export async function processShopifyEvent(
  merchantId: string,
  topic: string,
  eventId: string,
  payload: unknown,
): Promise<void> {
  const key = 'shopify:' + eventId;
  const existing = await getStore(merchantId);
  if (existing?.workspace.processedEvents.includes(key)) return;

  if (topic === 'app/uninstalled' || topic === 'orders/create' || topic === 'orders/cancelled') {
    await mutate(merchantId, (s) => {
      if (s.workspace.processedEvents.includes(key)) return;
      if (topic === 'app/uninstalled') {
        Object.assign(s.workspace.integration, {
          shopifyToken: '',
          shopifyVerifiedAt: undefined,
          shopifyRefreshToken: undefined,
          shopifyTokenExpiresAt: undefined,
          shopifyRefreshExpiresAt: undefined,
          shopifyScopes: undefined,
          shopifyWebhooksVerifiedAt: undefined,
          shopifyWebhooksUrl: undefined,
        });
      } else {
        ingestOrder(s, shopifyOrderSchema.parse(payload));
      }
      s.workspace.processedEvents.push(key);
    });
    return;
  }

  if (SHOPIFY_ORDER_TOPICS.has(topic)) {
    const restOrder = shopifyOrderSchema.parse(payload);
    let incoming: IncomingShopifyOrder = restOrder;
    if (!config.demo && existing?.workspace.integration.shopifyToken) {
      try {
        const integration = await freshShopifyIntegration(merchantId);
        const snapshot = await fetchShopifyOrderSnapshot(integration, restOrder.id);
        if (snapshot) {
          const snapOrder = snapshotToIncomingOrder(snapshot);
          incoming = {
            ...snapOrder,
            fulfillments: snapOrder.fulfillments?.length
              ? snapOrder.fulfillments
              : restOrder.fulfillments,
            note_attributes: snapOrder.note_attributes?.length
              ? snapOrder.note_attributes
              : restOrder.note_attributes,
            customer: snapOrder.customer?.sms_marketing_consent?.state
              ? snapOrder.customer
              : restOrder.customer,
          };
          if (
            restOrder.fulfillments?.some(
              (f) => (f.shipment_status ?? '').trim().toLowerCase() === 'delivered',
            )
          ) {
            incoming.event_delivery_status = 'delivered';
          }
        }
      } catch {
        // Fall back safely to REST order payload when GraphQL snapshot is unavailable.
      }
    }
    await mutate(merchantId, (s) => {
      if (s.workspace.processedEvents.includes(key)) return;
      ingestOrder(s, incoming);
      s.workspace.processedEvents.push(key);
    });
    return;
  }

  let rawOrderId: string | undefined;
  let eventDeliveryStatus: string | undefined;
  let webhookFulfillments: IncomingShopifyOrder['fulfillments'];
  let foStatusOverride: string | undefined;
  let holdReleased = false;

  if (SHOPIFY_FULFILLMENT_TOPICS.has(topic)) {
    const f = shopifyFulfillmentWebhookSchema.parse(payload);
    rawOrderId = f.order_id;
    webhookFulfillments = [f];
  } else if (SHOPIFY_FULFILLMENT_EVENT_TOPICS.has(topic)) {
    const ev = shopifyFulfillmentEventWebhookSchema.parse(payload);
    rawOrderId = ev.order_id;
    eventDeliveryStatus = ev.status;
  } else if (SHOPIFY_FULFILLMENT_ORDER_TOPICS.has(topic)) {
    const parsed = shopifyFulfillmentOrderWebhookSchema.parse(payload);
    const fo = 'fulfillment_order' in parsed ? parsed.fulfillment_order : parsed;
    rawOrderId = fo.order_id ?? undefined;
    if (topic === 'fulfillment_orders/placed_on_hold') foStatusOverride = 'ON_HOLD';
    else if (topic === 'fulfillment_orders/hold_released') holdReleased = true;
    else if (topic === 'fulfillment_orders/progress_reported') foStatusOverride = 'IN_PROGRESS';
    else if (fo.status) foStatusOverride = fo.status;

    if (!rawOrderId && existing?.workspace.integration.shopifyToken) {
      rawOrderId = await resolveOrderIdFromFulfillmentOrder(
        await freshShopifyIntegration(merchantId),
        fo.id,
      );
    }
  } else {
    throw new Error('Unsupported webhook topic: ' + topic);
  }

  const numericOrderId = rawOrderId?.split('/').at(-1);
  if (!numericOrderId || !/^\d+$/.test(numericOrderId)) {
    await mutate(merchantId, (s) => {
      if (!s.workspace.processedEvents.includes(key)) s.workspace.processedEvents.push(key);
    });
    return;
  }

  let incoming: IncomingShopifyOrder | undefined;
  if (!config.demo && existing?.workspace.integration.shopifyToken) {
    const snapshot = await fetchShopifyOrderSnapshot(
      await freshShopifyIntegration(merchantId),
      numericOrderId,
    );
    if (snapshot) {
      incoming = snapshotToIncomingOrder(snapshot);
      if (webhookFulfillments?.length) {
        incoming.fulfillments = incoming.fulfillments?.length
          ? [...incoming.fulfillments, ...webhookFulfillments]
          : webhookFulfillments;
      }
      if (eventDeliveryStatus) incoming.event_delivery_status = eventDeliveryStatus;
      if (foStatusOverride && incoming.display_fulfillment_status === 'UNFULFILLED') {
        incoming.display_fulfillment_status = foStatusOverride;
      }
    }
  }

  await mutate(merchantId, (s) => {
    if (s.workspace.processedEvents.includes(key)) return;
    if (incoming) {
      ingestOrder(s, incoming, false, false, { holdReleased });
    } else {
      const existingOrder = s.workspace.orders.find((o) => o.shopifyOrderId === numericOrderId);
      if (existingOrder) {
        ingestOrder(
          s,
          {
            id: numericOrderId,
            name: existingOrder.number,
            total_price: String(existingOrder.amount),
            currency: existingOrder.currency,
            payment_gateway_names:
              existingOrder.isCod === false ? ['Prepaid'] : ['Cash on Delivery'],
            updated_at: new Date().toISOString(),
            display_fulfillment_status:
              foStatusOverride ?? existingOrder.fulfillmentStatus ?? undefined,
            event_delivery_status: eventDeliveryStatus,
            fulfillments: webhookFulfillments,
          },
          false,
          false,
          { holdReleased },
        );
      }
    }
    s.workspace.processedEvents.push(key);
  });
}
export const metaPayload = z.object({
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          value: z.object({
            metadata: z.object({ phone_number_id: z.string() }).optional(),
            statuses: z
              .array(
                z.object({
                  id: z.string(),
                  status: z.string(),
                  recipient_id: z.string(),
                  biz_opaque_callback_data: z.string().max(512).optional(),
                  timestamp: z.string().regex(/^\d+$/),
                  errors: z
                    .array(
                      z.object({
                        code: z.number(),
                        title: z.string().optional(),
                        message: z.string().optional(),
                      }),
                    )
                    .optional(),
                }),
              )
              .optional(),
            messages: z
              .array(
                z.object({
                  id: z.string(),
                  from: z.string(),
                  timestamp: z.string().regex(/^\d+$/).optional(),
                  text: z.object({ body: z.string().max(4000) }).optional(),
                  context: z.object({ id: z.string() }).optional(),
                  button: z.object({ payload: z.string(), text: z.string() }).optional(),
                  interactive: z
                    .object({
                      button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
                    })
                    .optional(),
                }),
              )
              .optional(),
          }),
        }),
      ),
    }),
  ),
});

function needsHumanEscalation(text?: string, button?: string): boolean {
  if (button || !text?.trim()) return true;
  const normalized = text.trim().toLowerCase();
  const policyOnly =
    /\bpolic(?:y|ies)\b/.test(normalized) &&
    !/\b(cancel|refund|return|exchange|change|edit|wrong|replace|damag\w*|broken|missing|human|agent|staff|complaint)\s+(my|the|this|order|item|parcel|address)\b/.test(
      normalized,
    ) &&
    !/\b(want|need|like)\s+to\s+(cancel|refund|return|exchange|change|replace)\b/.test(normalized);
  if (policyOnly) return false;
  return /\b(cancel|refund|return|exchange|change|edit|wrong|replace|damag\w*|broken|missing|human|agent|staff|representative|complaint|confirm)\b/.test(
    normalized,
  );
}

export async function processMetaEvent(merchantId: string, raw: unknown): Promise<void> {
  const payload = metaPayload.parse(raw);
  await mutate(merchantId, (s) => {
    s.workspace.integration.metaWebhookLastReceivedAt = new Date().toISOString();
    resolveNotification(s.workspace, 'meta-webhook');
  });
  const storeForEvent = await getStore(merchantId);
  const stores = storeForEvent ? [storeForEvent] : [];
  for (const entry of payload.entry)
    for (const change of entry.changes) {
      const matches = stores.filter(
        (s) =>
          s.workspace.integration.phoneNumberId &&
          s.workspace.integration.phoneNumberId === change.value.metadata?.phone_number_id,
      );
      if (matches.length !== 1) continue;
      let store = matches[0]!;
      if (
        change.value.statuses?.some(
          (event) =>
            !store.workspace.outboundMessages?.some(
              (m) => m.messageId === event.id || m.id === event.biz_opaque_callback_data,
            ) &&
            store.workspace.outboundMessages?.some(
              (m) => m.recipient === event.recipient_id && m.status === 'SENDING',
            ),
        )
      )
        throw new ProviderError(
          'Delivery receipt is waiting for the send result to be recorded',
          false,
          { retryable: true },
        );
      if (change.value.statuses?.length) {
        await mutate(store.merchant.id, (s) => {
          for (const event of change.value.statuses!) {
            applyDeliveryStatus(s.workspace, event);
            const m = s.workspace.outboundMessages?.find((m) => m.messageId === event.id);
            if (m?.status === 'FAILED')
              notify(
                s.workspace,
                'message:' + m.id,
                'WhatsApp delivery failed',
                m.error ?? 'Meta reported a delivery failure',
                'Review the error in Messages before retrying.',
              );
            else if (m && ['DELIVERED', 'READ'].includes(m.status))
              resolveNotification(s.workspace, 'message:' + m.id);
          }
        });
      }
      store = (await getStore(merchantId))!;
      for (const message of change.value.messages ?? []) {
        const incomingDecision = parseOrderButton(
          message.button?.payload ?? message.interactive?.button_reply?.id ?? '',
        );
        const candidate = incomingDecision
          ? store.workspace.orders.find(
              (o) => o.id === incomingDecision.orderId && o.phone === message.from,
            )
          : undefined;
        if (
          candidate &&
          store.workspace.jobs.some(
            (j) => j.orderId === candidate.id && j.state === 'UNKNOWN' && j.claimedAt,
          )
        )
          throw new ProviderError(
            'Waiting for the outgoing message result before applying the reply',
            false,
            { retryable: true },
          );
        let eligible = true;
        if (candidate && !config.demo) {
          const raw = (await shopifyGraphql(
            await freshShopifyIntegration(store.merchant.id),
            'query DecisionEligibility($id:ID!){order(id:$id){cancelledAt displayFinancialStatus displayFulfillmentStatus}}',
            { id: 'gid://shopify/Order/' + candidate.shopifyOrderId },
          )) as {
            order: {
              cancelledAt: string | null;
              displayFinancialStatus: string;
              displayFulfillmentStatus: string;
            } | null;
          };
          eligible =
            !!raw.order &&
            !raw.order.cancelledAt &&
            raw.order.displayFinancialStatus === 'PENDING' &&
            raw.order.displayFulfillmentStatus === 'UNFULFILLED';
        }

        await mutate(store.merchant.id, (s) => {
          const w = s.workspace;
          const eventKey = `meta:${message.id}`;
          if (w.processedEvents.includes(eventKey)) return;
          const button = message.button?.payload ?? message.interactive?.button_reply?.id;
          const incomingText =
            message.text?.body ??
            message.interactive?.button_reply?.title ??
            message.button?.text ??
            '[Unsupported message]';
          if (button?.startsWith('ORDER:')) {
            const decision = parseOrderButton(button);
            const order = decision
              ? w.orders.find((o) => o.id === decision.orderId && o.phone === message.from)
              : undefined;
            const sent = order
              ? w.jobs.find(
                  (j) =>
                    j.orderId === order.id &&
                    ['TEST_CONFIRMATION', 'CONFIRMATION'].includes(j.kind) &&
                    j.state === 'DONE' &&
                    j.messageId &&
                    (!message.context || message.context.id === j.messageId),
                )
              : undefined;
            if (decision && order && sent && eligible)
              handleOrderDecision(w, order, decision.action);
            else {
              activity(
                w,
                'Unverified or ineligible order button ignored. No order action executed.',
              );
              if (order)
                notify(
                  w,
                  'decision:' + order.id,
                  'Customer reply requires review',
                  'Order reply could not be safely applied, or Shopify reports the order is no longer eligible.',
                  'Review the order in Shopify and contact the customer.',
                  'warning',
                );
            }
            w.processedEvents.push(eventKey);
            return;
          }
          if (
            !button &&
            message.text &&
            handleOptKeyword(s, {
              from: message.from,
              body: message.text.body,
              timestamp: message.timestamp,
            })
          ) {
            w.processedEvents.push(eventKey);
            return;
          }
          if (button === 'MENU:HUMAN') {
            const wasHuman = humanHandling(w, message.from);
            if (
              queueSupportHandoff(s, {
                from: message.from,
                body: incomingText,
                timestamp: message.timestamp,
              })
            ) {
              w.processedEvents.push(eventKey);
              return;
            }
            const c = customerConversation(w, message.from);
            append(c, 'in', incomingText);
            for (const thread of customerThreads(w, c)) {
              thread.human = true;
              thread.unread = true;
            }
            if (!wasHuman) {
              append(
                c,
                'note',
                `Customer tapped ${supportSettings(w).humanButtonTitle}. Assistant paused for human handling.`,
              );
              notify(
                w,
                'reply:' + c.id,
                'Customer requested support',
                `A customer tapped ${supportSettings(w).humanButtonTitle} on WhatsApp.`,
                'Reply in Inbox to assist them.',
                'info',
              );
              activity(w, 'Customer requested human support from WhatsApp menu.');
            }
            w.processedEvents.push(eventKey);
            return;
          }
          if (button === 'MENU:STATUS' || button === 'MENU:POLICY') {
            if (
              queueSupportReply(s, {
                from: message.from,
                body: incomingText,
                timestamp: message.timestamp,
                quotedId: message.context?.id,
                forcedIntent: button === 'MENU:STATUS' ? 'status' : 'policy',
                isButton: true,
              })
            ) {
              w.processedEvents.push(eventKey);
              return;
            }
            const wasHuman = humanHandling(w, message.from);
            const c = customerConversation(w, message.from);
            append(c, 'in', incomingText);
            c.unread = true;
            if (!wasHuman) {
              for (const thread of customerThreads(w, c)) thread.human = true;
              append(
                c,
                'note',
                'Menu selection received while automation could not reply. Assigned to human review.',
              );
              activity(w, 'Customer menu selection requires human reply in Inbox.');
            }
            w.processedEvents.push(eventKey);
            return;
          }
          if (
            !button &&
            message.text &&
            queueSupportReply(s, {
              from: message.from,
              body: message.text.body,
              timestamp: message.timestamp,
              quotedId: message.context?.id,
            })
          ) {
            w.processedEvents.push(eventKey);
            return;
          }
          const selected = button?.match(/^(CONFIRM|CHANGE|CANCEL):(.+)$/);
          const candidates = w.orders.filter((o) => o.phone === message.from);
          const job = message.context
            ? w.jobs.find((j) => j.messageId === message.context!.id)
            : undefined;
          const order = selected
            ? candidates.find((o) => o.id === selected[2])
            : job
              ? candidates.find((o) => o.id === job.orderId)
              : candidates.length === 1
                ? candidates[0]
                : undefined;
          if (!order) {
            const c = customerConversation(w, message.from);
            append(c, 'in', incomingText);
            c.unread = true;
            if (needsHumanEscalation(message.text?.body, button)) {
              c.human = true;
              activity(w, 'Customer message received in Inbox for human review.');
            } else activity(w, 'Customer message received in Inbox without an order association.');
            w.processedEvents.push(eventKey);
            return;
          }
          if (!config.demo) {
            const c = conversation(w, order);
            append(c, 'in', incomingText);
            c.unread = true;
            if (needsHumanEscalation(message.text?.body, button)) {
              c.human = true;
              notify(
                w,
                'reply:' + order.id,
                'Customer message requires review',
                'A reply was received without a verified order-action button.',
                'Review it in Inbox; no Shopify action was executed.',
                'warning',
              );
            }
            w.processedEvents.push(eventKey);
            return;
          }
          handleIncoming(
            w,
            order,
            selected
              ? selected[1]!
              : (message.text?.body ??
                  message.button?.text ??
                  '[Unsupported message type: human review required]'),
            false,
          );
          w.processedEvents.push(eventKey);
        });
      }
    }
}
