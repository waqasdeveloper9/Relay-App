import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { customerThreads } from '../models/customer-conversations.js';
import type { Job, Order, Store, Workspace } from '../models/types.js';
import {
  formatSupportTemplate,
  isPhoneOptedOut,
  orderMatchesPhone,
  supportSettings,
} from '../models/workspace-defaults.js';
import { activity, append, canSend, customerConversation } from './automation.js';
import { orderTestAllowed } from './order-test.js';
import { metaWebhookReady } from './meta-webhook-settings.js';
import { notify } from './notifications.js';
import { ProviderError, type SupportMenuButton, shopifyGraphql } from './providers.js';
import { freshShopifyIntegration } from './shopify-tokens.js';

const windowMs = 24 * 60 * 60 * 1000;
const menuExplicitDebounceMs = 60 * 1000;
const prefix = 'SUPPORT_REPLY:';
type Intent =
  | 'status'
  | 'tracking'
  | 'delivery'
  | 'refund_policy'
  | 'policy'
  | 'clarify'
  | 'no_order'
  | 'menu'
  | 'handoff'
  | 'optout'
  | 'optin';

export const isSupportReply = (kind: string): boolean => kind.startsWith(prefix);
export const isPolicyIntent = (intent?: string): boolean =>
  intent === 'delivery' || intent === 'refund_policy' || intent === 'policy';
export const isMenuIntent = (intent?: string): boolean => intent === 'menu';

export function supportMenuButtons(settings: Workspace['settings']): SupportMenuButton[] {
  const sup = supportSettings({ settings });
  const buttons: SupportMenuButton[] = [];
  if (settings.tracking) buttons.push({ id: 'MENU:STATUS', title: sup.statusButtonTitle });
  if (settings.faqs) buttons.push({ id: 'MENU:POLICY', title: sup.policyButtonTitle });
  buttons.push({ id: 'MENU:HUMAN', title: sup.humanButtonTitle });
  return buttons;
}

export function menuPromptDetails(
  brandName: string,
  settings: Workspace['settings'],
): { body: string; footer: string; buttons: SupportMenuButton[]; preview: string } {
  const sup = supportSettings({ settings });
  const brand = brandName.trim() || 'our store';
  const buttons = supportMenuButtons(settings);
  const body = formatSupportTemplate(sup.menuBody, { brand_name: brand }).slice(0, 1024);
  const footer = sup.menuFooter.trim().slice(0, 60);
  const preview = `${body}\n[${buttons.map((b) => b.title).join('] [')}]`;
  return { body, footer, buttons, preview };
}

function canReply(store: Store, phone: string): boolean {
  return (
    !config.demo &&
    metaWebhookReady(store) &&
    ((config.outbound && canSend(store)) || orderTestAllowed(store, phone))
  );
}

export function humanHandling(w: Workspace, phone: string): boolean {
  return w.conversations.some(
    (c) =>
      c.human &&
      (c.phone === phone || w.orders.some((o) => o.id === c.orderId && o.phone === phone)),
  );
}

function menuSentRecently(w: Workspace, phone: string, now: number, cooldownMs: number): boolean {
  if (
    (w.outboundMessages ?? []).some(
      (m) =>
        m.recipient === phone &&
        m.kind === 'SUPPORT_MENU' &&
        m.status !== 'FAILED' &&
        Date.parse(m.createdAt) > now - cooldownMs,
    )
  )
    return true;
  return w.jobs.some((j) => {
    if (!j.kind.startsWith(prefix + 'menu:')) return false;
    const recentOrActive =
      ['QUEUED', 'UNKNOWN'].includes(j.state) ||
      (j.state === 'DONE' && Date.parse(j.dueAt) > now - cooldownMs);
    if (!recentOrActive) return false;
    const msgId = j.kind.split(':')[2];
    return w.conversations.some(
      (c) => !c.orderId && c.phone === phone && c.messages.some((m) => m.id === msgId),
    );
  });
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
    .replace(/&#(\d+);/gi, (_m, n) => {
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

export function handleOptKeyword(
  store: Store,
  input: { from: string; body: string; timestamp?: string },
  now = Date.now(),
): boolean {
  const { from, body, timestamp } = input;
  const digits = from.replace(/\D/g, '');
  if (!/^\d{10,15}$/.test(digits)) return false;
  const w = store.workspace;
  const sup = supportSettings(w);
  const normalized = body.trim().toLowerCase();
  const received = timestamp !== undefined ? Number(timestamp) * 1000 : now;
  const insideWindow =
    Number.isFinite(received) && received > now - windowMs && received <= now + 60_000;

  if (sup.optOutKeywords.includes(normalized)) {
    w.settings.support = {
      ...sup,
      optedOutPhones: [...new Set([...sup.optedOutPhones, digits])],
    };
    const matchingOrderIds = new Set(w.orders.filter((o) => o.phone === digits).map((o) => o.id));
    for (const o of w.orders) {
      if (o.phone === digits && o.status === 'PENDING') {
        o.messageBlockedReason = 'Customer opted out of automated WhatsApp messages (STOP)';
      }
    }
    for (const j of w.jobs) {
      if (
        j.state === 'QUEUED' &&
        j.orderId &&
        matchingOrderIds.has(j.orderId) &&
        [
          'CONFIRMATION',
          'REMINDER',
          'TEST_CONFIRMATION',
          'TEST_HELLO',
          'DISPATCH_NOTICE',
          'DELIVERY_NOTICE',
          'PAYMENT_NOTICE',
          'IN_PROGRESS_NOTICE',
          'ON_HOLD_NOTICE',
        ].includes(j.kind)
      ) {
        j.state = 'FAILED';
        j.retryable = false;
        j.error = 'Cancelled after customer opted out via STOP keyword';
      }
    }
    const c = customerConversation(w, digits);
    const messageId = randomUUID();
    c.messages.push({
      id: messageId,
      direction: 'in',
      text: body,
      createdAt: new Date(insideWindow ? Math.min(received, now) : now).toISOString(),
    });
    c.unread = true;
    append(
      c,
      'note',
      `Customer opted out via "${normalized}". Automated templates and bot replies are paused.`,
    );
    activity(w, `Customer ${digits} opted out of automated WhatsApp messages`);
    if (insideWindow && canReply(store, digits)) {
      w.jobs.push({
        id: randomUUID(),
        kind: `${prefix}optout:${messageId}:${w.integration.phoneNumberId}`,
        state: 'QUEUED',
        attempts: 0,
        dueAt: new Date(now).toISOString(),
      });
    }
    return true;
  }

  if (isPhoneOptedOut(w, digits) && sup.optInKeywords.includes(normalized)) {
    w.settings.support = {
      ...sup,
      optedOutPhones: sup.optedOutPhones.filter((p) => p !== digits),
    };
    for (const o of w.orders) {
      if (o.phone === digits && o.messageBlockedReason?.includes('opted out')) {
        o.messageBlockedReason = undefined;
      }
    }
    const c = customerConversation(w, digits);
    const messageId = randomUUID();
    c.messages.push({
      id: messageId,
      direction: 'in',
      text: body,
      createdAt: new Date(insideWindow ? Math.min(received, now) : now).toISOString(),
    });
    c.unread = true;
    append(
      c,
      'note',
      `Customer opted back in via "${normalized}". Automated WhatsApp notifications re-enabled.`,
    );
    activity(w, `Customer ${digits} opted back in to WhatsApp notifications`);
    if (insideWindow && canReply(store, digits)) {
      w.jobs.push({
        id: randomUUID(),
        kind: `${prefix}optin:${messageId}:${w.integration.phoneNumberId}`,
        state: 'QUEUED',
        attempts: 0,
        dueAt: new Date(now).toISOString(),
      });
    }
    return true;
  }

  return false;
}

export function queueSupportReply(
  store: Store,
  input: {
    from: string;
    body: string;
    timestamp?: string;
    quotedId?: string;
    forcedIntent?: 'status' | 'policy';
    isButton?: boolean;
  },
  now = Date.now(),
): boolean {
  const { from, body, timestamp, quotedId, forcedIntent, isButton } = input;
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
  if (isPhoneOptedOut(w, from) || humanHandling(w, from)) return false;

  const sup = supportSettings(w);
  const question = body.toLowerCase().trim();
  const asksPolicyTerm = /\bpolic(?:y|ies)\b/.test(question);

  let intent: Intent;
  if (forcedIntent) {
    intent = forcedIntent;
  } else {
    const hasActionOrIssue =
      /\b(wrong|damag\w*|broken|missing|defective|leaking|complaint|human|agent|staff|representative)\b/.test(
        question,
      ) ||
      /\b(?:talk\s+to\s+(?:a\s+)?(?:person|someone|team|support)|support\s+(?:team|agent|person))\b/.test(
        question,
      ) ||
      /\b(cancel|refund|return|exchange|change|edit|replace)\s+(?:my|the|this|an|order|item|parcel|address|phone|number)\b/.test(
        question,
      ) ||
      /\b(want|need|like)\s+to\s+(?:cancel|refund|return|exchange|change|replace)\b/.test(
        question,
      ) ||
      (!asksPolicyTerm &&
        /\b(cancel|refund|return|exchange|change|edit|replace|confirm)\b/.test(question));
    if (hasActionOrIssue) return false;

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
      /\b(where\s+(?:is|are).*(?:order|parcel|package)|order\s+(?:status|update|detail|details|info|information)|status\b.*\b(?:order|parcel)|has\s+(?:my\s+)?order\s+shipped|has\s+it\s+shipped|about\s+(?:my\s+)?order|check\s+(?:my\s+)?order|my\s+order)\b/.test(
        question,
      ) ||
      (/#\d[a-z0-9-]*/.test(question) &&
        /\b(where|status|check|about|shipped|dispatch\w*)\b/.test(question))
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
      (w.jobs.some(
        (j) =>
          j.kind.startsWith(prefix + 'clarify:') &&
          j.state === 'DONE' &&
          Date.parse(j.dueAt) > now - windowMs &&
          (w.orders.some((o) => o.id === j.orderId && orderMatchesPhone(o, from)) ||
            w.outboundMessages?.some((m) => m.jobId === j.id && m.recipient === from) ||
            w.conversations.some(
              (c) =>
                !c.orderId &&
                c.phone === from &&
                c.messages.some((m) => m.id === j.kind.split(':')[2]),
            )),
      ) ||
        w.outboundMessages?.some(
          (m) =>
            m.recipient === from &&
            m.kind === 'SUPPORT_MENU' &&
            ['ACCEPTED', 'SENT', 'DELIVERED', 'READ'].includes(m.status) &&
            Date.parse(m.createdAt) > now - windowMs,
        ))
    )
      intent = 'status';
    else {
      const isCasualAck =
        /^(?:ok|okay|k|kk|thanks|thank\s*you|thx|ty|alright|cool|great|fine|done|noted|good|ji|jee|👍|🙏|👌|❤️|😊)+[!.\s]*$/i.test(
          question,
        );
      if (!question || isCasualAck) return false;
      if (!w.settings.faqs && !w.settings.tracking) return false;
      const explicitMenuCmd = /^(?:menu|options|help)\b[!?.]*$/i.test(question);
      const cooldown = explicitMenuCmd
        ? menuExplicitDebounceMs
        : Math.max(1, sup.menuCooldownHours) * 3600_000;
      if (menuSentRecently(w, from, now, cooldown)) return false;
      intent = 'menu';
    }
  }

  const policyIntent = isPolicyIntent(intent);
  const menuIntent = isMenuIntent(intent);
  if (menuIntent) {
    if (!w.settings.faqs && !w.settings.tracking) return false;
  } else if (policyIntent) {
    if (!w.settings.faqs) return false;
  } else if (!w.settings.tracking) {
    return false;
  }

  const allSent = (w.outboundMessages ?? []).filter(
    (m) =>
      m.recipient === from &&
      m.messageId &&
      ['ACCEPTED', 'SENT', 'DELIVERED', 'READ'].includes(m.status),
  );
  const quoted = allSent.find((m) => m.messageId === quotedId);
  if (!isButton && quotedId && !quoted) return false;

  const orders = w.orders.filter((o) => orderMatchesPhone(o, from) && !o.archivedAt);
  const mentioned = [...question.matchAll(/#([a-z0-9-]+)|\border\s+([0-9][a-z0-9-]*)\b/g)].map(
    (match) => match[1] ?? match[2],
  );
  if (!mentioned.length && /^\s*#?[0-9][a-z0-9-]*\s*$/.test(question))
    mentioned.push(question.trim().replace(/^#/, ''));
  const explicit = orders.find((o) => mentioned.includes(o.number.replace(/^#/, '').toLowerCase()));
  const contextOrder = orders.find((o) => o.id === quoted?.orderId);
  const order = mentioned.length
    ? mentioned.length === 1 && (!quoted || !contextOrder || contextOrder.id === explicit?.id)
      ? explicit
      : undefined
    : (contextOrder ?? (orders.length === 1 ? orders[0] : undefined));

  if (!policyIntent && !menuIntent) {
    if (!orders.length) intent = 'no_order';
    else if (!order) intent = 'clarify';
  }

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
    orderId: menuIntent || intent === 'clarify' || intent === 'no_order' ? undefined : order?.id,
    kind: `${prefix}${intent}:${messageId}:${w.integration.phoneNumberId}`,
    state: 'QUEUED',
    attempts: 0,
    dueAt: new Date(now).toISOString(),
  });
  return true;
}

export function queueSupportHandoff(
  store: Store,
  input: { from: string; body: string; timestamp?: string },
  now = Date.now(),
): boolean {
  const { from, body, timestamp } = input;
  const received = timestamp !== undefined ? Number(timestamp) * 1000 : now;
  const w = store.workspace;
  if (
    !Number.isFinite(received) ||
    received <= now - windowMs ||
    received > now + 60_000 ||
    !/^\d{10,15}$/.test(from) ||
    isPhoneOptedOut(w, from) ||
    humanHandling(w, from) ||
    !canReply(store, from)
  )
    return false;

  const conversation = customerConversation(w, from);
  const messageId = randomUUID();
  conversation.messages.push({
    id: messageId,
    direction: 'in',
    text: body,
    createdAt: new Date(Math.min(received, now)).toISOString(),
  });
  for (const thread of customerThreads(w, conversation)) {
    thread.human = true;
    thread.unread = true;
  }
  append(
    conversation,
    'note',
    'Customer tapped Talk to support. Assistant paused for human handling.',
  );
  notify(
    w,
    'reply:' + conversation.id,
    'Customer requested support',
    'A customer tapped Talk to support on WhatsApp.',
    'Reply in Inbox to assist them.',
    'info',
  );
  activity(w, 'Customer requested human support from WhatsApp menu.');
  w.jobs.push({
    id: randomUUID(),
    kind: `${prefix}handoff:${messageId}:${w.integration.phoneNumberId}`,
    state: 'QUEUED',
    attempts: 0,
    dueAt: new Date(now).toISOString(),
  });
  return true;
}

export function supportReplyContext(store: Store, job: Job, order: Order | undefined) {
  const [, intent, messageId, sender] = job.kind.split(':');
  const policyIntent = isPolicyIntent(intent);
  const statusOrTracking = intent === 'status' || intent === 'tracking';
  const conversation =
    store.workspace.conversations.find(
      (c) => !c.orderId && c.messages.some((m) => m.id === messageId && m.direction === 'in'),
    ) ??
    (order
      ? store.workspace.conversations.find((c) => c.phone === order.phone && !c.orderId)
      : undefined);
  const phone = conversation?.phone ?? order?.phone ?? '';
  const inbound = conversation?.messages.find((m) => m.id === messageId && m.direction === 'in');
  const handoffAlreadyReplied =
    intent === 'handoff' &&
    !!inbound &&
    (store.workspace.outboundMessages ?? []).some(
      (m) =>
        m.recipient === phone &&
        m.kind === 'INBOX_REPLY' &&
        ['ACCEPTED', 'SENT', 'DELIVERED', 'READ'].includes(m.status) &&
        Date.parse(m.createdAt) >= Date.parse(inbound.createdAt),
    );
  const featureEnabled =
    intent === 'handoff' || intent === 'optout' || intent === 'optin'
      ? true
      : intent === 'menu'
        ? store.workspace.settings.faqs || store.workspace.settings.tracking
        : policyIntent
          ? store.workspace.settings.faqs
          : store.workspace.settings.tracking;
  const optBypass = intent === 'optout' || intent === 'optin';
  if (
    sender !== store.workspace.integration.phoneNumberId ||
    !featureEnabled ||
    (statusOrTracking && (!order || order.archivedAt)) ||
    (!statusOrTracking && order?.archivedAt) ||
    !phone ||
    !inbound ||
    !canReply(store, phone) ||
    (!optBypass && intent !== 'handoff' && isPhoneOptedOut(store.workspace, phone)) ||
    (!optBypass && intent !== 'handoff' && humanHandling(store.workspace, phone)) ||
    handoffAlreadyReplied ||
    Date.parse(inbound.createdAt) <= Date.now() - windowMs
  )
    throw new ProviderError(
      intent === 'handoff' && handoffAlreadyReplied
        ? 'Handoff reply skipped because staff already responded in Inbox'
        : 'Support reply blocked by the customer reply window, sender authorization, or human takeover',
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
            z.object({
              url: z.string().nullish(),
              number: z.string().nullish(),
              company: z.string().nullish(),
            }),
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
  phone?: string,
): Promise<string> {
  const sup = supportSettings(store.workspace);
  const brand = store.merchant.brandName.trim() || 'our store';

  if (intent === 'menu')
    return menuPromptDetails(store.merchant.brandName, store.workspace.settings).preview;

  if (intent === 'handoff') return formatSupportTemplate(sup.handoffText, { brand_name: brand });

  if (intent === 'no_order') return formatSupportTemplate(sup.noOrderText, { brand_name: brand });

  if (intent === 'optout')
    return formatSupportTemplate(sup.optOutConfirmationText, { brand_name: brand });

  if (intent === 'optin')
    return `Thanks — automated WhatsApp order notifications from ${brand} have been re-enabled for your number.`;

  if (intent === 'clarify') {
    const matches = phone
      ? store.workspace.orders.filter((o) => orderMatchesPhone(o, phone) && !o.archivedAt)
      : [];
    const recent =
      matches.length >= 2
        ? matches
            .slice(0, 3)
            .map((o) => o.number)
            .join(', ')
        : 'your confirmation message';
    return formatSupportTemplate(sup.clarifyText, { orders: recent, brand_name: brand });
  }

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
  let cancelled = order.status === 'CANCELLED';
  let status = order.fulfillmentStatus ?? '';
  const tracking: string[] = [];
  if (store.workspace.integration.shopifyToken && store.workspace.integration.shopDomain) {
    const integration = await freshShopifyIntegration(store.merchant.id);
    const { order: current } = orderResult.parse(
      await shopifyGraphql(
        integration,
        'query SupportOrder($id:ID!){order(id:$id){cancelledAt displayFulfillmentStatus fulfillments(first:10){status trackingInfo(first:5){url number}}}}',
        { id: 'gid://shopify/Order/' + order.shopifyOrderId },
      ),
    );
    if (!current)
      throw new ProviderError('Shopify could not find the order for this support reply');
    cancelled = !!current.cancelledAt;
    status = current.displayFulfillmentStatus;
    for (const info of current.fulfillments
      .filter((f) => f.status === 'SUCCESS')
      .flatMap((f) => f.trackingInfo)) {
      const val = info.url?.startsWith('https://') ? info.url : info.number;
      if (val) tracking.push(val);
    }
  }
  if (!tracking.length && (order.trackingUrl || order.trackingNumber)) {
    const fallback = order.trackingUrl?.startsWith('https://')
      ? order.trackingUrl
      : order.trackingNumber;
    if (fallback) tracking.push(fallback);
  }
  if (cancelled) return `Order ${order.number} has been cancelled.`;
  const summary =
    order.delivery === 'Delivered'
      ? 'has been delivered'
      : status === 'FULFILLED'
        ? 'has been fulfilled'
        : status === 'PARTIALLY_FULFILLED' || order.delivery === 'Partially fulfilled'
          ? 'has been partially fulfilled'
          : status === 'ON_HOLD' || order.delivery === 'On hold'
            ? 'is currently on hold'
            : status === 'IN_PROGRESS' || order.delivery === 'In progress'
              ? 'is currently being prepared for dispatch'
              : status === 'SCHEDULED' || order.delivery === 'Scheduled'
                ? 'has fulfillment scheduled'
                : status === 'RESTOCKED' || order.delivery === 'Restocked'
                  ? 'has been restocked'
                  : status === 'UNFULFILLED' || order.delivery === 'Unfulfilled'
                    ? 'has not been fulfilled yet'
                    : status
                      ? `has fulfillment status: ${status.toLowerCase().replaceAll('_', ' ')}`
                      : `has status: ${order.delivery}`;
  const courier = order.trackingCompany ? ` (${order.trackingCompany})` : '';
  return (
    `Order ${order.number} ${summary}.` +
    (tracking.length
      ? ` Tracking${courier}: ${[...new Set(tracking)].slice(0, 3).join(', ')}`
      : intent === 'tracking'
        ? ' Tracking is not available yet.'
        : '')
  );
}
