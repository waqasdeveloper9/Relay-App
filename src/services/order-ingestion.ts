import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CountryCode } from 'libphonenumber-js';
import type { Store, Order } from '../models/types.js';
import { config } from '../config.js';
import { phone } from '../utils/security.js';
import { activity, enqueue, canSend } from './automation.js';
import { orderTestAllowed } from './order-test.js';
import { resolveNotification } from './notifications.js';
import { metaWebhookReady } from './meta-webhook-settings.js';
import { reliability } from './reliability-settings.js';
export const shopifyOrderSchema = z.object({
  id: z.union([z.string(), z.number().safe()]).transform(String),
  name: z.string(),
  total_price: z.string().regex(/^\d+(\.\d{1,4})?$/),
  currency: z.string().length(3),
  payment_gateway_names: z.array(z.string()).default([]),
  tags: z.string().optional(),
  phone: z.string().nullish(),
  created_at: z.string().datetime({ offset: true }).optional(),
  updated_at: z.string().datetime({ offset: true }).optional(),
  cancelled_at: z.string().nullish(),
  financial_status: z.string().optional(),
  fulfillment_status: z.string().nullish(),
  customer: z
    .object({
      first_name: z.string().nullish(),
      last_name: z.string().nullish(),
      phone: z.string().nullish(),
    })
    .nullish(),
  shipping_address: z
    .object({
      name: z.string().nullish(),
      phone: z.string().nullish(),
      country_code: z
        .string()
        .regex(/^[A-Z]{2}$/)
        .optional(),
    })
    .nullish(),
});
export type IncomingShopifyOrder = z.infer<typeof shopifyOrderSchema>;
export function planOrderMessage(s: Store, o: Order, recovered = false): void {
  if (o.archivedAt) return;
  const r = reliability(s.workspace);
  const w = s.workspace;
  if (
    w.outboundMessages?.some(
      (m) =>
        m.orderId === o.id &&
        ['CONFIRMATION', 'TEST_CONFIRMATION', 'TEST_HELLO'].includes(m.kind) &&
        ['ACCEPTED', 'SENT', 'DELIVERED', 'READ', 'UNKNOWN', 'SENDING'].includes(m.status),
    )
  ) {
    o.messageBlockedReason = undefined;
    return;
  }
  if (
    w.jobs.some(
      (j) =>
        j.orderId === o.id && ['CONFIRMATION', 'TEST_CONFIRMATION', 'TEST_HELLO'].includes(j.kind),
    )
  ) {
    o.messageBlockedReason = undefined;
    return;
  }
  let reason = '';
  if (o.status !== 'PENDING') reason = 'Order is no longer pending confirmation';
  else if (o.delivery !== 'Unfulfilled') reason = 'Order has already entered fulfillment';
  else if (!o.phone) reason = 'A valid customer phone number is missing';
  else if (Date.now() - Date.parse(o.createdAt) > r.maxMessageAgeHours * 3600000)
    reason = 'Order is older than the configured messaging age limit';
  else if (orderTestAllowed(s, o.phone)) {
    enqueue(w, o, r.testMode!.template === 'hello_world' ? 'TEST_HELLO' : 'TEST_CONFIRMATION');
    o.messageBlockedReason = undefined;
    return;
  } else if (recovered && r.recoveryMessaging === 'REVIEW')
    reason = 'Recovered order requires merchant review before messaging';
  else if (!config.demo && w.integration.templateName !== 'hello_world' && !metaWebhookReady(s))
    reason =
      'Incoming WhatsApp replies are not configured. Save the Meta App Secret and verify the merchant callback in Integrations.';
  else if (!w.settings.confirmations) reason = 'Order-confirmation automation is paused';
  else if (!canSend(s)) reason = 'Trial expired or subscription inactive';
  else if (!o.consent) reason = 'Customer messaging permission has not been recorded';
  else if (!config.outbound) reason = 'Production outbound messaging is disabled by the platform';
  else {
    enqueue(w, o, 'CONFIRMATION');
    o.messageBlockedReason = undefined;
    return;
  }
  o.messageBlockedReason = reason;
}
export function repairMissingConfirmations(s: Store): void {
  for (const o of s.workspace.orders) {
    if (!o.archivedAt && o.status === 'PENDING') planOrderMessage(s, o, true);
  }
}
export function ingestOrder(
  s: Store,
  input: IncomingShopifyOrder,
  recovered = false,
  restoreArchived = false,
): Order | undefined {
  const w = s.workspace;
  const old = w.orders.find((o) => o.shopifyOrderId === input.id);
  if (old?.archivedAt) {
    if (!restoreArchived) return old;
    old.archivedAt = undefined;
  }
  if (!old && !input.payment_gateway_names.some((g) => /cash on delivery|\bcod\b/i.test(g))) return;
  if (
    old?.sourceUpdatedAt &&
    input.updated_at &&
    Date.parse(old.sourceUpdatedAt) > Date.parse(input.updated_at)
  )
    return old;
  let normalized = '';
  try {
    normalized = phone(
      input.shipping_address?.phone || input.phone || input.customer?.phone || '',
      input.shipping_address?.country_code as CountryCode | undefined,
    );
  } catch {}
  const o =
    old ??
    ({
      id: randomUUID(),
      shopifyOrderId: input.id,
      number: input.name,
      name: 'Customer',
      phone: '',
      amount: 0,
      currency: input.currency,
      status: 'PENDING',
      delivery: 'Unfulfilled',
      consent: false,
      tags: [],
      createdAt: input.created_at ?? new Date().toISOString(),
    } as Order);
  Object.assign(o, {
    number: input.name,
    name:
      input.shipping_address?.name ||
      [input.customer?.first_name, input.customer?.last_name].filter(Boolean).join(' ') ||
      old?.name ||
      'Customer',
    phone: normalized || old?.phone || '',
    amount: Number(input.total_price),
    currency: input.currency,
    sourceUpdatedAt: input.updated_at ?? old?.sourceUpdatedAt,
  });
  if (input.tags !== undefined)
    o.tags = input.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  if (input.cancelled_at) {
    o.status = 'CANCELLED';
    for (const job of w.jobs.filter(
      (j) => j.orderId === o.id && j.kind === 'CANCEL' && ['QUEUED', 'UNKNOWN'].includes(j.state),
    )) {
      job.state = 'DONE';
      job.claimedAt = undefined;
      job.error = undefined;
      job.retryable = false;
      resolveNotification(w, 'job:' + job.id);
      activity(w, 'Shopify cancellation reconciled for ' + o.number);
    }
    for (const task of w.tasks.filter(
      (t) => t.orderId === o.id && t.kind === 'Cancellation' && t.status === 'APPROVED',
    )) {
      task.status = 'VERIFIED';
      task.detail += '\nShopify cancellation verified during synchronization.';
    }
  } else if (
    input.financial_status &&
    input.financial_status !== 'pending' &&
    o.status === 'PENDING'
  )
    o.status = 'NEEDS_REVIEW';
  if (input.fulfillment_status === 'fulfilled' || input.fulfillment_status === 'partial')
    o.delivery = 'In transit';
  if (o.status === 'CONFIRMED' && o.tags.includes('COD-CONFIRMED'))
    for (const job of w.jobs.filter(
      (j) => j.orderId === o.id && j.kind === 'TAG' && ['QUEUED', 'UNKNOWN'].includes(j.state),
    )) {
      job.state = 'DONE';
      job.claimedAt = undefined;
      job.error = undefined;
      job.retryable = false;
      resolveNotification(w, 'job:' + job.id);
    }
  if (!old) {
    w.orders.unshift(o);
    activity(w, (recovered ? 'Recovered' : 'Received') + ' Shopify order ' + o.number);
  }
  planOrderMessage(s, o, recovered);
  return o;
}
