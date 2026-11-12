import { customerConversations, customerThreads } from '../models/customer-conversations.js';
import { conversation, append } from '../services/automation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { demoWorkspace } from '../services/seed.js';
import { createStore, getStore, publicWorkspace, mutate } from '../services/repository.js';
import {
  acceptInbox,
  claimInbox,
  finishInbox,
  getSyncState,
  claimSync,
  updateSync,
  requestSync,
  inboxSummary,
} from '../services/reliability-repository.js';
import { processMetaEvent, processShopifyEvent } from '../services/incoming-events.js';
import {
  ingestOrder,
  planOrderMessage,
  repairMissingConfirmations,
} from '../services/order-ingestion.js';
import { config } from '../config.js';
import { defaultReliability } from '../services/reliability-settings.js';
import { reconcileMerchant } from '../services/shopify-reconciliation.js';
import { jobRetry } from '../services/retry-policy.js';
import { ProviderError } from '../services/providers.js';
import { buttonPayload } from '../services/order-confirmation.js';
import { tick } from '../services/worker.js';
import { encrypt } from '../utils/security.js';
import type { Store } from '../models/types.js';
import { applyBulkOrderAction } from '../services/order-operations.js';
import { requestFullSync } from '../services/reliability-repository.js';
function fixture(): Store {
  const workspace = demoWorkspace();
  workspace.orders = [];
  workspace.jobs = [];
  workspace.conversations = [];
  workspace.tasks = [];
  workspace.processedEvents = [];
  workspace.integration.shopDomain = randomUUID() + '.myshopify.com';
  return {
    merchant: {
      id: randomUUID(),
      email: randomUUID() + '@test.invalid',
      brandName: 'Recovery test',
      passwordHash: '',
      createdAt: new Date().toISOString(),
      trialEndsAt: new Date(Date.now() + 86400000).toISOString(),
      subscriptionStatus: 'TRIALING',
    },
    workspace,
  };
}
const incoming = (id = '100') => ({
  id,
  name: '#' + id,
  total_price: '1200',
  currency: 'PKR',
  payment_gateway_names: ['Cash on Delivery'],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  financial_status: 'pending',
  shipping_address: { name: 'Test recipient', phone: '+923001234567', country_code: 'PK' },
});
test('durable inbox deduplicates per tenant, leases claims, and retains failed events', async () => {
  const s = fixture();
  await createStore(s);
  const id = randomUUID();
  await acceptInbox(s.merchant.id, 'shopify', id, 'orders/create', incoming());
  await acceptInbox(s.merchant.id, 'shopify', id, 'orders/create', incoming());
  const e = (await claimInbox())!;
  assert.equal(e.merchantId, s.merchant.id);
  assert.equal(e.attempts, 1);
  assert.equal(await claimInbox(), undefined);
  await finishInbox(e, 'Temporary database failure');
  assert.equal(await claimInbox(), undefined);
  const summary = await inboxSummary(s.merchant.id);
  assert.equal(summary.find((v) => v.state === 'QUEUED')?._count, 1);
});
test('recovered orders merge idempotently; stale updates cannot undo cancellation', async () => {
  const s = fixture();
  await createStore(s);
  const input = incoming();
  await processShopifyEvent(s.merchant.id, 'orders/create', 'event1', input);
  await processShopifyEvent(s.merchant.id, 'orders/create', 'event1', input);
  await processShopifyEvent(s.merchant.id, 'orders/cancelled', 'event2', {
    ...input,
    updated_at: new Date(Date.now() + 1000).toISOString(),
    cancelled_at: new Date().toISOString(),
  });
  await processShopifyEvent(s.merchant.id, 'orders/updated', 'event3', input);
  const result = (await getStore(s.merchant.id))!.workspace;
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0]!.status, 'CANCELLED');
  assert.equal(result.jobs.length, 0);
  assert.equal(result.orders[0]!.consent, false);
});
test('recovered historical orders are held for review and paid orders never queue messages', () => {
  const s = fixture();
  s.workspace.settings.reliability = { ...defaultReliability, recoveryMessaging: 'REVIEW' };
  const o = ingestOrder(s, incoming(), true)!;
  assert.match(o.messageBlockedReason!, /review/);
  assert.equal(s.workspace.jobs.length, 0);
  o.createdAt = new Date(0).toISOString();
  planOrderMessage(s, o);
  assert.match(o.messageBlockedReason!, /age limit/);
  const paid = ingestOrder(s, { ...incoming('101'), financial_status: 'paid' }, false)!;
  assert.equal(paid.status, 'NEEDS_REVIEW');
  assert.equal(s.workspace.jobs.length, 0);
});
test('only retryable, definitive failures auto-retry; uncertain WhatsApp sends stay unknown', () => {
  assert.equal(
    jobRetry(
      'CONFIRMATION',
      new ProviderError('Throttled', false, { retryable: true, retryAfterSeconds: 60 }),
      1,
    ).retry,
    true,
  );
  assert.equal(jobRetry('CONFIRMATION', new ProviderError('Expired token'), 1).retry, false);
  const uncertain = new ProviderError('Timeout', true, { retryable: false });
  assert.deepEqual(
    { ...jobRetry('CONFIRMATION', uncertain, 1), delay: 0 },
    { retry: false, unknown: true, delay: 0 },
  );
  assert.equal(jobRetry('TAG', uncertain, 1).retry, true);
  assert.equal(jobRetry('TAG', uncertain, 8).retry, false);
});
test('sync claims reject overlapping workers and stale lease tokens', async () => {
  const id = randomUUID();
  const lease = (await claimSync(id))!;
  assert.equal(await claimSync(id), undefined);
  await updateSync(id, 'wrong-token', { checkpoint: new Date() });
  assert.equal((await getSyncState(id)).checkpoint, null);
  await updateSync(id, lease.leaseToken!, { leaseToken: null, leaseUntil: null });
  assert.ok(await claimSync(id));
});
test('catch-up retains its checkpoint on failure, resumes pages, and deduplicates repeated results', async () => {
  const s = fixture();
  s.workspace.integration.shopifyToken = encrypt('mock');
  await createStore(s);
  const original = globalThis.fetch;
  let calls = 0;
  const node = {
    id: 'gid://shopify/Order/7654',
    name: '#7654',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cancelledAt: null,
    displayFinancialStatus: 'PENDING',
    displayFulfillmentStatus: 'UNFULFILLED',
    paymentGatewayNames: ['Cash on Delivery'],
    currentTotalPriceSet: { shopMoney: { amount: '1200', currencyCode: 'PKR' } },
    shippingAddress: { name: 'Test', phone: '+923001234567', countryCodeV2: 'PK' },
  };
  globalThis.fetch = async (_url, options) => {
    calls++;
    const body = JSON.parse(String(options?.body));
    if (calls === 1) throw new Error('network');
    assert.equal(body.variables.after, calls === 2 ? null : 'page1');
    return new Response(
      JSON.stringify({
        data: {
          orders: {
            nodes: [node],
            pageInfo: { hasNextPage: calls === 2, endCursor: calls === 2 ? 'page1' : null },
          },
        },
      }),
    );
  };
  try {
    await reconcileMerchant(s.merchant.id);
    let state = await getSyncState(s.merchant.id);
    assert.equal(state.checkpoint, null);
    assert.ok(state.error);
    await requestSync(s.merchant.id);
    await reconcileMerchant(s.merchant.id);
    state = await getSyncState(s.merchant.id);
    assert.equal(state.cursor, 'page1');
    assert.equal(state.checkpoint, null);
    await reconcileMerchant(s.merchant.id);
    state = await getSyncState(s.merchant.id);
    assert.ok(state.checkpoint);
    assert.equal(state.error, null);
    assert.equal((await getStore(s.merchant.id))!.workspace.orders.length, 1);
    assert.equal((await getStore(s.merchant.id))!.workspace.jobs.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});
test('verified button confirmation and duplicate delivery queue exactly one Shopify tag action', async () => {
  const s = fixture();
  s.workspace.integration.phoneNumberId = '900009001';
  const o = ingestOrder(s, incoming())!;
  s.workspace.jobs = [
    {
      id: randomUUID(),
      orderId: o.id,
      kind: 'TEST_CONFIRMATION',
      state: 'DONE',
      dueAt: new Date().toISOString(),
      attempts: 1,
      messageId: 'wamid.recovery',
    },
  ];
  await createStore(s);
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: s.workspace.integration.phoneNumberId },
              messages: [
                {
                  id: 'reply1',
                  from: o.phone,
                  context: { id: 'wamid.recovery' },
                  button: { payload: buttonPayload('CONFIRM', o.id), text: 'Confirm order' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  await processMetaEvent(s.merchant.id, payload);
  await processMetaEvent(s.merchant.id, payload);
  let result = (await getStore(s.merchant.id))!;
  assert.equal(result.workspace.orders[0]!.status, 'CONFIRMED');
  assert.equal(result.workspace.jobs.filter((j) => j.kind === 'TAG').length, 1);
  await tick();
  result = (await getStore(s.merchant.id))!;
  assert.ok(result.workspace.orders[0]!.tags.includes('COD-CONFIRMED'));
});
test('late button replies are recorded for review without confirming an expired order', async () => {
  const s = fixture();
  s.workspace.integration.phoneNumberId = '900009002';
  const o = ingestOrder(s, incoming())!;
  o.confirmationExpiresAt = new Date(0).toISOString();
  s.workspace.jobs = [
    {
      id: randomUUID(),
      orderId: o.id,
      kind: 'TEST_CONFIRMATION',
      state: 'DONE',
      dueAt: new Date().toISOString(),
      attempts: 1,
      messageId: 'wamid.late',
    },
  ];
  await createStore(s);
  await processMetaEvent(s.merchant.id, {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: '900009002' },
              messages: [
                {
                  id: 'late1',
                  from: o.phone,
                  context: { id: 'wamid.late' },
                  button: { payload: buttonPayload('CONFIRM', o.id), text: 'Confirm order' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const after = (await getStore(s.merchant.id))!;
  assert.equal(after.workspace.orders[0]!.status, 'PENDING');
  assert.equal(after.workspace.jobs.filter((j) => j.kind === 'TAG').length, 0);
  assert.ok(after.workspace.notifications?.length);
});
test('public snapshots exclude merchant webhook secrets and verification hashes', () => {
  const s = fixture();
  s.workspace.integration.metaAppSecret = encrypt('private');
  s.workspace.integration.metaVerifyTokenHash = 'private-hash';
  const value = JSON.stringify(publicWorkspace(s.workspace));
  assert.ok(!value.includes(s.workspace.integration.metaAppSecret));
  assert.ok(!value.includes('private-hash'));
  assert.equal(publicWorkspace(s.workspace).integration.hasMetaAppSecret, true);
});

test('signed delivery correlation recovers a lost send response and cannot regress delivered state', async () => {
  const { applyDeliveryStatus, updateMessage } = await import('../services/message-history.js');
  const s = fixture();
  const o = ingestOrder(s, incoming())!;
  const jobId = randomUUID(),
    id = randomUUID();
  s.workspace.jobs = [
    {
      id: jobId,
      orderId: o.id,
      kind: 'TEST_CONFIRMATION',
      state: 'UNKNOWN',
      attempts: 1,
      dueAt: new Date().toISOString(),
    },
  ];
  s.workspace.outboundMessages = [
    {
      id,
      jobId,
      orderId: o.id,
      kind: 'TEST_CONFIRMATION',
      recipient: o.phone,
      templateName: 'confirmation',
      languageCode: 'en',
      preview: 'Order confirmation',
      status: 'UNKNOWN',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
  applyDeliveryStatus(s.workspace, {
    id: 'wamid.recovered',
    recipient_id: o.phone,
    status: 'delivered',
    timestamp: String(Math.floor(Date.now() / 1000)),
    biz_opaque_callback_data: id,
  });
  assert.equal(s.workspace.jobs[0]!.state, 'DONE');
  assert.equal(s.workspace.jobs[0]!.messageId, 'wamid.recovered');
  assert.ok(o.confirmationExpiresAt);
  await createStore(s);
  await updateMessage(s.merchant.id, id, { status: 'ACCEPTED', messageId: 'wamid.recovered' });
  assert.equal(
    (await getStore(s.merchant.id))!.workspace.outboundMessages![0]!.status,
    'DELIVERED',
  );
});
test('restart recovery restores a known accepted result instead of sending a duplicate', async () => {
  const s = fixture();
  const o = ingestOrder(s, incoming())!;
  const jobId = randomUUID();
  s.workspace.jobs = [
    {
      id: jobId,
      orderId: o.id,
      kind: 'TEST_CONFIRMATION',
      state: 'UNKNOWN',
      attempts: 1,
      dueAt: new Date().toISOString(),
      claimedAt: new Date(Date.now() - 180000).toISOString(),
    },
  ];
  s.workspace.outboundMessages = [
    {
      id: randomUUID(),
      jobId,
      orderId: o.id,
      kind: 'TEST_CONFIRMATION',
      recipient: o.phone,
      templateName: 'confirmation',
      languageCode: 'en',
      preview: 'Confirmation',
      status: 'ACCEPTED',
      messageId: 'wamid.persisted',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
  await createStore(s);
  await tick();
  const after = (await getStore(s.merchant.id))!;
  assert.equal(after.workspace.jobs[0]!.state, 'DONE');
  assert.equal(after.workspace.jobs[0]!.attempts, 1);
  assert.equal(after.workspace.jobs[0]!.messageId, 'wamid.persisted');
});
test('Shopify state reconciliation completes uncertain cancellation and tag jobs without another mutation', () => {
  const s = fixture();
  const o = ingestOrder(s, incoming())!;
  s.workspace.jobs.push({
    id: randomUUID(),
    orderId: o.id,
    kind: 'CANCEL',
    state: 'UNKNOWN',
    attempts: 1,
    dueAt: new Date().toISOString(),
  });
  s.workspace.tasks.push({
    id: randomUUID(),
    orderId: o.id,
    kind: 'Cancellation',
    status: 'APPROVED',
    detail: 'Customer request',
    createdAt: new Date().toISOString(),
  });
  ingestOrder(s, {
    ...incoming(),
    updated_at: new Date(Date.now() + 1000).toISOString(),
    cancelled_at: new Date().toISOString(),
  });
  assert.equal(o.status, 'CANCELLED');
  assert.equal(s.workspace.jobs[0]!.state, 'DONE');
  assert.equal(s.workspace.tasks[0]!.status, 'VERIFIED');
  const confirmed = ingestOrder(s, incoming('101'))!;
  confirmed.status = 'CONFIRMED';
  s.workspace.jobs.push({
    id: randomUUID(),
    orderId: confirmed.id,
    kind: 'TAG',
    state: 'UNKNOWN',
    attempts: 1,
    dueAt: new Date().toISOString(),
  });
  ingestOrder(s, {
    ...incoming('101'),
    updated_at: new Date(Date.now() + 1000).toISOString(),
    tags: 'COD-CONFIRMED',
  });
  assert.equal(
    s.workspace.jobs.find((j) => j.orderId === confirmed.id && j.kind === 'TAG')!.state,
    'DONE',
  );
});
test('confirmation setup is tenant-bound and requires verification again after the callback URL changes', async () => {
  const { metaWebhookReady, metaCallbackUrl } =
    await import('../services/meta-webhook-settings.js');
  const { config } = await import('../config.js');
  const prior = config.appUrl;
  const s = fixture();
  config.appUrl = 'https://test-callback.invalid';
  try {
    Object.assign(s.workspace.integration, {
      metaAppSecret: encrypt('secret'),
      metaVerifyTokenHash: 'hash',
      metaWebhookVerifiedAt: new Date().toISOString(),
      metaWebhookUrl: metaCallbackUrl(s.merchant.id),
      wabaId: '123',
    });
    assert.equal(metaWebhookReady(s), false);
    s.workspace.settings.metaSubscription = { wabaId: '123', verifiedAt: new Date().toISOString() };
    assert.equal(metaWebhookReady(s), true);
    config.appUrl = 'https://changed-callback.invalid';
    assert.equal(metaWebhookReady(s), false);
  } finally {
    config.appUrl = prior;
  }
});

test('bulk confirmation deduplicates selection and queues one Shopify tag per order', () => {
  const s = fixture();
  const a = ingestOrder(s, incoming('201'), true)!;
  const b = ingestOrder(s, incoming('202'), true)!;
  assert.deepEqual(applyBulkOrderAction(s, 'confirm', [a.id, a.id, b.id]), {
    affected: 2,
    skipped: 0,
  });
  assert.equal(s.workspace.jobs.filter((j) => j.kind === 'TAG').length, 2);
  assert.deepEqual(applyBulkOrderAction(s, 'confirm', [a.id]), { affected: 0, skipped: 1 });
  assert.equal(s.workspace.jobs.length, 2);
});
test('bulk actions reject unavailable tenant IDs before changing any order', () => {
  const s = fixture();
  const a = ingestOrder(s, incoming('203'), true)!;
  const before = a.status;
  assert.throws(() => applyBulkOrderAction(s, 'confirm', [a.id, randomUUID()]));
  assert.equal(a.status, before);
  assert.equal(s.workspace.jobs.length, 0);
});
test('removed orders remain deduplicated and hidden until explicitly restored', () => {
  const s = fixture();
  const a = ingestOrder(s, incoming('204'), true)!;
  applyBulkOrderAction(s, 'confirm', [a.id]);
  applyBulkOrderAction(s, 'remove', [a.id]);
  assert.equal(publicWorkspace(s.workspace).orders.length, 0);
  assert.equal(s.workspace.jobs[0]!.state, 'FAILED');
  ingestOrder(s, incoming('204'), true);
  assert.equal(s.workspace.orders.length, 1);
  assert.equal(publicWorkspace(s.workspace).orders.length, 0);
  ingestOrder(s, incoming('204'), true, true);
  assert.equal(publicWorkspace(s.workspace).orders[0]!.id, a.id);
  assert.equal(s.workspace.jobs.length, 1);
});
test('remove all checks the reviewed count and refuses in-flight actions', () => {
  const s = fixture();
  const a = ingestOrder(s, incoming('205'), true)!;
  assert.throws(() => applyBulkOrderAction(s, 'remove', [], true, 0));
  assert.equal(a.archivedAt, undefined);
  applyBulkOrderAction(s, 'confirm', [a.id]);
  s.workspace.jobs[0]!.state = 'UNKNOWN';
  s.workspace.jobs[0]!.claimedAt = new Date().toISOString();
  assert.throws(() => applyBulkOrderAction(s, 'remove', [], true, 1));
  s.workspace.jobs[0]!.state = 'DONE';
  assert.equal(applyBulkOrderAction(s, 'remove', [], true, 1).affected, 1);
});
test('manual Shopify sync opens a bounded fresh window and prevents overlapping requests', async () => {
  const s = fixture();
  await createStore(s);
  await requestFullSync(s.merchant.id, 30, true);
  const state = await getSyncState(s.merchant.id);
  assert.equal(state.manualRequested, true);
  assert.equal(state.restoreArchived, true);
  assert.equal(state.cursor, null);
  assert.ok(
    Math.abs(state.windowEnd!.getTime() - state.windowStart!.getTime() - 30 * 86400000) < 100,
  );
  await assert.rejects(requestFullSync(s.merchant.id, 7, false));
});

test('recovered eligible orders queue a missing confirmation exactly once and repair settings changes', () => {
  const s = fixture();
  s.workspace.settings.confirmations = true;
  s.workspace.settings.reliability = { ...defaultReliability, recoveryMessaging: 'SEND_ELIGIBLE' };
  const o = ingestOrder(s, incoming('206'), true)!;
  assert.match(o.messageBlockedReason!, /permission/);
  o.consent = true;
  const previous = config.outbound;
  config.outbound = true;
  try {
    repairMissingConfirmations(s);
    repairMissingConfirmations(s);
    ingestOrder(s, incoming('206'), true);
    assert.equal(
      s.workspace.jobs.filter((j) => j.orderId === o.id && j.kind === 'CONFIRMATION').length,
      1,
    );
    assert.equal(o.messageBlockedReason, undefined);
  } finally {
    config.outbound = previous;
  }
});

test('authorized own-number recovery queues sandbox confirmation without inventing customer consent', () => {
  const s = fixture();
  const previous = config.demo;
  config.demo = false;
  s.workspace.integration.whatsappToken = encrypt('fake-token');
  s.workspace.integration.whatsappVerifiedAt = new Date().toISOString();
  s.workspace.integration.templateName = 'relay_order_confirmation_v1';
  s.workspace.integration.languageCode = 'en';
  s.workspace.settings.reliability = {
    ...defaultReliability,
    recoveryMessaging: 'REVIEW',
    testMode: {
      recipient: '923001234567',
      template: 'relay_order_confirmation_v1',
      until: new Date(Date.now() + 60000).toISOString(),
    },
  };
  try {
    const o = ingestOrder(s, incoming('207'), true)!;
    repairMissingConfirmations(s);
    assert.equal(s.workspace.jobs.filter((j) => j.orderId === o.id).length, 1);
    assert.equal(s.workspace.jobs[0]!.kind, 'TEST_CONFIRMATION');
    assert.equal(o.consent, false);
    const other = ingestOrder(
      s,
      {
        ...incoming('208'),
        shipping_address: { name: 'Other', phone: '+923009999999', country_code: 'PK' },
      },
      true,
    )!;
    assert.ok(other.messageBlockedReason);
    assert.equal(s.workspace.jobs.filter((j) => j.orderId === other.id).length, 0);
  } finally {
    config.demo = previous;
  }
});

test('customer inbox combines legacy order history and retains ambiguous replies once', async () => {
  const s = fixture();
  s.workspace.integration.phoneNumberId = 'test-sender';
  const seed = demoWorkspace().orders[0]!;
  s.workspace.orders = [
    { ...seed, id: randomUUID(), phone: '923001234567' },
    { ...seed, id: randomUUID(), phone: '923001234567' },
  ];
  for (const o of s.workspace.orders) {
    const c = conversation(s.workspace, o);
    append(c, 'note', o.number);
  }
  await createStore(s);
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: s.workspace.integration.phoneNumberId },
              messages: [
                {
                  id: randomUUID(),
                  from: seed.phone === '923001234567' ? seed.phone : '923001234567',
                  text: { body: 'Hi, I have a question' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  await processMetaEvent(s.merchant.id, payload);
  await processMetaEvent(s.merchant.id, payload);
  const w = (await getStore(s.merchant.id))!.workspace;
  const groups = customerConversations(w);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.messages.length, 3);
  assert.equal(groups[0]!.messages.filter((m) => m.text === 'Hi, I have a question').length, 1);
  assert.equal(w.conversations.find((c) => !c.orderId)?.messages[0]?.text, 'Hi, I have a question');
  assert.ok(w.orders.every((o) => o.status === seed.status));
  assert.equal(customerThreads(w, w.conversations[0]!).length, 3);
  const other = fixture();
  assert.equal(customerConversations(other.workspace).length, 0);
});
test('customer inbox retains messages without any order', async () => {
  const s = fixture();
  s.workspace.integration.phoneNumberId = 'test-sender';
  await createStore(s);
  await processMetaEvent(s.merchant.id, {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: s.workspace.integration.phoneNumberId },
              messages: [{ id: randomUUID(), from: '923009876543', text: { body: 'Hello' } }],
            },
          },
        ],
      },
    ],
  });
  const w = (await getStore(s.merchant.id))!.workspace;
  assert.equal(customerConversations(w)[0]?.messages[0]?.text, 'Hello');
  assert.equal(w.orders.length, 0);
});

test('support replies resolve phone-matched orders without prior confirmations and clarify multiple orders', async () => {
  const { queueSupportReply, supportReplyText } = await import('../services/support-replies.js');
  const { metaCallbackUrl } = await import('../services/meta-webhook-settings.js');
  const store = fixture();
  const prior = { demo: config.demo, webhookUrl: config.webhookUrl };
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const from = '923001234567';
  const input = { from, body: 'Where is my order?', timestamp: String(Math.floor(now / 1000)) };
  try {
    config.demo = false;
    config.webhookUrl = 'https://test-callback.invalid';
    Object.assign(store.workspace.integration, {
      phoneNumberId: 'test-sender',
      wabaId: 'test-waba',
      metaAppSecret: 'test-secret',
      metaVerifyTokenHash: 'test-hash',
      metaWebhookVerifiedAt: createdAt,
      metaWebhookUrl: metaCallbackUrl(store.merchant.id),
      whatsappToken: 'test-token',
      whatsappVerifiedAt: createdAt,
      templateName: 'test_confirmation',
      languageCode: 'en',
    });
    store.workspace.settings.tracking = true;
    store.workspace.settings.metaSubscription = { wabaId: 'test-waba', verifiedAt: createdAt };
    store.workspace.settings.reliability = {
      ...defaultReliability,
      testMode: {
        recipient: from,
        template: 'test_confirmation',
        until: new Date(now + 60000).toISOString(),
      },
    };
    // 0 orders for phone -> polite no_order reply (never silent dead end)
    assert.equal(queueSupportReply(store, input, now), true);
    assert.match(store.workspace.jobs.at(-1)!.kind, /^SUPPORT_REPLY:no_order:/);
    assert.equal(store.workspace.jobs.at(-1)!.orderId, undefined);

    // 1 synced order for phone (even with zero prior Relay template messages) -> status directly
    const seed = demoWorkspace().orders[0]!;
    const otherCustomerOrder = { ...seed, id: '999', phone: '923009999999', number: '#999' };
    store.workspace.orders = [{ ...seed, id: '1', phone: from, number: '#1' }, otherCustomerOrder];
    assert.equal(
      queueSupportReply(store, { ...input, body: 'I want to ask about order' }, now),
      true,
    );
    assert.match(store.workspace.jobs.at(-1)!.kind, /^SUPPORT_REPLY:status:/);
    assert.equal(store.workspace.jobs.at(-1)!.orderId, '1');

    // Asking about another customer's order number (#999) never leaks cross-customer order
    assert.equal(queueSupportReply(store, { ...input, body: 'Where is #999?' }, now), true);
    assert.match(store.workspace.jobs.at(-1)!.kind, /^SUPPORT_REPLY:clarify:/);
    assert.equal(store.workspace.jobs.at(-1)!.orderId, undefined);

    // 2 orders for the same phone -> clarify listing recent order numbers, then resolve #2
    store.workspace.orders = [
      ...['1', '2'].map((id) => ({ ...seed, id, phone: from, number: '#' + id })),
      otherCustomerOrder,
    ];
    store.workspace.outboundMessages = ['1', '2'].map((id) => ({
      id: 'history-' + id,
      orderId: id,
      recipient: from,
      messageId: 'wamid-' + id,
      kind: 'TEST_CONFIRMATION',
      status: 'ACCEPTED',
      createdAt,
      updatedAt: createdAt,
      preview: 'Order confirmation',
      templateName: 'test_confirmation',
      languageCode: 'en',
    }));
    assert.equal(queueSupportReply(store, input, now), true);
    const clarifyJob = store.workspace.jobs.at(-1)!;
    assert.match(clarifyJob.kind, /^SUPPORT_REPLY:clarify:/);
    clarifyJob.state = 'DONE';
    const clarifyCopy = await supportReplyText(store, 'clarify', undefined, from);
    assert.match(clarifyCopy, /#1/);
    assert.match(clarifyCopy, /#2/);
    assert.doesNotMatch(clarifyCopy, /#999/);

    assert.equal(queueSupportReply(store, { ...input, body: '#2' }, now), true);
    assert.match(store.workspace.jobs.at(-1)!.kind, /^SUPPORT_REPLY:status:/);
    assert.equal(store.workspace.jobs.at(-1)!.orderId, '2');

    assert.equal(queueSupportReply(store, { ...input, quotedId: 'wamid-2' }, now), true);
    assert.equal(store.workspace.jobs.at(-1)!.orderId, '2');
    assert.equal(queueSupportReply(store, { ...input, quotedId: 'unrelated' }, now), false);
    assert.equal(queueSupportReply(store, { ...input, body: 'Cancel my order' }, now), false);
    assert.equal(queueSupportReply(store, { ...input, body: 'Talk to support' }, now), false);
  } finally {
    Object.assign(config, prior);
  }
});

test('interactive 3-button help menu, cooldown, menu button clicks, and handoff respect 24h window and human takeover', async () => {
  const { queueSupportReply, supportMenuButtons } = await import('../services/support-replies.js');
  const { metaCallbackUrl } = await import('../services/meta-webhook-settings.js');
  const { inboxReplyEligibility } = await import('../models/inbox-eligibility.js');
  const s = fixture();
  const prior = {
    demo: config.demo,
    outbound: config.outbound,
    webhookUrl: config.webhookUrl,
  };
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const from = '923001234567';
  try {
    config.demo = false;
    config.outbound = true;
    config.webhookUrl = 'https://test-callback.invalid';
    Object.assign(s.workspace.integration, {
      shopDomain: 'policy-store.myshopify.com',
      shopifyToken: encrypt('fake-shopify-token'),
      phoneNumberId: '888777666',
      wabaId: '555444333',
      metaAppSecret: encrypt('secret'),
      metaVerifyTokenHash: 'hash',
      metaWebhookVerifiedAt: createdAt,
      metaWebhookUrl: metaCallbackUrl(s.merchant.id),
      whatsappToken: encrypt('fake-meta-token'),
      whatsappVerifiedAt: createdAt,
      templateName: 'relay_order_confirmation_v1',
      languageCode: 'en',
    });
    s.workspace.settings.faqs = true;
    s.workspace.settings.tracking = true;
    s.workspace.settings.metaSubscription = { wabaId: '555444333', verifiedAt: createdAt };
    await createStore(s);

    const metaMsg = (id: string, body: string) => ({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '888777666' },
                messages: [{ id, from, timestamp: String(Math.floor(now / 1000)), text: { body } }],
              },
            },
          ],
        },
      ],
    });
    const metaButton = (id: string, btnId: string, btnTitle: string) => ({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '888777666' },
                messages: [
                  {
                    id,
                    from,
                    timestamp: String(Math.floor(now / 1000)),
                    interactive: { button_reply: { id: btnId, title: btnTitle } },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    // Pure gratitude / ack before any menu does not trigger unsolicited menu spam
    await processMetaEvent(s.merchant.id, metaMsg('m-ack-0', 'Thanks!'));
    assert.equal((await getStore(s.merchant.id))!.workspace.jobs.length, 0);

    // Casual greeting queues interactive menu without locking human takeover
    await processMetaEvent(s.merchant.id, metaMsg('m-greet-1', 'Hi there'));
    const afterGreeting = (await getStore(s.merchant.id))!;
    assert.equal(afterGreeting.workspace.conversations[0]!.human, false);
    assert.equal(afterGreeting.workspace.jobs.length, 1);
    assert.match(afterGreeting.workspace.jobs[0]!.kind, /^SUPPORT_REPLY:menu:/);

    // Repeat casual text within 12h cooldown does NOT queue another menu
    await processMetaEvent(s.merchant.id, metaMsg('m-greet-2', 'Hehehe'));
    assert.equal((await getStore(s.merchant.id))!.workspace.jobs.length, 1);
    assert.equal((await getStore(s.merchant.id))!.workspace.conversations[0]!.human, false);

    // Eligibility helper allows reply within 24h inbound window
    assert.equal(
      inboxReplyEligibility(
        {
          mode: 'connected',
          outboundEnabled: true,
          metaWebhookConfigured: true,
          merchant: afterGreeting.merchant,
          workspace: afterGreeting.workspace,
        },
        afterGreeting.workspace.conversations[0]!,
        now,
      ).allowed,
      true,
    );

    const sentPayloads: { type: string; body: string; buttons?: string[] }[] = [];
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('https://policy-store.myshopify.com/')) {
        const parsed = JSON.parse(String(options?.body)) as { query: string };
        if (parsed.query.includes('shopPolicies')) {
          return new Response(
            JSON.stringify({
              data: {
                shop: {
                  shopPolicies: [
                    {
                      type: 'SHIPPING_POLICY',
                      title: 'Shipping policy',
                      url: 'https://policy-store.myshopify.com/policies/shipping-policy',
                      body: '<p>We dispatch in <strong>24 hours</strong> &amp; deliver in 2-4 days.</p>',
                    },
                    {
                      type: 'REFUND_POLICY',
                      title: 'Refund policy',
                      url: 'https://policy-store.myshopify.com/policies/refund-policy',
                      body: '<p>Returns accepted within 7 days of delivery.</p>',
                    },
                  ],
                },
              },
            }),
          );
        }
        return new Response(
          JSON.stringify({
            data: {
              order: {
                cancelledAt: null,
                displayFulfillmentStatus: 'FULFILLED',
                fulfillments: [
                  {
                    status: 'SUCCESS',
                    trackingInfo: [{ url: 'https://track.example/abc123', number: 'abc123' }],
                  },
                ],
              },
            },
          }),
        );
      }
      if (String(url).includes('/888777666/messages')) {
        const parsed = JSON.parse(String(options?.body)) as {
          type: string;
          text?: { body: string };
          interactive?: {
            type: string;
            body: { text: string };
            action: { buttons: { type: string; reply: { id: string; title: string } }[] };
          };
          biz_opaque_callback_data: string;
        };
        assert.ok(parsed.biz_opaque_callback_data);
        if (parsed.type === 'interactive') {
          assert.equal(parsed.interactive?.type, 'button');
          assert.ok(
            parsed.interactive!.action.buttons.length >= 1 &&
              parsed.interactive!.action.buttons.length <= 3,
          );
          for (const b of parsed.interactive!.action.buttons) assert.ok(b.reply.title.length <= 20);
          sentPayloads.push({
            type: 'interactive',
            body: parsed.interactive!.body.text,
            buttons: parsed.interactive!.action.buttons.map((b) => b.reply.id),
          });
        } else {
          assert.equal(parsed.type, 'text');
          sentPayloads.push({ type: 'text', body: parsed.text!.body });
        }
        return new Response(
          JSON.stringify({ messages: [{ id: 'wamid.support.' + sentPayloads.length }] }),
        );
      }
      return originalFetch(url, options);
    };

    // Execute queued interactive menu job
    await tick();
    const afterMenu = (await getStore(s.merchant.id))!;
    assert.equal(afterMenu.workspace.jobs[0]!.state, 'DONE');
    assert.equal(afterMenu.workspace.outboundMessages?.[0]?.kind, 'SUPPORT_MENU');
    assert.equal(sentPayloads[0]?.type, 'interactive');
    assert.deepEqual(sentPayloads[0]?.buttons, ['MENU:STATUS', 'MENU:POLICY', 'MENU:HUMAN']);

    // Dynamic menu button filtering respects feature toggles
    assert.deepEqual(
      supportMenuButtons({ ...afterMenu.workspace.settings, tracking: false, faqs: true }).map(
        (b) => b.id,
      ),
      ['MENU:POLICY', 'MENU:HUMAN'],
    );
    assert.deepEqual(
      supportMenuButtons({ ...afterMenu.workspace.settings, tracking: true, faqs: false }).map(
        (b) => b.id,
      ),
      ['MENU:STATUS', 'MENU:HUMAN'],
    );

    // Escalation mixed with policy keyword still refuses auto-reply
    assert.equal(
      queueSupportReply(
        afterMenu,
        {
          from,
          body: 'Wrong item delivered, what is your return policy?',
          timestamp: String(Math.floor(now / 1000)),
        },
        now,
      ),
      false,
    );
    assert.equal(
      queueSupportReply(
        afterMenu,
        {
          from,
          body: 'I want to return my order, return policy?',
          timestamp: String(Math.floor(now / 1000)),
        },
        now,
      ),
      false,
    );

    // Clicking Store policies button answers via Shopify shopPolicies
    await processMetaEvent(
      s.merchant.id,
      metaButton('m-btn-policy', 'MENU:POLICY', 'Store policies'),
    );
    await tick();
    assert.equal(sentPayloads[1]?.type, 'text');
    assert.match(sentPayloads[1]!.body, /Shipping policy: https:\/\/policy-store\.myshopify\.com/);
    assert.match(
      sentPayloads[1]!.body,
      /Return & refund policy: https:\/\/policy-store\.myshopify\.com/,
    );

    // Synced COD order (no prior confirmation template sent) + clicking Order status returns live Shopify tracking
    await processShopifyEvent(s.merchant.id, 'orders/create', 'sh-order-500', incoming('500'));
    await processMetaEvent(
      s.merchant.id,
      metaButton('m-btn-status', 'MENU:STATUS', 'Order status'),
    );
    await tick();
    assert.match(sentPayloads[2]!.body, /Order #500 has been fulfilled/);
    assert.match(sentPayloads[2]!.body, /https:\/\/track\.example\/abc123/);

    // Specific shipping policy and return policy questions continue to work
    await processMetaEvent(s.merchant.id, metaMsg('m-ship-1', 'What is your shipping policy?'));
    await tick();
    await processMetaEvent(s.merchant.id, metaMsg('m-refund-1', 'What is your return policy?'));
    await tick();
    assert.match(sentPayloads[3]!.body, /24 hours & deliver in 2-4 days/);
    assert.match(sentPayloads[4]!.body, /Returns accepted within 7 days/);

    // Clicking Talk to support switches customer threads to human handling and sends 1 handoff ack
    await processMetaEvent(
      s.merchant.id,
      metaButton('m-btn-human', 'MENU:HUMAN', 'Talk to support'),
    );
    const afterHandoffIntake = (await getStore(s.merchant.id))!;
    assert.ok(afterHandoffIntake.workspace.conversations.every((c) => c.human));
    await tick();
    assert.equal(sentPayloads.length, 6);
    assert.match(sentPayloads[5]!.body, /has been notified and will reply here shortly/);
    const afterHandoffSend = (await getStore(s.merchant.id))!;
    assert.ok(afterHandoffSend.workspace.conversations.every((c) => c.human));

    // Human takeover blocks further menus, button automations, and auto-replies until resumed
    assert.equal(
      queueSupportReply(
        afterHandoffSend,
        {
          from,
          body: 'I want to ask about policies',
          timestamp: String(Math.floor(now / 1000)),
        },
        now,
      ),
      false,
    );
    await processMetaEvent(
      s.merchant.id,
      metaButton('m-btn-policy-2', 'MENU:POLICY', 'Store policies'),
    );
    await tick();
    assert.equal(sentPayloads.length, 6);
  } finally {
    Object.assign(config, prior);
    globalThis.fetch = originalFetch;
  }
});

test('interactive menu preserves UNKNOWN status cleanly on ambiguous 500 timeout without duplicate out bubble', async () => {
  const { metaCallbackUrl } = await import('../services/meta-webhook-settings.js');
  const s = fixture();
  const prior = {
    demo: config.demo,
    outbound: config.outbound,
    webhookUrl: config.webhookUrl,
  };
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const from = '923001234568';
  try {
    config.demo = false;
    config.outbound = true;
    config.webhookUrl = 'https://test-callback.invalid';
    Object.assign(s.workspace.integration, {
      phoneNumberId: '888777999',
      wabaId: '555444999',
      metaAppSecret: encrypt('secret'),
      metaVerifyTokenHash: 'hash',
      metaWebhookVerifiedAt: createdAt,
      metaWebhookUrl: metaCallbackUrl(s.merchant.id),
      whatsappToken: encrypt('fake-meta-token'),
      whatsappVerifiedAt: createdAt,
    });
    s.workspace.settings.faqs = true;
    s.workspace.settings.tracking = true;
    s.workspace.settings.metaSubscription = { wabaId: '555444999', verifiedAt: createdAt };
    await createStore(s);

    await processMetaEvent(s.merchant.id, {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '888777999' },
                messages: [
                  {
                    id: 'm-500-1',
                    from,
                    timestamp: String(Math.floor(now / 1000)),
                    text: { body: 'Hello' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    globalThis.fetch = async (url, options) => {
      if (String(url).includes('/888777999/messages'))
        return new Response('upstream error', { status: 500 });
      return originalFetch(url, options);
    };
    await tick();
    const after500 = (await getStore(s.merchant.id))!;
    assert.equal(after500.workspace.jobs[0]!.state, 'UNKNOWN');
    assert.equal(after500.workspace.outboundMessages?.[0]?.kind, 'SUPPORT_MENU');
    assert.equal(after500.workspace.outboundMessages?.[0]?.status, 'UNKNOWN');
    assert.equal(
      after500.workspace.conversations[0]!.messages.some((m) => m.direction === 'out'),
      false,
    );
  } finally {
    Object.assign(config, prior);
    globalThis.fetch = originalFetch;
  }
});

test('orders/delete webhook archives order and cancels queued jobs', async () => {
  const s = fixture();
  await createStore(s);
  const input = incoming('999');
  await processShopifyEvent(s.merchant.id, 'orders/create', 'ev1', input);
  const storeBefore = (await getStore(s.merchant.id))!;
  const o = storeBefore.workspace.orders.find((ord) => ord.shopifyOrderId === '999')!;
  assert.ok(!o.archivedAt);
  await mutate(s.merchant.id, (st) => {
    st.workspace.jobs.push({
      id: randomUUID(),
      orderId: o.id,
      kind: 'CONFIRMATION',
      state: 'QUEUED',
      dueAt: new Date().toISOString(),
      attempts: 0,
    });
  });
  await processShopifyEvent(s.merchant.id, 'orders/delete', 'ev2', { id: 999 });
  const storeAfter = (await getStore(s.merchant.id))!;
  const orderAfter = storeAfter.workspace.orders.find((ord) => ord.shopifyOrderId === '999')!;
  assert.ok(orderAfter.archivedAt);
  assert.equal(storeAfter.workspace.jobs[0]!.state, 'FAILED');
  assert.match(storeAfter.workspace.jobs[0]!.error!, /deleted in Shopify/i);
});

test('manual or background reconciliation archives orders deleted in Shopify', async () => {
  const s = fixture();
  await createStore(s);
  await mutate(s.merchant.id, (st) => {
    st.workspace.integration.shopDomain =
      'test-sync-' + s.merchant.id.slice(0, 8) + '.myshopify.com';
    st.workspace.integration.shopifyToken = encrypt('mock');
    st.workspace.integration.shopifyVerifiedAt = new Date().toISOString();
    ingestOrder(st, incoming('888'));
  });
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    try {
      const body = options?.body ? JSON.parse(String(options.body)) : {};
      if (body.query && typeof body.query === 'string') {
        if (body.query.includes('RelayRecovery')) {
          return new Response(
            JSON.stringify({
              data: {
                orders: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            }),
          );
        }
        if (body.query.includes('VerifyShopifyOrders')) {
          return new Response(
            JSON.stringify({
              data: {
                nodes: [null],
              },
            }),
          );
        }
      }
    } catch {
      /* Fallback for unparseable mock requests */
    }
    return new Response(JSON.stringify({ data: {} }));
  };
  try {
    await requestFullSync(s.merchant.id, 60, false);
    await reconcileMerchant(s.merchant.id);
    const storeAfter = (await getStore(s.merchant.id))!;
    const ord = storeAfter.workspace.orders.find((o) => o.shopifyOrderId === '888')!;
    assert.ok(ord.archivedAt);
  } finally {
    globalThis.fetch = original;
  }
});
