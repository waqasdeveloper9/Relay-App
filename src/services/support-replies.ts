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
const orderWindowMs = 30 * 24 * 60 * 60 * 1000;
const prefix = 'SUPPORT_REPLY:';
type Intent = 'status' | 'tracking' | 'delivery' | 'refund_policy' | 'policy' | 'clarify';

export const isSupportReply = (kind: string): boolean => kind.startsWith(prefix);
export const isPolicyIntent = (intent?: string): boolean =>
  intent === 'delivery' || intent === 'refund_policy' || intent === 'policy';

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

const shopPolicyLabels: Record<string, string> = {
  SHIPPING_POLICY: 'Shipping policy',
  REFUND_POLICY: 'Return & refund policy',
  PRIVACY_POLICY: 'Privacy policy',
  TERMS_OF_SERVICE: 'Terms of service',
  TERMS_OF_SALE: 'Terms of sale',
  CONTACT_INFORMATION: 'Contact information',
  LEGAL_NOTICE: 'Legal notice',
  SUBSCRIPTION_POLICY: 'Subscription policy',
};

export function policySummary(html?: string | null, max = 500): string {
  if (!html) return '';
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);|&apos;/gi, "'")
    .replace(/&ndash;/gi, '–')
    .replace(/&mdash;/gi, '—')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isInteger(code) && code >= 32 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    })
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number(n);
      return Number.isInteger(code) && code >= 32 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const boundary = cut.lastIndexOf(' ');
  return (boundary > max * 0.5 ? cut.slice(0, boundary) : cut).trimEnd() + '…';
}

export function queueSupportReply(
  store: Store,
  input: { from: string; body: string; timestamp?: string; quotedId?: string },
  now = Date.now(),
): boolean {
  const { from, body, timestamp, quotedId } = input;
  const received = timestamp !== undefined ? Number(timestamp) * 1000 : now;
  if (
    !Number.isFinite(received) ||
    received <= now - windowMs ||
    received > now + 60_000 ||
    !/^\d{10,15}$/.test(from) ||
    !canReply(store, from)
  )
    return false;
  const w = store.workspace;
  if (humanHandling(w, from)) return false;
  const question = body.toLowerCase();
  const asksPolicyTerm = /\bpolic(?:y|ies)\b/.test(question);
  const hasActionOrIssue =
    /\b(wrong|damag\w*|broken|missing|defective|leaking|complaint|human|agent|staff|representative)\b/.test(
      question,
    ) ||
    /\b(cancel|refund|return|exchange|change|edit|replace)\s+(?:my|the|this|an|order|item|parcel|address|phone|number)\b/.test(
      question,
    ) ||
    /\b(want|need|like)\s+to\s+(?:cancel|refund|return|exchange|change|replace)\b/.test(question) ||
    (!asksPolicyTerm && /\b(cancel|refund|return|exchange|change|edit|replace)\b/.test(question));
  if (hasActionOrIssue) return false;

  let intent: Intent;
  if (
    (/\b(delivery|deliver|arrive|shipping|ship)\b/.test(question) &&
      /\b(how (?:many|long)|time|days|when|polic(?:y|ies)|charge|charges|fee|cost|cod|cash on delivery|estimate)\b/.test(
        question,
      )) ||
    /\b(?:shipping|delivery)\s+polic(?:y|ies)\b/.test(question)
  )
    intent = 'delivery';
  else if (
    asksPolicyTerm &&
    /\b(return|refund|exchange|cancel(?:lation)?|money\s*back)\b/.test(question)
  )
    intent = 'refund_policy';
  else if (/\b(track(?:ing)?|courier|tracking number)\b/.test(question)) intent = 'tracking';
  else if (
    /\b(where\s+(?:is|are).*(?:order|parcel|package)|order\s+status|status\b.*\border|has\s+(?:my\s+)?order\s+shipped|has\s+it\s+shipped)\b/.test(
      question,
    )
  )
    intent = 'status';
  else if (
    asksPolicyTerm ||
    /\b(?:terms\s+(?:of\s+service|and\s+conditions|&\s*conditions)|privacy\s+polic(?:y|ies)|store\s+hours|support\s+hours|faqs?)\b/.test(
      question,
    )
  )
    intent = 'policy';
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

  const policyIntent = isPolicyIntent(intent);
  if (policyIntent ? !w.settings.faqs : !w.settings.tracking) return false;

  const orders = w.orders.filter((o) => o.phone === from && !o.archivedAt);
  const allSent = (w.outboundMessages ?? []).filter(
    (m) =>
      m.recipient === from &&
      m.messageId &&
      ['ACCEPTED', 'SENT', 'DELIVERED', 'READ'].includes(m.status),
  );
  const orderSent = allSent.filter(
    (m) => m.orderId && ['CONFIRMATION', 'REMINDER', 'TEST_CONFIRMATION'].includes(m.kind),
  );
  const quoted = (policyIntent ? allSent : orderSent).find((m) => m.messageId === quotedId);
  if (quotedId && !quoted) return false;

  const active = orders.filter((o) =>
    orderSent.some(
      (m) => m.orderId === o.id && (m === quoted || Date.parse(m.createdAt) > now - orderWindowMs),
    ),
  );
  if (!policyIntent && !active.length) return false;

  const mentioned = [...question.matchAll(/#([a-z0-9-]+)|\border\s+([0-9][a-z0-9-]*)\b/g)].map(
    (match) => match[1] ?? match[2],
  );
  if (!mentioned.length && /^\s*#?[0-9][a-z0-9-]*\s*$/.test(question))
    mentioned.push(question.trim().replace(/^#/, ''));
  const explicit = orders.find((o) => mentioned.includes(o.number.replace(/^#/, '').toLowerCase()));
  const contextOrder = active.find((o) => o.id === quoted?.orderId);
  const order = mentioned.length
    ? mentioned.length === 1 && (!quoted || !contextOrder || contextOrder.id === explicit?.id)
      ? explicit
      : undefined
    : (contextOrder ?? (active.length === 1 ? active[0] : undefined));
  if (!order && !policyIntent) intent = 'clarify';

  const conversation = customerConversation(w, from);
  conversation.human = false;
  const messageId = randomUUID();
  conversation.messages.push({
    id: messageId,
    direction: 'in',
    text: body,
    createdAt: new Date(Math.min(received, now)).toISOString(),
  });
  conversation.unread = true;
  w.jobs.push({
    id: randomUUID(),
    orderId: policyIntent ? order?.id : (order ?? active[0]!).id,
    kind: `${prefix}${intent}:${messageId}:${w.integration.phoneNumberId}`,
    state: 'QUEUED',
    attempts: 0,
    dueAt: new Date(now).toISOString(),
  });
  return true;
}

export function supportReplyContext(store: Store, job: Job, order: Order | undefined) {
  const [, intent, messageId, sender] = job.kind.split(':');
  const policyIntent = isPolicyIntent(intent);
  const conversation =
    store.workspace.conversations.find(
      (c) => !c.orderId && c.messages.some((m) => m.id === messageId && m.direction === 'in'),
    ) ??
    (order
      ? store.workspace.conversations.find((c) => c.phone === order.phone && !c.orderId)
      : undefined);
  const phone = conversation?.phone ?? order?.phone ?? '';
  const inbound = conversation?.messages.find((m) => m.id === messageId && m.direction === 'in');
  if (
    sender !== store.workspace.integration.phoneNumberId ||
    (policyIntent ? !store.workspace.settings.faqs : !store.workspace.settings.tracking) ||
    (!policyIntent && (!order || order.archivedAt)) ||
    (policyIntent && order?.archivedAt) ||
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

const policiesResult = z.object({
  shop: z.object({
    shopPolicies: z.array(
      z.object({
        type: z.string(),
        title: z.string().nullish(),
        url: z.string().nullish(),
        body: z.string().nullish(),
      }),
    ),
  }),
});

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

async function fetchShopPolicies(store: Store) {
  if (!store.workspace.integration.shopifyToken || !store.workspace.integration.shopDomain)
    return [];
  const integration = await freshShopifyIntegration(store.merchant.id);
  const result = policiesResult.parse(
    await shopifyGraphql(integration, '{shop{shopPolicies{type title url body}}}'),
  );
  return result.shop.shopPolicies;
}

export async function supportReplyText(
  store: Store,
  intent?: string,
  order?: Order,
): Promise<string> {
  if (intent === 'clarify')
    return 'Which order can we help with? Please reply with the order number from your confirmation.';

  if (isPolicyIntent(intent)) {
    const policies = await fetchShopPolicies(store);
    const storePolicy = store.workspace.settings.policy.trim();

    if (intent === 'delivery') {
      const shipping = policies.find((p) => p.type === 'SHIPPING_POLICY');
      const summary = policySummary(shipping?.body, 550);
      const link = shipping?.url?.startsWith('https://') ? shipping.url : '';
      if (summary && link) return `Shipping policy:\n${summary}\n\nFull details: ${link}`;
      if (link) return `For delivery estimates, please see our shipping policy: ${link}`;
      if (summary) return `Shipping policy:\n${summary}`;
      if (storePolicy) return storePolicy;
      throw new ProviderError(
        'No published Shopify shipping policy or saved store policy is available for this reply',
      );
    }

    if (intent === 'refund_policy') {
      const refund = policies.find((p) => p.type === 'REFUND_POLICY');
      const summary = policySummary(refund?.body, 550);
      const link = refund?.url?.startsWith('https://') ? refund.url : '';
      if (summary && link) return `Return & refund policy:\n${summary}\n\nFull details: ${link}`;
      if (link) return `For returns and refunds, please see our policy: ${link}`;
      if (summary) return `Return & refund policy:\n${summary}`;
      if (storePolicy) return storePolicy;
      throw new ProviderError(
        'No published Shopify refund policy or saved store policy is available for this reply',
      );
    }

    const lines: string[] = [];
    for (const p of policies) {
      const label = shopPolicyLabels[p.type] ?? p.title?.trim() ?? p.type.replaceAll('_', ' ');
      const link = p.url?.startsWith('https://') ? p.url : '';
      const summary = policySummary(p.body, 260);
      if (link) lines.push(`- ${label}: ${link}`);
      else if (summary) lines.push(`- ${label}: ${summary}`);
    }
    if (lines.length) {
      const parts = ['Here are our store policies:', lines.join('\n')];
      if (storePolicy) parts.push(storePolicy);
      parts.push('Reply with "shipping policy" or "return policy" for specific details.');
      return parts.join('\n\n').slice(0, 3500);
    }
    if (storePolicy) return storePolicy.slice(0, 3500);
    throw new ProviderError(
      'No published Shopify policies or saved store policy are available for this reply',
    );
  }

  if (!order)
    throw new ProviderError('An associated order is required for status and tracking replies');
  const integration = await freshShopifyIntegration(store.merchant.id);
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
