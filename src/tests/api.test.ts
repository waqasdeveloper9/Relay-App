import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { createApp } from '../app.js';
import { config } from '../config.js';
import { getStore, mutate } from '../services/repository.js';
import type { Workspace } from '../models/types.js';
import { buttonPayload } from '../services/order-confirmation.js';
import { authWorkspaceRedirect } from '../../web/lib/auth-origin.js';

test('hosted authentication compares origins without blocking equivalent URLs', () => {
  const origin = 'https://workspace.example';
  assert.equal(authWorkspaceRedirect(origin + '/', origin, false), '');
  assert.equal(authWorkspaceRedirect(origin + '/dashboard', origin, false), '');
  assert.equal(authWorkspaceRedirect('https://WORKSPACE.example:443/', origin, false), '');
  assert.equal(authWorkspaceRedirect(origin, 'http://localhost:3001', true), '');
  assert.equal(authWorkspaceRedirect(origin, 'https://other.example', false), origin);
  assert.equal(authWorkspaceRedirect('invalid', origin, false), '');
});

let server: Server;
let base: string;
before(async () => {
  config.appUrl = 'https://relay-test.invalid';
  config.shopifySecret = 'test-shopify-secret';
  config.metaSecret = 'test-meta-secret';
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server address unavailable');
  base = `http://127.0.0.1:${address.port}/api`;
});
after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
async function request(path: string, body?: unknown, cookie = '', method = 'POST') {
  return fetch(base + path, {
    method: body === undefined ? 'GET' : method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function session() {
  const response = await request('/auth/demo', {});
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const snapshot = (await (await request('/workspace', undefined, cookie)).json()) as {
    merchant: { id: string };
    workspace: Workspace;
  };
  return { cookie, ...snapshot };
}
test('unauthenticated workspace access is rejected', async () => {
  assert.equal((await request('/workspace')).status, 401);
});

test('signed order buttons require the owning sender and sent-message context; duplicates do not repeat cancellation', async () => {
  const s = await session();
  const target = s.workspace.orders.find((o) => o.status === 'PENDING')!;
  await mutate(s.merchant.id, (store) => {
    store.workspace.integration.phoneNumberId = '123123456';
    store.workspace.jobs.push({
      id: randomUUID(),
      orderId: target.id,
      kind: 'TEST_CONFIRMATION',
      state: 'DONE',
      attempts: 1,
      dueAt: new Date().toISOString(),
      messageId: 'wamid.confirm-template',
    });
  });
  const post = async (from: string, context: string, payload: string, id: string) => {
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '123123456' },
                messages: [
                  { id, from, context: { id: context }, button: { payload, text: 'Cancel order' } },
                ],
              },
            },
          ],
        },
      ],
    });
    return fetch(base + '/webhooks/meta', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256':
          'sha256=' + createHmac('sha256', config.metaSecret).update(body).digest('hex'),
      },
      body,
    });
  };
  const payload = buttonPayload('CANCEL', target.id);
  assert.equal(
    (await post('923009999999', 'wamid.confirm-template', payload, 'wrong-sender')).status,
    200,
  );
  assert.equal((await post(target.phone, 'wrong-context', payload, 'wrong-context')).status, 200);
  assert.equal(
    (
      await post(
        target.phone,
        'wamid.confirm-template',
        payload.replace('CANCEL', 'CONFIRM'),
        'tampered',
      )
    ).status,
    200,
  );
  assert.equal(
    (await getStore(s.merchant.id))!.workspace.jobs.filter((j) => j.kind === 'CANCEL').length,
    0,
  );
  for (let n = 0; n < 2; n++)
    assert.equal(
      (await post(target.phone, 'wamid.confirm-template', payload, 'same-cancel-event')).status,
      200,
    );
  const updated = (await getStore(s.merchant.id))!;
  assert.equal(updated.workspace.orders.find((o) => o.id === target.id)!.status, 'NEEDS_REVIEW');
  assert.equal(updated.workspace.jobs.filter((j) => j.kind === 'CANCEL').length, 1);
  assert.equal(
    updated.workspace.tasks.filter((t) => t.orderId === target.id && t.kind === 'Cancellation')
      .length,
    1,
  );
});

test('reading a conversation clears unread status only in the owning workspace', async () => {
  const a = await session();
  const b = await session();
  const conversation = a.workspace.conversations.find((c) => c.unread)!;
  assert.equal((await request(`/conversations/${conversation.id}/read`, {}, b.cookie)).status, 404);
  assert.equal((await request(`/conversations/${conversation.id}/read`, {}, a.cookie)).status, 200);
  assert.equal(
    (await getStore(a.merchant.id))!.workspace.conversations.find((c) => c.id === conversation.id)!
      .unread,
    false,
  );
});
test('registration, login, cookie protection and logout work', async () => {
  const email = `${randomUUID()}@example.com`;
  const password = 'Very-secure-test-password';
  const response = await request('/auth/register', { email, password, brandName: 'A test store' });
  assert.equal(response.status, 201);
  assert.match(response.headers.get('set-cookie')!, /HttpOnly/);
  assert.match(response.headers.get('set-cookie')!, /SameSite=Strict/);
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const snapshot = await (await request('/workspace', undefined, cookie)).json();
  assert.ok(!('passwordHash' in snapshot.merchant));
  assert.equal(snapshot.workspace.orders.length, 0);
  assert.equal(
    (await request('/auth/register', { email, password, brandName: 'Duplicate' })).status,
    409,
  );
  assert.equal((await request('/auth/login', { email, password })).status, 200);
  assert.equal(
    (await request('/auth/login', { email, password: 'Incorrect-password' })).status,
    401,
  );
  const logout = await request('/auth/logout', {}, cookie);
  assert.match(logout.headers.get('set-cookie')!, /Expires=/);
});
test('cross-origin mutations are rejected', async () => {
  const response = await fetch(base + '/auth/demo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.invalid' },
    body: '{}',
  });
  assert.equal(response.status, 403);
});
test('a merchant cannot mutate another merchant order', async () => {
  const a = await session();
  const b = await session();
  assert.equal(
    (await request(`/orders/${a.workspace.orders[1]!.id}/action`, { action: 'confirm' }, b.cookie))
      .status,
    404,
  );
});
test('request verification needs approval and nonempty evidence', async () => {
  const s = await session();
  const id = s.workspace.tasks[0]!.id;
  assert.equal(
    (await request(`/tasks/${id}/action`, { action: 'verify', evidence: 'checked' }, s.cookie))
      .status,
    400,
  );
  assert.equal((await request(`/tasks/${id}/action`, { action: 'approve' }, s.cookie)).status, 200);
  assert.notEqual(
    (await request(`/tasks/${id}/action`, { action: 'verify' }, s.cookie)).status,
    200,
  );
  assert.equal(
    (
      await request(
        `/tasks/${id}/action`,
        { action: 'verify', evidence: 'Manually checked Shopify and courier reference 42' },
        s.cookie,
      )
    ).status,
    200,
  );
});
test('integration tokens are masked and demo checks do not mark a real connection verified', async () => {
  const s = await session();
  const response = await request(
    '/integrations',
    {
      shopDomain: 'test-store.myshopify.com',
      shopifyToken: 'secret-token',
      phoneNumberId: '123',
      wabaId: '456',
      whatsappToken: 'meta-token',
      templateName: 'order_confirmation_v1',
      languageCode: 'en_US',
    },
    s.cookie,
  );
  assert.equal(response.status, 200);
  const check = await (
    await request('/integrations/test', { provider: 'shopify' }, s.cookie)
  ).json();
  assert.equal(check.simulated, true);
  const snapshot = await (await request('/workspace', undefined, s.cookie)).json();
  assert.equal(snapshot.workspace.integration.hasShopifyToken, true);
  assert.ok(!JSON.stringify(snapshot).includes('secret-token'));
  assert.ok(!snapshot.workspace.integration.shopifyVerifiedAt);
});
test('signed Shopify COD events are deduplicated and do not infer messaging consent', async () => {
  const s = await session();
  const domain = `${randomUUID()}.myshopify.com`;
  await mutate(s.merchant.id, (store) => {
    store.workspace.integration.shopDomain = domain;
  });
  const body = JSON.stringify({
    id: '900001',
    name: '#900001',
    total_price: '1990.00',
    currency: 'PKR',
    payment_gateway_names: ['Cash on Delivery'],
    shipping_address: { name: 'Webhook Customer', phone: '03001234567', country_code: 'PK' },
  });
  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Shop-Domain': domain,
    'X-Shopify-Topic': 'orders/create',
    'X-Shopify-Webhook-Id': randomUUID(),
    'X-Shopify-Hmac-Sha256': createHmac('sha256', config.shopifySecret)
      .update(body)
      .digest('base64'),
  };
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await fetch(base + '/webhooks/shopify', { method: 'POST', headers, body })).status,
      200,
    );
  const updated = await getStore(s.merchant.id);
  const orders = updated!.workspace.orders.filter((o) => o.shopifyOrderId === '900001');
  assert.equal(orders.length, 1);
  assert.equal(orders[0]!.consent, false);
  assert.equal(updated!.workspace.jobs.filter((j) => j.orderId === orders[0]!.id).length, 0);
  assert.equal(
    (
      await fetch(base + '/webhooks/shopify', {
        method: 'POST',
        headers: { ...headers, 'X-Shopify-Hmac-Sha256': 'forged' },
        body,
      })
    ).status,
    401,
  );
});
test('Meta replies correlate by context, not the latest order for a shared phone', async () => {
  const s = await session();
  await mutate(s.merchant.id, (store) => {
    const w = store.workspace;
    w.integration.phoneNumberId = '99112233';
    const o = w.orders[1]!;
    w.orders[4]!.phone = o.phone;
    w.jobs.push({
      id: randomUUID(),
      orderId: o.id,
      kind: 'CONFIRMATION',
      state: 'DONE',
      attempts: 1,
      dueAt: new Date().toISOString(),
      messageId: 'wamid.original',
    });
  });
  const original = s.workspace.orders[1]!;
  const body = JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: '99112233' },
              messages: [
                {
                  id: 'wamid.reply',
                  from: original.phone,
                  text: { body: 'Confirm' },
                  context: { id: 'wamid.original' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const headers = {
    'Content-Type': 'application/json',
    'X-Hub-Signature-256': `sha256=${createHmac('sha256', config.metaSecret).update(body).digest('hex')}`,
  };
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await fetch(base + '/webhooks/meta', { method: 'POST', headers, body })).status,
      200,
    );
  const after = await getStore(s.merchant.id);
  assert.equal(after!.workspace.orders.find((o) => o.id === original.id)!.status, 'CONFIRMED');
  assert.equal(after!.workspace.orders[4]!.status, 'PENDING');
  assert.equal(
    after!.workspace.jobs.filter((j) => j.kind === 'TAG' && j.orderId === original.id).length,
    1,
  );
});

test('explicitly trusted local origins work while untrusted and lookalike origins stay blocked', async () => {
  const original = config.allowedOrigins;
  config.allowedOrigins = ['http://127.0.0.1:3001'];
  try {
    for (const [origin, expected] of [
      ['http://127.0.0.1:3001', 200],
      ['http://127.0.0.1:3001.evil.invalid', 403],
      ['http://127.0.0.1:3002', 403],
    ]) {
      const r = await fetch(base + '/auth/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin as string },
        body: '{}',
      });
      assert.equal(r.status, expected);
    }
  } finally {
    config.allowedOrigins = original;
  }
});

test('templates persist per merchant and blank token updates retain encrypted credentials', async () => {
  const a = await session();
  const b = await session();
  const body = {
    shopDomain: 'templates.myshopify.com',
    phoneNumberId: '1234',
    wabaId: '9876',
    whatsappToken: 'private-meta-value',
    templateName: 'custom_confirmation',
    languageCode: 'en',
  };
  assert.equal((await request('/integrations', body, a.cookie)).status, 200);
  const encrypted = (await getStore(a.merchant.id))!.workspace.integration.whatsappToken;
  assert.equal(
    (await request('/integrations', { ...body, whatsappToken: '' }, a.cookie)).status,
    200,
  );
  assert.equal((await getStore(a.merchant.id))!.workspace.integration.whatsappToken, encrypted);
  for (let n = 0; n < 2; n++)
    assert.equal(
      (
        await request(
          '/integrations/whatsapp/templates',
          { name: 'another_template', language: 'en_US' },
          a.cookie,
        )
      ).status,
      200,
    );
  const snapshot = await (await request('/workspace', undefined, a.cookie)).json();
  assert.equal(snapshot.workspace.integration.hasWhatsappToken, true);
  assert.equal(snapshot.workspace.integration.templateName, 'custom_confirmation');
  assert.equal(snapshot.workspace.settings.savedTemplates.length, 2);
  assert.ok(!JSON.stringify(snapshot).includes('private-meta-value'));
  assert.ok(!(await getStore(b.merchant.id))!.workspace.settings.savedTemplates?.length);
  assert.equal(
    (
      await request(
        '/integrations/whatsapp/templates',
        { name: 'invalid template', language: 'English' },
        a.cookie,
      )
    ).status,
    400,
  );
});

test('signed Meta delivery receipts update only the owning message without regressing read status', async () => {
  const a = await session();
  const b = await session();
  await mutate(a.merchant.id, (s) => {
    s.workspace.integration.phoneNumberId = '77712345';
    s.workspace.outboundMessages = [
      {
        id: randomUUID(),
        kind: 'SAMPLE',
        recipient: '923001234567',
        templateName: 'hello_world',
        languageCode: 'en_US',
        preview: 'Sample',
        status: 'ACCEPTED',
        messageId: 'wamid.receipt-test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
  });
  const post = async (
    status: string,
    timestamp: string,
    recipient = '923001234567',
    forged = false,
  ) => {
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '77712345' },
                statuses: [
                  { id: 'wamid.receipt-test', recipient_id: recipient, status, timestamp },
                ],
              },
            },
          ],
        },
      ],
    });
    return fetch(base + '/webhooks/meta', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256':
          'sha256=' +
          createHmac('sha256', forged ? 'wrong-secret' : config.metaSecret)
            .update(body)
            .digest('hex'),
      },
      body,
    });
  };
  assert.equal((await post('delivered', '1800000000', undefined, true)).status, 401);
  await post('delivered', '1800000000', '923009999999');
  assert.equal((await getStore(a.merchant.id))!.workspace.outboundMessages![0]!.status, 'ACCEPTED');
  await post('delivered', '1800000000');
  await post('read', '1800000010');
  await post('sent', '1800000020');
  await post('delivered', '1800000000');
  assert.equal((await getStore(a.merchant.id))!.workspace.outboundMessages![0]!.status, 'READ');
  assert.ok(!(await getStore(b.merchant.id))!.workspace.outboundMessages?.length);
});

test('sample requests persist accepted message IDs and enforce a reported cooldown', async () => {
  const s = await session();
  await mutate(s.merchant.id, (x) => {
    x.workspace.integration.phoneNumberId = '66612345';
    x.workspace.integration.whatsappVerifiedAt = new Date().toISOString();
  });
  const { encrypt } = await import('../utils/security.js');
  await mutate(s.merchant.id, (x) => {
    x.workspace.integration.whatsappToken = encrypt('sample-test-token');
  });
  const originalFetch = globalThis.fetch;
  const demo = config.demo;
  let sends = 0;
  globalThis.fetch = async (input, options) => {
    if (String(input).startsWith('https://graph.facebook.com/')) {
      sends++;
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.history-sample' }] }));
    }
    return originalFetch(input, options);
  };
  config.demo = false;
  try {
    const response = await request(
      '/integrations/whatsapp/test-message',
      { recipient: '+923001234567', ownVerifiedNumber: true },
      s.cookie,
    );
    assert.equal(response.status, 200);
    const messages = (await getStore(s.merchant.id))!.workspace.outboundMessages!;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.status, 'ACCEPTED');
    assert.equal(messages[0]!.messageId, 'wamid.history-sample');
    const retry = await request(
      '/integrations/whatsapp/test-message',
      { recipient: '+923001234567', ownVerifiedNumber: true },
      s.cookie,
    );
    assert.equal(retry.status, 429);
    assert.ok(Number(retry.headers.get('Retry-After')) > 0);
    assert.equal(sends, 1);
  } finally {
    globalThis.fetch = originalFetch;
    config.demo = demo;
  }
});

test('merchant webhook setup stores encrypted secrets and hashes verification tokens without exposing them', async () => {
  const s = await session();
  const secret = 'a'.repeat(32);
  const save = {
    shopDomain: '',
    phoneNumberId: '919191919',
    wabaId: '818181818',
    whatsappToken: 'fake-access',
    metaAppSecret: secret,
    templateName: 'merchant_confirmation',
    languageCode: 'en',
  };
  assert.equal((await request('/integrations', save, s.cookie)).status, 200);
  const generated = await (await request('/integrations/meta/verify-token', {}, s.cookie)).json();
  assert.equal(generated.token.length, 64);
  const snapshot = await (await request('/workspace', undefined, s.cookie)).json();
  assert.ok(!JSON.stringify(snapshot).includes(secret));
  assert.ok(!JSON.stringify(snapshot).includes(generated.token));
  assert.equal(snapshot.workspace.integration.hasMetaAppSecret, true);
  const challenge =
    '/webhooks/meta/' +
    s.merchant.id +
    '?hub.mode=subscribe&hub.challenge=checked&hub.verify_token=';
  assert.equal((await request(challenge + 'wrong')).status, 403);
  assert.equal(await (await request(challenge + generated.token)).text(), 'checked');
  assert.ok((await getStore(s.merchant.id))!.workspace.integration.metaWebhookVerifiedAt);
  const body = JSON.stringify({
    entry: [{ changes: [{ value: { metadata: { phone_number_id: '919191919' }, statuses: [] } }] }],
  });
  const post = (sign: string) =>
    fetch(base + '/webhooks/meta/' + s.merchant.id, {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', sign).update(body).digest('hex'),
      },
    });
  assert.equal((await post(config.metaSecret)).status, 401);
  assert.equal((await post(secret)).status, 200);
  assert.equal(
    (await request('/integrations', { ...save, metaAppSecret: '', whatsappToken: '' }, s.cookie))
      .status,
    200,
  );
  assert.equal(
    (await getStore(s.merchant.id))!.workspace.integration.metaAppSecret !== undefined,
    true,
  );
});
test('connected signed confirmation is durably accepted then updates Relay and Shopify through separate processing', async () => {
  const s = await session();
  const target = s.workspace.orders.find((o) => o.status === 'PENDING')!;
  const { encrypt } = await import('../utils/security.js');
  const { drainInbox } = await import('../services/inbox-worker.js');
  const { tick } = await import('../services/worker.js');
  const secret = 'b'.repeat(32);
  await mutate(s.merchant.id, (x) => {
    Object.assign(x.workspace.integration, {
      phoneNumberId: '929292929',
      shopDomain: 'reliable.myshopify.com',
      shopifyToken: encrypt('fake-shopify'),
      metaAppSecret: encrypt(secret),
    });
    x.workspace.jobs.push({
      id: randomUUID(),
      orderId: target.id,
      kind: 'TEST_CONFIRMATION',
      state: 'DONE',
      attempts: 1,
      dueAt: new Date().toISOString(),
      messageId: 'wamid.connected-confirm',
    });
  });
  const original = globalThis.fetch;
  const demo = config.demo;
  let tagCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://reliable.myshopify.com/')) {
      const body = JSON.parse(String(options?.body));
      if (body.query.includes('mutation Tags')) {
        tagCalls++;
        return new Response(JSON.stringify({ data: { tagsAdd: { userErrors: [] } } }));
      }
      return new Response(
        JSON.stringify({
          data: {
            order: {
              cancelledAt: null,
              displayFinancialStatus: 'PENDING',
              displayFulfillmentStatus: 'UNFULFILLED',
            },
          },
        }),
      );
    }
    return original(url, options);
  };
  config.demo = false;
  try {
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '929292929' },
                messages: [
                  {
                    id: 'connected-click',
                    from: target.phone,
                    context: { id: 'wamid.connected-confirm' },
                    button: { payload: buttonPayload('CONFIRM', target.id), text: 'Confirm order' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const send = () =>
      original(base + '/webhooks/meta/' + s.merchant.id, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256':
            'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
        },
        body,
      });
    assert.equal((await send()).status, 200);
    assert.equal(
      (await getStore(s.merchant.id))!.workspace.orders.find((o) => o.id === target.id)!.status,
      'PENDING',
    );
    await drainInbox();
    assert.equal(
      (await getStore(s.merchant.id))!.workspace.orders.find((o) => o.id === target.id)!.status,
      'CONFIRMED',
    );
    await tick();
    assert.ok(
      (await getStore(s.merchant.id))!.workspace.orders
        .find((o) => o.id === target.id)!
        .tags.includes('COD-CONFIRMED'),
    );
    assert.equal((await send()).status, 200);
    await drainInbox();
    await tick();
    assert.equal(tagCalls, 1);
  } finally {
    globalThis.fetch = original;
    config.demo = demo;
  }
});

test('trusted local login issues a usable local session while public login keeps Secure cookies', async () => {
  const previous = config.allowedOrigins;
  const origin = new URL(base).origin;
  config.allowedOrigins = [origin];
  try {
    const body = {
      email: randomUUID() + '@test.invalid',
      password: 'LocalTest-password-123!',
      brandName: 'Local auth test',
    };
    const registered = await fetch(base + '/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify(body),
    });
    assert.equal(registered.status, 201);
    const cookie = registered.headers.get('set-cookie')!;
    assert.doesNotMatch(cookie, /; Secure/i);
    assert.match(cookie, /HttpOnly/i);
    assert.equal((await request('/workspace', undefined, cookie.split(';')[0]!)).status, 200);
    const health = await (await request('/health')).json();
    assert.equal(health.localLoginAllowed, true);
    const login = await fetch(base + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: config.appUrl },
      body: JSON.stringify(body),
    });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie')!, /; Secure/i);
  } finally {
    config.allowedOrigins = previous;
  }
});

test('merchant cancellation requires explicit reason and confirmation and cannot queue twice', async () => {
  const s = await session();
  const id = randomUUID();
  await mutate(s.merchant.id, (store) => {
    const order = store.workspace.orders[0]!;
    order.status = 'NEEDS_REVIEW';
    order.archivedAt = undefined;
    store.workspace.jobs = store.workspace.jobs.filter((j) => j.orderId !== order.id);
    store.workspace.tasks.push({
      id,
      orderId: order.id,
      kind: 'Cancellation',
      status: 'OPEN',
      detail: 'Customer cancellation',
      createdAt: new Date().toISOString(),
    });
  });
  assert.equal(
    (await request('/tasks/' + id + '/action', { action: 'approve' }, s.cookie)).status,
    400,
  );
  assert.equal(
    (
      await request(
        '/tasks/' + id + '/action',
        { action: 'cancel', reason: 'Customer request' },
        s.cookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        '/tasks/' + id + '/action',
        { action: 'cancel', reason: ' ', confirmed: true },
        s.cookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        '/tasks/' + id + '/action',
        { action: 'cancel', reason: 'Customer request', confirmed: true },
        s.cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        '/tasks/' + id + '/action',
        { action: 'cancel', reason: 'Customer request', confirmed: true },
        s.cookie,
      )
    ).status,
    400,
  );
  const store = (await getStore(s.merchant.id))!;
  const task = store.workspace.tasks.find((t) => t.id === id)!;
  assert.equal(
    store.workspace.jobs.filter((j) => j.orderId === task.orderId && j.kind === 'CANCEL').length,
    1,
  );
  assert.equal(store.workspace.orders.find((o) => o.id === task.orderId)!.status, 'NEEDS_REVIEW');
});
