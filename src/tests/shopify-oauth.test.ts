import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createApp } from '../app.js';
import { drainInbox } from '../services/inbox-worker.js';
import { config } from '../config.js';
import { issueToken } from '../middlewares/auth.js';
import { createStore, getStore, mutate, publicWorkspace } from '../services/repository.js';
import { emptyWorkspace } from '../services/seed.js';
import { decrypt, encrypt } from '../utils/security.js';
import { assertScopes, freshShopifyIntegration } from '../services/shopify-tokens.js';

let server: Server;
let base: string;
const realFetch = globalThis.fetch;
let exchanges = 0;
let grantedScope = 'write_orders,read_legal_policies';
let providerFails = false;
let refreshes = 0;
const subscriptions: { id: string; topic: string; uri: string }[] = [];
before(async () => {
  config.demo = false;
  config.shopifyClientId = 'test-relay-client';
  config.shopifySecret = 'test-relay-secret';
  config.appUrl = 'https://relay-test.example';
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (
      !url.endsWith('.myshopify.com/admin/oauth/access_token') &&
      !url.includes('.myshopify.com/admin/api/')
    )
      return realFetch(input, init);
    if (url.endsWith('/admin/oauth/access_token')) {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('client_secret'), config.shopifySecret);
      if (body.get('grant_type') === 'refresh_token') refreshes++;
      else {
        exchanges++;
        assert.equal(body.get('expiring'), '1');
      }
      return providerFails
        ? Response.json({ error: 'denied' }, { status: 401 })
        : Response.json({
            access_token: 'shopify-offline-token',
            scope: grantedScope,
            refresh_token: 'shopify-refresh-token',
            expires_in: 86400,
            refresh_token_expires_in: 7776000,
          });
    }
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    if (body.query.includes('webhookSubscriptionCreate')) {
      const entry = {
        id: randomUUID(),
        topic: String(body.variables.topic),
        uri: String((body.variables.input as { uri: string }).uri),
      };
      subscriptions.push(entry);
      return Response.json({ data: { webhookSubscriptionCreate: { userErrors: [] } } });
    }
    if (body.query.includes('webhookSubscriptions('))
      return Response.json({
        data: { webhookSubscriptions: { nodes: subscriptions, pageInfo: { hasNextPage: false } } },
      });
    return Response.json({ data: { shop: { name: 'OAuth test shop' } } });
  };
  await new Promise<void>((resolve) => {
    server = createApp().listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  base = `http://127.0.0.1:${address.port}/api`;
});
after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});
async function merchant() {
  const id = randomUUID();
  await createStore({
    merchant: {
      id,
      email: `${id}@oauth.invalid`,
      passwordHash: '',
      brandName: 'OAuth test',
      subscriptionStatus: 'ACTIVE',
      createdAt: new Date().toISOString(),
      trialEndsAt: new Date().toISOString(),
    },
    workspace: emptyWorkspace(),
  });
  return { id, cookie: `relay_session=${await issueToken(id)}` };
}
async function request(path: string, cookie = '', body?: unknown) {
  return realFetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
}
async function begin(
  owner: Awaited<ReturnType<typeof merchant>>,
  shop = `store-${randomUUID()}.myshopify.com`,
  includeFulfillmentScopes = false,
) {
  const response = await request('/integrations/shopify/connect', owner.cookie, {
    shopDomain: shop,
    ...(includeFulfillmentScopes ? { includeFulfillmentScopes: true } : {}),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const authorization = new URL(body.authorizationUrl);
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  return { shop, cookie, state: authorization.searchParams.get('state')!, authorization, response };
}
function callback(flow: Awaited<ReturnType<typeof begin>>, changes: Record<string, string> = {}) {
  const values = {
    shop: flow.shop,
    state: flow.state,
    code: 'one-time-code',
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...changes,
  };
  const message = Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const hmac = createHmac('sha256', config.shopifySecret).update(message).digest('hex');
  return '/integrations/shopify/callback?' + new URLSearchParams({ ...values, hmac });
}

test('OAuth start requires a merchant session and a valid Shopify domain', async () => {
  assert.equal(
    (await request('/integrations/shopify/connect', '', { shopDomain: 'shop.myshopify.com' }))
      .status,
    401,
  );
  const owner = await merchant();
  for (const domain of [
    'https://evil.example',
    'shop.myshopify.com.evil.example',
    'shop.myshopify.com/path',
    'shop.myshopify.com:443',
  ])
    assert.equal(
      (await request('/integrations/shopify/connect', owner.cookie, { shopDomain: domain })).status,
      400,
    );
});
test('OAuth uses a secure browser nonce and exact configured HTTPS callback', async () => {
  const owner = await merchant();
  const flow = await begin(owner);
  assert.equal(
    flow.authorization.searchParams.get('redirect_uri'),
    `${config.appUrl}/api/integrations/shopify/callback`,
  );
  assert.equal(flow.authorization.searchParams.get('scope'), 'write_orders,read_legal_policies');
  assert.equal(flow.state.length, 43);
  assert.match(flow.response.headers.get('set-cookie')!, /HttpOnly/);
  assert.match(flow.response.headers.get('set-cookie')!, /SameSite=Lax/);
  assert.match(flow.response.headers.get('set-cookie')!, /Secure/);
  config.appUrl = 'http://127.0.0.1:5173';
  assert.equal(
    (await request('/integrations/shopify/connect', owner.cookie, { shopDomain: flow.shop }))
      .status,
    400,
  );
  config.appUrl = 'https://relay-test.example';
});
test('forged, duplicated, stale, and wrong-browser callbacks never exchange a token', async () => {
  const flow = await begin(await merchant());
  const count = exchanges;
  assert.equal((await request(callback(flow), '')).status, 400);
  assert.equal(
    (await request(callback(flow), 'relay_shopify_oauth=' + 'x'.repeat(43))).status,
    400,
  );
  assert.equal(
    (await request(callback(flow).replace('code=one-time-code', 'code=tampered'), flow.cookie))
      .status,
    400,
  );
  assert.equal(
    (await request(callback(flow) + '&shop=other.myshopify.com', flow.cookie)).status,
    400,
  );
  assert.equal(
    (
      await request(
        callback(flow, { timestamp: String(Math.floor(Date.now() / 1000) - 3600) }),
        flow.cookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (await request(callback(flow, { shop: 'different.myshopify.com' }), flow.cookie)).status,
    400,
  );
  assert.equal(exchanges, count);
});
test('valid callback binds encrypted tokens to the initiating merchant and rejects replay', async () => {
  const a = await merchant();
  const b = await merchant();
  const flow = await begin(a);
  const response = await request(callback(flow), `${flow.cookie}; ${b.cookie}`);
  assert.equal(response.status, 303);
  assert.match(response.headers.get('location')!, /shopify=connected/);
  const saved = (await getStore(a.id))!.workspace;
  assert.equal(saved.integration.shopDomain, flow.shop);
  assert.equal(decrypt(saved.integration.shopifyToken), 'shopify-offline-token');
  assert.equal(decrypt(saved.integration.shopifyRefreshToken!), 'shopify-refresh-token');
  assert.equal((await getStore(b.id))!.workspace.integration.shopifyToken, '');
  assert.ok(
    !JSON.stringify(publicWorkspace(saved)).includes(saved.integration.shopifyRefreshToken!),
  );
  const count = exchanges;
  assert.equal((await request(callback(flow), flow.cookie)).status, 400);
  assert.equal(exchanges, count);
  assert.equal(
    (await request('/integrations/shopify/connect', b.cookie, { shopDomain: flow.shop })).status,
    400,
  );
});
test('provider rejection and missing scopes do not leave a verified connection', async () => {
  const owner = await merchant();
  let flow = await begin(owner);
  providerFails = true;
  let response = await request(callback(flow), flow.cookie);
  assert.match(response.headers.get('location')!, /shopify=failed/);
  assert.equal((await getStore(owner.id))!.workspace.integration.shopifyToken, '');
  providerFails = false;
  grantedScope = 'read_orders';
  flow = await begin(owner);
  response = await request(callback(flow), flow.cookie);
  assert.match(response.headers.get('location')!, /shopify=failed/);
  assert.equal((await getStore(owner.id))!.workspace.integration.shopifyToken, '');
  grantedScope = 'write_orders,read_legal_policies';
});
test('expired offline tokens refresh and refreshed secrets stay server-side', async () => {
  const owner = await merchant();
  const flow = await begin(owner);
  await request(callback(flow), flow.cookie);
  await mutate(owner.id, (s) => {
    s.workspace.integration.shopifyTokenExpiresAt = new Date(Date.now() - 1000).toISOString();
  });
  const beforeRefresh = refreshes;
  const fresh = await freshShopifyIntegration(owner.id);
  assert.equal(refreshes, beforeRefresh + 1);
  assert.ok(Date.parse(fresh.shopifyTokenExpiresAt!) > Date.now());
  await freshShopifyIntegration(owner.id);
  assert.equal(refreshes, beforeRefresh + 1);
  assert.ok(
    !JSON.stringify(publicWorkspace((await getStore(owner.id))!.workspace)).includes(
      fresh.shopifyRefreshToken!,
    ),
  );
});
test('webhook registration is tenant-scoped and idempotent', async () => {
  const owner = await merchant();
  const flow = await begin(owner);
  await request(callback(flow), flow.cookie);
  subscriptions.length = 0;
  assert.equal((await request('/integrations/shopify/webhooks', owner.cookie, {})).status, 200);
  assert.equal(subscriptions.length, 8);
  assert.equal((await request('/integrations/shopify/webhooks', owner.cookie, {})).status, 200);
  assert.equal(subscriptions.length, 8);
  assert.equal(
    (await getStore(owner.id))!.workspace.integration.shopifyWebhooksUrl,
    `${config.appUrl}/api/webhooks/shopify`,
  );
});
test('optional fulfillment scopes request and register extended webhook topics', async () => {
  const owner = await merchant();
  const flow = await begin(owner, undefined, true);
  assert.equal(
    flow.authorization.searchParams.get('scope'),
    'write_orders,read_legal_policies,write_fulfillments,write_merchant_managed_fulfillment_orders',
  );
  grantedScope =
    'write_orders,read_legal_policies,write_fulfillments,write_merchant_managed_fulfillment_orders';
  try {
    const cb = await request(callback(flow), flow.cookie);
    assert.equal(cb.status, 303);
    assert.match(cb.headers.get('location')!, /shopify=connected/);
    const saved = (await getStore(owner.id))!.workspace.integration;
    assert.deepEqual(saved.shopifyScopes, [
      'write_orders',
      'read_legal_policies',
      'write_fulfillments',
      'write_merchant_managed_fulfillment_orders',
    ]);
    subscriptions.length = 0;
    const wh = await request('/integrations/shopify/webhooks', owner.cookie, {});
    assert.equal(wh.status, 200);
    assert.equal(subscriptions.length, 15);
    assert.ok(subscriptions.some((s) => s.topic === 'FULFILLMENT_EVENTS_CREATE'));
    assert.ok(subscriptions.some((s) => s.topic === 'FULFILLMENT_ORDERS_PLACED_ON_HOLD'));
    assert.ok(subscriptions.some((s) => s.topic === 'FULFILLMENT_ORDERS_HOLD_RELEASED'));
    // Second call remains idempotent with no duplicate subscriptions created.
    assert.equal((await request('/integrations/shopify/webhooks', owner.cookie, {})).status, 200);
    assert.equal(subscriptions.length, 15);
  } finally {
    grantedScope = 'write_orders,read_legal_policies';
  }
});
test('manual tokens cannot bypass Shopify authorization in connected mode', async () => {
  const owner = await merchant();
  const response = await request('/integrations', owner.cookie, {
    shopDomain: 'manual.myshopify.com',
    shopifyToken: 'injected-token',
    phoneNumberId: '',
    wabaId: '',
    templateName: 'test_template',
    languageCode: 'en_US',
  });
  assert.equal(response.status, 400);
  assert.equal((await getStore(owner.id))!.workspace.integration.shopifyToken, '');
});
test('write scope satisfies its matching read scope', () => {
  assert.doesNotThrow(() => assertScopes('write_orders', ['read_orders']));
  assert.throws(() => assertScopes('read_orders', ['write_orders']));
});
test('uninstall clears both access and refresh credentials', async () => {
  const owner = await merchant();
  const flow = await begin(owner);
  await request(callback(flow), flow.cookie);
  const body = '{}';
  const signature = createHmac('sha256', config.shopifySecret).update(body).digest('base64');
  const response = await realFetch(`${base}/webhooks/shopify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': signature,
      'X-Shopify-Shop-Domain': flow.shop,
      'X-Shopify-Webhook-Id': randomUUID(),
      'X-Shopify-Topic': 'app/uninstalled',
    },
    body,
  });
  assert.equal(response.status, 200);
  await drainInbox();
  const i = (await getStore(owner.id))!.workspace.integration;
  assert.equal(i.shopifyToken, '');
  assert.equal(i.shopifyRefreshToken, undefined);
  assert.ok(!i.shopifyVerifiedAt);
});
test('expired refresh credentials require reconnect rather than another provider request', async () => {
  const owner = await merchant();
  await mutate(owner.id, (s) =>
    Object.assign(s.workspace.integration, {
      shopDomain: 'expired.myshopify.com',
      shopifyToken: encrypt('expired'),
      shopifyRefreshToken: encrypt('refresh'),
      shopifyTokenExpiresAt: new Date(0).toISOString(),
      shopifyRefreshExpiresAt: new Date(0).toISOString(),
    }),
  );
  const count = refreshes;
  await assert.rejects(freshShopifyIntegration(owner.id), /expired/);
  assert.equal(refreshes, count);
});
