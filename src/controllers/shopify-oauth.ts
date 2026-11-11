import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import {
  getStore,
  listStores,
  mutate,
  saveOAuthAttempt,
  consumeOAuthAttempt,
} from '../services/repository.js';
import { activity } from '../services/automation.js';
import { checkShopify } from '../services/providers.js';
import {
  encryptedTokenFields,
  freshShopifyIntegration,
  requestShopifyToken,
  shopDomainSchema,
} from '../services/shopify-tokens.js';
import { issueToken, setSession } from '../middlewares/auth.js';
import { InputError } from '../utils/errors.js';
import { ensureShopifyWebhooks } from '../services/shopify-webhooks.js';

const callbackPath = '/api/integrations/shopify/callback';
const nonceCookie = 'relay_shopify_oauth';
const expiresMs = 10 * 60000;
export function publicOAuthConfig() {
  const url = new URL(config.appUrl);
  const https = url.protocol === 'https:';
  return {
    configured: !!config.shopifyClientId && !!config.shopifySecret && https && !config.demo,
    appUrl: url.origin,
    callbackUrl: `${url.origin}${callbackPath}`,
    webhookUrl: `${(config.webhookUrl || url.origin).replace(/\/$/, '')}/api/webhooks/shopify`,
    scopes: config.shopifyScopes,
    fulfillmentScopes: config.shopifyFulfillmentScopes,
    reason: config.demo
      ? 'OAuth is unavailable in demo mode.'
      : !https
        ? 'Configure a public HTTPS app URL to connect Shopify.'
        : !config.shopifyClientId || !config.shopifySecret
          ? 'The Relay app credentials are not configured on the server.'
          : null,
  };
}
export function oauthConfig(_req: Request, res: Response): void {
  res.json(publicOAuthConfig());
}
function stateHash(state: string) {
  return createHash('sha256').update(state).digest('hex');
}
function cookieOptions() {
  return {
    httpOnly: true,
    secure: config.appUrl.startsWith('https:'),
    sameSite: 'lax' as const,
    path: '/api/integrations/shopify',
    maxAge: expiresMs,
  };
}
function nonceFromCookie(req: Request): string | undefined {
  return (req.headers.cookie ?? '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${nonceCookie}=`))
    ?.slice(nonceCookie.length + 1);
}
export async function beginOAuth(req: Request, res: Response): Promise<void> {
  const options = publicOAuthConfig();
  if (!options.configured)
    throw new InputError(options.reason ?? 'Shopify OAuth is not configured.');
  const { shopDomain, includeFulfillmentScopes } = z
    .object({ shopDomain: shopDomainSchema, includeFulfillmentScopes: z.boolean().optional() })
    .parse(req.body);
  if (
    (await listStores()).some(
      (s) => s.merchant.id !== req.merchantId && s.workspace.integration.shopDomain === shopDomain,
    )
  )
    throw new InputError('This Shopify store is already linked to another workspace.');
  const existing = req.store.workspace.integration;
  if (
    existing.shopDomain &&
    existing.shopDomain !== shopDomain &&
    req.store.workspace.orders.length
  )
    throw new InputError(
      'This workspace already contains another store’s orders. Create a separate workspace for a different store.',
    );
  const state = randomBytes(32).toString('base64url');
  await saveOAuthAttempt({
    stateHash: stateHash(state),
    merchantId: req.merchantId,
    shopDomain,
    expiresAt: new Date(Date.now() + expiresMs),
  });
  res.cookie(nonceCookie, state, cookieOptions());
  const requestedScopes = [
    ...new Set([
      ...config.shopifyScopes,
      ...(includeFulfillmentScopes ? config.shopifyFulfillmentScopes : []),
    ]),
  ];
  const url = new URL(`https://${shopDomain}/admin/oauth/authorize`);
  url.search = new URLSearchParams({
    client_id: config.shopifyClientId,
    scope: requestedScopes.join(','),
    redirect_uri: options.callbackUrl,
    state,
  }).toString();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ authorizationUrl: url.toString() });
}
export function validateShopifyCallback(
  originalUrl: string,
  cookie: string | undefined,
): Record<string, string> {
  const params = new URL(originalUrl, 'http://localhost').searchParams;
  const values: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(values, key))
      throw new InputError('Duplicate OAuth callback parameters are not allowed.');
    values[key] = value;
  }
  const { hmac, state, shop, timestamp, code } = values;
  if (
    !state ||
    !/^[A-Za-z0-9_-]{43}$/.test(state) ||
    !cookie ||
    state.length !== cookie.length ||
    !timingSafeEqual(Buffer.from(state), Buffer.from(cookie))
  )
    throw new InputError(
      'Shopify authorization state is missing or does not match this browser. Start again from Integrations.',
    );
  shopDomainSchema.parse(shop);
  if (!hmac || !/^[a-f0-9]{64}$/i.test(hmac) || !config.shopifySecret)
    throw new InputError('Invalid Shopify callback signature.');
  const message = Object.keys(values)
    .filter((k) => k !== 'hmac')
    .sort()
    .map((k) => `${k}=${values[k]}`)
    .join('&');
  const expected = createHmac('sha256', config.shopifySecret).update(message).digest();
  if (!timingSafeEqual(expected, Buffer.from(hmac, 'hex')))
    throw new InputError('Invalid Shopify callback signature.');
  if (
    !timestamp ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(Date.now() - Number(timestamp) * 1000) > expiresMs
  )
    throw new InputError('Shopify authorization has expired. Start again from Integrations.');
  if (!code || code.length > 2048)
    throw new InputError('Shopify did not supply an authorization code.');
  return values;
}
export async function completeOAuth(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const values = validateShopifyCallback(req.originalUrl, nonceFromCookie(req));
  const attempt = await consumeOAuthAttempt(stateHash(values.state!), values.shop!);
  if (!attempt)
    throw new InputError(
      'This authorization was already used or expired. Start again from Integrations.',
    );
  res.clearCookie(nonceCookie, { ...cookieOptions(), maxAge: undefined });
  const destination = new URL(config.appUrl);
  destination.searchParams.set('page', 'integrations');
  try {
    const original = await getStore(attempt.merchantId);
    if (!original) throw new InputError('Workspace no longer exists.');
    const tokens = await requestShopifyToken(attempt.shopDomain, {
      code: values.code!,
      expiring: '1',
    });
    const fields = encryptedTokenFields(tokens);
    const integration = {
      ...original.workspace.integration,
      shopDomain: attempt.shopDomain,
      ...fields,
    };
    await checkShopify(integration);
    await mutate(attempt.merchantId, (s) => {
      const current = s.workspace.integration;
      if (
        current.shopDomain &&
        current.shopDomain !== attempt.shopDomain &&
        s.workspace.orders.length
      )
        throw new InputError('Another store is already linked to this workspace.');
      Object.assign(current, fields, {
        shopDomain: attempt.shopDomain,
        shopifyVerifiedAt: new Date().toISOString(),
        shopifyWebhooksVerifiedAt: undefined,
        shopifyWebhooksUrl: undefined,
      });
      activity(s.workspace, `Shopify store ${attempt.shopDomain} connected through authorization`);
    });
    // The one-time browser nonce identifies the initiating merchant even when
    // the regular SameSite=Strict session cookie is absent on Shopify's redirect.
    setSession(res, await issueToken(attempt.merchantId));
    destination.searchParams.set('shopify', 'connected');
  } catch {
    destination.searchParams.set('shopify', 'failed');
  }
  res.redirect(303, destination.toString());
}
export async function registerWebhooks(req: Request, res: Response): Promise<void> {
  if (!publicOAuthConfig().configured)
    throw new InputError('A public HTTPS app URL and Relay credentials are required.');
  const integration = await freshShopifyIntegration(req.merchantId);
  const webhookUrl = publicOAuthConfig().webhookUrl;
  const topics = await ensureShopifyWebhooks(integration, webhookUrl);
  await mutate(req.merchantId, (s) => {
    if (s.workspace.integration.shopDomain !== integration.shopDomain)
      throw new InputError('Store connection changed. Try again.');
    s.workspace.integration.shopifyWebhooksVerifiedAt = new Date().toISOString();
    s.workspace.integration.shopifyWebhooksUrl = webhookUrl;
    activity(
      s.workspace,
      `Shopify webhooks verified (${topics.length} topic${topics.length === 1 ? '' : 's'})`,
    );
  });
  res.json({
    ok: true,
    topics,
    message: `${topics.length} Shopify order, fulfillment, and uninstall webhooks are registered for this URL.`,
  });
}
