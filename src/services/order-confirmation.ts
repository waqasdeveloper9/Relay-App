import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { decrypt } from '../utils/security.js';
import type { Integration, Order } from '../models/types.js';
import { ProviderError, request, shopifyGraphql, metaMessageId } from './providers.js';
import { defaultShopifySync, isCodGateway } from '../models/workspace-defaults.js';

export const confirmationTemplateName = 'relay_order_confirmation_v1';
export const confirmationTemplateBody =
  'Hi {{1}}, thank you for ordering from {{2}}.\nOrder: {{3}}\nItems: {{4}}\nTotal (Cash on Delivery): {{5}}\nDelivery address: {{6}}\nPlease confirm your order or cancel it using the buttons below.';

export type OrderButtonAction = 'CONFIRM' | 'CANCEL' | 'CHANGE_ADDRESS' | (string & {});

export function detectButtonAction(
  text: string,
  index = 0,
): 'CONFIRM' | 'CANCEL' | 'CHANGE_ADDRESS' | string {
  const t = text.trim().toLowerCase();
  if (/confirm|yes|accept|verify|proceed/.test(t)) return 'CONFIRM';
  if (/cancel|reject|decline|no/.test(t)) return 'CANCEL';
  if (/address|change|edit|update|location/.test(t)) return 'CHANGE_ADDRESS';
  if (/support|help|human|agent|contact/.test(t)) return 'SUPPORT';
  return index === 0 ? 'CONFIRM' : index === 1 ? 'CANCEL' : `BUTTON_${index + 1}`;
}

export function buttonPayload(action: string, orderId: string): string {
  const value = `ORDER:${action}:${orderId}`;
  return `${value}:${createHmac('sha256', config.encryptionKey).update(value).digest('hex')}`;
}
export function parseOrderButton(
  payload: string,
): { action: string; orderId: string } | undefined {
  const match = payload.match(/^ORDER:([A-Z0-9_]+):([a-zA-Z0-9-]+):([a-f0-9]{64})$/);
  if (!match) return;
  const expected = buttonPayload(match[1]!, match[2]!)
    .split(':')
    .at(-1)!;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(match[3]!))) return;
  return { action: match[1]!, orderId: match[2]! };
}

export interface ValidatedConfirmationTemplate {
  body: string;
  language: string;
  variableCount: number;
  variableKeys: string[];
  buttons: { index: number; type: string; text: string; action: string }[];
}

export async function validateConfirmationTemplate(
  i: Integration,
): Promise<ValidatedConfirmationTemplate> {
  if (
    !/^[a-z0-9_]{1,100}$/.test(i.templateName) ||
    !/^[a-z]{2}(?:_[A-Z]{2})?$/.test(i.languageCode) ||
    !/^\d+$/.test(i.wabaId)
  )
    throw new ProviderError(
      'Save a valid template name and language from the connected WhatsApp account',
    );
  const raw = await request(
    `https://graph.facebook.com/${config.metaVersion}/${i.wabaId}/message_templates?name=${encodeURIComponent(i.templateName)}&limit=100`,
    { headers: { Authorization: `Bearer ${decrypt(i.whatsappToken)}` } },
  );
  const templates = z
    .object({
      data: z.array(
        z.object({
          name: z.string(),
          language: z.string(),
          status: z.string(),
          components: z.array(
            z.object({
              type: z.string(),
              text: z.string().optional(),
              buttons: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
            }),
          ),
        }),
      ),
    })
    .parse(raw).data;
  const matching = templates.filter((t) => t.name === i.templateName);
  if (!matching.length) {
    throw new ProviderError(
      `Template "${i.templateName}" was not found in your Meta WhatsApp account (WABA ${i.wabaId}). Create and submit it in Meta WhatsApp Manager, or enter your approved template name in Integrations.`,
    );
  }
  const matchingLang =
    matching.find((t) => t.language === i.languageCode) ??
    (i.languageCode.startsWith('en')
      ? matching.find(
          (t) => t.language === 'en' || t.language === 'en_US' || t.language.startsWith('en'),
        )
      : undefined);
  if (!matchingLang) {
    const available = matching.map((t) => t.language).join(', ');
    throw new ProviderError(
      `Template "${i.templateName}" is registered on Meta in language [${available}], but Relay is configured with "${i.languageCode}". Update the language in Integrations.`,
    );
  }
  if (matchingLang.status !== 'APPROVED') {
    throw new ProviderError(
      `Template "${i.templateName}" status is "${matchingLang.status}" on Meta (must be approved before sending).`,
    );
  }
  const template = matchingLang;
  const body = template.components.find((c) => c.type === 'BODY')?.text ?? '';
  const rawButtons = template.components.find((c) => c.type === 'BUTTONS')?.buttons ?? [];
  const foundVarMatches = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  const variableCount = foundVarMatches.length;

  if (variableCount > 0) {
    const expectedVars = Array.from({ length: variableCount }, (_, idx) => idx + 1);
    if (foundVarMatches.join(',') !== expectedVars.join(',')) {
      throw new ProviderError(
        `Template "${i.templateName}" body variables must be sequential {{1}} to {{${variableCount}}}. Found: ${foundVarMatches.map((n) => `{{${n}}}`).join(', ') || 'none'}.`,
      );
    }
  }

  const buttons = rawButtons.map((b, idx) => ({
    index: idx,
    type: b.type,
    text: (b.text ?? '').trim(),
    action: detectButtonAction(b.text ?? '', idx),
  }));

  const variableKeys = foundVarMatches.map((n) => String(n));
  return { body, language: template.language, variableCount, variableKeys, buttons };
}
const money = z.object({ shopMoney: z.object({ amount: z.string(), currencyCode: z.string() }) });
const shopOrder = z.object({
  id: z.string(),
  name: z.string(),
  cancelledAt: z.string().nullable(),
  displayFinancialStatus: z.string(),
  displayFulfillmentStatus: z.string(),
  paymentGatewayNames: z.array(z.string()),
  totalReceivedSet: money,
  currentTotalPriceSet: money,
  shippingAddress: z.object({ formatted: z.array(z.string()) }).nullable(),
  lineItems: z.object({
    nodes: z.array(z.object({ name: z.string(), quantity: z.number() })),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  }),
});
async function readShopOrder(i: Integration, order: Order) {
  return z
    .object({ order: shopOrder.nullable() })
    .parse(
      await shopifyGraphql(
        i,
        'query RelayOrder($id: ID!) { order(id: $id) { id name cancelledAt displayFinancialStatus displayFulfillmentStatus paymentGatewayNames totalReceivedSet { shopMoney { amount currencyCode } } currentTotalPriceSet { shopMoney { amount currencyCode } } shippingAddress { formatted } lineItems(first: 25) { nodes { name quantity } pageInfo { hasNextPage } } } }',
        { id: `gid://shopify/Order/${order.shopifyOrderId}` },
      ),
    ).order;
}
function text(value: string, max = 500): string {
  return (
    value
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max) || 'Not available'
  );
}
export interface OrderTemplateContext {
  customerName: string;
  brandName: string;
  orderNumber: string;
  cleanOrderNumber: string;
  items: string;
  currency: string;
  amount: string;
  totalPrice: string;
  address: string;
}

export function resolveTemplateVariables(
  body: string,
  count: number,
  ctx: OrderTemplateContext,
): string[] {
  if (count <= 0) return [];

  // Profile 1: Standard 6-variable Relay template
  // "Hi {{1}}, thank you for ordering from {{2}}.\nOrder: {{3}}\nItems: {{4}}\nTotal (Cash on Delivery): {{5}}\nDelivery address: {{6}}"
  if (count === 6) {
    return [
      ctx.customerName,
      ctx.brandName,
      ctx.orderNumber,
      ctx.items,
      ctx.totalPrice,
      ctx.address,
    ].map((v) => text(v));
  }

  // Profile 2: 7-variable Order with Address template
  // "Hi {{1}}! Thank you for your order {{2}} of {{3}} ({{4}} {{5}}) at {{6}}.\n📍 Delivery address:\n{{7}}"
  if (count === 7) {
    return [
      ctx.customerName,
      ctx.orderNumber,
      ctx.items,
      ctx.currency,
      ctx.amount,
      ctx.brandName,
      ctx.address,
    ].map((v) => text(v));
  }

  // General heuristic resolution analyzing surrounding text around each {{k}}
  const resolved: string[] = [];
  const regex = /\{\{(\d+)\}\}/g;
  let match: RegExpExecArray | null;
  const matches: { index: number; varNum: number; start: number; end: number }[] = [];

  while ((match = regex.exec(body)) !== null) {
    matches.push({
      index: matches.length,
      varNum: Number(match[1]),
      start: match.index,
      end: regex.lastIndex,
    });
  }

  for (let i = 0; i < count; i++) {
    const m = matches[i];
    const prevEnd = i > 0 ? matches[i - 1]!.end : 0;
    const beforeText = m ? body.slice(Math.max(0, m.start - 60), m.start).toLowerCase() : '';
    const immediateBefore = m ? body.slice(prevEnd, m.start).trim().toLowerCase() : '';

    let val = '';
    if (immediateBefore.endsWith('(') && /^\s*\{\{\d+\}\}/.test(body.slice(m ? m.end : 0))) {
      val = ctx.currency;
    } else if (immediateBefore === '' && i > 0 && resolved[i - 1] === ctx.currency) {
      val = ctx.amount;
    } else if (/address|delivery|shipping|deliver to|location/.test(beforeText)) {
      val = ctx.address;
    } else if (
      /hi\b|hello\b|dear\b|customer\b|name\b/.test(beforeText) &&
      !/brand|store/.test(beforeText)
    ) {
      val = ctx.customerName;
    } else if (/items?:?\b|products?:?\b|\bof\b|summary\b/.test(beforeText)) {
      val = ctx.items;
    } else if (/total|price|amount|cod|cash on delivery|pay/.test(beforeText)) {
      val = ctx.totalPrice;
    } else if (/ordering from|\bat\b|\bfrom\b|store\b|brand\b/.test(beforeText)) {
      val = ctx.brandName;
    } else if (/order:?|order\s*(number|#|no\.?)?|#/.test(beforeText)) {
      val = ctx.cleanOrderNumber || ctx.orderNumber;
    }

    if (!val) {
      const fallbackPool = [
        ctx.customerName,
        ctx.brandName,
        ctx.cleanOrderNumber || ctx.orderNumber,
        ctx.items,
        ctx.totalPrice,
        ctx.address,
        ctx.currency,
        ctx.amount,
      ];
      val = fallbackPool[i] ?? '';
    }

    resolved.push(text(val));
  }

  return resolved;
}

export async function sendOrderConfirmation(
  i: Integration,
  order: Order,
  brandName: string,
  onPrepared?: (preview: string) => Promise<void>,
  correlationId?: string,
): Promise<string> {
  const validated = await validateConfirmationTemplate(i);
  const current = await readShopOrder(i, order);
  if (
    !current ||
    current.cancelledAt ||
    current.displayFulfillmentStatus !== 'UNFULFILLED' ||
    current.displayFinancialStatus !== 'PENDING'
  )
    throw new ProviderError('Only pending, unfulfilled orders can receive this COD confirmation');
  if (!current.shippingAddress)
    throw new ProviderError(
      'Shipping address is unavailable. Review Shopify protected customer data access.',
    );
  const items =
    current.lineItems.nodes.map((item) => `${item.name} x${item.quantity}`).join('; ') +
    (current.lineItems.pageInfo.hasNextPage ? '; additional items in order' : '');
  const currency =
    current.currentTotalPriceSet.shopMoney.currencyCode || order.currency || 'Rs';
  const amount =
    current.currentTotalPriceSet.shopMoney.amount || String(order.amount);
  const rawNumber = current.name || order.number;
  const cleanNumber = rawNumber.replace(/^#/, '');

  const ctx: OrderTemplateContext = {
    customerName: order.name || current.shippingAddress.formatted[0] || 'Customer',
    brandName: brandName || 'our store',
    orderNumber: rawNumber,
    cleanOrderNumber: cleanNumber,
    items,
    currency,
    amount,
    totalPrice: `${currency} ${amount}`,
    address: current.shippingAddress.formatted.join(', '),
  };

  const values = resolveTemplateVariables(validated.body, validated.variableCount, ctx);

  if (onPrepared) {
    const buttonLabels = validated.buttons.map((b) => `[${b.text || b.action}]`).join(' ');
    await onPrepared(
      validated.body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => values[Number(n) - 1] ?? '') +
        (buttonLabels ? `\n${buttonLabels}` : '\n[Confirm order] [Cancel order]'),
    );
  }

  const templateComponents: Record<string, unknown>[] = [];
  if (values.length > 0) {
    templateComponents.push({
      type: 'body',
      parameters: values.map((value) => ({ type: 'text', text: value })),
    });
  }

  const quickReplyButtons = validated.buttons.filter(
    (b) => b.type === 'QUICK_REPLY' || !b.type,
  );
  if (quickReplyButtons.length > 0) {
    for (const btn of quickReplyButtons) {
      templateComponents.push({
        type: 'button',
        sub_type: 'quick_reply',
        index: String(btn.index),
        parameters: [{ type: 'payload', payload: buttonPayload(btn.action, order.id) }],
      });
    }
  } else {
    templateComponents.push(
      ...(['CONFIRM', 'CANCEL'] as const).map((action, index) => ({
        type: 'button',
        sub_type: 'quick_reply',
        index: String(index),
        parameters: [{ type: 'payload', payload: buttonPayload(action, order.id) }],
      })),
    );
  }

  const result = await request(
    `https://graph.facebook.com/${config.metaVersion}/${i.phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${decrypt(i.whatsappToken)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: order.phone,
        biz_opaque_callback_data: correlationId,
        type: 'template',
        template: {
          name: i.templateName,
          language: { code: validated.language },
          components: templateComponents,
        },
      }),
    },
    true,
  );
  return metaMessageId(result);
}
export async function cancelUnpaidCodOrder(
  i: Integration,
  order: Order,
  reason = 'Customer requested cancellation through Relay WhatsApp confirmation',
  codKeywords: string[] = defaultShopifySync.codGatewayKeywords,
): Promise<void> {
  const current = await readShopOrder(i, order);
  if (!current) throw new ProviderError('Shopify order is unavailable');
  if (current.cancelledAt) return;
  if (
    current.displayFinancialStatus !== 'PENDING' ||
    current.displayFulfillmentStatus !== 'UNFULFILLED' ||
    Number(current.totalReceivedSet.shopMoney.amount) !== 0 ||
    !isCodGateway(current.paymentGatewayNames, codKeywords)
  )
    throw new ProviderError(
      'Automatic cancellation requires an unpaid, unfulfilled COD order. Manual review required.',
    );
  const result = z
    .object({
      orderCancel: z.object({
        job: z.object({ id: z.string(), done: z.boolean() }).nullable(),
        orderCancelUserErrors: z.array(z.object({ message: z.string() })),
        userErrors: z.array(z.object({ message: z.string() })),
      }),
    })
    .parse(
      await shopifyGraphql(
        i,
        'mutation RelayCancel($id: ID!, $note: String!) { orderCancel(orderId: $id, reason: CUSTOMER, restock: true, notifyCustomer: false, staffNote: $note) { job { id done } orderCancelUserErrors { message } userErrors { message } } }',
        { id: current.id, note: reason.slice(0, 255) },
      ),
    ).orderCancel;
  if (result.orderCancelUserErrors.length || result.userErrors.length)
    throw new ProviderError(
      'Shopify rejected cancellation. Check order eligibility and permissions.',
    );
  // Never report cancellation locally until Shopify confirms the final order state.
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const state = z
        .object({ order: z.object({ cancelledAt: z.string().nullable() }).nullable() })
        .parse(
          await shopifyGraphql(
            i,
            'query RelayCancelState($id: ID!) { order(id: $id) { cancelledAt } }',
            { id: current.id },
          ),
        );
      if (state.order?.cancelledAt) return;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch {
    throw new ProviderError(
      'Cancellation was submitted but Shopify completion could not be checked. Reconcile in Shopify before retrying.',
      true,
    );
  }
  throw new ProviderError(
    'Shopify accepted cancellation but final completion is unconfirmed. Reconcile in Shopify before retrying.',
    true,
  );
}
