import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { decrypt } from '../utils/security.js';
import type { Integration, Order } from '../models/types.js';
import { ProviderError, request, shopifyGraphql, metaMessageId } from './providers.js';

export const confirmationTemplateName = 'relay_order_confirmation_v1';
export const confirmationTemplateBody =
  'Hi {{1}}, thank you for ordering from {{2}}.\nOrder: {{3}}\nItems: {{4}}\nTotal (Cash on Delivery): {{5}}\nDelivery address: {{6}}\nPlease confirm your order or cancel it using the buttons below.';
export function buttonPayload(action: 'CONFIRM' | 'CANCEL', orderId: string): string {
  const value = `ORDER:${action}:${orderId}`;
  return `${value}:${createHmac('sha256', config.encryptionKey).update(value).digest('hex')}`;
}
export function parseOrderButton(
  payload: string,
): { action: 'CONFIRM' | 'CANCEL'; orderId: string } | undefined {
  const match = payload.match(/^ORDER:(CONFIRM|CANCEL):([a-zA-Z0-9-]+):([a-f0-9]{64})$/);
  if (!match) return;
  const expected = buttonPayload(match[1] as 'CONFIRM' | 'CANCEL', match[2]!)
    .split(':')
    .at(-1)!;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(match[3]!))) return;
  return { action: match[1] as 'CONFIRM' | 'CANCEL', orderId: match[2]! };
}
export async function validateConfirmationTemplate(i: Integration): Promise<string> {
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
              buttons: z.array(z.object({ type: z.string(), text: z.string() })).optional(),
            }),
          ),
        }),
      ),
    })
    .parse(raw).data;
  const template = templates.find(
    (t) => t.name === i.templateName && t.language === i.languageCode && t.status === 'APPROVED',
  );
  const body = template?.components.find((c) => c.type === 'BODY')?.text ?? '';
  const buttons = template?.components.find((c) => c.type === 'BUTTONS')?.buttons ?? [];
  if (
    !template ||
    template.components.some((c) => !['BODY', 'FOOTER', 'BUTTONS'].includes(c.type)) ||
    [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1]).join(',') !== '1,2,3,4,5,6' ||
    buttons.length !== 2 ||
    buttons.some((b) => b.type !== 'QUICK_REPLY') ||
    buttons[0]?.text !== 'Confirm order' ||
    buttons[1]?.text !== 'Cancel order'
  )
    throw new ProviderError(
      'Template must be approved with six ordered body variables and quick replies: Confirm order, Cancel order. No header components.',
    );
  return body;
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
export async function sendOrderConfirmation(
  i: Integration,
  order: Order,
  brandName: string,
  onPrepared?: (preview: string) => Promise<void>,
  correlationId?: string,
): Promise<string> {
  const templateBody = await validateConfirmationTemplate(i);
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
  const values = [
    order.name,
    brandName,
    current.name,
    items,
    `${current.currentTotalPriceSet.shopMoney.currencyCode} ${current.currentTotalPriceSet.shopMoney.amount}`,
    current.shippingAddress.formatted.join(', '),
  ].map((v) => text(v));
  if (onPrepared)
    await onPrepared(
      templateBody.replace(/\{\{(\d+)\}\}/g, (_, n: string) => values[Number(n) - 1] ?? '') +
        '\n[Confirm order] [Cancel order]',
    );
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
          language: { code: i.languageCode },
          components: [
            { type: 'body', parameters: values.map((value) => ({ type: 'text', text: value })) },
            ...(['CONFIRM', 'CANCEL'] as const).map((action, index) => ({
              type: 'button',
              sub_type: 'quick_reply',
              index: String(index),
              parameters: [{ type: 'payload', payload: buttonPayload(action, order.id) }],
            })),
          ],
        },
      }),
    },
    true,
  );
  return metaMessageId(result);
}
export async function cancelUnpaidCodOrder(i: Integration, order: Order): Promise<void> {
  const current = await readShopOrder(i, order);
  if (!current) throw new ProviderError('Shopify order is unavailable');
  if (current.cancelledAt) return;
  if (
    current.displayFinancialStatus !== 'PENDING' ||
    current.displayFulfillmentStatus !== 'UNFULFILLED' ||
    Number(current.totalReceivedSet.shopMoney.amount) !== 0 ||
    !current.paymentGatewayNames.some((g) => /cash on delivery|\bcod\b/i.test(g))
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
        'mutation RelayCancel($id: ID!) { orderCancel(orderId: $id, reason: CUSTOMER, restock: true, notifyCustomer: false, staffNote: "Customer requested cancellation through Relay WhatsApp confirmation") { job { id done } orderCancelUserErrors { message } userErrors { message } } }',
        { id: current.id },
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
