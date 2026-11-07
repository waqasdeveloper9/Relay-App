import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import type { Job, Order, Store, Workspace } from '../models/types.js';
import { canSend, customerConversation } from './automation.js';
import { orderTestAllowed } from './order-test.js';
import { metaWebhookReady } from './meta-webhook-settings.js';
import { ProviderError, shopifyGraphql } from './providers.js';
import { freshShopifyIntegration } from './shopify-tokens.js';

const windowMs = 24 * 60 * 60 * 1000;
const prefix = 'SUPPORT_REPLY:';
type Intent = 'status' | 'tracking' | 'delivery' | 'clarify';

export const isSupportReply = (kind: string): boolean => kind.startsWith(prefix);

function canReply(store: Store, phone: string): boolean {
  return (
    !config.demo &&
    metaWebhookReady(store) &&
    ((config.outbound && canSend(store)) || orderTestAllowed(store, phone))
  );
}

function humanHandling(w: Workspace, phone: string): boolean {
  return w.conversations.some(
    (c) =>
      c.human &&
      (c.phone === phone || w.orders.some((o) => o.id === c.orderId && o.phone === phone)),
  );
}

export function queueSupportReply(
  store: Store,
  input: { from: string; body: string; timestamp?: string; quotedId?: string },
  now = Date.now(),
): boolean {
  const { from, body, timestamp, quotedId } = input;
  const received = Number(timestamp) * 1000;
  if (
    !Number.isFinite(received) ||
    received <= now - windowMs ||
    received > now ||
    !/^\d{10,15}$/.test(from) ||
    !canReply(store, from)
  )
    return false;
  const w = store.workspace;
  if (humanHandling(w, from)) return false;
  const question = body.toLowerCase();
  if (/\b(cancel|refund|return|change|edit|wrong|replace)\b/.test(question)) return false;
  let intent: Intent;
  if (
    /\b(delivery|deliver|arrive|shipping|ship)\b/.test(question) &&
    /\b(how (?:many|long)|time|days|when)\b/.test(question)
  )
    intent = 'delivery';
  else if (/\b(track(?:ing)?|courier|tracking number)\b/.test(question)) intent = 'tracking';
  else if (
    /\b(where.*order|order status|status.*order|has.*shipped|where.*package)\b/.test(question)
  )
    intent = 'status';
  else if (
    /^\s*#?[0-9][a-z0-9-]*\s*$/.test(question) &&
    w.jobs.some(
      (j) =>
        j.kind.startsWith(prefix + 'clarify:') &&
        j.state === 'DONE' &&
        w.orders.some((o) => o.id === j.orderId && o.phone === from) &&
        Date.parse(j.dueAt) > now - windowMs,
    )
  )
    intent = 'status';
  else return false;

  const orders = w.orders.filter((o) => o.phone === from && !o.archivedAt);
  const sent = (w.outboundMessages ?? []).filter(
    (m) =>
      m.recipient === from &&
      m.orderId &&
      m.messageId &&
      ['CONFIRMATION', 'REMINDER', 'TEST_CONFIRMATION'].includes(m.kind) &&
      ['ACCEPTED', 'SENT', 'DELIVERED', 'READ'].includes(m.status),
  );
  const quoted = sent.find((m) => m.messageId === quotedId);
  const active = orders.filter((o) =>
    sent.some(
      (m) => m.orderId === o.id && (m === quoted || Date.parse(m.createdAt) > now - windowMs),
    ),
  );
  if (!active.length || (quotedId && !quoted)) return false;
  const mentioned = [...question.matchAll(/#([a-z0-9-]+)|\border\s+([0-9][a-z0-9-]*)\b/g)].map(
    (match) => match[1] ?? match[2],
  );
  if (!mentioned.length && /^\s*#?[0-9][a-z0-9-]*\s*$/.test(question))
    mentioned.push(question.trim().replace(/^#/, ''));
  const explicit = orders.find((o) => mentioned.includes(o.number.replace(/^#/, '').toLowerCase()));
  const contextOrder = active.find((o) => o.id === quoted?.orderId);
  const order = mentioned.length
    ? mentioned.length === 1 && (!quoted || contextOrder?.id === explicit?.id)
      ? explicit
      : undefined
    : (contextOrder ?? (active.length === 1 ? active[0] : undefined));
  if (!order && intent !== 'delivery') intent = 'clarify';

  if (intent === 'delivery' ? !w.settings.faqs : !w.settings.tracking) return false;
  const conversation = customerConversation(w, from);
  conversation.human = false;
  const messageId = randomUUID();
  conversation.messages.push({
    id: messageId,
    direction: 'in',
    text: body,
    createdAt: new Date(received).toISOString(),
  });
  conversation.unread = true;
  w.jobs.push({
    id: randomUUID(),
    orderId: (order ?? active[0]!).id,
    kind: `${prefix}${intent}:${messageId}:${w.integration.phoneNumberId}`,
    state: 'QUEUED',
    attempts: 0,
    dueAt: new Date(now).toISOString(),
  });
  return true;
}

export function supportReplyContext(store: Store, job: Job, order: Order | undefined) {
  const [, intent, messageId, sender] = job.kind.split(':');
  const phone = order?.phone;
  const conversation = store.workspace.conversations.find((c) => c.phone === phone && !c.orderId);
  const inbound = conversation?.messages.find((m) => m.id === messageId && m.direction === 'in');
  if (
    sender !== store.workspace.integration.phoneNumberId ||
    (intent === 'delivery' ? !store.workspace.settings.faqs : !store.workspace.settings.tracking) ||
    !order ||
    order.archivedAt ||
    !phone ||
    !inbound ||
    !canReply(store, phone) ||
    humanHandling(store.workspace, phone) ||
    Date.parse(inbound.createdAt) <= Date.now() - windowMs
  )
    throw new ProviderError(
      'Support reply blocked by the customer reply window, sender authorization, or human takeover',
    );
  return { intent, phone, conversationId: conversation!.id };
}

const orderResult = z.object({
  order: z
    .object({
      cancelledAt: z.string().nullable(),
      displayFulfillmentStatus: z.string(),
      fulfillments: z.array(
        z.object({
          status: z.string(),
          trackingInfo: z.array(
            z.object({ url: z.string().nullable(), number: z.string().nullable() }),
          ),
        }),
      ),
    })
    .nullable(),
});

export async function supportReplyText(
  merchantId: string,
  order: Order,
  intent?: string,
): Promise<string> {
  if (intent === 'clarify')
    return 'Which order can we help with? Please reply with the order number from your confirmation.';
  const integration = await freshShopifyIntegration(merchantId);
  if (intent === 'delivery') {
    const result = z
      .object({
        shop: z.object({
          shopPolicies: z.array(z.object({ type: z.string(), url: z.string().url() })),
        }),
      })
      .parse(await shopifyGraphql(integration, '{shop{shopPolicies{type url}}}'));
    const url = result.shop.shopPolicies.find((policy) => policy.type === 'SHIPPING_POLICY')?.url;
    if (!url || !url.startsWith('https://'))
      throw new ProviderError('No published Shopify shipping policy is available for this reply');
    return `For delivery estimates, please see our shipping policy: ${url}`;
  }
  const { order: current } = orderResult.parse(
    await shopifyGraphql(
      integration,
      'query SupportOrder($id:ID!){order(id:$id){cancelledAt displayFulfillmentStatus fulfillments(first:10){status trackingInfo(first:5){url number}}}}',
      { id: 'gid://shopify/Order/' + order.shopifyOrderId },
    ),
  );
  if (!current) throw new ProviderError('Shopify could not find the order for this support reply');
  if (current.cancelledAt) return `Order ${order.number} has been cancelled.`;
  const tracking = current.fulfillments
    .filter((f) => f.status === 'SUCCESS')
    .flatMap((f) => f.trackingInfo)
    .map((info) => (info.url?.startsWith('https://') ? info.url : info.number))
    .filter(Boolean);
  const status = current.displayFulfillmentStatus;
  const summary =
    status === 'FULFILLED'
      ? 'has been fulfilled'
      : status === 'PARTIALLY_FULFILLED'
        ? 'has been partially fulfilled'
        : status === 'UNFULFILLED'
          ? 'has not been fulfilled yet'
          : `has fulfillment status: ${status.toLowerCase().replaceAll('_', ' ')}`;
  return (
    `Order ${order.number} ${summary}.` +
    (tracking.length
      ? ` Tracking: ${[...new Set(tracking)].slice(0, 3).join(', ')}`
      : intent === 'tracking'
        ? ' Tracking is not available yet.'
        : '')
  );
}
