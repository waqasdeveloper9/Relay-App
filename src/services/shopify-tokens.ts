import { z } from 'zod';
import { config } from '../config.js';
import { decrypt, encrypt } from '../utils/security.js';
import { InputError } from '../utils/errors.js';
import { acquireRefreshLease, getStore, mutate, releaseRefreshLease } from './repository.js';
import { ProviderError } from './providers.js';
import type { Integration } from '../models/types.js';

export const shopDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(255)
  .regex(
    /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/,
    'Enter a store.myshopify.com domain without a URL path',
  );
const tokenSchema = z
  .object({
    access_token: z.string().min(1),
    scope: z.string(),
    expires_in: z.number().int().positive().optional(),
    refresh_token: z.string().min(1).optional(),
    refresh_token_expires_in: z.number().int().positive().optional(),
  })
  .refine(
    (t) => !t.expires_in || !!t.refresh_token,
    'Expiring access tokens must include a refresh token',
  );
export type ShopifyTokens = z.infer<typeof tokenSchema>;
export function assertScopes(granted: string, required = config.shopifyScopes): void {
  const scopes = granted.split(',').map((s) => s.trim());
  if (
    required.some(
      (scope) =>
        !scopes.includes(scope) &&
        !(scope.startsWith('read_') && scopes.includes(`write_${scope.slice(5)}`)),
    )
  )
    throw new InputError(
      'Shopify did not grant the required order permissions. Reconnect and approve access.',
    );
}
export async function requestShopifyToken(
  shop: string,
  parameters: Record<string, string>,
): Promise<ShopifyTokens> {
  shopDomainSchema.parse(shop);
  let response: Response;
  try {
    response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: config.shopifyClientId,
        client_secret: config.shopifySecret,
        ...parameters,
      }),
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
  } catch {
    throw new ProviderError(
      'Shopify authorization could not be reached. Please try connecting again.',
    );
  }
  if (!response.ok)
    throw new ProviderError(
      `Shopify token exchange returned HTTP ${response.status}. Reconnect the store or review app credentials.`,
    );
  const parsed = tokenSchema.safeParse(await response.json());
  if (!parsed.success)
    throw new ProviderError('Shopify returned an incomplete token response. Reconnect the store.');
  assertScopes(parsed.data.scope);
  return parsed.data;
}
export function encryptedTokenFields(tokens: ShopifyTokens) {
  return {
    shopifyToken: encrypt(tokens.access_token),
    shopifyRefreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : undefined,
    shopifyTokenExpiresAt: tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : undefined,
    shopifyRefreshExpiresAt: tokens.refresh_token_expires_in
      ? new Date(Date.now() + tokens.refresh_token_expires_in * 1000).toISOString()
      : undefined,
    shopifyScopes: tokens.scope
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
export async function freshShopifyIntegration(merchantId: string): Promise<Integration> {
  const store = await getStore(merchantId);
  if (!store?.workspace.integration.shopifyToken)
    throw new InputError('Connect your Shopify store first.');
  const i = store.workspace.integration;
  if (!i.shopifyTokenExpiresAt || Date.parse(i.shopifyTokenExpiresAt) > Date.now() + 60000)
    return i;
  if (
    !i.shopifyRefreshToken ||
    (i.shopifyRefreshExpiresAt && Date.parse(i.shopifyRefreshExpiresAt) <= Date.now())
  )
    throw new InputError('Shopify authorization expired. Reconnect your store.');
  if (!(await acquireRefreshLease(merchantId)))
    throw new ProviderError('Shopify authorization is being refreshed. Try again shortly.');
  try {
    const latest = (await getStore(merchantId))!.workspace.integration;
    if (
      latest.shopifyTokenExpiresAt &&
      Date.parse(latest.shopifyTokenExpiresAt) > Date.now() + 60000
    )
      return latest;
    if (!latest.shopifyRefreshToken) throw new InputError('Reconnect your Shopify store.');
    const tokens = await requestShopifyToken(latest.shopDomain, {
      grant_type: 'refresh_token',
      refresh_token: decrypt(latest.shopifyRefreshToken),
    });
    return await mutate(merchantId, (s) => {
      if (s.workspace.integration.shopifyToken !== latest.shopifyToken)
        throw new InputError('Shopify connection changed during refresh. Try again.');
      Object.assign(s.workspace.integration, encryptedTokenFields(tokens));
      return structuredClone(s.workspace.integration);
    });
  } finally {
    await releaseRefreshLease(merchantId);
  }
}
