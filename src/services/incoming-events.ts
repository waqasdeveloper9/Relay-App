import { humanHandling, queueSupportHandoff, queueSupportReply } from './support-replies.js';
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
import { shopifyOrderSchema, ingestOrder } from './order-ingestion.js';
import { config } from '../config.js';
import { freshShopifyIntegration } from './shopify-tokens.js';
import { notify, resolveNotification } from './notifications.js';
import { ProviderError, shopifyGraphql } from './providers.js';
export async function processShopifyEvent(
  merchantId: string,
  topic: string,
  eventId: string,
  payload: unknown,
): Promise<void> {
  await mutate(merchantId, (s) => {
    const key = 'shopify:' + eventId;
    if (s.workspace.processedEvents.includes(key)) return;
    if (topic === 'app/uninstalled') {
      Object.assign(s.workspace.integration, {
        shopifyToken: '',
        shopifyVerifiedAt: undefined,
        shopifyRefreshToken: undefined,
        shopifyTokenExpiresAt: undefined,
        shopifyRefreshExpiresAt: undefined,
        shopifyWebhooksVerifiedAt: undefined,
        shopifyWebhooksUrl: undefined,
      });
    } else ingestOrder(s, shopifyOrderSchema.parse(payload));
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
                'Customer tapped Talk to support. Assistant paused for human handling.',
              );
              notify(
                w,
                'reply:' + c.id,
                'Customer requested support',
                'A customer tapped Talk to support on WhatsApp.',
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
