import { z } from 'zod';
import { config } from '../config.js';
import { decrypt } from '../utils/security.js';
import type { Integration, Order } from '../models/types.js';

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
export async function addOrderTag(i: Integration, order: Order): Promise<void> {
  const data = z
    .object({ tagsAdd: z.object({ userErrors: z.array(z.object({ message: z.string() })) }) })
    .parse(
      await shopifyGraphql(
        i,
        'mutation Tags($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { node { id } userErrors { message } } }',
        { id: `gid://shopify/Order/${order.shopifyOrderId}`, tags: ['COD-CONFIRMED'] },
      ),
    );
  if (data.tagsAdd.userErrors.length)
    throw new ProviderError('Shopify could not apply the confirmation tag');
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
): Promise<void> {
  const id = 'gid://shopify/Order/' + order.shopifyOrderId;
  const removed = z
    .object({ tagsRemove: z.object({ userErrors: z.array(z.object({ message: z.string() })) }) })
    .parse(
      await shopifyGraphql(
        i,
        'mutation CancellationTagsRemove($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }',
        { id, tags: completed ? ['COD-CONFIRMED', 'CANCELLATION-REQUESTED'] : ['COD-CONFIRMED'] },
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
          { id, tags: ['CANCELLATION-REQUESTED'] },
        ),
      );
    if (added.tagsAdd.userErrors.length)
      throw new ProviderError('Shopify could not apply the cancellation request tag');
  }
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
