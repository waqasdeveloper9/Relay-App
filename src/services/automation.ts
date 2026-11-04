import { randomUUID } from 'node:crypto';
import type { Conversation, Job, Order, Store, Workspace } from '../models/types.js';
import { reliability } from './reliability-settings.js';
import { notify } from './notifications.js';
import { InputError } from '../utils/errors.js';

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
export function enqueue(w: Workspace, order: Order, kind: Job['kind'], delay = 0): void {
  if (w.jobs.some((j) => j.orderId === order.id && j.kind === kind)) return;
  w.jobs.push({
    id: randomUUID(),
    orderId: order.id,
    kind,
    state: 'QUEUED',
    attempts: 0,
    dueAt: new Date(Date.now() + delay).toISOString(),
  });
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
  enqueue(w, order, 'TAG');
  activity(w, `${order.name} confirmed order ${order.number}`);
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
      'Customer confirmed. Shopify COD-CONFIRMED tag synchronization queued. No payment or fulfillment performed.',
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
