import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CountryCode } from 'libphonenumber-js';
import type { DeliveryStatus, Store, Order } from '../models/types.js';
import { config } from '../config.js';
import { phone } from '../utils/security.js';
import { activity, enqueue, canSend } from './automation.js';
import { dispatchTestAllowed, orderTestAllowed } from './order-test.js';
import { resolveNotification } from './notifications.js';
import { metaWebhookReady } from './meta-webhook-settings.js';
import { reliability } from './reliability-settings.js';
import {
  dispatchSettings,
  hasShopifyScope,
  isCodGateway,
  isPhoneOptedOut,
  shopifySyncSettings,
} from '../models/workspace-defaults.js';
import type { ShopifyOrderSnapshot } from './providers.js';

const restFulfillmentSchema = z.object({
  status: z.string().nullish(),
  shipment_status: z.string().nullish(),
  tracking_number: z.string().nullish(),
  tracking_numbers: z.array(z.string()).optional(),
  tracking_url: z.string().nullish(),
  tracking_urls: z.array(z.string()).optional(),
  tracking_company: z.string().nullish(),
});

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
  display_fulfillment_status: z.string().nullish(),
  event_delivery_status: z.string().nullish(),
  fulfillments: z.array(restFulfillmentSchema).optional(),
  note_attributes: z
    .array(
      z.object({
        name: z.string(),
        value: z.union([z.string(), z.number(), z.boolean()]).nullish(),
      }),
    )
    .optional(),
  customer: z
    .object({
      first_name: z.string().nullish(),
      last_name: z.string().nullish(),
      phone: z.string().nullish(),
      sms_marketing_consent: z
        .object({
          state: z.string().nullish(),
        })
        .nullish(),
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

export function snapshotToIncomingOrder(node: ShopifyOrderSnapshot): IncomingShopifyOrder {
  const id = node.id.split('/').at(-1)!;
  if (!/^\d+$/.test(id)) throw new Error('Shopify returned an invalid order ID');
  return {
    id,
    name: node.name,
    tags: node.tags?.join(', '),
    phone: node.phone,
    total_price: node.currentTotalPriceSet.shopMoney.amount,
    currency: node.currentTotalPriceSet.shopMoney.currencyCode,
    payment_gateway_names: node.paymentGatewayNames,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    cancelled_at: node.cancelledAt,
    financial_status: node.displayFinancialStatus?.toLowerCase(),
    fulfillment_status:
      node.displayFulfillmentStatus === 'FULFILLED'
        ? 'fulfilled'
        : node.displayFulfillmentStatus === 'PARTIALLY_FULFILLED'
          ? 'partial'
          : null,
    display_fulfillment_status: node.displayFulfillmentStatus,
    note_attributes: node.customAttributes?.map((a) => ({ name: a.key, value: a.value })),
    customer: node.customer
      ? {
          sms_marketing_consent: {
            state: node.customer.smsMarketingConsent?.marketingState ?? null,
          },
        }
      : undefined,
    shipping_address: node.shippingAddress
      ? {
          name: node.shippingAddress.name,
          phone: node.shippingAddress.phone,
          country_code: node.shippingAddress.countryCodeV2 ?? undefined,
        }
      : null,
    fulfillments: node.fulfillments?.map((f) => ({
      status: f.status,
      shipment_status: f.events?.nodes.some((e) => e.status === 'DELIVERED')
        ? 'delivered'
        : (f.displayStatus ?? null),
      tracking_number: f.trackingInfo?.find((t) => t.number)?.number ?? null,
      tracking_url: f.trackingInfo?.find((t) => t.url)?.url ?? null,
      tracking_company: f.trackingInfo?.find((t) => t.company)?.company ?? null,
    })),
  };
}

export function mapShopifyFulfillmentStatus(
  displayStatus?: string | null,
  restStatus?: string | null,
  fulfillments?: IncomingShopifyOrder['fulfillments'],
  eventStatus?: string | null,
  existingDelivery?: DeliveryStatus,
): DeliveryStatus {
  const display = (displayStatus ?? '').trim().toUpperCase();
  const rest = (restStatus ?? '').trim().toLowerCase();
  const event = (eventStatus ?? '').trim().toUpperCase();
  const active = (fulfillments ?? []).filter(
    (f) => !['CANCELLED', 'ERROR', 'FAILURE'].includes((f.status ?? '').trim().toUpperCase()),
  );
  const deliveredFromShipment = active.some(
    (f) => (f.shipment_status ?? '').trim().toUpperCase() === 'DELIVERED',
  );
  if (display === 'RESTOCKED') return 'Restocked';
  if (display === 'FULFILLMENT_NOT_REQUIRED') return 'Fulfillment not required';
  if (event === 'DELIVERED' || deliveredFromShipment) return 'Delivered';
  if (existingDelivery === 'Delivered' && (display === 'FULFILLED' || rest === 'fulfilled'))
    return 'Delivered';
  if (display === 'ON_HOLD') return 'On hold';
  if (display === 'IN_PROGRESS') return 'In progress';
  if (display === 'SCHEDULED') return 'Scheduled';
  if (display === 'PARTIALLY_FULFILLED' || rest === 'partial') return 'Partially fulfilled';
  if (display === 'FULFILLED' || rest === 'fulfilled') return 'In transit';
  if (display === 'UNFULFILLED') return 'Unfulfilled';
  if (restStatus === null && !display) return 'Unfulfilled';
  return existingDelivery ?? 'Unfulfilled';
}

function extractTracking(fulfillments?: IncomingShopifyOrder['fulfillments']): {
  trackingUrl?: string;
  trackingNumber?: string;
  trackingCompany?: string;
} {
  if (!fulfillments?.length) return {};
  const active = fulfillments.filter(
    (f) => !['CANCELLED', 'ERROR', 'FAILURE'].includes((f.status ?? '').trim().toUpperCase()),
  );
  for (let idx = active.length - 1; idx >= 0; idx--) {
    const f = active[idx]!;
    const rawUrl = f.tracking_url || f.tracking_urls?.find((u) => u.startsWith('https://')) || '';
    const trackingUrl = rawUrl.startsWith('https://') ? rawUrl.trim() : undefined;
    const trackingNumber = (f.tracking_number || f.tracking_numbers?.find(Boolean) || '').trim();
    const trackingCompany = (f.tracking_company || '').trim();
    if (trackingUrl || trackingNumber || trackingCompany) {
      return {
        ...(trackingUrl ? { trackingUrl } : {}),
        ...(trackingNumber ? { trackingNumber } : {}),
        ...(trackingCompany ? { trackingCompany } : {}),
      };
    }
  }
  return {};
}

export function planOrderMessage(s: Store, o: Order, recovered = false): void {
  if (o.archivedAt) return;
  if (o.isCod === false) {
    o.messageBlockedReason = undefined;
    return;
  }
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
  else if ((o.financialStatus ?? 'pending').toLowerCase() !== 'pending')
    reason = 'Order is no longer payment pending';
  else if (o.delivery !== 'Unfulfilled') reason = 'Order has already entered fulfillment';
  else if (!o.phone) reason = 'A valid customer phone number is missing';
  else if (isPhoneOptedOut(w, o.phone))
    reason = 'Customer opted out of automated WhatsApp messages (STOP)';
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

export function planDispatchNotification(
  s: Store,
  o: Order,
  recovered = false,
  actionTriggered = false,
): void {
  if (o.archivedAt || o.status === 'CANCELLED' || !o.phone) return;
  const w = s.workspace;
  if (isPhoneOptedOut(w, o.phone)) return;
  const d = dispatchSettings(w);
  const r = reliability(w);
  const referenceIso = actionTriggered
    ? new Date().toISOString()
    : recovered
      ? o.createdAt
      : (o.sourceUpdatedAt ?? o.createdAt);
  if (Date.now() - Date.parse(referenceIso) > r.maxMessageAgeHours * 3600000) return;

  const kinds: Array<
    | 'PAYMENT_NOTICE'
    | 'IN_PROGRESS_NOTICE'
    | 'ON_HOLD_NOTICE'
    | 'DISPATCH_NOTICE'
    | 'DELIVERY_NOTICE'
  > = [];
  if (d.paidEnabled && d.paidTemplateName && (o.financialStatus ?? '').toLowerCase() === 'paid')
    kinds.push('PAYMENT_NOTICE');
  if (d.inProgressEnabled && d.inProgressTemplateName && o.delivery === 'In progress')
    kinds.push('IN_PROGRESS_NOTICE');
  if (d.onHoldEnabled && d.onHoldTemplateName && o.delivery === 'On hold')
    kinds.push('ON_HOLD_NOTICE');
  if (
    d.enabled &&
    d.templateName &&
    (o.delivery === 'In transit' || (d.notifyOnPartial && o.delivery === 'Partially fulfilled'))
  )
    kinds.push('DISPATCH_NOTICE');
  if (d.deliveredEnabled && d.deliveredTemplateName && o.delivery === 'Delivered')
    kinds.push('DELIVERY_NOTICE');
  if (!kinds.length) return;

  const allowed =
    dispatchTestAllowed(s, o.phone) ||
    (o.consent && canSend(s) && (config.demo || config.outbound));
  if (!allowed) return;

  for (const kind of kinds) {
    if (
      w.outboundMessages?.some(
        (m) =>
          m.orderId === o.id &&
          m.kind === kind &&
          ['ACCEPTED', 'SENT', 'DELIVERED', 'READ', 'UNKNOWN', 'SENDING'].includes(m.status),
      ) ||
      w.jobs.some((j) => j.orderId === o.id && j.kind === kind)
    )
      continue;
    enqueue(w, o, kind);
  }
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
  extra?: { holdReleased?: boolean },
): Order | undefined {
  const w = s.workspace;
  const sync = shopifySyncSettings(w);
  const old = w.orders.find((o) => o.shopifyOrderId === input.id);
  if (old?.archivedAt) {
    if (!restoreArchived) return old;
    old.archivedAt = undefined;
  }
  const hasGateways = input.payment_gateway_names.length > 0;
  const cod = hasGateways
    ? isCodGateway(input.payment_gateway_names, sync.codGatewayKeywords)
    : (old?.isCod ?? false);
  if (!old && !cod && !sync.importNonCodOrders) return;
  if (
    old?.sourceUpdatedAt &&
    input.updated_at &&
    Date.parse(old.sourceUpdatedAt) > Date.parse(input.updated_at) &&
    !input.event_delivery_status &&
    !extra?.holdReleased
  )
    return old;
  let normalized = '';
  try {
    normalized = phone(
      input.shipping_address?.phone || input.phone || input.customer?.phone || '',
      input.shipping_address?.country_code as CountryCode | undefined,
    );
  } catch {}
  const financialStatus = (
    input.financial_status ??
    old?.financialStatus ??
    'pending'
  ).toLowerCase();
  const paymentMethod =
    input.payment_gateway_names.filter(Boolean).join(', ') ||
    old?.paymentMethod ||
    (cod ? 'Cash on delivery' : financialStatus === 'paid' ? 'Prepaid' : 'Other payment');
  const previousDelivery = old?.delivery;
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
      status: cod ? 'PENDING' : 'CONFIRMED',
      isCod: cod,
      financialStatus,
      paymentMethod,
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
    isCod: cod,
    financialStatus,
    paymentMethod,
    sourceUpdatedAt: input.updated_at ?? old?.sourceUpdatedAt,
  });
  if (input.display_fulfillment_status) o.fulfillmentStatus = input.display_fulfillment_status;
  const smsState = (input.customer?.sms_marketing_consent?.state ?? '').trim().toLowerCase();
  const smsConsentGranted = sync.syncCustomerSmsConsent && smsState === 'subscribed';
  const attrKey = sync.checkoutConsentAttributeKey.trim().toLowerCase();
  const attrConsentGranted =
    !!attrKey &&
    (input.note_attributes ?? []).some(
      (attr) =>
        attr.name.trim().toLowerCase() === attrKey &&
        sync.checkoutConsentValues.includes(
          String(attr.value ?? '')
            .trim()
            .toLowerCase(),
        ),
    );
  if (!o.consent && (smsConsentGranted || attrConsentGranted)) {
    o.consent = true;
    activity(
      w,
      `Explicit messaging opt-in recorded from Shopify ${smsConsentGranted ? 'SMS consent' : 'checkout attribute'} for ${o.number}`,
    );
  }
  if (input.tags !== undefined)
    o.tags = input.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  if (input.cancelled_at) {
    o.status = 'CANCELLED';
    if (w.jobs.some((j) => j.orderId === o.id && j.kind === 'CANCEL'))
      enqueue(w, o, 'CANCEL_CLEANUP');
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
    cod &&
    input.financial_status &&
    input.financial_status !== 'pending' &&
    o.status === 'PENDING'
  ) {
    o.status = 'NEEDS_REVIEW';
  }

  o.delivery = mapShopifyFulfillmentStatus(
    input.display_fulfillment_status,
    input.fulfillment_status,
    input.fulfillments,
    input.event_delivery_status,
    old?.delivery,
  );
  const tracking = extractTracking(input.fulfillments);
  if (tracking.trackingUrl) o.trackingUrl = tracking.trackingUrl;
  if (tracking.trackingNumber) o.trackingNumber = tracking.trackingNumber;
  if (tracking.trackingCompany) o.trackingCompany = tracking.trackingCompany;

  const resolveActiveActionJobs = (
    kinds: Array<
      | 'MARK_PAID'
      | 'MARK_IN_PROGRESS'
      | 'MARK_OPEN'
      | 'FULFILL_ORDER'
      | 'UPDATE_TRACKING'
      | 'MARK_DELIVERED'
    >,
    note?: string,
  ) => {
    for (const job of w.jobs.filter(
      (j) =>
        j.orderId === o.id &&
        kinds.includes(j.kind as (typeof kinds)[number]) &&
        ['QUEUED', 'UNKNOWN'].includes(j.state),
    )) {
      job.state = 'DONE';
      job.claimedAt = undefined;
      job.error = undefined;
      job.retryable = false;
      resolveNotification(w, 'job:' + job.id);
      if (note) activity(w, note);
    }
  };
  if (financialStatus !== 'pending') {
    for (const job of w.jobs.filter(
      (j) =>
        j.orderId === o.id && ['CONFIRMATION', 'REMINDER'].includes(j.kind) && j.state === 'QUEUED',
    )) {
      job.state = 'FAILED';
      job.retryable = false;
      job.error = 'Stopped after Shopify payment status changed';
      resolveNotification(w, 'job:' + job.id);
    }
  }
  if (financialStatus === 'paid') {
    resolveActiveActionJobs(['MARK_PAID'], 'Shopify paid status reconciled for ' + o.number);
  }
  if (o.delivery === 'In progress') {
    resolveActiveActionJobs(
      ['MARK_IN_PROGRESS'],
      'Shopify in-progress status reconciled for ' + o.number,
    );
  }
  if (o.delivery === 'Unfulfilled' && previousDelivery === 'In progress') {
    resolveActiveActionJobs(['MARK_OPEN'], 'Shopify reopened status reconciled for ' + o.number);
  }
  if (['In transit', 'Delivered', 'Partially fulfilled'].includes(o.delivery)) {
    resolveActiveActionJobs(['FULFILL_ORDER'], 'Shopify fulfillment reconciled for ' + o.number);
  }
  if (o.delivery === 'Delivered') {
    resolveActiveActionJobs(['MARK_DELIVERED'], 'Shopify delivery reconciled for ' + o.number);
  }
  const pendingTracking = w.jobs.find(
    (j) =>
      j.orderId === o.id && j.kind === 'UPDATE_TRACKING' && ['QUEUED', 'UNKNOWN'].includes(j.state),
  );
  if (
    pendingTracking?.payload &&
    (!pendingTracking.payload.trackingNumber ||
      o.trackingNumber === pendingTracking.payload.trackingNumber) &&
    (!pendingTracking.payload.trackingCompany ||
      o.trackingCompany === pendingTracking.payload.trackingCompany) &&
    (!pendingTracking.payload.trackingUrl || o.trackingUrl === pendingTracking.payload.trackingUrl)
  ) {
    resolveActiveActionJobs(
      ['UPDATE_TRACKING'],
      'Shopify tracking update reconciled for ' + o.number,
    );
  }

  if (o.status === 'CONFIRMED' && o.tags.includes(sync.confirmedTag))
    for (const job of w.jobs.filter(
      (j) => j.orderId === o.id && j.kind === 'TAG' && ['QUEUED', 'UNKNOWN'].includes(j.state),
    )) {
      job.state = 'DONE';
      job.claimedAt = undefined;
      job.error = undefined;
      job.retryable = false;
      resolveNotification(w, 'job:' + job.id);
    }
  if (o.status === 'NEEDS_REVIEW' && o.tags.includes(sync.reviewTag))
    for (const job of w.jobs.filter(
      (j) =>
        j.orderId === o.id && j.kind === 'REVIEW_TAG' && ['QUEUED', 'UNKNOWN'].includes(j.state),
    )) {
      job.state = 'DONE';
      job.claimedAt = undefined;
      job.error = undefined;
      job.retryable = false;
      resolveNotification(w, 'job:' + job.id);
    }
  if (o.delivery === 'On hold')
    for (const job of w.jobs.filter(
      (j) =>
        j.orderId === o.id &&
        j.kind === 'FULFILLMENT_HOLD' &&
        ['QUEUED', 'UNKNOWN'].includes(j.state),
    )) {
      job.state = 'DONE';
      job.claimedAt = undefined;
      job.error = undefined;
      job.retryable = false;
      resolveNotification(w, 'job:' + job.id);
    }
  if (extra?.holdReleased || (previousDelivery === 'On hold' && o.delivery !== 'On hold'))
    for (const job of w.jobs.filter(
      (j) =>
        j.orderId === o.id &&
        j.kind === 'FULFILLMENT_RELEASE' &&
        ['QUEUED', 'UNKNOWN'].includes(j.state),
    )) {
      job.state = 'DONE';
      job.claimedAt = undefined;
      job.error = undefined;
      job.retryable = false;
      resolveNotification(w, 'job:' + job.id);
    }

  if (
    !old &&
    cod &&
    o.status === 'PENDING' &&
    o.delivery === 'Unfulfilled' &&
    sync.autoHoldUnconfirmed &&
    hasShopifyScope(w.integration, 'write_merchant_managed_fulfillment_orders')
  ) {
    enqueue(w, o, 'FULFILLMENT_HOLD');
  }

  if (!old) {
    w.orders.unshift(o);
    activity(
      w,
      `${recovered ? 'Recovered' : 'Received'} Shopify ${cod ? 'COD' : 'non-COD'} order ${o.number}`,
    );
  }
  planOrderMessage(s, o, recovered);
  planDispatchNotification(s, o, recovered);
  return o;
}
