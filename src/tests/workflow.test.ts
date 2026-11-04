import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canSend, confirm, conversation, enqueue, handleIncoming } from '../services/automation.js';
import { createStore, getStore, mutate, publicWorkspace } from '../services/repository.js';
import { demoWorkspace } from '../services/seed.js';
import type { Store } from '../models/types.js';
import { tick } from '../services/worker.js';
import { config } from '../config.js';
import { orderTestAllowed } from '../services/order-test.js';
import { encrypt } from '../utils/security.js';

test('order-triggered sandbox sends are tenant-bound, number-bound, expiring and do not imply consent', async () => {
  const previous = {
    demo: config.demo,
  };
  const originalFetch = globalThis.fetch;
  const store = fixture();
  store.workspace.jobs = [];
  const order = store.workspace.orders.find((o) => o.status === 'PENDING')!;
  order.consent = false;
  store.workspace.integration = {
    ...store.workspace.integration,
    templateName: 'hello_world',
    languageCode: 'en_US',
    phoneNumberId: '12345',
    whatsappToken: encrypt('fake-token'),
    whatsappVerifiedAt: new Date().toISOString(),
  };
  store.workspace.settings.reliability = {
    syncEnabled: true,
    syncIntervalMinutes: 5,
    initialLookbackDays: 7,
    maxMessageAgeHours: 24,
    recoveryMessaging: 'REVIEW',
    testMode: {
      recipient: order.phone,
      template: 'hello_world',
      until: new Date(Date.now() + 60000).toISOString(),
    },
  };
  order.createdAt = new Date().toISOString();
  await createStore(store);
  config.demo = false;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    assert.equal(JSON.parse(String(options?.body)).to, order.phone);
    return new Response(JSON.stringify({ messages: [{ id: 'sandbox-accepted' }] }));
  };
  try {
    assert.equal(orderTestAllowed(store, order.phone), true);
    assert.equal(orderTestAllowed(store, '923009999999'), false);
    assert.equal(orderTestAllowed(fixture(), order.phone), false);
    store.workspace.settings.reliability!.testMode!.until = new Date(0).toISOString();
    assert.equal(orderTestAllowed(store, order.phone), false);
    store.workspace.settings.reliability!.testMode!.until = new Date(
      Date.now() + 60000,
    ).toISOString();
    await mutate(store.merchant.id, (s) => {
      enqueue(s.workspace, order, 'TEST_HELLO');
      enqueue(s.workspace, order, 'TEST_HELLO');
    });
    await tick();
    await tick();
    const updated = (await getStore(store.merchant.id))!;
    assert.equal(calls, 1);
    assert.equal(updated.workspace.jobs[0]!.state, 'DONE');
    assert.equal(updated.workspace.jobs[0]!.messageId, 'sandbox-accepted');
    assert.equal(updated.workspace.orders.find((o) => o.id === order.id)!.consent, false);
    assert.equal(
      updated.workspace.jobs.some((j) => j.kind === 'REMINDER'),
      false,
    );
    assert.equal(
      updated.workspace.conversations.find((c) => c.orderId === order.id)!.messages.at(-1)!
        .direction,
      'note',
    );
  } finally {
    Object.assign(config, previous);
    globalThis.fetch = originalFetch;
  }
});

function fixture(): Store {
  return {
    merchant: {
      id: randomUUID(),
      email: `${randomUUID()}@test.invalid`,
      passwordHash: '',
      brandName: 'Test',
      subscriptionStatus: 'TRIALING',
      createdAt: new Date().toISOString(),
      trialEndsAt: new Date(Date.now() + 86400000).toISOString(),
    },
    workspace: demoWorkspace(),
  };
}
test('duplicate confirmations enqueue one Shopify action', () => {
  const { workspace: w } = fixture();
  const o = w.orders.find((o) => o.status === 'PENDING')!;
  confirm(w, o);
  confirm(w, o);
  assert.equal(o.status, 'CONFIRMED');
  assert.equal(w.jobs.filter((j) => j.orderId === o.id && j.kind === 'TAG').length, 1);
});
test('human takeover records customer messages without a bot response', () => {
  const { workspace: w } = fixture();
  const o = w.orders[2]!;
  const c = conversation(w, o);
  c.human = true;
  const before = c.messages.length;
  handleIncoming(w, o, 'Confirm', true);
  assert.equal(c.messages.length, before + 1);
  assert.equal(o.status, 'NEEDS_REVIEW');
});
test('change requests remain open and do not claim execution', () => {
  const { workspace: w } = fixture();
  const o = w.orders[1]!;
  const response = handleIncoming(w, o, 'Please change my address', true);
  assert.match(response!, /not been changed/);
  assert.equal(w.tasks.find((t) => t.orderId === o.id)?.status, 'OPEN');
  assert.equal(conversation(w, o).human, true);
});
test('an expired trial blocks outbound jobs but still accepts incoming support', async () => {
  const store = fixture();
  store.merchant.trialEndsAt = new Date(Date.now() - 1).toISOString();
  assert.equal(canSend(store), false);
  const o = store.workspace.orders[1]!;
  enqueue(store.workspace, o, 'CONFIRMATION');
  await createStore(store);
  await tick();
  const after = await getStore(store.merchant.id);
  assert.equal(after!.workspace.jobs[0]!.state, 'FAILED');
  assert.match(after!.workspace.jobs[0]!.error!, /Trial expired/);
  assert.ok(
    handleIncoming(after!.workspace, after!.workspace.orders[1]!, 'Where is my parcel?', true),
  );
});
test('tenant mutations are isolated and failed writes roll back', async () => {
  const a = fixture();
  const b = fixture();
  await createStore(a);
  await createStore(b);
  await mutate(a.merchant.id, (s) => {
    s.workspace.settings.policy = 'Tenant A policy';
  });
  assert.notEqual((await getStore(b.merchant.id))!.workspace.settings.policy, 'Tenant A policy');
  await assert.rejects(
    mutate(a.merchant.id, (s) => {
      s.workspace.orders = [];
      throw new Error('abort');
    }),
  );
  assert.equal((await getStore(a.merchant.id))!.workspace.orders.length, 12);
});
test('public API projection never includes encrypted credentials', () => {
  const { workspace: w } = fixture();
  w.integration.shopifyToken = 'encrypted-shopify';
  w.integration.whatsappToken = 'encrypted-meta';
  const result = JSON.stringify(publicWorkspace(w));
  assert.ok(!result.includes('encrypted-shopify'));
  assert.ok(!result.includes('encrypted-meta'));
  assert.equal(publicWorkspace(w).integration.hasShopifyToken, true);
});
test('one reminder is queued after a simulated confirmation message', async () => {
  const store = fixture();
  const o = store.workspace.orders[1]!;
  enqueue(store.workspace, o, 'CONFIRMATION');
  await createStore(store);
  await tick();
  const after = await getStore(store.merchant.id);
  assert.equal(
    after!.workspace.jobs.filter((j) => j.kind === 'CONFIRMATION' && j.state === 'DONE').length,
    1,
  );
  assert.equal(after!.workspace.jobs.filter((j) => j.kind === 'REMINDER').length, 1);
  assert.ok(after!.workspace.jobs[0]!.messageId?.startsWith('demo-'));
});
test('connected inbound replies are internal suggestions, not fabricated sends', () => {
  const { workspace: w } = fixture();
  const o = w.orders[1]!;
  handleIncoming(w, o, 'Where is my order?', false);
  assert.equal(conversation(w, o).messages.at(-1)!.direction, 'note');
});

test('human takeover also pauses queued outbound reminders', async () => {
  const store = fixture();
  const order = store.workspace.orders[1]!;
  conversation(store.workspace, order).human = true;
  enqueue(store.workspace, order, 'REMINDER');
  await createStore(store);
  await tick();
  const after = await getStore(store.merchant.id);
  assert.equal(after!.workspace.jobs[0]!.state, 'FAILED');
  assert.match(after!.workspace.jobs[0]!.error!, /human handling/);
  assert.equal(after!.workspace.jobs[0]!.messageId, undefined);
});
