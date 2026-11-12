import { z } from 'zod';
import { config } from '../config.js';
import { decrypt } from '../utils/security.js';
import type { Integration, Order } from '../models/types.js';
import { hasShopifyScope } from '../models/workspace-defaults.js';

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly ambiguous = false,
    public readonly details: {
      retryable?: boolean;
      retryAfterSeconds?: number;
      code?: string;
    } = {},
  ) {
    super(message);
  }
}
export async function request(
  url: string,
  options: RequestInit,
  mutating = false,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(12000),
      redirect: 'error',
    });
  } catch {
    throw new ProviderError(
      'Provider could not be reached. Check connection before retrying.',
      mutating,
      { retryable: !mutating, code: 'NETWORK' },
    );
  }
  if (!response.ok) {
    let code: number | undefined;
    try {
      const body = (await response.json()) as { error?: { code?: number } };
      code = body.error?.code;
    } catch {
      /* Non-JSON provider response. */
    }
    const reasons: Record<number, string> = {
      190: 'Meta access token is invalid or expired. Replace the saved token.',
      131030: 'Recipient is not allowed for this sandbox. Verify the recipient in Meta.',
      131031: 'WhatsApp business account is locked. Review it in Meta Business Support.',
      132001: 'Template name or language is unavailable in this WhatsApp account.',
      132000: 'Parameters do not match the approved template.',
      131026: 'Meta could not deliver to this recipient.',
    };
    const retryAfter = Number(response.headers.get('Retry-After'));
    throw new ProviderError(
      (code ? `Meta ${code}: ` : '') +
        (code && reasons[code]
          ? reasons[code]
          : `Provider returned HTTP ${response.status}. Review credentials, permissions, and provider availability.`),
      mutating && response.status >= 500,
      {
        retryable:
          response.status === 429 ||
          response.status >= 500 ||
          (!!code && [4, 80007, 130429, 131056].includes(code)),
        code: String(code ?? response.status),
        retryAfterSeconds:
          Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 3600) : undefined,
      },
    );
  }
  try {
    return await response.json();
  } catch {
    throw new ProviderError('Provider returned an invalid response.', mutating, {
      retryable: !mutating,
      code: 'INVALID_RESPONSE',
    });
  }
}
export async function shopifyGraphql(
  i: Integration,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<unknown> {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(i.shopDomain))
    throw new ProviderError('A valid myshopify.com domain is required');
  const result = await request(
    `https://${i.shopDomain}/admin/api/${config.shopifyVersion}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': decrypt(i.shopifyToken),
      },
      body: JSON.stringify({ query, variables }),
    },
    /mutation/.test(query),
  );
  const parsed = z
    .object({ data: z.record(z.unknown()).optional(), errors: z.array(z.unknown()).optional() })
    .parse(result);
  if (
    parsed.errors?.some(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        'extensions' in e &&
        (e.extensions as { code?: string })?.code === 'THROTTLED',
    )
  )
    throw new ProviderError('Shopify API rate limit reached. Relay will retry.', false, {
      retryable: true,
      code: 'THROTTLED',
    });
  if (parsed.errors?.length || !parsed.data)
    throw new ProviderError('Shopify rejected the operation. Check API scopes and version.');
  return parsed.data;
}
export async function checkShopify(i: Integration): Promise<string> {
  const data = z
    .object({ shop: z.object({ name: z.string() }) })
    .parse(await shopifyGraphql(i, 'query { shop { name } }'));
  return data.shop.name;
}
export async function checkWhatsapp(i: Integration): Promise<string> {
  if (!/^\d+$/.test(i.phoneNumberId))
    throw new ProviderError('Phone Number ID must contain digits only');
  const result = await request(
    `https://graph.facebook.com/${config.metaVersion}/${i.phoneNumberId}?fields=display_phone_number,verified_name`,
    { headers: { Authorization: `Bearer ${decrypt(i.whatsappToken)}` } },
  );
  return z.object({ display_phone_number: z.string() }).parse(result).display_phone_number;
}
export async function addOrderTag(
  i: Integration,
  order: Order,
  tags: string[] = ['COD-CONFIRMED'],
): Promise<void> {
  const normalized = tags.map((t) => t.trim()).filter(Boolean);
  if (!normalized.length) return;
  const data = z
    .object({ tagsAdd: z.object({ userErrors: z.array(z.object({ message: z.string() })) }) })
    .parse(
      await shopifyGraphql(
        i,
        'mutation Tags($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { node { id } userErrors { message } } }',
        { id: `gid://shopify/Order/${order.shopifyOrderId}`, tags: normalized },
      ),
    );
  if (data.tagsAdd.userErrors.length)
    throw new ProviderError('Shopify could not apply the order tag');
}
export function metaMessageId(result: unknown): string {
  const parsed = z
    .object({ messages: z.array(z.object({ id: z.string().min(1) })).min(1) })
    .safeParse(result);
  if (!parsed.success)
    throw new ProviderError(
      'Meta response did not include a valid message ID. Check provider history before retrying.',
      true,
    );
  return parsed.data.messages[0]!.id;
}
export async function sendHelloWorldTest(
  i: Integration,
  recipient: string,
  correlationId?: string,
): Promise<string> {
  if (!/^\d+$/.test(i.phoneNumberId) || !i.whatsappToken || !i.whatsappVerifiedAt)
    throw new ProviderError('Save and verify the WhatsApp connection first');
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
        to: recipient,
        biz_opaque_callback_data: correlationId,
        type: 'template',
        template: { name: 'hello_world', language: { code: 'en_US' } },
      }),
    },
    true,
  );
  return metaMessageId(result);
}

export async function syncCancellationTags(
  i: Integration,
  order: Order,
  completed: boolean,
  confirmedTag = 'COD-CONFIRMED',
  cancellationRequestedTag = 'CANCELLATION-REQUESTED',
): Promise<void> {
  const id = 'gid://shopify/Order/' + order.shopifyOrderId;
  const conf = confirmedTag.trim() || 'COD-CONFIRMED';
  const reqTag = cancellationRequestedTag.trim() || 'CANCELLATION-REQUESTED';
  const toRemove = completed ? [...new Set([conf, reqTag])] : [conf];
  const removed = z
    .object({ tagsRemove: z.object({ userErrors: z.array(z.object({ message: z.string() })) }) })
    .parse(
      await shopifyGraphql(
        i,
        'mutation CancellationTagsRemove($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }',
        { id, tags: toRemove },
      ),
    );
  if (removed.tagsRemove.userErrors.length)
    throw new ProviderError('Shopify could not remove cancellation-related tags');
  if (!completed) {
    const added = z
      .object({ tagsAdd: z.object({ userErrors: z.array(z.object({ message: z.string() })) }) })
      .parse(
        await shopifyGraphql(
          i,
          'mutation CancellationTagsAdd($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }',
          { id, tags: [reqTag] },
        ),
      );
    if (added.tagsAdd.userErrors.length)
      throw new ProviderError('Shopify could not apply the cancellation request tag');
  }
}

export interface SupportMenuButton {
  id: 'MENU:STATUS' | 'MENU:POLICY' | 'MENU:HUMAN';
  title: string;
}

export async function sendSupportText(
  integration: Integration,
  recipient: string,
  body: string,
  correlationId: string,
): Promise<string> {
  if (
    !/^\d+$/.test(integration.phoneNumberId) ||
    !integration.whatsappToken ||
    !integration.whatsappVerifiedAt
  )
    throw new ProviderError('Save and verify the WhatsApp connection first');
  return metaMessageId(
    await request(
      `https://graph.facebook.com/${config.metaVersion}/${integration.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${decrypt(integration.whatsappToken)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: recipient,
          biz_opaque_callback_data: correlationId,
          type: 'text',
          text: { body },
        }),
      },
      true,
    ),
  );
}

export async function sendSupportInteractiveMenu(
  integration: Integration,
  recipient: string,
  body: string,
  buttons: SupportMenuButton[],
  correlationId: string,
  footer?: string,
): Promise<string> {
  if (
    !/^\d+$/.test(integration.phoneNumberId) ||
    !integration.whatsappToken ||
    !integration.whatsappVerifiedAt
  )
    throw new ProviderError('Save and verify the WhatsApp connection first');
  if (!buttons.length || buttons.length > 3)
    throw new ProviderError('Interactive menu must contain between 1 and 3 reply buttons');
  const bodyText = body.trim().slice(0, 1024);
  const footerText = footer?.trim().slice(0, 60);
  return metaMessageId(
    await request(
      `https://graph.facebook.com/${config.metaVersion}/${integration.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${decrypt(integration.whatsappToken)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: recipient,
          biz_opaque_callback_data: correlationId,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: bodyText },
            ...(footerText ? { footer: { text: footerText } } : {}),
            action: {
              buttons: buttons.map((b) => ({
                type: 'reply',
                reply: { id: b.id, title: b.title.trim().slice(0, 20) },
              })),
            },
          },
        }),
      },
      true,
    ),
  );
}

export const shopifyOrderSnapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  tags: z.array(z.string()).optional(),
  phone: z.string().nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
  cancelledAt: z.string().nullable(),
  displayFinancialStatus: z.string().nullable(),
  displayFulfillmentStatus: z.string(),
  paymentGatewayNames: z.array(z.string()),
  currentTotalPriceSet: z.object({
    shopMoney: z.object({ amount: z.string(), currencyCode: z.string() }),
  }),
  shippingAddress: z
    .object({
      name: z.string().nullable(),
      phone: z.string().nullable(),
      countryCodeV2: z.string().nullable(),
    })
    .nullable(),
  customAttributes: z.array(z.object({ key: z.string(), value: z.string().nullish() })).optional(),
  customer: z
    .object({
      smsMarketingConsent: z.object({ marketingState: z.string().nullish() }).nullish(),
    })
    .nullish()
    .optional(),
  fulfillments: z
    .array(
      z.object({
        id: z.string().optional(),
        status: z.string(),
        displayStatus: z.string().nullish(),
        trackingInfo: z
          .array(
            z.object({
              url: z.string().nullish(),
              number: z.string().nullish(),
              company: z.string().nullish(),
            }),
          )
          .optional(),
        events: z
          .object({
            nodes: z.array(z.object({ status: z.string(), happenedAt: z.string().optional() })),
          })
          .optional(),
      }),
    )
    .optional(),
});
export type ShopifyOrderSnapshot = z.infer<typeof shopifyOrderSnapshotSchema>;

export async function fetchShopifyOrderSnapshot(
  i: Integration,
  shopifyOrderId: string,
): Promise<ShopifyOrderSnapshot | null> {
  const numericId = shopifyOrderId.split('/').at(-1) ?? '';
  if (!/^\d+$/.test(numericId))
    throw new ProviderError('Invalid Shopify order ID for snapshot fetch');
  const includeEvents = hasShopifyScope(i, 'read_fulfillments');
  const includeCustomer = hasShopifyScope(i, 'read_customers');
  const query = `query RelayOrderSnapshot($id: ID!) { order(id: $id) { id name tags phone createdAt updatedAt cancelledAt displayFinancialStatus displayFulfillmentStatus paymentGatewayNames customAttributes { key value } currentTotalPriceSet { shopMoney { amount currencyCode } } shippingAddress { name phone countryCodeV2 }${includeCustomer ? ' customer { smsMarketingConsent { marketingState } }' : ''} fulfillments(first: 10) { id status displayStatus trackingInfo(first: 5) { url number company }${includeEvents ? ' events(first: 10) { nodes { status happenedAt } }' : ''} } } }`;
  const data = z
    .object({ order: shopifyOrderSnapshotSchema.nullable() })
    .parse(await shopifyGraphql(i, query, { id: `gid://shopify/Order/${numericId}` }));
  return data.order;
}

export async function resolveOrderIdFromFulfillmentOrder(
  i: Integration,
  fulfillmentOrderId: string,
): Promise<string | undefined> {
  if (!hasShopifyScope(i, 'read_merchant_managed_fulfillment_orders'))
    throw new ProviderError(
      'Shopify fulfillment-order permission is missing. Reconnect Shopify with fulfillment scopes.',
    );
  const gid = fulfillmentOrderId.startsWith('gid://')
    ? fulfillmentOrderId
    : `gid://shopify/FulfillmentOrder/${fulfillmentOrderId}`;
  const data = z
    .object({
      fulfillmentOrder: z.object({ order: z.object({ id: z.string() }) }).nullable(),
    })
    .parse(
      await shopifyGraphql(
        i,
        'query RelayResolveFulfillmentOrder($id: ID!) { fulfillmentOrder(id: $id) { order { id } } }',
        { id: gid },
      ),
    );
  return data.fulfillmentOrder?.order.id.split('/').at(-1);
}

const fulfillmentOrdersResponseSchema = z.object({
  order: z
    .object({
      fulfillmentOrders: z.object({
        nodes: z.array(
          z.object({
            id: z.string(),
            status: z.string(),
            fulfillmentHolds: z
              .array(
                z.object({
                  id: z.string(),
                  handle: z.string().nullish(),
                  heldByRequestingApp: z.boolean().optional(),
                  reason: z.string().nullish(),
                }),
              )
              .optional(),
          }),
        ),
      }),
    })
    .nullable(),
});

export async function placeOrderFulfillmentHold(
  i: Integration,
  order: Order,
  reasonNotes: string,
): Promise<'HELD' | 'ALREADY_HELD'> {
  if (!hasShopifyScope(i, 'write_merchant_managed_fulfillment_orders'))
    throw new ProviderError(
      'Shopify fulfillment hold permission is not granted. Reconnect Shopify with fulfillment scopes in Integrations.',
    );
  const data = fulfillmentOrdersResponseSchema.parse(
    await shopifyGraphql(
      i,
      'query RelayOrderHolds($id: ID!) { order(id: $id) { fulfillmentOrders(first: 20) { nodes { id status fulfillmentHolds { id handle heldByRequestingApp reason } } } } }',
      { id: `gid://shopify/Order/${order.shopifyOrderId}` },
    ),
  );
  if (!data.order) throw new ProviderError('Shopify order is unavailable for fulfillment hold');
  const nodes = data.order.fulfillmentOrders.nodes;
  const targets = nodes.filter(
    (fo) =>
      ['OPEN', 'SCHEDULED', 'IN_PROGRESS'].includes(fo.status) &&
      !(fo.fulfillmentHolds ?? []).some(
        (h) => h.handle === 'relay-hold' || h.heldByRequestingApp === true,
      ),
  );
  if (!targets.length) return 'ALREADY_HELD';
  const notes = reasonNotes.trim().slice(0, 250) || 'Held by Relay pending order review';
  for (const fo of targets) {
    const result = z
      .object({
        fulfillmentOrderHold: z.object({
          userErrors: z.array(z.object({ message: z.string() })),
        }),
      })
      .parse(
        await shopifyGraphql(
          i,
          'mutation RelayPlaceHold($id: ID!, $fulfillmentHold: FulfillmentOrderHoldInput!) { fulfillmentOrderHold(id: $id, fulfillmentHold: $fulfillmentHold) { fulfillmentHold { id handle } userErrors { message } } }',
          {
            id: fo.id,
            fulfillmentHold: {
              reason: 'AWAITING_PAYMENT',
              reasonNotes: notes,
              handle: 'relay-hold',
            },
          },
        ),
      );
    if (result.fulfillmentOrderHold.userErrors.length)
      throw new ProviderError(
        result.fulfillmentOrderHold.userErrors.map((e) => e.message).join('; ') ||
          'Shopify could not place a fulfillment hold on this order',
      );
  }
  return 'HELD';
}

export async function releaseOrderFulfillmentHold(
  i: Integration,
  order: Order,
): Promise<'RELEASED' | 'NONE'> {
  if (!hasShopifyScope(i, 'write_merchant_managed_fulfillment_orders'))
    throw new ProviderError(
      'Shopify fulfillment hold release permission is not granted. Reconnect Shopify with fulfillment scopes in Integrations.',
    );
  const data = fulfillmentOrdersResponseSchema.parse(
    await shopifyGraphql(
      i,
      'query RelayOrderHolds($id: ID!) { order(id: $id) { fulfillmentOrders(first: 20) { nodes { id status fulfillmentHolds { id handle heldByRequestingApp reason } } } } }',
      { id: `gid://shopify/Order/${order.shopifyOrderId}` },
    ),
  );
  if (!data.order) return 'NONE';
  let released = 0;
  for (const fo of data.order.fulfillmentOrders.nodes) {
    if (fo.status !== 'ON_HOLD') continue;
    const relayHoldIds = (fo.fulfillmentHolds ?? [])
      .filter((h) => h.handle === 'relay-hold' || h.heldByRequestingApp === true)
      .map((h) => h.id);
    if (!relayHoldIds.length) continue;
    const result = z
      .object({
        fulfillmentOrderReleaseHold: z.object({
          userErrors: z.array(z.object({ message: z.string() })),
        }),
      })
      .parse(
        await shopifyGraphql(
          i,
          'mutation RelayReleaseHold($id: ID!, $holdIds: [ID!]) { fulfillmentOrderReleaseHold(id: $id, holdIds: $holdIds) { fulfillmentOrder { id status } userErrors { message } } }',
          { id: fo.id, holdIds: relayHoldIds },
        ),
      );
    if (result.fulfillmentOrderReleaseHold.userErrors.length)
      throw new ProviderError(
        result.fulfillmentOrderReleaseHold.userErrors.map((e) => e.message).join('; ') ||
          'Shopify could not release the Relay fulfillment hold',
      );
    released++;
  }
  return released > 0 ? 'RELEASED' : 'NONE';
}

export async function markShopifyOrderPaid(
  i: Integration,
  order: Order,
): Promise<'MARKED_PAID' | 'ALREADY_PAID'> {
  if (!hasShopifyScope(i, 'write_orders'))
    throw new ProviderError('Shopify write_orders permission is required to mark orders paid.');
  const check = z
    .object({
      order: z
        .object({
          id: z.string(),
          canMarkAsPaid: z.boolean(),
          displayFinancialStatus: z.string().nullish(),
          cancelledAt: z.string().nullish(),
        })
        .nullable(),
    })
    .parse(
      await shopifyGraphql(
        i,
        'query RelayCheckMarkPaid($id: ID!) { order(id: $id) { id canMarkAsPaid displayFinancialStatus cancelledAt } }',
        { id: `gid://shopify/Order/${order.shopifyOrderId}` },
      ),
    );
  if (!check.order) throw new ProviderError('Shopify order is unavailable');
  if (check.order.cancelledAt) throw new ProviderError('Cancelled orders cannot be marked paid');
  if ((check.order.displayFinancialStatus ?? '').toUpperCase() === 'PAID') return 'ALREADY_PAID';
  if (!check.order.canMarkAsPaid)
    throw new ProviderError(
      'Shopify reports this order cannot be marked paid (already settled, refunded, or zero unpaid balance).',
    );
  const res = z
    .object({
      orderMarkAsPaid: z.object({
        order: z.object({ id: z.string(), displayFinancialStatus: z.string().nullish() }).nullish(),
        userErrors: z.array(z.object({ message: z.string() })),
      }),
    })
    .parse(
      await shopifyGraphql(
        i,
        'mutation RelayMarkOrderPaid($input: OrderMarkAsPaidInput!) { orderMarkAsPaid(input: $input) { order { id displayFinancialStatus } userErrors { message } } }',
        { input: { id: check.order.id } },
      ),
    );
  if (res.orderMarkAsPaid.userErrors.length)
    throw new ProviderError(
      res.orderMarkAsPaid.userErrors.map((e) => e.message).join('; ') ||
        'Shopify could not mark this order as paid',
    );
  return 'MARKED_PAID';
}

export async function reportFulfillmentProgress(
  i: Integration,
  order: Order,
  reasonNotes?: string,
): Promise<'IN_PROGRESS' | 'ALREADY_IN_PROGRESS'> {
  if (!hasShopifyScope(i, 'write_merchant_managed_fulfillment_orders'))
    throw new ProviderError(
      'Shopify fulfillment-order permission is not granted. Enable fulfillment scopes and reconnect Shopify in Integrations.',
    );
  const data = fulfillmentOrdersResponseSchema.parse(
    await shopifyGraphql(
      i,
      'query RelayOrderHolds($id: ID!) { order(id: $id) { fulfillmentOrders(first: 20) { nodes { id status fulfillmentHolds { id handle heldByRequestingApp reason } } } } }',
      { id: `gid://shopify/Order/${order.shopifyOrderId}` },
    ),
  );
  if (!data.order) throw new ProviderError('Shopify order is unavailable');
  const nodes = data.order.fulfillmentOrders.nodes;
  const targets = nodes.filter((fo) => ['OPEN', 'SCHEDULED'].includes(fo.status));
  if (!targets.length) {
    if (nodes.some((fo) => fo.status === 'IN_PROGRESS')) return 'ALREADY_IN_PROGRESS';
    if (nodes.some((fo) => fo.status === 'ON_HOLD'))
      throw new ProviderError(
        'Fulfillment is currently on hold in Shopify. Release the hold before marking it in progress.',
      );
    throw new ProviderError('No open Shopify fulfillment orders found to mark in progress');
  }
  const cleanNotes = reasonNotes?.trim().slice(0, 250);
  for (const fo of targets) {
    const result = z
      .object({
        fulfillmentOrderReportProgress: z.object({
          userErrors: z.array(z.object({ message: z.string() })),
        }),
      })
      .parse(
        await shopifyGraphql(
          i,
          'mutation RelayReportProgress($id: ID!, $progressReport: FulfillmentOrderProgressReportInput) { fulfillmentOrderReportProgress(id: $id, progressReport: $progressReport) { fulfillmentOrder { id status } userErrors { message } } }',
          {
            id: fo.id,
            ...(cleanNotes ? { progressReport: { reasonNotes: cleanNotes } } : {}),
          },
        ),
      );
    if (result.fulfillmentOrderReportProgress.userErrors.length)
      throw new ProviderError(
        result.fulfillmentOrderReportProgress.userErrors.map((e) => e.message).join('; ') ||
          'Shopify could not mark fulfillment as in progress',
      );
  }
  return 'IN_PROGRESS';
}

export async function reopenFulfillmentOrder(
  i: Integration,
  order: Order,
): Promise<'OPEN' | 'ALREADY_OPEN'> {
  if (!hasShopifyScope(i, 'write_merchant_managed_fulfillment_orders'))
    throw new ProviderError(
      'Shopify fulfillment-order permission is not granted. Enable fulfillment scopes and reconnect Shopify in Integrations.',
    );
  const data = fulfillmentOrdersResponseSchema.parse(
    await shopifyGraphql(
      i,
      'query RelayOrderHolds($id: ID!) { order(id: $id) { fulfillmentOrders(first: 20) { nodes { id status fulfillmentHolds { id handle heldByRequestingApp reason } } } } }',
      { id: `gid://shopify/Order/${order.shopifyOrderId}` },
    ),
  );
  if (!data.order) throw new ProviderError('Shopify order is unavailable');
  const nodes = data.order.fulfillmentOrders.nodes;
  const targets = nodes.filter((fo) => ['IN_PROGRESS', 'SCHEDULED'].includes(fo.status));
  if (!targets.length) {
    if (nodes.some((fo) => fo.status === 'OPEN')) return 'ALREADY_OPEN';
    if (nodes.some((fo) => fo.status === 'ON_HOLD'))
      throw new ProviderError(
        'Fulfillment is currently on hold in Shopify. Release the hold instead of reopening.',
      );
    throw new ProviderError('No in-progress or scheduled fulfillment orders found to reopen');
  }
  for (const fo of targets) {
    const result = z
      .object({
        fulfillmentOrderOpen: z.object({
          userErrors: z.array(z.object({ message: z.string() })),
        }),
      })
      .parse(
        await shopifyGraphql(
          i,
          'mutation RelayOpenFulfillmentOrder($id: ID!) { fulfillmentOrderOpen(id: $id) { fulfillmentOrder { id status } userErrors { message } } }',
          { id: fo.id },
        ),
      );
    if (result.fulfillmentOrderOpen.userErrors.length)
      throw new ProviderError(
        result.fulfillmentOrderOpen.userErrors.map((e) => e.message).join('; ') ||
          'Shopify could not reopen this fulfillment order',
      );
  }
  return 'OPEN';
}

function buildTrackingInput(payload?: {
  trackingCompany?: string;
  trackingNumber?: string;
  trackingUrl?: string;
}): Record<string, string> | undefined {
  const company = payload?.trackingCompany?.trim();
  const number = payload?.trackingNumber?.trim();
  const url = payload?.trackingUrl?.trim();
  const tracking: Record<string, string> = {};
  if (company) tracking.company = company;
  if (number) tracking.number = number;
  if (url) tracking.url = url;
  return Object.keys(tracking).length ? tracking : undefined;
}

export async function createShopifyFulfillment(
  i: Integration,
  order: Order,
  payload?: {
    trackingCompany?: string;
    trackingNumber?: string;
    trackingUrl?: string;
    notifyCustomer?: boolean;
  },
): Promise<'FULFILLED'> {
  if (
    !hasShopifyScope(i, 'write_fulfillments') ||
    !hasShopifyScope(i, 'read_merchant_managed_fulfillment_orders')
  )
    throw new ProviderError(
      'Shopify fulfillment write scopes are not granted. Enable fulfillment scopes and reconnect Shopify in Integrations.',
    );
  const data = fulfillmentOrdersResponseSchema.parse(
    await shopifyGraphql(
      i,
      'query RelayOrderHolds($id: ID!) { order(id: $id) { fulfillmentOrders(first: 20) { nodes { id status fulfillmentHolds { id handle heldByRequestingApp reason } } } } }',
      { id: `gid://shopify/Order/${order.shopifyOrderId}` },
    ),
  );
  if (!data.order) throw new ProviderError('Shopify order is unavailable');
  const nodes = data.order.fulfillmentOrders.nodes;
  if (nodes.some((fo) => fo.status === 'ON_HOLD'))
    throw new ProviderError(
      'Fulfillment is currently on hold in Shopify. Release the hold before fulfilling.',
    );
  const targets = nodes.filter((fo) => ['OPEN', 'IN_PROGRESS', 'SCHEDULED'].includes(fo.status));
  if (!targets.length)
    throw new ProviderError('No open Shopify fulfillment orders remain to fulfill');
  const trackingInfo = buildTrackingInput(payload);
  const res = z
    .object({
      fulfillmentCreate: z.object({
        fulfillment: z.object({ id: z.string() }).nullish(),
        userErrors: z.array(z.object({ message: z.string() })),
      }),
    })
    .parse(
      await shopifyGraphql(
        i,
        'mutation RelayFulfillmentCreate($fulfillment: FulfillmentInput!) { fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id status } userErrors { message } } }',
        {
          fulfillment: {
            lineItemsByFulfillmentOrder: targets.map((fo) => ({ fulfillmentOrderId: fo.id })),
            notifyCustomer: payload?.notifyCustomer ?? false,
            ...(trackingInfo ? { trackingInfo } : {}),
          },
        },
      ),
    );
  if (res.fulfillmentCreate.userErrors.length)
    throw new ProviderError(
      res.fulfillmentCreate.userErrors.map((e) => e.message).join('; ') ||
        'Shopify could not fulfill this order',
    );
  return 'FULFILLED';
}

const activeFulfillmentsSchema = z.object({
  order: z
    .object({
      fulfillments: z.array(
        z.object({
          id: z.string(),
          status: z.string(),
        }),
      ),
    })
    .nullable(),
});

async function latestActiveFulfillmentId(i: Integration, order: Order): Promise<string> {
  if (!hasShopifyScope(i, 'write_fulfillments'))
    throw new ProviderError(
      'Shopify write_fulfillments permission is not granted. Enable fulfillment scopes and reconnect Shopify in Integrations.',
    );
  const data = activeFulfillmentsSchema.parse(
    await shopifyGraphql(
      i,
      'query RelayOrderFulfillments($id: ID!) { order(id: $id) { fulfillments(first: 10) { id status } } }',
      { id: `gid://shopify/Order/${order.shopifyOrderId}` },
    ),
  );
  if (!data.order) throw new ProviderError('Shopify order is unavailable');
  const active = [...data.order.fulfillments]
    .reverse()
    .find((f) => f.status.toUpperCase() === 'SUCCESS');
  if (!active)
    throw new ProviderError(
      'Fulfill the order first before updating tracking or marking delivered',
    );
  return active.id;
}

export async function updateFulfillmentTracking(
  i: Integration,
  order: Order,
  payload: {
    trackingCompany?: string;
    trackingNumber?: string;
    trackingUrl?: string;
    notifyCustomer?: boolean;
  },
): Promise<'UPDATED'> {
  const trackingInfoInput = buildTrackingInput(payload);
  if (!trackingInfoInput)
    throw new ProviderError('Provide a courier, tracking number, or tracking URL');
  const fulfillmentId = await latestActiveFulfillmentId(i, order);
  const res = z
    .object({
      fulfillmentTrackingInfoUpdate: z.object({
        userErrors: z.array(z.object({ message: z.string() })),
      }),
    })
    .parse(
      await shopifyGraphql(
        i,
        'mutation RelayUpdateTracking($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) { fulfillmentTrackingInfoUpdate(fulfillmentId: $fulfillmentId, trackingInfoInput: $trackingInfoInput, notifyCustomer: $notifyCustomer) { fulfillment { id } userErrors { message } } }',
        {
          fulfillmentId,
          trackingInfoInput,
          notifyCustomer: payload.notifyCustomer ?? false,
        },
      ),
    );
  if (res.fulfillmentTrackingInfoUpdate.userErrors.length)
    throw new ProviderError(
      res.fulfillmentTrackingInfoUpdate.userErrors.map((e) => e.message).join('; ') ||
        'Shopify could not update fulfillment tracking',
    );
  return 'UPDATED';
}

export async function createFulfillmentDeliveredEvent(
  i: Integration,
  order: Order,
): Promise<'DELIVERED'> {
  let fulfillmentId: string;
  try {
    fulfillmentId = await latestActiveFulfillmentId(i, order);
  } catch (err) {
    // If order has no active fulfillment in Shopify yet, fulfill it first
    await createShopifyFulfillment(i, order);
    fulfillmentId = await latestActiveFulfillmentId(i, order);
  }
  const res = z
    .object({
      fulfillmentEventCreate: z.object({
        userErrors: z.array(z.object({ message: z.string() })),
      }),
    })
    .parse(
      await shopifyGraphql(
        i,
        'mutation RelayMarkDelivered($fulfillmentEvent: FulfillmentEventInput!) { fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) { fulfillmentEvent { id status } userErrors { message } } }',
        {
          fulfillmentEvent: {
            fulfillmentId,
            status: 'DELIVERED',
            happenedAt: new Date().toISOString(),
          },
        },
      ),
    );
  if (res.fulfillmentEventCreate.userErrors.length)
    throw new ProviderError(
      res.fulfillmentEventCreate.userErrors.map((e) => e.message).join('; ') ||
        'Shopify could not record delivery event',
    );
  return 'DELIVERED';
}

export async function validateUtilityTemplate(
  i: Integration,
  options: {
    templateName: string;
    languageCode: string;
    expectedVariables: number;
    requireUrlButton?: boolean;
  },
): Promise<{ body: string; hasUrlButton: boolean }> {
  const { templateName, languageCode, expectedVariables, requireUrlButton } = options;
  if (
    !/^[a-z0-9_]{1,100}$/.test(templateName) ||
    !/^[a-z]{2}(?:_[A-Z]{2})?$/.test(languageCode) ||
    !/^\d+$/.test(i.wabaId) ||
    !i.whatsappToken
  )
    throw new ProviderError(
      'Save a connected WhatsApp Business Account ID, token, template name, and language code first',
    );
  const raw = await request(
    `https://graph.facebook.com/${config.metaVersion}/${i.wabaId}/message_templates?name=${encodeURIComponent(templateName)}&limit=100`,
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
              buttons: z
                .array(
                  z.object({
                    type: z.string(),
                    text: z.string().optional(),
                    url: z.string().optional(),
                  }),
                )
                .optional(),
            }),
          ),
        }),
      ),
    })
    .parse(raw).data;
  const template = templates.find(
    (t) => t.name === templateName && t.language === languageCode && t.status === 'APPROVED',
  );
  if (!template)
    throw new ProviderError(
      `Template "${templateName}" (${languageCode}) was not found as APPROVED in this WhatsApp Business Account`,
    );
  const header = template.components.find((c) => c.type === 'HEADER');
  if (header && header.text && /\{\{\d+\}\}/.test(header.text))
    throw new ProviderError(
      'Utility templates with variable header placeholders are not supported',
    );
  const body = template.components.find((c) => c.type === 'BODY')?.text ?? '';
  const foundVars = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1]);
  const expectedOrder = Array.from({ length: expectedVariables }, (_, idx) => String(idx + 1));
  if (foundVars.join(',') !== expectedOrder.join(','))
    throw new ProviderError(
      `Template body must contain ${expectedVariables} ordered variable(s) ({{1}}..{{${expectedVariables}}}); found ${foundVars.length}.`,
    );
  const buttons = template.components.find((c) => c.type === 'BUTTONS')?.buttons ?? [];
  const hasUrlButton = buttons.some(
    (b) => b.type === 'URL' && typeof b.url === 'string' && b.url.includes('{{1}}'),
  );
  if (requireUrlButton && !hasUrlButton)
    throw new ProviderError(
      'Dynamic tracking URL button is enabled, but the approved Meta template does not contain a dynamic URL button with {{1}}.',
    );
  return { body, hasUrlButton };
}

export async function sendUtilityNotification(
  i: Integration,
  params: {
    recipient: string;
    templateName: string;
    languageCode: string;
    bodyValues: string[];
    dynamicUrlSuffix?: string;
    correlationId?: string;
  },
): Promise<string> {
  if (!/^\d+$/.test(i.phoneNumberId) || !i.whatsappToken || !i.whatsappVerifiedAt)
    throw new ProviderError('Save and verify the WhatsApp connection first');
  const components: Record<string, unknown>[] = [];
  if (params.bodyValues.length) {
    components.push({
      type: 'body',
      parameters: params.bodyValues.map((value) => ({
        type: 'text',
        text:
          value
            .replace(/[\r\n\t]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 500) || 'Not available',
      })),
    });
  }
  if (params.dynamicUrlSuffix !== undefined) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: params.dynamicUrlSuffix.trim().slice(0, 500) }],
    });
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
        to: params.recipient,
        biz_opaque_callback_data: params.correlationId,
        type: 'template',
        template: {
          name: params.templateName,
          language: { code: params.languageCode },
          ...(components.length ? { components } : {}),
        },
      }),
    },
    true,
  );
  return metaMessageId(result);
}
