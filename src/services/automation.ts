import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type {
  Conversation,
  Job,
  Order,
  OrderActionPayload,
  ShopifyOrderAction,
  Store,
  Workspace,
} from '../models/types.js';
import { reliability } from './reliability-settings.js';
import { notify } from './notifications.js';
import { InputError } from '../utils/errors.js';
import { hasShopifyScope, shopifySyncSettings } from '../models/workspace-defaults.js';

export function activity(w: Workspace, text: string): void {
  w.activity.unshift({ id: randomUUID(), text, createdAt: new Date().toISOString() });
  w.activity = w.activity.slice(0, 100);
}
export function canSend(store: Store): boolean {
  return (
    store.merchant.subscriptionStatus === 'ACTIVE' ||
    (store.merchant.subscriptionStatus === 'TRIALING' &&
      Date.parse(store.merchant.trialEndsAt) > Date.now())
  );
}
export function enqueue(
  w: Workspace,
  order: Order,
  kind: Job['kind'],
  delay = 0,
  payload?: OrderActionPayload,
): void {
  if (w.jobs.some((j) => j.orderId === order.id && j.kind === kind)) return;
  w.jobs.push({
    id: randomUUID(),
    orderId: order.id,
    kind,
    state: 'QUEUED',
    attempts: 0,
    dueAt: new Date(Date.now() + delay).toISOString(),
    ...(payload ? { payload } : {}),
  });
}

type RequeueableJobKind =
  | 'TAG'
  | 'REVIEW_TAG'
  | 'FULFILLMENT_HOLD'
  | 'FULFILLMENT_RELEASE'
  | 'MARK_PAID'
  | 'MARK_IN_PROGRESS'
  | 'MARK_OPEN'
  | 'FULFILL_ORDER'
  | 'UPDATE_TRACKING'
  | 'MARK_DELIVERED';

// Re-queue completed/failed Shopify state-sync jobs across reversible order lifecycle transitions
// (e.g. unconfirmed hold -> confirmed release -> post-confirm cancel re-hold) without violating
// the unique (merchantId, orderId, kind) DB constraint or ever re-queuing messaging/UNKNOWN jobs.
export function requeue(
  w: Workspace,
  order: Order,
  kind: RequeueableJobKind,
  delay = 0,
  payload?: OrderActionPayload,
): void {
  const existing = w.jobs.find((j) => j.orderId === order.id && j.kind === kind);
  if (!existing) {
    enqueue(w, order, kind, delay, payload);
    return;
  }
  if (existing.state === 'DONE' || existing.state === 'FAILED') {
    existing.state = 'QUEUED';
    existing.attempts = 0;
    existing.error = undefined;
    existing.claimedAt = undefined;
    existing.retryable = false;
    existing.dueAt = new Date(Date.now() + delay).toISOString();
    existing.payload = payload;
  }
}

const actionToJobKind: Record<ShopifyOrderAction, RequeueableJobKind> = {
  mark_paid: 'MARK_PAID',
  mark_in_progress: 'MARK_IN_PROGRESS',
  reopen: 'MARK_OPEN',
  hold: 'FULFILLMENT_HOLD',
  release_hold: 'FULFILLMENT_RELEASE',
  fulfill: 'FULFILL_ORDER',
  update_tracking: 'UPDATE_TRACKING',
  mark_delivered: 'MARK_DELIVERED',
};

export function checkShopifyActionEligibility(
  w: Workspace,
  order: Order,
  action: ShopifyOrderAction,
  payload?: OrderActionPayload,
): void {
  if (order.archivedAt) throw new InputError('Restore this removed order before updating Shopify');
  if (order.status === 'CANCELLED')
    throw new InputError('Cancelled orders cannot run payment or fulfillment actions');

  const kind = actionToJobKind[action];
  if (
    w.jobs.some(
      (j) => j.orderId === order.id && j.kind === kind && ['QUEUED', 'UNKNOWN'].includes(j.state),
    )
  ) {
    throw new InputError(
      'This Shopify action is already queued or awaiting confirmation for this order.',
    );
  }

  const fin = (order.financialStatus ?? 'pending').toLowerCase();
  if (action === 'mark_paid') {
    if (fin === 'paid') throw new InputError('This order is already marked paid');
    if (!['pending', 'authorized', 'partially_paid'].includes(fin))
      throw new InputError('Only payment-pending or partially paid orders can be marked paid');
    if (!config.demo && !hasShopifyScope(w.integration, 'write_orders'))
      throw new InputError('Shopify write_orders permission is required to mark orders paid');
    return;
  }

  if (action === 'mark_in_progress') {
    if (order.delivery === 'On hold')
      throw new InputError('Release the fulfillment hold before marking this order in progress');
    if (!['Unfulfilled', 'Scheduled'].includes(order.delivery))
      throw new InputError('Only Unfulfilled or Scheduled orders can be marked In progress');
    if (
      !config.demo &&
      !hasShopifyScope(w.integration, 'write_merchant_managed_fulfillment_orders')
    )
      throw new InputError(
        'Shopify fulfillment-order permission is missing. Enable fulfillment scopes and reconnect Shopify in Integrations.',
      );
    return;
  }

  if (action === 'reopen') {
    if (!['In progress', 'Scheduled'].includes(order.delivery))
      throw new InputError('Only In progress or Scheduled orders can be reopened to Unfulfilled');
    if (
      !config.demo &&
      !hasShopifyScope(w.integration, 'write_merchant_managed_fulfillment_orders')
    )
      throw new InputError(
        'Shopify fulfillment-order permission is missing. Enable fulfillment scopes and reconnect Shopify in Integrations.',
      );
    return;
  }

  if (action === 'hold') {
    if (!['Unfulfilled', 'In progress', 'Scheduled'].includes(order.delivery))
      throw new InputError(
        'Only Unfulfilled, In progress, or Scheduled orders can be placed on hold',
      );
    if (
      !config.demo &&
      !hasShopifyScope(w.integration, 'write_merchant_managed_fulfillment_orders')
    )
      throw new InputError(
        'Shopify fulfillment-order permission is missing. Enable fulfillment scopes and reconnect Shopify in Integrations.',
      );
    return;
  }

  if (action === 'release_hold') {
    if (order.delivery !== 'On hold') throw new InputError('This order is not currently on hold');
    if (
      !config.demo &&
      !hasShopifyScope(w.integration, 'write_merchant_managed_fulfillment_orders')
    )
      throw new InputError(
        'Shopify fulfillment-order permission is missing. Enable fulfillment scopes and reconnect Shopify in Integrations.',
      );
    return;
  }

  if (action === 'fulfill') {
    if (order.delivery === 'On hold')
      throw new InputError('Release the fulfillment hold before fulfilling this order');
    if (
      !['Unfulfilled', 'In progress', 'Scheduled', 'Partially fulfilled'].includes(order.delivery)
    )
      throw new InputError('No unfulfilled items remain on this order');
    if (
      !config.demo &&
      (!hasShopifyScope(w.integration, 'write_fulfillments') ||
        !hasShopifyScope(w.integration, 'read_merchant_managed_fulfillment_orders'))
    )
      throw new InputError(
        'Shopify fulfillment write permissions are missing. Enable fulfillment scopes and reconnect Shopify in Integrations.',
      );
    return;
  }

  if (action === 'update_tracking') {
    if (!['In transit', 'Partially fulfilled', 'Delivered'].includes(order.delivery))
      throw new InputError('Fulfill the order before updating tracking details');
    if (!payload?.trackingCompany && !payload?.trackingNumber && !payload?.trackingUrl)
      throw new InputError('Enter a courier, tracking number, or tracking URL');
    if (!config.demo && !hasShopifyScope(w.integration, 'write_fulfillments'))
      throw new InputError(
        'Shopify write_fulfillments permission is missing. Enable fulfillment scopes and reconnect Shopify in Integrations.',
      );
    return;
  }

  if (action === 'mark_delivered') {
    if (
      !['Unfulfilled', 'In progress', 'Scheduled', 'In transit', 'Partially fulfilled'].includes(
        order.delivery,
      )
    )
      throw new InputError('Only active or unfulfilled orders can be marked Delivered');
    if (!config.demo && !hasShopifyScope(w.integration, 'write_fulfillments'))
      throw new InputError(
        'Shopify write_fulfillments permission is missing. Enable fulfillment scopes and reconnect Shopify in Integrations.',
      );
  }
}

export function queueShopifyOrderAction(
  w: Workspace,
  order: Order,
  action: ShopifyOrderAction,
  payload?: OrderActionPayload,
): { jobKind: RequeueableJobKind; message: string } {
  checkShopifyActionEligibility(w, order, action, payload);
  const kind = actionToJobKind[action];
  const cleanPayload: OrderActionPayload | undefined = payload
    ? {
        ...(payload.trackingCompany?.trim()
          ? { trackingCompany: payload.trackingCompany.trim() }
          : {}),
        ...(payload.trackingNumber?.trim()
          ? { trackingNumber: payload.trackingNumber.trim() }
          : {}),
        ...(payload.trackingUrl?.trim() ? { trackingUrl: payload.trackingUrl.trim() } : {}),
        ...(payload.notifyCustomer !== undefined ? { notifyCustomer: payload.notifyCustomer } : {}),
        ...(payload.reasonNotes?.trim() ? { reasonNotes: payload.reasonNotes.trim() } : {}),
      }
    : undefined;
  requeue(
    w,
    order,
    kind,
    0,
    cleanPayload && Object.keys(cleanPayload).length ? cleanPayload : undefined,
  );
  const labels: Record<ShopifyOrderAction, string> = {
    mark_paid: 'Mark paid',
    mark_in_progress: 'Mark in progress',
    reopen: 'Reopen fulfillment',
    hold: 'Place fulfillment hold',
    release_hold: 'Release Relay fulfillment hold',
    fulfill: 'Fulfill order',
    update_tracking: 'Update fulfillment tracking',
    mark_delivered: 'Mark delivered',
  };
  activity(w, `Queued Shopify ${labels[action]} for ${order.number}`);
  return {
    jobKind: kind,
    message: `${labels[action]} queued for ${order.number} in Shopify.`,
  };
}
export function conversation(w: Workspace, order: Order): Conversation {
  let c = w.conversations.find((c) => c.orderId === order.id);
  if (!c) {
    c = { id: randomUUID(), orderId: order.id, human: false, unread: false, messages: [] };
    w.conversations.unshift(c);
  }
  return c;
}
export function append(c: Conversation, direction: 'in' | 'out' | 'note', text: string): void {
  c.messages.push({ id: randomUUID(), direction, text, createdAt: new Date().toISOString() });
}
export function confirm(w: Workspace, order: Order): void {
  if (order.archivedAt) throw new InputError('Restore this removed order before confirming it');
  if (order.status === 'CANCELLED') throw new InputError('A cancelled order cannot be confirmed');
  if (
    w.tasks.some(
      (t) => t.orderId === order.id && t.kind === 'Cancellation' && t.status !== 'VERIFIED',
    )
  )
    throw new InputError('Resolve the cancellation request before confirming this order');
  if (order.status === 'CONFIRMED') return;
  order.status = 'CONFIRMED';
  requeue(w, order, 'TAG');
  if (
    shopifySyncSettings(w).releaseHoldOnConfirm &&
    hasShopifyScope(w.integration, 'write_merchant_managed_fulfillment_orders')
  )
    requeue(w, order, 'FULFILLMENT_RELEASE');
  activity(w, `${order.name} confirmed order ${order.number}`);
}

export function markForReview(w: Workspace, order: Order, reason = 'moved to review'): void {
  if (order.archivedAt) throw new InputError('Restore this removed order before updating it');
  if (order.status === 'CANCELLED')
    throw new InputError('A cancelled order cannot be moved to review');
  order.status = 'NEEDS_REVIEW';
  const sync = shopifySyncSettings(w);
  if (sync.tagOnReview) requeue(w, order, 'REVIEW_TAG');
  if (
    sync.holdOnReview &&
    hasShopifyScope(w.integration, 'write_merchant_managed_fulfillment_orders')
  )
    requeue(w, order, 'FULFILLMENT_HOLD');
  activity(w, `${order.number} ${reason}`);
}

export function handleOrderDecision(
  w: Workspace,
  order: Order,
  action: 'CONFIRM' | 'CANCEL',
): void {
  const c = conversation(w, order);
  append(c, 'in', action === 'CONFIRM' ? 'Confirm order' : 'Cancel order');
  c.unread = true;
  if (!order.archivedAt && order.status === 'CONFIRMED' && action === 'CANCEL') {
    order.status = 'NEEDS_REVIEW';
    c.human = true;
    if (
      !w.tasks.some(
        (t) => t.orderId === order.id && t.kind === 'Cancellation' && t.status !== 'VERIFIED',
      )
    ) {
      w.tasks.unshift({
        id: randomUUID(),
        orderId: order.id,
        kind: 'Cancellation',
        detail:
          'Customer requested cancellation after confirming. Review the current Shopify payment, fulfillment, and dispatch state before cancelling. Shopify has not been cancelled.',
        status: 'OPEN',
        createdAt: new Date().toISOString(),
      });
    }
    enqueue(w, order, 'CANCEL_TAGS');
    const sync = shopifySyncSettings(w);
    if (
      sync.holdOnCancellationRequest &&
      hasShopifyScope(w.integration, 'write_merchant_managed_fulfillment_orders')
    )
      requeue(w, order, 'FULFILLMENT_HOLD');
    notify(
      w,
      'decision:' + order.id,
      'Cancellation requested after confirmation',
      'Customer changed their decision. The order now requires review; Shopify cancellation is pending review; confirmation tag removal is queued.',
      'Review the cancellation request before dispatch.',
      'warning',
    );
    activity(
      w,
      `Cancellation requested after confirmation for ${order.number}; merchant review required.`,
    );
    append(
      c,
      'note',
      'Cancellation requested after confirmation. Order moved to Needs review and assigned to a human. Shopify has not been cancelled.',
    );
    return;
  }
  if (
    !!order.archivedAt ||
    c.human ||
    order.status !== 'PENDING' ||
    Date.parse(
      order.confirmationExpiresAt ??
        new Date(
          Date.parse(order.createdAt) + reliability(w).maxMessageAgeHours * 3600000,
        ).toISOString(),
    ) < Date.now()
  ) {
    notify(
      w,
      'decision:' + order.id,
      'Customer decision requires review',
      'The confirmation expired, an earlier decision exists, or human handling is active.',
      'Review the order before making another change.',
      'warning',
    );
    append(
      c,
      'note',
      'Duplicate, conflicting, or late decision requires review; no new Shopify action queued.',
    );
    return;
  }
  if (action === 'CONFIRM') {
    confirm(w, order);
    append(
      c,
      'note',
      `Customer confirmed. Shopify ${shopifySyncSettings(w).confirmedTag} tag synchronization queued. No payment or fulfillment performed.`,
    );
  } else {
    order.status = 'NEEDS_REVIEW';
    w.tasks.unshift({
      id: randomUUID(),
      orderId: order.id,
      kind: 'Cancellation',
      detail:
        'Customer selected Cancel order. Shopify cancellation queued; completion is not yet confirmed.',
      status: 'APPROVED',
      createdAt: new Date().toISOString(),
    });
    enqueue(w, order, 'CANCEL');
    activity(w, `Cancellation queued for ${order.number}; awaiting Shopify completion.`);
    append(c, 'note', 'Cancellation pending Shopify completion.');
  }
}
export function handleIncoming(
  w: Workspace,
  order: Order,
  text: string,
  demo: boolean,
): string | undefined {
  const c = conversation(w, order);
  append(c, 'in', text);
  c.unread = true;
  if (c.human) return;
  const normalized = text.trim().toLowerCase();
  let reply: string;
  if (/^(confirm|yes|confirm order|yes, please confirm my order\.)$/.test(normalized)) {
    if (order.status === 'CANCELLED')
      reply = 'This order is cancelled. Our team can help you place a new order.';
    else {
      confirm(w, order);
      reply = `Thank you. Order ${order.number} is confirmed. Our team will prepare it for dispatch.`;
    }
  } else if (/cancel|address|change|human|agent|team|damag|complaint/.test(normalized)) {
    const kind = /cancel/.test(normalized)
      ? 'Cancellation'
      : /address|change/.test(normalized)
        ? 'Address change'
        : 'Customer support';
    if (
      !w.tasks.some((t) => t.orderId === order.id && t.kind === kind && t.status !== 'VERIFIED')
    ) {
      w.tasks.unshift({
        id: randomUUID(),
        orderId: order.id,
        kind,
        detail: text,
        status: 'OPEN',
        createdAt: new Date().toISOString(),
      });
    }
    if (order.status !== 'CANCELLED') order.status = 'NEEDS_REVIEW';
    c.human = true;
    reply =
      'Your request has been recorded for our team. Your order has not been changed yet. A team member will follow up here.';
    activity(w, `${kind} requested for ${order.number}`);
  } else if (w.settings.tracking && /track|where|arriv|parcel|status/.test(normalized)) {
    reply = `Order ${order.number}: ${order.delivery}.${order.trackingUrl ? ` Track your shipment: ${order.trackingUrl}` : ' A tracking link is not available yet. We cannot confirm a delivery date at this stage.'}`;
  } else if (w.settings.faqs && /policy|return|exchange|hours|delivery charge/.test(normalized)) {
    reply = w.settings.policy;
  } else {
    c.human = true;
    if (
      !w.tasks.some(
        (t) => t.orderId === order.id && t.kind === 'Customer support' && t.status !== 'VERIFIED',
      )
    )
      w.tasks.unshift({
        id: randomUUID(),
        orderId: order.id,
        kind: 'Customer support',
        detail: text,
        status: 'OPEN',
        createdAt: new Date().toISOString(),
      });
    reply = 'Thank you for your message. Our team will help you with this request.';
  }
  if (demo) append(c, 'out', reply);
  else append(c, 'note', `Suggested reply (not sent): ${reply}`);
  return reply;
}

export function customerConversation(w: Workspace, phone: string): Conversation {
  let c = w.conversations.find((c) => !c.orderId && c.phone === phone);
  if (!c) {
    c = { id: randomUUID(), phone, human: false, unread: true, messages: [] };
    w.conversations.unshift(c);
  }
  return c;
}
