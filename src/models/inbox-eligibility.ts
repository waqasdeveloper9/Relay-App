import { conversationPhone, customerThreads } from './customer-conversations.js';
import type { Conversation, Merchant, Workspace } from './types.js';

export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface InboxReplyEligibility {
  allowed: boolean;
  phone: string;
  reason?: string;
  windowExpiresAt?: string;
}

export function inboxReplyEligibility(
  input: {
    mode: 'demo' | 'connected';
    outboundEnabled: boolean;
    metaWebhookConfigured: boolean;
    merchant: Pick<Merchant, 'subscriptionStatus' | 'trialEndsAt'>;
    workspace: {
      orders: Workspace['orders'];
      conversations: Workspace['conversations'];
      settings: Workspace['settings'];
      integration: Pick<
        Workspace['integration'],
        'phoneNumberId' | 'whatsappVerifiedAt' | 'templateName' | 'languageCode'
      > & { whatsappToken?: string; hasWhatsappToken?: boolean };
    };
  },
  conversation: Conversation,
  now = Date.now(),
): InboxReplyEligibility {
  const phone = conversationPhone(input.workspace, conversation);
  if (input.mode === 'demo') return { allowed: true, phone };
  if (!/^\d{10,15}$/.test(phone))
    return {
      allowed: false,
      phone,
      reason: 'A valid customer phone number is required before replying.',
    };
  const i = input.workspace.integration;
  const hasToken = 'hasWhatsappToken' in i ? !!i.hasWhatsappToken : !!i.whatsappToken;
  if (!i.whatsappVerifiedAt || !hasToken || !/^\d+$/.test(i.phoneNumberId))
    return {
      allowed: false,
      phone,
      reason: 'Save and verify your WhatsApp Cloud API connection in Integrations first.',
    };
  if (!input.metaWebhookConfigured)
    return {
      allowed: false,
      phone,
      reason: 'Complete Meta reply webhook verification and sender subscription in Integrations.',
    };
  const trialOrSubActive =
    input.merchant.subscriptionStatus === 'ACTIVE' ||
    (input.merchant.subscriptionStatus === 'TRIALING' &&
      Date.parse(input.merchant.trialEndsAt) > now);
  const test = input.workspace.settings.reliability?.testMode;
  const testAuthorized =
    !!test &&
    /^\d{10,15}$/.test(test.recipient) &&
    phone === test.recipient &&
    Date.parse(test.until) > now &&
    i.templateName === test.template &&
    /^[a-z0-9_]{1,100}$/.test(test.template) &&
    (i.templateName === 'hello_world'
      ? i.languageCode === 'en_US'
      : /^[a-z]{2}(?:_[A-Z]{2})?$/.test(i.languageCode));
  if (!((input.outboundEnabled && trialOrSubActive) || testAuthorized)) {
    if (!input.outboundEnabled)
      return {
        allowed: false,
        phone,
        reason: test
          ? 'Your 24-hour own-number test window expired or does not match this recipient/template. Renew it in Reliability.'
          : 'Outbound sending is paused. Enable a 24-hour own-number test in Reliability or enable platform outbound messaging.',
      };
    return {
      allowed: false,
      phone,
      reason:
        'Trial expired or subscription inactive. Renew your plan or enable a 24-hour own-number test in Reliability.',
    };
  }
  const threads = customerThreads(input.workspace, conversation);
  let latestInbound = 0;
  for (const thread of threads) {
    for (const m of thread.messages) {
      if (m.direction !== 'in') continue;
      const at = Date.parse(m.createdAt);
      if (Number.isFinite(at) && at > latestInbound && at <= now + 60_000) latestInbound = at;
    }
  }
  if (!latestInbound || now - latestInbound >= REPLY_WINDOW_MS)
    return {
      allowed: false,
      phone,
      reason:
        'WhatsApp allows free-form replies only within 24 hours of the customer’s latest message.',
    };
  return {
    allowed: true,
    phone,
    windowExpiresAt: new Date(latestInbound + REPLY_WINDOW_MS).toISOString(),
  };
}
