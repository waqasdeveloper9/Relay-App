import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createApp } from '../app.js';
import { config } from '../config.js';
import { issueToken } from '../middlewares/auth.js';
import {
  defaultQuickReplies,
  defaultShopifySync,
  defaultSupportSettings,
  orderMatchesPhone,
} from '../models/workspace-defaults.js';
import type { Store } from '../models/types.js';
import { confirm, enqueue, handleOrderDecision, markForReview } from '../services/automation.js';
import { processMetaEvent, processShopifyEvent } from '../services/incoming-events.js';
import {
  ingestOrder,
  mapShopifyFulfillmentStatus,
  planDispatchNotification,
  planOrderMessage,
} from '../services/order-ingestion.js';
import { createShopifyFulfillment, validateUtilityTemplate } from '../services/providers.js';
import { createStore, getStore, mutate } from '../services/repository.js';
import { emptyWorkspace } from '../services/seed.js';
import {
  menuPromptDetails,
  supportMenuButtons,
  supportReplyText,
} from '../services/support-replies.js';
import { tick } from '../services/worker.js';
import { encrypt } from '../utils/security.js';

let server: Server;
let base: string;
const realFetch = globalThis.fetch;
const initialAppUrl = config.appUrl;

before(async () => {
  config.appUrl = 'https://relay-test.example';
  await new Promise<void>((resolve) => {
    server = createApp().listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server address unavailable');
  base = `http://127.0.0.1:${address.port}/api`;
});

after(async () => {
  config.appUrl = initialAppUrl;
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function makeStore(options?: {
  brandName?: string;
  scopes?: string[];
  shopDomain?: string;
  phoneNumberId?: string;
  wabaId?: string;
}): Store {
  const merchantId = randomUUID();
  const wabaId = options?.wabaId ?? '99887766';
  const phoneNumberId =
    options?.phoneNumberId ?? String(1000000000 + Math.floor(Math.random() * 8999999999));
  const workspace = emptyWorkspace();
  workspace.integration = {
    ...workspace.integration,
    shopDomain: options?.shopDomain ?? `shop-${merchantId.slice(0, 8)}.myshopify.com`,
    shopifyToken: encrypt('shopify-token'),
    shopifyVerifiedAt: new Date().toISOString(),
    shopifyScopes: options?.scopes ?? ['write_orders', 'read_legal_policies'],
    phoneNumberId,
    wabaId,
    whatsappToken: encrypt('meta-token'),
    whatsappVerifiedAt: new Date().toISOString(),
    templateName: 'relay_order_confirmation_v1',
    languageCode: 'en_US',
    metaAppSecret: encrypt('meta-app-secret'),
    metaVerifyTokenHash: createHash('sha256').update('verify-token').digest('hex'),
    metaWebhookVerifiedAt: new Date().toISOString(),
    metaWebhookUrl: `https://relay-test.example/api/webhooks/meta/${merchantId}`,
  };
  workspace.settings.metaSubscription = {
    wabaId,
    verifiedAt: new Date().toISOString(),
  };
  return {
    merchant: {
      id: merchantId,
      email: `${merchantId}@test.invalid`,
      passwordHash: '',
      brandName: options?.brandName ?? 'Scent Studio',
      subscriptionStatus: 'ACTIVE',
      createdAt: new Date().toISOString(),
      trialEndsAt: new Date(Date.now() + 86400000).toISOString(),
    },
    workspace,
  };
}

function shopifyPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: '88001',
    name: '#88001',
    total_price: '4500',
    currency: 'PKR',
    payment_gateway_names: ['Cash on Delivery (COD)'],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    financial_status: 'pending',
    fulfillment_status: null,
    display_fulfillment_status: 'UNFULFILLED',
    shipping_address: {
      name: 'Ayesha Khan',
      phone: '+923001112233',
      country_code: 'PK',
    },
    ...overrides,
  };
}

async function apiRequest(path: string, cookie: string, body?: unknown, method = 'POST') {
  return realFetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('fulfillment mapping, webhook sync, hold/release, tracking extraction, and staleness protection', async () => {
  assert.equal(mapShopifyFulfillmentStatus('IN_PROGRESS', null), 'In progress');
  assert.equal(mapShopifyFulfillmentStatus('SCHEDULED', null), 'Scheduled');
  assert.equal(mapShopifyFulfillmentStatus('ON_HOLD', null), 'On hold');
  assert.equal(
    mapShopifyFulfillmentStatus('PARTIALLY_FULFILLED', 'partial'),
    'Partially fulfilled',
  );
  assert.equal(mapShopifyFulfillmentStatus('FULFILLED', 'fulfilled'), 'In transit');
  assert.equal(
    mapShopifyFulfillmentStatus('FULFILLED', 'fulfilled', [
      { status: 'SUCCESS', shipment_status: 'delivered' },
    ]),
    'Delivered',
  );
  assert.equal(mapShopifyFulfillmentStatus('RESTOCKED', 'restocked'), 'Restocked');
  // Delivered status does not silently regress back to In transit on repeated FULFILLED snapshots.
  assert.equal(
    mapShopifyFulfillmentStatus('FULFILLED', 'fulfilled', [], undefined, 'Delivered'),
    'Delivered',
  );

  const prevDemo = config.demo;
  const store = makeStore({
    scopes: [
      'write_orders',
      'read_legal_policies',
      'read_fulfillments',
      'write_merchant_managed_fulfillment_orders',
    ],
  });
  await createStore(store);

  let snapshotState: {
    displayFulfillmentStatus: string;
    updatedAt: string;
    fulfillments: unknown[];
  } = {
    displayFulfillmentStatus: 'IN_PROGRESS',
    updatedAt: new Date(Date.now() + 2000).toISOString(),
    fulfillments: [],
  };

  config.demo = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.includes('.myshopify.com')) return realFetch(input, init);
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables?: Record<string, unknown>;
    };
    if (body.query.includes('RelayResolveFulfillmentOrder')) {
      return Response.json({
        data: {
          fulfillmentOrder: {
            order: { id: 'gid://shopify/Order/88001' },
          },
        },
      });
    }
    if (body.query.includes('RelayOrderSnapshot')) {
      return Response.json({
        data: {
          order: {
            id: 'gid://shopify/Order/88001',
            name: '#88001',
            tags: ['COD-CONFIRMED'],
            phone: null,
            createdAt: new Date(Date.now() - 10000).toISOString(),
            updatedAt: snapshotState.updatedAt,
            cancelledAt: null,
            displayFinancialStatus: 'PENDING',
            displayFulfillmentStatus: snapshotState.displayFulfillmentStatus,
            paymentGatewayNames: ['Cash on Delivery (COD)'],
            currentTotalPriceSet: { shopMoney: { amount: '4500', currencyCode: 'PKR' } },
            shippingAddress: { name: 'Ayesha Khan', phone: '+923001112233', countryCodeV2: 'PK' },
            fulfillments: snapshotState.fulfillments,
          },
        },
      });
    }
    throw new Error(`Unexpected Shopify query: ${body.query}`);
  };

  try {
    await processShopifyEvent(store.merchant.id, 'orders/create', 'ev-create', shopifyPayload());
    let order = (await getStore(store.merchant.id))!.workspace.orders[0]!;
    assert.equal(order.delivery, 'Unfulfilled');

    // In progress via orders/updated GraphQL snapshot enrichment
    await processShopifyEvent(
      store.merchant.id,
      'orders/updated',
      'ev-progress',
      shopifyPayload({ updated_at: new Date(Date.now() + 1000).toISOString() }),
    );
    order = (await getStore(store.merchant.id))!.workspace.orders[0]!;
    assert.equal(order.delivery, 'In progress');
    assert.equal(order.fulfillmentStatus, 'IN_PROGRESS');

    // Placed on hold via fulfillment_orders/placed_on_hold resolving order_id from FO id
    snapshotState = {
      displayFulfillmentStatus: 'ON_HOLD',
      updatedAt: new Date(Date.now() + 3000).toISOString(),
      fulfillments: [],
    };
    await processShopifyEvent(store.merchant.id, 'fulfillment_orders/placed_on_hold', 'ev-hold', {
      fulfillment_order: { id: 'gid://shopify/FulfillmentOrder/551', status: 'ON_HOLD' },
    });
    order = (await getStore(store.merchant.id))!.workspace.orders[0]!;
    assert.equal(order.delivery, 'On hold');

    // Hold released bypasses equal/older sourceUpdatedAt timestamp so hold release always applies
    snapshotState = {
      displayFulfillmentStatus: 'UNFULFILLED',
      updatedAt: new Date(Date.now() + 3000).toISOString(),
      fulfillments: [],
    };
    await processShopifyEvent(store.merchant.id, 'fulfillment_orders/hold_released', 'ev-release', {
      fulfillment_order: { id: '551', order_id: '88001', status: 'OPEN' },
    });
    order = (await getStore(store.merchant.id))!.workspace.orders[0]!;
    assert.equal(order.delivery, 'Unfulfilled');

    // Fulfillments/create extracts courier + tracking while ignoring CANCELLED fulfillments
    snapshotState = {
      displayFulfillmentStatus: 'FULFILLED',
      updatedAt: new Date(Date.now() + 5000).toISOString(),
      fulfillments: [
        {
          status: 'CANCELLED',
          displayStatus: 'CANCELLED',
          trackingInfo: [{ url: 'https://bad.example/old', number: 'OLD000', company: 'OldCo' }],
          events: { nodes: [] },
        },
        {
          status: 'SUCCESS',
          displayStatus: 'IN_TRANSIT',
          trackingInfo: [
            { url: 'https://track.example/TCS-789', number: 'TCS-789', company: 'TCS' },
          ],
          events: { nodes: [] },
        },
      ],
    };
    await processShopifyEvent(store.merchant.id, 'fulfillments/create', 'ev-fulfill', {
      order_id: '88001',
      status: 'success',
      tracking_company: 'TCS',
      tracking_number: 'TCS-789',
      tracking_url: 'https://track.example/TCS-789',
    });
    order = (await getStore(store.merchant.id))!.workspace.orders[0]!;
    assert.equal(order.delivery, 'In transit');
    assert.equal(order.trackingCompany, 'TCS');
    assert.equal(order.trackingNumber, 'TCS-789');
    assert.equal(order.trackingUrl, 'https://track.example/TCS-789');

    // Stale orders/updated cannot regress fulfillment back to UNFULFILLED
    snapshotState = {
      displayFulfillmentStatus: 'UNFULFILLED',
      updatedAt: new Date(Date.now() + 1000).toISOString(),
      fulfillments: [],
    };
    await processShopifyEvent(
      store.merchant.id,
      'orders/updated',
      'ev-stale',
      shopifyPayload({ updated_at: new Date(Date.now() + 1000).toISOString() }),
    );
    order = (await getStore(store.merchant.id))!.workspace.orders[0]!;
    assert.equal(order.delivery, 'In transit');

    // fulfillment_events/create with delivered updates state even if order updatedAt equals stored sourceUpdatedAt
    snapshotState = {
      displayFulfillmentStatus: 'FULFILLED',
      updatedAt: new Date(Date.now() + 5000).toISOString(),
      fulfillments: [
        {
          status: 'SUCCESS',
          displayStatus: 'DELIVERED',
          trackingInfo: [
            { url: 'https://track.example/TCS-789', number: 'TCS-789', company: 'TCS' },
          ],
          events: { nodes: [{ status: 'DELIVERED', happenedAt: new Date().toISOString() }] },
        },
      ],
    };
    await processShopifyEvent(store.merchant.id, 'fulfillment_events/create', 'ev-delivered', {
      order_id: '88001',
      status: 'delivered',
    });
    order = (await getStore(store.merchant.id))!.workspace.orders[0]!;
    assert.equal(order.delivery, 'Delivered');
  } finally {
    config.demo = prevDemo;
    globalThis.fetch = realFetch;
  }
});

test('non-COD orders respect sync toggle, keyword matching, COD-only reports, and read-only tracking', async () => {
  const prevDemo = config.demo;
  config.demo = true;
  try {
    const storeA = makeStore();
    await createStore(storeA);
    const cookieA = `relay_session=${await issueToken(storeA.merchant.id)}`;

    await mutate(storeA.merchant.id, (s) => {
      // 1 COD pending order + 1 Prepaid fulfilled order
      const cod = ingestOrder(s, shopifyPayload({ id: '9001', name: '#9001' }));
      assert.equal(cod?.isCod, true);
      assert.equal(cod?.status, 'PENDING');
      const card = ingestOrder(
        s,
        shopifyPayload({
          id: '9002',
          name: '#9002',
          payment_gateway_names: ['Shopify Payments'],
          financial_status: 'paid',
          display_fulfillment_status: 'FULFILLED',
          fulfillments: [
            {
              status: 'SUCCESS',
              tracking_company: 'Leopards',
              tracking_number: 'LEO-44',
              tracking_url: 'https://track.example/LEO-44',
            },
          ],
          shipping_address: { name: 'Bilal Tariq', phone: '+923005556677', country_code: 'PK' },
        }),
      );
      assert.ok(card);
      assert.equal(card.isCod, false);
      assert.equal(card.status, 'CONFIRMED');
      assert.equal(card.financialStatus, 'paid');
      assert.equal(card.paymentMethod, 'Shopify Payments');
      assert.equal(card.delivery, 'In transit');
      // Never queues COD CONFIRMATION job for non-COD orders
      assert.equal(
        s.workspace.jobs.some((j) => j.orderId === card.id && j.kind === 'CONFIRMATION'),
        false,
      );
    });

    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: storeA.workspace.settings.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const reportRes = await apiRequest(`/reports?date=${today}`, cookieA);
    assert.equal(reportRes.status, 200);
    const report = (await reportRes.json()) as {
      orders: number;
      codOrders: number;
      nonCodOrders: number;
      confirmed: number;
      codConfirmed: number;
      pending: number;
    };
    assert.equal(report.orders, 2);
    assert.equal(report.codOrders, 1);
    assert.equal(report.nonCodOrders, 1);
    assert.equal(report.codConfirmed, 0);
    assert.equal(report.confirmed, 0);
    assert.equal(report.pending, 1);

    const cardOrder = (await getStore(storeA.merchant.id))!.workspace.orders.find(
      (o) => o.number === '#9002',
    )!;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes('.myshopify.com')) {
        return Response.json({
          data: {
            order: {
              cancelledAt: null,
              displayFulfillmentStatus: 'FULFILLED',
              fulfillments: [
                {
                  status: 'SUCCESS',
                  trackingInfo: [
                    { url: 'https://track.example/LEO-44', number: 'LEO-44', company: 'Leopards' },
                  ],
                },
              ],
            },
          },
        });
      }
      return realFetch(input, init);
    };
    const trackingReply = await supportReplyText(
      (await getStore(storeA.merchant.id))!,
      'status',
      cardOrder,
    );
    assert.match(trackingReply, /Order #9002 has been fulfilled/);
    assert.match(trackingReply, /Tracking \(Leopards\): https:\/\/track\.example\/LEO-44/);

    // Tenant B disables importNonCodOrders and sets custom COD gateway keyword
    const storeB = makeStore();
    storeB.workspace.settings.shopifySync = {
      ...defaultShopifySync,
      importNonCodOrders: false,
      codGatewayKeywords: ['pay at door'],
    };
    const skippedCard = ingestOrder(
      storeB,
      shopifyPayload({
        id: '9003',
        name: '#9003',
        payment_gateway_names: ['Stripe'],
        financial_status: 'paid',
      }),
    );
    assert.equal(skippedCard, undefined);
    const customCod = ingestOrder(
      storeB,
      shopifyPayload({
        id: '9004',
        name: '#9004',
        payment_gateway_names: ['Pay at Door Cash'],
        financial_status: 'pending',
      }),
    );
    assert.ok(customCod);
    assert.equal(customCod.isCod, true);
    assert.equal(customCod.status, 'PENDING');
  } finally {
    config.demo = prevDemo;
    globalThis.fetch = realFetch;
  }
});

test('configurable Shopify tags and Relay-owned fulfillment holds leave third-party holds untouched', async () => {
  const prevDemo = config.demo;
  const storeNoScope = makeStore({ scopes: ['write_orders', 'read_legal_policies'] });
  storeNoScope.workspace.settings.shopifySync = {
    ...defaultShopifySync,
    autoHoldUnconfirmed: true,
    holdOnReview: true,
    tagOnReview: true,
    reviewTag: 'MANUAL-CHECK',
  };
  const oNoScope = ingestOrder(storeNoScope, shopifyPayload({ id: '9101', name: '#9101' }))!;
  // Missing write_merchant_managed_fulfillment_orders skips FULFILLMENT_HOLD cleanly
  assert.equal(
    storeNoScope.workspace.jobs.some((j) => j.kind === 'FULFILLMENT_HOLD'),
    false,
  );
  markForReview(storeNoScope.workspace, oNoScope, 'flagged');
  assert.equal(
    storeNoScope.workspace.jobs.some((j) => j.kind === 'REVIEW_TAG'),
    true,
  );
  assert.equal(
    storeNoScope.workspace.jobs.some((j) => j.kind === 'FULFILLMENT_HOLD'),
    false,
  );

  const store = makeStore({
    scopes: [
      'write_orders',
      'read_legal_policies',
      'read_fulfillments',
      'write_merchant_managed_fulfillment_orders',
    ],
  });
  store.workspace.settings.shopifySync = {
    ...defaultShopifySync,
    confirmedTag: 'VERIFIED-COD',
    reviewTag: 'HOLD-REVIEW',
    cancellationRequestedTag: 'CUST-CANCEL',
    tagOnReview: true,
    autoHoldUnconfirmed: true,
    holdOnReview: true,
    holdOnCancellationRequest: true,
    releaseHoldOnConfirm: true,
    holdReasonNotes: 'Waiting WhatsApp confirmation',
  };
  await createStore(store);

  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  config.demo = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.includes('.myshopify.com')) return realFetch(input, init);
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    calls.push(body);
    if (body.query.includes('RelayOrderHolds')) {
      const holdList = body.query.includes('fulfillmentHolds')
        ? calls.some((c) => c.query.includes('RelayPlaceHold'))
          ? {
              nodes: [
                {
                  id: 'gid://shopify/FulfillmentOrder/701',
                  status: 'ON_HOLD',
                  fulfillmentHolds: [
                    {
                      id: 'gid://shopify/FulfillmentHold/manual-99',
                      handle: 'merchant-fraud',
                      heldByRequestingApp: false,
                      reason: 'HIGH_RISK_OF_FRAUD',
                    },
                    {
                      id: 'gid://shopify/FulfillmentHold/relay-1',
                      handle: 'relay-hold',
                      heldByRequestingApp: true,
                      reason: 'AWAITING_PAYMENT',
                    },
                  ],
                },
              ],
            }
          : {
              nodes: [
                {
                  id: 'gid://shopify/FulfillmentOrder/701',
                  status: 'OPEN',
                  fulfillmentHolds: [],
                },
              ],
            }
        : { nodes: [] };
      return Response.json({ data: { order: { fulfillmentOrders: holdList } } });
    }
    if (body.query.includes('RelayPlaceHold')) {
      return Response.json({
        data: {
          fulfillmentOrderHold: {
            fulfillmentHold: { id: 'fh1', handle: 'relay-hold' },
            userErrors: [],
          },
        },
      });
    }
    if (body.query.includes('RelayReleaseHold')) {
      return Response.json({
        data: {
          fulfillmentOrderReleaseHold: {
            fulfillmentOrder: { id: 'gid://shopify/FulfillmentOrder/701', status: 'ON_HOLD' },
            userErrors: [],
          },
        },
      });
    }
    if (body.query.includes('mutation Tags(')) {
      return Response.json({ data: { tagsAdd: { node: { id: '1' }, userErrors: [] } } });
    }
    if (body.query.includes('CancellationTagsRemove')) {
      return Response.json({ data: { tagsRemove: { userErrors: [] } } });
    }
    if (body.query.includes('CancellationTagsAdd')) {
      return Response.json({ data: { tagsAdd: { userErrors: [] } } });
    }
    throw new Error(`Unexpected Shopify query: ${body.query}`);
  };

  try {
    await mutate(store.merchant.id, (s) => {
      const order = ingestOrder(s, shopifyPayload({ id: '9102', name: '#9102' }))!;
      assert.equal(
        s.workspace.jobs.some((j) => j.orderId === order.id && j.kind === 'FULFILLMENT_HOLD'),
        true,
      );
    });

    // Execute FULFILLMENT_HOLD
    await tick();
    const placeCall = calls.find((c) => c.query.includes('RelayPlaceHold'));
    assert.ok(placeCall);
    assert.deepEqual(placeCall.variables.fulfillmentHold, {
      reason: 'AWAITING_PAYMENT',
      reasonNotes: 'Waiting WhatsApp confirmation',
      handle: 'relay-hold',
    });

    // Confirm order -> queues TAG ('VERIFIED-COD') and FULFILLMENT_RELEASE
    await mutate(store.merchant.id, (s) => {
      const order = s.workspace.orders[0]!;
      confirm(s.workspace, order);
    });
    await tick();
    await tick();

    const tagCall = calls.find((c) => c.query.includes('mutation Tags('));
    assert.ok(tagCall);
    assert.deepEqual(tagCall.variables.tags, ['VERIFIED-COD']);

    const releaseCall = calls.find((c) => c.query.includes('RelayReleaseHold'));
    assert.ok(releaseCall);
    // Must release ONLY the Relay hold, leaving merchant's 'manual-99' hold untouched
    assert.deepEqual(releaseCall.variables.holdIds, ['gid://shopify/FulfillmentHold/relay-1']);

    // Post-confirmation cancellation queues CANCEL_TAGS and FULFILLMENT_HOLD
    await mutate(store.merchant.id, (s) => {
      const order = s.workspace.orders[0]!;
      handleOrderDecision(s.workspace, order, 'CANCEL');
    });
    const afterCancel = (await getStore(store.merchant.id))!;
    assert.equal(
      afterCancel.workspace.jobs.some((j) => j.kind === 'CANCEL_TAGS' && j.state === 'QUEUED'),
      true,
    );
    assert.equal(
      afterCancel.workspace.jobs.some((j) => j.kind === 'FULFILLMENT_HOLD' && j.state === 'QUEUED'),
      true,
    );
    // Drain CANCEL_TAGS and FULFILLMENT_HOLD cleanly
    await tick();
    await tick();
    const remCall = calls.find((c) => c.query.includes('CancellationTagsRemove'));
    const addCancelTag = calls.find((c) => c.query.includes('CancellationTagsAdd'));
    assert.deepEqual(remCall?.variables.tags, ['VERIFIED-COD']);
    assert.deepEqual(addCancelTag?.variables.tags, ['CUST-CANCEL']);
  } finally {
    // Clean any remaining queued jobs on earlier stores and restore config
    await mutate(store.merchant.id, (s) => {
      for (const j of s.workspace.jobs) if (j.state === 'QUEUED') j.state = 'DONE';
    });
    config.demo = prevDemo;
    globalThis.fetch = realFetch;
  }
});

test('dispatch & delivery Utility templates validate, send with custom variable ordering, deduplicate, and handle 500 ambiguously', async () => {
  const prevDemo = config.demo;
  const prevOutbound = config.outbound;
  config.demo = false;
  config.outbound = false;

  const store = makeStore({ brandName: 'Roast & Bloom' });
  const cookie = `relay_session=${await issueToken(store.merchant.id)}`;
  store.workspace.settings.dispatchNotifications = {
    enabled: true,
    templateName: 'relay_dispatch_v1',
    languageCode: 'en',
    variables: ['order_number', 'courier', 'tracking_number'],
    includeTrackingButtonUrl: true,
    notifyOnPartial: false,
    deliveredEnabled: true,
    deliveredTemplateName: 'relay_delivered_v1',
    deliveredLanguageCode: 'en',
    deliveredVariables: ['customer_name', 'brand_name', 'order_number'],
  };
  const order = ingestOrder(
    store,
    shopifyPayload({
      id: '9201',
      name: '#9201',
      payment_gateway_names: ['Stripe'],
      financial_status: 'paid',
    }),
  )!;
  order.consent = true;
  // Use sandbox operator authorization for outbound notices while OUTBOUND_ENABLED=false
  store.workspace.settings.reliability = {
    syncEnabled: true,
    syncIntervalMinutes: 5,
    initialLookbackDays: 7,
    maxMessageAgeHours: 24,
    recoveryMessaging: 'REVIEW',
    testMode: {
      recipient: order.phone,
      template: 'relay_order_confirmation_v1',
      until: new Date(Date.now() + 3600_000).toISOString(),
    },
  };
  await createStore(store);

  const metaSends: Record<string, unknown>[] = [];
  let forceMeta500 = false;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.includes('graph.facebook.com')) return realFetch(input, init);
    if (url.includes('/message_templates')) {
      const name = new URL(url).searchParams.get('name');
      if (name === 'relay_dispatch_v1') {
        return Response.json({
          data: [
            {
              name: 'relay_dispatch_v1',
              language: 'en',
              status: 'APPROVED',
              components: [
                {
                  type: 'BODY',
                  text: 'Order {{1}} shipped via {{2}}. Tracking code: {{3}}.',
                },
                {
                  type: 'BUTTONS',
                  buttons: [
                    { type: 'URL', text: 'Track order', url: 'https://track.example/{{1}}' },
                  ],
                },
              ],
            },
          ],
        });
      }
      if (name === 'relay_delivered_v1') {
        return Response.json({
          data: [
            {
              name: 'relay_delivered_v1',
              language: 'en',
              status: 'APPROVED',
              components: [
                { type: 'BODY', text: 'Hi {{1}}, your {{2}} order {{3}} has been delivered!' },
              ],
            },
          ],
        });
      }
      if (name === 'bad_template_v1') {
        return Response.json({
          data: [
            {
              name: 'bad_template_v1',
              language: 'en',
              status: 'APPROVED',
              components: [{ type: 'BODY', text: 'Only {{1}} variable here.' }],
            },
          ],
        });
      }
      return Response.json({ data: [] });
    }
    if (url.includes('/messages')) {
      if (forceMeta500) {
        return Response.json({ error: { message: 'Internal error' } }, { status: 500 });
      }
      const parsed = JSON.parse(String(init?.body)) as Record<string, unknown>;
      metaSends.push(parsed);
      return Response.json({ messages: [{ id: `wamid.notice-${metaSends.length}` }] });
    }
    throw new Error(`Unexpected Meta URL: ${url}`);
  };

  try {
    // Reject wrong variable count / missing URL button
    await assert.rejects(
      validateUtilityTemplate(store.workspace.integration, {
        templateName: 'bad_template_v1',
        languageCode: 'en',
        expectedVariables: 3,
      }),
      /must contain 3 ordered variable/,
    );
    await assert.rejects(
      validateUtilityTemplate(store.workspace.integration, {
        templateName: 'relay_delivered_v1',
        languageCode: 'en',
        expectedVariables: 3,
        requireUrlButton: true,
      }),
      /dynamic URL button with \{\{1\}\}/,
    );

    // Endpoint validation returns 200 & hasUrlButton
    const valRes = await apiRequest('/integrations/whatsapp/validate-template', cookie, {
      kind: 'dispatch',
    });
    assert.equal(valRes.status, 200);
    const valBody = (await valRes.json()) as { ok: boolean; hasUrlButton: boolean };
    assert.equal(valBody.ok, true);
    assert.equal(valBody.hasUrlButton, true);

    // Transition order to In transit -> DISPATCH_NOTICE queued and executed
    await mutate(store.merchant.id, (s) => {
      const target = s.workspace.orders[0]!;
      ingestOrder(
        s,
        shopifyPayload({
          id: '9201',
          name: '#9201',
          payment_gateway_names: ['Stripe'],
          financial_status: 'paid',
          display_fulfillment_status: 'FULFILLED',
          updated_at: new Date().toISOString(),
          fulfillments: [
            {
              status: 'SUCCESS',
              tracking_company: 'Trax',
              tracking_number: 'TRX-551',
              tracking_url: 'https://track.example/TRX-551',
            },
          ],
        }),
      );
      // Repeated ingestion does not queue a second DISPATCH_NOTICE
      planDispatchNotification(s, target);
      assert.equal(
        s.workspace.jobs.filter((j) => j.kind === 'DISPATCH_NOTICE' && j.orderId === target.id)
          .length,
        1,
      );
    });

    await tick();
    assert.equal(metaSends.length, 1);
    const dispatchReq = metaSends[0] as {
      to: string;
      template: {
        name: string;
        components: { type: string; sub_type?: string; parameters: { text: string }[] }[];
      };
    };
    assert.equal(dispatchReq.to, order.phone);
    assert.equal(dispatchReq.template.name, 'relay_dispatch_v1');
    assert.deepEqual(
      dispatchReq.template.components[0]?.parameters.map((p) => p.text),
      ['#9201', 'Trax', 'TRX-551'],
    );
    assert.equal(dispatchReq.template.components[1]?.sub_type, 'url');
    assert.equal(dispatchReq.template.components[1]?.parameters[0]?.text, 'TRX-551');

    // Repeated webhook after DISPATCH_NOTICE ACCEPTED does NOT enqueue duplicate
    await mutate(store.merchant.id, (s) => {
      const target = s.workspace.orders[0]!;
      planDispatchNotification(s, target);
      assert.equal(s.workspace.jobs.filter((j) => j.kind === 'DISPATCH_NOTICE').length, 1);
    });

    // Delivery event -> test conservative 500 => UNKNOWN outcome
    forceMeta500 = true;
    await mutate(store.merchant.id, (s) => {
      ingestOrder(
        s,
        shopifyPayload({
          id: '9201',
          name: '#9201',
          payment_gateway_names: ['Stripe'],
          financial_status: 'paid',
          display_fulfillment_status: 'FULFILLED',
          event_delivery_status: 'delivered',
          updated_at: new Date().toISOString(),
        }),
      );
    });
    await tick();
    const after500 = (await getStore(store.merchant.id))!;
    const deliveryJob = after500.workspace.jobs.find((j) => j.kind === 'DELIVERY_NOTICE')!;
    const deliveryMsg = after500.workspace.outboundMessages?.find(
      (m) => m.jobId === deliveryJob.id,
    )!;
    assert.equal(deliveryJob.state, 'UNKNOWN');
    assert.equal(deliveryMsg.status, 'UNKNOWN');

    // Now succeed on a fresh store for age guard + actual DELIVERY_NOTICE send
    forceMeta500 = false;
    await mutate(store.merchant.id, (s) => {
      deliveryJob.state = 'DONE'; // settle so tick doesn't linger
      const target = s.workspace.orders[0]!;
      target.sourceUpdatedAt = new Date(Date.now() - 48 * 3600_000).toISOString();
      target.createdAt = new Date(Date.now() - 48 * 3600_000).toISOString();
      s.workspace.jobs = s.workspace.jobs.filter((j) => j.kind !== 'DELIVERY_NOTICE');
      s.workspace.outboundMessages = (s.workspace.outboundMessages ?? []).filter(
        (m) => m.kind !== 'DELIVERY_NOTICE',
      );
      planDispatchNotification(s, target);
      // Freshness guard rejects stale order update
      assert.equal(
        s.workspace.jobs.some((j) => j.kind === 'DELIVERY_NOTICE'),
        false,
      );
    });
  } finally {
    await mutate(store.merchant.id, (s) => {
      for (const j of s.workspace.jobs) {
        if (j.state === 'QUEUED' || j.state === 'UNKNOWN') j.state = 'DONE';
      }
    });
    config.demo = prevDemo;
    config.outbound = prevOutbound;
    globalThis.fetch = realFetch;
  }
});

test('STOP/START opt-out, Inbox cross-phone order linking, and configurable bot copy work end-to-end with strict tenant checks', async () => {
  const prevDemo = config.demo;
  const prevOutbound = config.outbound;
  config.demo = false;
  config.outbound = true;

  const store = makeStore({ brandName: 'Noor Perfumes' });
  const otherStore = makeStore({ brandName: 'Other Tenant' });
  await createStore(store);
  await createStore(otherStore);
  const cookie = `relay_session=${await issueToken(store.merchant.id)}`;

  const primaryPhone = '923001112233';
  const secondaryPhone = '923009998877';

  await mutate(store.merchant.id, (s) => {
    const order = ingestOrder(s, shopifyPayload({ id: '9301', name: '#9301' }))!;
    order.consent = true;
    enqueue(s.workspace, order, 'CONFIRMATION');
  });
  await mutate(otherStore.merchant.id, (s) => {
    ingestOrder(s, shopifyPayload({ id: '9999', name: '#9999' }));
  });

  const sentTexts: { to: string; body: string }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('.myshopify.com')) {
      return Response.json({
        data: {
          order: {
            cancelledAt: null,
            displayFulfillmentStatus: 'UNFULFILLED',
            fulfillments: [],
          },
        },
      });
    }
    if (url.includes('graph.facebook.com') && url.includes('/messages')) {
      const parsed = JSON.parse(String(init?.body)) as { to: string; text?: { body: string } };
      sentTexts.push({ to: parsed.to, body: parsed.text?.body ?? '' });
      return Response.json({ messages: [{ id: `wamid.opt-${sentTexts.length}` }] });
    }
    return realFetch(input, init);
  };

  try {
    // 1. Update support copy & quick replies via PUT /settings
    const saveRes = await apiRequest(
      '/settings',
      cookie,
      {
        confirmations: true,
        reminders: true,
        faqs: true,
        tracking: true,
        reminderHours: 6,
        timezone: 'Asia/Karachi',
        policy: 'Custom store policy text.',
        support: {
          ...defaultSupportSettings,
          menuBody: 'Hello from {{brand_name}}! Choose an option:',
          menuFooter: 'Support bot',
          statusButtonTitle: 'Track order',
          policyButtonTitle: 'Policies',
          humanButtonTitle: 'Agent',
        },
        quickReplies: [{ label: 'Dispatch note', body: 'Your parcel left today.' }],
      },
      'PUT',
    );
    assert.equal(saveRes.status, 200);
    const updatedStore = (await getStore(store.merchant.id))!;
    assert.deepEqual(
      supportMenuButtons(updatedStore.workspace.settings).map((b) => b.title),
      ['Track order', 'Policies', 'Agent'],
    );
    assert.match(
      menuPromptDetails(updatedStore.merchant.brandName, updatedStore.workspace.settings).body,
      /Hello from Noor Perfumes!/,
    );
    assert.deepEqual(updatedStore.workspace.settings.quickReplies, [
      { label: 'Dispatch note', body: 'Your parcel left today.' },
    ]);

    // 2. Customer sends STOP via Meta webhook -> cancels queued confirmation, blocks future replies, sends 1 ack
    await processMetaEvent(store.merchant.id, {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: store.workspace.integration.phoneNumberId },
                messages: [
                  {
                    id: 'wamid.in.stop',
                    from: primaryPhone,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    text: { body: 'STOP' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    let afterStop = (await getStore(store.merchant.id))!;
    assert.deepEqual(afterStop.workspace.settings.support?.optedOutPhones, [primaryPhone]);
    const stoppedOrder = afterStop.workspace.orders[0]!;
    assert.match(stoppedOrder.messageBlockedReason!, /opted out/i);
    assert.equal(afterStop.workspace.jobs.find((j) => j.kind === 'CONFIRMATION')?.state, 'FAILED');

    // Send the single optout acknowledgment
    await tick();
    assert.equal(sentTexts.length, 1);
    assert.match(
      sentTexts[0]!.body,
      /unsubscribed from automated order notifications from Noor Perfumes/i,
    );

    // Saving settings WITHOUT optedOutPhones preserves STOP opt-out
    const toggleRes = await apiRequest(
      '/settings',
      cookie,
      {
        confirmations: true,
        reminders: false,
        faqs: true,
        tracking: true,
        reminderHours: 6,
        timezone: 'Asia/Karachi',
        policy: 'Custom store policy text.',
        support: {
          ...defaultSupportSettings,
          optedOutPhones: undefined,
          menuBody: 'Hello from {{brand_name}}! Choose an option:',
        },
      },
      'PUT',
    );
    assert.equal(toggleRes.status, 200);
    afterStop = (await getStore(store.merchant.id))!;
    assert.deepEqual(afterStop.workspace.settings.support?.optedOutPhones, [primaryPhone]);

    // Customer query while opted out does not queue support reply
    await processMetaEvent(store.merchant.id, {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: store.workspace.integration.phoneNumberId },
                messages: [
                  {
                    id: 'wamid.in.blocked',
                    from: primaryPhone,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    text: { body: 'Where is my order?' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    afterStop = (await getStore(store.merchant.id))!;
    assert.equal(
      afterStop.workspace.jobs.some((j) => j.kind.startsWith('SUPPORT_REPLY:status:')),
      false,
    );

    // Customer sends START -> opted back in and blocked reason cleared
    await processMetaEvent(store.merchant.id, {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: store.workspace.integration.phoneNumberId },
                messages: [
                  {
                    id: 'wamid.in.start',
                    from: primaryPhone,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    text: { body: 'START' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    await tick();
    const afterStart = (await getStore(store.merchant.id))!;
    assert.deepEqual(afterStart.workspace.settings.support?.optedOutPhones, []);
    assert.equal(afterStart.workspace.orders[0]!.messageBlockedReason, undefined);
    assert.equal(sentTexts.length, 2);
    assert.match(sentTexts[1]!.body, /re-enabled/);

    // 3. Cross-phone Inbox order linking + cross-tenant protection + primary phone guard
    const secondaryConvId = randomUUID();
    const primaryConvId = randomUUID();
    await mutate(store.merchant.id, (s) => {
      s.workspace.conversations.push(
        {
          id: secondaryConvId,
          phone: secondaryPhone,
          human: false,
          unread: true,
          messages: [
            {
              id: randomUUID(),
              direction: 'in',
              text: 'Where is my order?',
              createdAt: new Date().toISOString(),
            },
          ],
        },
        {
          id: primaryConvId,
          orderId: stoppedOrder.id,
          human: false,
          unread: false,
          messages: [],
        },
      );
    });

    assert.equal(orderMatchesPhone(stoppedOrder, secondaryPhone), false);

    // Reject cross-tenant orderId
    const otherOrderId = (await getStore(otherStore.merchant.id))!.workspace.orders[0]!.id;
    const crossTenantLink = await apiRequest(`/conversations/${secondaryConvId}/action`, cookie, {
      action: 'link_order',
      orderId: otherOrderId,
    });
    assert.equal(crossTenantLink.status, 404);

    // Link merchant's own order to secondary WhatsApp number
    const linkOk = await apiRequest(`/conversations/${secondaryConvId}/action`, cookie, {
      action: 'link_order',
      orderId: stoppedOrder.id,
    });
    assert.equal(linkOk.status, 200);
    let linkedStore = (await getStore(store.merchant.id))!;
    assert.equal(orderMatchesPhone(linkedStore.workspace.orders[0]!, secondaryPhone), true);

    // Customer messaging from secondaryPhone now matches order #9301
    await processMetaEvent(store.merchant.id, {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: store.workspace.integration.phoneNumberId },
                messages: [
                  {
                    id: 'wamid.in.sec-status',
                    from: secondaryPhone,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    text: { body: 'Where is my order?' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    linkedStore = (await getStore(store.merchant.id))!;
    assert.equal(
      linkedStore.workspace.jobs.some(
        (j) => j.kind.startsWith('SUPPORT_REPLY:status:') && j.orderId === stoppedOrder.id,
      ),
      true,
    );
    await tick();
    assert.equal(sentTexts.length, 3);
    assert.equal(sentTexts[2]!.to, secondaryPhone);
    assert.match(sentTexts[2]!.body, /Order #9301 has not been fulfilled yet/);

    // Primary conversation cannot unlink its own order's phone number
    const unlinkPrimary = await apiRequest(`/conversations/${primaryConvId}/action`, cookie, {
      action: 'unlink_order',
      orderId: stoppedOrder.id,
    });
    assert.equal(unlinkPrimary.status, 400);

    // Secondary conversation can unlink cleanly
    const unlinkSec = await apiRequest(`/conversations/${secondaryConvId}/action`, cookie, {
      action: 'unlink_order',
      orderId: stoppedOrder.id,
    });
    assert.equal(unlinkSec.status, 200);
    linkedStore = (await getStore(store.merchant.id))!;
    assert.equal(orderMatchesPhone(linkedStore.workspace.orders[0]!, secondaryPhone), false);
    assert.ok(defaultQuickReplies.length >= 4);
  } finally {
    await mutate(store.merchant.id, (s) => {
      for (const j of s.workspace.jobs) {
        if (j.state === 'QUEUED' || j.state === 'UNKNOWN') j.state = 'DONE';
      }
    });
    config.demo = prevDemo;
    config.outbound = prevOutbound;
    globalThis.fetch = realFetch;
  }
});

test('bidirectional Shopify payment/fulfillment actions, bulk operations, ON_HOLD guardrail, and scope checks', async () => {
  const prevDemo = config.demo;
  const prevOutbound = config.outbound;
  config.demo = false;
  config.outbound = false;

  const storeNoScope = makeStore({
    scopes: ['read_orders', 'read_legal_policies', 'read_fulfillments'],
  });
  const store = makeStore({
    scopes: [
      'write_orders',
      'read_legal_policies',
      'write_fulfillments',
      'write_merchant_managed_fulfillment_orders',
    ],
  });
  await createStore(storeNoScope);
  await createStore(store);

  const noScopeCookie = `relay_session=${await issueToken(storeNoScope.merchant.id)}`;
  const cookie = `relay_session=${await issueToken(store.merchant.id)}`;

  let noScopeOrderId = '';
  let order9402Id = '';
  let order9403Id = '';
  await mutate(storeNoScope.merchant.id, (s) => {
    const o1 = ingestOrder(s, shopifyPayload({ id: '9401', name: '#9401' }))!;
    o1.delivery = 'In transit';
    o1.fulfillmentStatus = 'FULFILLED';
    noScopeOrderId = o1.id;
  });
  await mutate(store.merchant.id, (s) => {
    const o2 = ingestOrder(s, shopifyPayload({ id: '9402', name: '#9402' }))!;
    const o3 = ingestOrder(s, shopifyPayload({ id: '9403', name: '#9403' }))!;
    // Future-due confirmation job verifies MARK_PAID cancels pending confirmations cleanly.
    enqueue(s.workspace, o2, 'CONFIRMATION', 60_000);
    order9402Id = o2.id;
    order9403Id = o3.id;
  });

  const foStatus: Record<string, string> = { '9402': 'OPEN', '9403': 'OPEN' };
  const heldByRelay: Record<string, boolean> = { '9402': false, '9403': false };
  const fulfillmentsByOrder: Record<string, { id: string; status: string }[]> = {
    '9402': [],
    '9403': [],
  };
  const mutationsCalled: { name: string; variables: Record<string, unknown> }[] = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.includes('.myshopify.com')) return realFetch(input, init);
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const key =
      String(body.variables.id ?? '')
        .split('/')
        .at(-1) ?? '';

    if (body.query.includes('RelayCheckMarkPaid')) {
      return Response.json({
        data: {
          order: {
            id: body.variables.id,
            canMarkAsPaid: true,
            displayFinancialStatus: 'PENDING',
            cancelledAt: null,
          },
        },
      });
    }
    if (body.query.includes('RelayMarkOrderPaid')) {
      mutationsCalled.push({ name: 'mark_paid', variables: body.variables });
      return Response.json({
        data: {
          orderMarkAsPaid: {
            order: {
              id: (body.variables.input as { id: string }).id,
              displayFinancialStatus: 'PAID',
            },
            userErrors: [],
          },
        },
      });
    }
    if (body.query.includes('RelayOrderHolds')) {
      return Response.json({
        data: {
          order: {
            fulfillmentOrders: {
              nodes: [
                {
                  id: `gid://shopify/FulfillmentOrder/${key}`,
                  status: foStatus[key] ?? 'OPEN',
                  fulfillmentHolds: heldByRelay[key]
                    ? [
                        {
                          id: `gid://shopify/FulfillmentHold/${key}`,
                          handle: 'relay-hold',
                          heldByRequestingApp: true,
                          reason: 'OTHER',
                        },
                      ]
                    : [],
                },
              ],
            },
          },
        },
      });
    }
    if (body.query.includes('RelayReportProgress')) {
      mutationsCalled.push({ name: 'mark_in_progress', variables: body.variables });
      foStatus[key] = 'IN_PROGRESS';
      return Response.json({
        data: {
          fulfillmentOrderReportProgress: {
            fulfillmentOrder: { id: body.variables.id, status: 'IN_PROGRESS' },
            userErrors: [],
          },
        },
      });
    }
    if (body.query.includes('RelayOpenFulfillmentOrder')) {
      mutationsCalled.push({ name: 'reopen', variables: body.variables });
      foStatus[key] = 'OPEN';
      return Response.json({
        data: {
          fulfillmentOrderOpen: {
            fulfillmentOrder: { id: body.variables.id, status: 'OPEN' },
            userErrors: [],
          },
        },
      });
    }
    if (body.query.includes('RelayPlaceHold')) {
      mutationsCalled.push({ name: 'hold', variables: body.variables });
      foStatus[key] = 'ON_HOLD';
      heldByRelay[key] = true;
      return Response.json({
        data: {
          fulfillmentOrderHold: {
            fulfillmentHold: { id: `gid://shopify/FulfillmentHold/${key}`, handle: 'relay-hold' },
            userErrors: [],
          },
        },
      });
    }
    if (body.query.includes('RelayReleaseHold')) {
      mutationsCalled.push({ name: 'release_hold', variables: body.variables });
      const foKey = String(body.variables.id).split('/').at(-1)!;
      foStatus[foKey] = 'OPEN';
      heldByRelay[foKey] = false;
      return Response.json({
        data: {
          fulfillmentOrderReleaseHold: {
            fulfillmentOrder: { id: body.variables.id, status: 'OPEN' },
            userErrors: [],
          },
        },
      });
    }
    if (body.query.includes('RelayFulfillmentCreate')) {
      mutationsCalled.push({ name: 'fulfill', variables: body.variables });
      const fInput = body.variables.fulfillment as {
        lineItemsByFulfillmentOrder: { fulfillmentOrderId: string }[];
      };
      const foKey = fInput.lineItemsByFulfillmentOrder[0]!.fulfillmentOrderId.split('/').at(-1)!;
      foStatus[foKey] = 'CLOSED';
      const id = `gid://shopify/Fulfillment/${foKey}-1`;
      fulfillmentsByOrder[foKey] = [{ id, status: 'SUCCESS' }];
      return Response.json({
        data: { fulfillmentCreate: { fulfillment: { id }, userErrors: [] } },
      });
    }
    if (body.query.includes('RelayOrderFulfillments')) {
      return Response.json({ data: { order: { fulfillments: fulfillmentsByOrder[key] ?? [] } } });
    }
    if (body.query.includes('RelayUpdateTracking')) {
      mutationsCalled.push({ name: 'update_tracking', variables: body.variables });
      return Response.json({
        data: { fulfillmentTrackingInfoUpdate: { userErrors: [] } },
      });
    }
    if (body.query.includes('RelayMarkDelivered')) {
      mutationsCalled.push({ name: 'mark_delivered', variables: body.variables });
      return Response.json({
        data: { fulfillmentEventCreate: { userErrors: [] } },
      });
    }
    throw new Error(`Unexpected Shopify query: ${body.query}`);
  };

  try {
    // Scope guards reject insufficient Shopify permissions (including write_fulfillments vs read_fulfillments).
    assert.equal(
      (
        await apiRequest(`/orders/${noScopeOrderId}/shopify-action`, noScopeCookie, {
          action: 'mark_paid',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await apiRequest(`/orders/${noScopeOrderId}/shopify-action`, noScopeCookie, {
          action: 'mark_delivered',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await apiRequest('/orders/bulk', noScopeCookie, {
          action: 'hold',
          ids: [noScopeOrderId],
        })
      ).status,
      400,
    );

    // Non-HTTPS tracking URL rejected cleanly.
    const badTrack = await apiRequest(`/orders/${order9402Id}/shopify-action`, cookie, {
      action: 'fulfill',
      trackingUrl: 'http://insecure.example/1',
    });
    assert.equal(badTrack.status, 400);

    // 1. Mark in progress -> Reopen -> Hold
    assert.equal(
      (
        await apiRequest(`/orders/${order9402Id}/shopify-action`, cookie, {
          action: 'mark_in_progress',
        })
      ).status,
      200,
    );
    await tick();
    assert.equal(
      (await getStore(store.merchant.id))!.workspace.orders.find((o) => o.id === order9402Id)!
        .delivery,
      'In progress',
    );

    assert.equal(
      (await apiRequest(`/orders/${order9402Id}/shopify-action`, cookie, { action: 'reopen' }))
        .status,
      200,
    );
    await tick();
    assert.equal(
      (await getStore(store.merchant.id))!.workspace.orders.find((o) => o.id === order9402Id)!
        .delivery,
      'Unfulfilled',
    );

    assert.equal(
      (await apiRequest(`/orders/${order9402Id}/shopify-action`, cookie, { action: 'hold' }))
        .status,
      200,
    );
    await tick();
    let order9402 = (await getStore(store.merchant.id))!.workspace.orders.find(
      (o) => o.id === order9402Id,
    )!;
    assert.equal(order9402.delivery, 'On hold');

    // Guardrail rejects fulfill when local or live Shopify fulfillment order is ON_HOLD.
    const blockedFulfill = await apiRequest(`/orders/${order9402Id}/shopify-action`, cookie, {
      action: 'fulfill',
    });
    assert.equal(blockedFulfill.status, 400);
    await assert.rejects(
      createShopifyFulfillment(
        (await getStore(store.merchant.id))!.workspace.integration,
        order9402,
      ),
      /Release the hold before fulfilling/,
    );

    // 2. Release hold -> Fulfill with tracking + notifyCustomer -> Update tracking -> Mark delivered
    assert.equal(
      (
        await apiRequest(`/orders/${order9402Id}/shopify-action`, cookie, {
          action: 'release_hold',
        })
      ).status,
      200,
    );
    await tick();
    assert.equal(
      (
        await apiRequest(`/orders/${order9402Id}/shopify-action`, cookie, {
          action: 'fulfill',
          trackingCompany: 'TCS',
          trackingNumber: 'TCS-111',
          trackingUrl: 'https://track.example/TCS-111',
          notifyCustomer: true,
        })
      ).status,
      200,
    );
    await tick();
    order9402 = (await getStore(store.merchant.id))!.workspace.orders.find(
      (o) => o.id === order9402Id,
    )!;
    assert.equal(order9402.delivery, 'In transit');
    assert.equal(order9402.trackingCompany, 'TCS');
    assert.equal(order9402.trackingNumber, 'TCS-111');
    const fulfillCall = mutationsCalled.find((m) => m.name === 'fulfill')!.variables
      .fulfillment as {
      notifyCustomer: boolean;
      trackingInfo: { company: string; number: string; url: string };
    };
    assert.equal(fulfillCall.notifyCustomer, true);
    assert.deepEqual(fulfillCall.trackingInfo, {
      company: 'TCS',
      number: 'TCS-111',
      url: 'https://track.example/TCS-111',
    });

    assert.equal(
      (
        await apiRequest(`/orders/${order9402Id}/shopify-action`, cookie, {
          action: 'update_tracking',
          trackingCompany: 'Leopards',
          trackingNumber: 'LEO-222',
          trackingUrl: 'https://track.example/LEO-222',
        })
      ).status,
      200,
    );
    await tick();
    order9402 = (await getStore(store.merchant.id))!.workspace.orders.find(
      (o) => o.id === order9402Id,
    )!;
    assert.equal(order9402.trackingCompany, 'Leopards');
    assert.equal(order9402.trackingNumber, 'LEO-222');

    assert.equal(
      (
        await apiRequest(`/orders/${order9402Id}/shopify-action`, cookie, {
          action: 'mark_delivered',
        })
      ).status,
      200,
    );
    await tick();
    assert.equal(
      (await getStore(store.merchant.id))!.workspace.orders.find((o) => o.id === order9402Id)!
        .delivery,
      'Delivered',
    );

    // 3. Mark paid resolves payment status, confirms pending COD, stops queued confirmation, blocks duplicate
    assert.equal(
      (await apiRequest(`/orders/${order9402Id}/shopify-action`, cookie, { action: 'mark_paid' }))
        .status,
      200,
    );
    await tick();
    const afterPaidStore = (await getStore(store.merchant.id))!;
    order9402 = afterPaidStore.workspace.orders.find((o) => o.id === order9402Id)!;
    assert.equal(order9402.financialStatus, 'paid');
    assert.equal(order9402.status, 'CONFIRMED');
    const stoppedConfirm = afterPaidStore.workspace.jobs.find(
      (j) => j.orderId === order9402Id && j.kind === 'CONFIRMATION',
    )!;
    assert.equal(stoppedConfirm.state, 'FAILED');
    assert.match(stoppedConfirm.error!, /marked paid/i);
    assert.equal(
      (await apiRequest(`/orders/${order9402Id}/shopify-action`, cookie, { action: 'mark_paid' }))
        .status,
      400,
    );

    // 4. Bulk actions skip ineligible orders and execute eligible ones
    const bulkPaid = await apiRequest('/orders/bulk', cookie, {
      action: 'mark_paid',
      ids: [order9402Id, order9403Id],
    });
    assert.equal(bulkPaid.status, 200);
    const bulkPaidBody = (await bulkPaid.json()) as { affected: number; skipped: number };
    assert.deepEqual(
      { affected: bulkPaidBody.affected, skipped: bulkPaidBody.skipped },
      { affected: 1, skipped: 1 },
    );
    await tick();
    assert.equal(
      (await getStore(store.merchant.id))!.workspace.orders.find((o) => o.id === order9403Id)!
        .financialStatus,
      'paid',
    );

    assert.equal(
      (
        await apiRequest('/orders/bulk', cookie, {
          action: 'mark_in_progress',
          ids: [order9403Id],
        })
      ).status,
      200,
    );
    await tick();
    assert.equal(
      (await getStore(store.merchant.id))!.workspace.orders.find((o) => o.id === order9403Id)!
        .delivery,
      'In progress',
    );
    assert.equal(
      (await apiRequest('/orders/bulk', cookie, { action: 'hold', ids: [order9403Id] })).status,
      200,
    );
    await tick();
    assert.equal(
      (await getStore(store.merchant.id))!.workspace.orders.find((o) => o.id === order9403Id)!
        .delivery,
      'On hold',
    );
    assert.equal(
      (await apiRequest('/orders/bulk', cookie, { action: 'release_hold', ids: [order9403Id] }))
        .status,
      200,
    );
    await tick();
    assert.equal(
      (await getStore(store.merchant.id))!.workspace.orders.find((o) => o.id === order9403Id)!
        .delivery,
      'Unfulfilled',
    );
  } finally {
    for (const sId of [storeNoScope.merchant.id, store.merchant.id]) {
      await mutate(sId, (s) => {
        for (const j of s.workspace.jobs) {
          if (j.state === 'QUEUED' || j.state === 'UNKNOWN') j.state = 'DONE';
        }
      });
    }
    config.demo = prevDemo;
    config.outbound = prevOutbound;
    globalThis.fetch = realFetch;
  }
});

test('ambiguous 500 on MARK_PAID and FULFILL_ORDER becomes UNKNOWN without blind retry, reconciles on webhook, and external payment blocks COD confirmation', async () => {
  const prevDemo = config.demo;
  const prevOutbound = config.outbound;
  config.demo = false;
  config.outbound = false;

  const store = makeStore({
    scopes: [
      'write_orders',
      'read_legal_policies',
      'write_fulfillments',
      'write_merchant_managed_fulfillment_orders',
    ],
  });
  await createStore(store);
  const cookie = `relay_session=${await issueToken(store.merchant.id)}`;

  let order9501Id = '';
  let order9502Id = '';
  await mutate(store.merchant.id, (s) => {
    const o1 = ingestOrder(s, shopifyPayload({ id: '9501', name: '#9501' }))!;
    const o2 = ingestOrder(s, shopifyPayload({ id: '9502', name: '#9502' }))!;
    enqueue(s.workspace, o2, 'CONFIRMATION', 60_000);
    const o3 = ingestOrder(
      s,
      shopifyPayload({
        id: '9503',
        name: '#9503',
        financial_status: 'paid',
      }),
    )!;
    assert.equal(o3.status, 'NEEDS_REVIEW');
    assert.equal(o3.messageBlockedReason, 'Order is no longer pending confirmation');
    o3.status = 'PENDING';
    planOrderMessage(s, o3);
    assert.equal(o3.messageBlockedReason, 'Order is no longer payment pending');
    o3.status = 'NEEDS_REVIEW';
    order9501Id = o1.id;
    order9502Id = o2.id;
  });

  let markPaidCalls = 0;
  let fulfillCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.includes('.myshopify.com')) return realFetch(input, init);
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    if (body.query.includes('RelayCheckMarkPaid')) {
      return Response.json({
        data: {
          order: {
            id: body.variables.id,
            canMarkAsPaid: true,
            displayFinancialStatus: 'PENDING',
            cancelledAt: null,
          },
        },
      });
    }
    if (body.query.includes('RelayMarkOrderPaid')) {
      markPaidCalls++;
      return Response.json({ error: 'Shopify 500 timeout' }, { status: 500 });
    }
    if (body.query.includes('RelayOrderHolds')) {
      return Response.json({
        data: {
          order: {
            fulfillmentOrders: {
              nodes: [
                {
                  id: 'gid://shopify/FulfillmentOrder/9501',
                  status: 'OPEN',
                  fulfillmentHolds: [],
                },
              ],
            },
          },
        },
      });
    }
    if (body.query.includes('RelayFulfillmentCreate')) {
      fulfillCalls++;
      return Response.json({ error: 'Shopify 500 timeout' }, { status: 500 });
    }
    throw new Error(`Unexpected Shopify query: ${body.query}`);
  };

  try {
    assert.equal(
      (await apiRequest(`/orders/${order9501Id}/shopify-action`, cookie, { action: 'mark_paid' }))
        .status,
      200,
    );
    await tick();
    // Second tick must NOT blindly retry ambiguous MARK_PAID!
    await tick();
    assert.equal(markPaidCalls, 1);

    assert.equal(
      (await apiRequest(`/orders/${order9501Id}/shopify-action`, cookie, { action: 'fulfill' }))
        .status,
      200,
    );
    await tick();
    await tick();
    assert.equal(fulfillCalls, 1);

    const mid = (await getStore(store.merchant.id))!;
    const paidJob = mid.workspace.jobs.find(
      (j) => j.orderId === order9501Id && j.kind === 'MARK_PAID',
    )!;
    const fulfillJob = mid.workspace.jobs.find(
      (j) => j.orderId === order9501Id && j.kind === 'FULFILL_ORDER',
    )!;
    assert.equal(paidJob.state, 'UNKNOWN');
    assert.equal(paidJob.retryable, false);
    assert.equal(fulfillJob.state, 'UNKNOWN');
    assert.equal(fulfillJob.retryable, false);
    assert.ok(
      mid.workspace.notifications?.some(
        (n) =>
          n.key === 'job:' + paidJob.id &&
          n.title === 'Action outcome is uncertain' &&
          !n.resolvedAt,
      ),
    );

    // Webhook/reconciliation snapshot proves both succeeded in Shopify and clears UNKNOWN + alerts.
    await mutate(store.merchant.id, (s) => {
      ingestOrder(
        s,
        shopifyPayload({
          id: '9501',
          name: '#9501',
          financial_status: 'paid',
          display_fulfillment_status: 'FULFILLED',
          updated_at: new Date(Date.now() + 5000).toISOString(),
          fulfillments: [
            {
              status: 'SUCCESS',
              tracking_company: 'PostEx',
              tracking_number: 'PK-99',
              tracking_url: 'https://track.example/PK-99',
            },
          ],
        }),
      );
      // External payment webhook on an unconfirmed COD order stops queued confirmation and marks NEEDS_REVIEW.
      ingestOrder(
        s,
        shopifyPayload({
          id: '9502',
          name: '#9502',
          financial_status: 'paid',
          updated_at: new Date(Date.now() + 5000).toISOString(),
        }),
      );
    });

    const reconciled = (await getStore(store.merchant.id))!;
    const rPaidJob = reconciled.workspace.jobs.find(
      (j) => j.orderId === order9501Id && j.kind === 'MARK_PAID',
    )!;
    const rFulfillJob = reconciled.workspace.jobs.find(
      (j) => j.orderId === order9501Id && j.kind === 'FULFILL_ORDER',
    )!;
    assert.equal(rPaidJob.state, 'DONE');
    assert.equal(rFulfillJob.state, 'DONE');
    assert.ok(
      reconciled.workspace.notifications?.find((n) => n.key === 'job:' + paidJob.id)?.resolvedAt,
    );

    const o9502 = reconciled.workspace.orders.find((o) => o.id === order9502Id)!;
    assert.equal(o9502.status, 'NEEDS_REVIEW');
    assert.equal(o9502.financialStatus, 'paid');
    const cJob = reconciled.workspace.jobs.find(
      (j) => j.orderId === order9502Id && j.kind === 'CONFIRMATION',
    )!;
    assert.equal(cJob.state, 'FAILED');
    assert.match(cJob.error!, /payment status changed/i);
  } finally {
    await mutate(store.merchant.id, (s) => {
      for (const j of s.workspace.jobs) {
        if (j.state === 'QUEUED' || j.state === 'UNKNOWN') j.state = 'DONE';
      }
    });
    config.demo = prevDemo;
    config.outbound = prevOutbound;
    globalThis.fetch = realFetch;
  }
});

test('all 5 status WhatsApp templates, explicit checkout consent sync, STOP blocking, and custom orderViews persistence work end-to-end', async () => {
  const prevDemo = config.demo;
  const prevOutbound = config.outbound;
  config.demo = false;
  config.outbound = true;

  const store = makeStore({
    brandName: 'Khaas Scents',
    scopes: [
      'write_orders',
      'read_legal_policies',
      'write_fulfillments',
      'write_merchant_managed_fulfillment_orders',
    ],
  });
  store.workspace.settings.confirmations = false;
  await createStore(store);
  const cookie = `relay_session=${await issueToken(store.merchant.id)}`;

  const metaSends: {
    to: string;
    template: { name: string; components: { type: string; parameters: { text: string }[] }[] };
  }[] = [];
  let foStatus = 'OPEN';
  let held = false;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('.myshopify.com')) {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (body.query.includes('RelayOrderHolds')) {
        return Response.json({
          data: {
            order: {
              fulfillmentOrders: {
                nodes: [
                  {
                    id: 'gid://shopify/FulfillmentOrder/9601',
                    status: foStatus,
                    fulfillmentHolds: held
                      ? [
                          {
                            id: 'gid://shopify/FulfillmentHold/9601',
                            handle: 'relay-hold',
                            heldByRequestingApp: true,
                            reason: 'OTHER',
                          },
                        ]
                      : [],
                  },
                ],
              },
            },
          },
        });
      }
      if (body.query.includes('RelayReportProgress')) {
        foStatus = 'IN_PROGRESS';
        return Response.json({ data: { fulfillmentOrderReportProgress: { userErrors: [] } } });
      }
      if (body.query.includes('RelayPlaceHold')) {
        foStatus = 'ON_HOLD';
        held = true;
        return Response.json({
          data: {
            fulfillmentOrderHold: {
              fulfillmentHold: { id: 'gid://shopify/FulfillmentHold/9601', handle: 'relay-hold' },
              userErrors: [],
            },
          },
        });
      }
      if (body.query.includes('RelayReleaseHold')) {
        foStatus = 'OPEN';
        held = false;
        return Response.json({
          data: {
            fulfillmentOrderReleaseHold: {
              fulfillmentOrder: { id: 'gid://shopify/FulfillmentOrder/9601', status: 'OPEN' },
              userErrors: [],
            },
          },
        });
      }
      if (body.query.includes('RelayFulfillmentCreate')) {
        foStatus = 'CLOSED';
        return Response.json({
          data: {
            fulfillmentCreate: {
              fulfillment: { id: 'gid://shopify/Fulfillment/9601-1' },
              userErrors: [],
            },
          },
        });
      }
      if (body.query.includes('RelayOrderFulfillments')) {
        return Response.json({
          data: {
            order: {
              fulfillments: [{ id: 'gid://shopify/Fulfillment/9601-1', status: 'SUCCESS' }],
            },
          },
        });
      }
      if (body.query.includes('RelayMarkDelivered')) {
        return Response.json({ data: { fulfillmentEventCreate: { userErrors: [] } } });
      }
      if (body.query.includes('RelayCheckMarkPaid')) {
        return Response.json({
          data: {
            order: {
              id: body.variables.id,
              canMarkAsPaid: true,
              displayFinancialStatus: 'PENDING',
              cancelledAt: null,
            },
          },
        });
      }
      if (body.query.includes('RelayMarkOrderPaid')) {
        return Response.json({
          data: {
            orderMarkAsPaid: {
              order: {
                id: (body.variables.input as { id: string }).id,
                displayFinancialStatus: 'PAID',
              },
              userErrors: [],
            },
          },
        });
      }
      throw new Error(`Unexpected Shopify query: ${body.query}`);
    }
    if (url.includes('graph.facebook.com') && url.includes('/message_templates')) {
      const name = new URL(url).searchParams.get('name');
      const bodies: Record<string, string> = {
        relay_paid_v1: 'Hi {{1}}, payment for {{2}} ({{3}}) at {{4}} was received.',
        relay_progress_v1: 'Hi {{1}}, your order {{2}} at {{3}} is now being packed.',
        relay_hold_v1: 'Hi {{1}}, your order {{2}} has been paused for confirmation.',
        relay_dispatch_v1: 'Order {{1}} shipped via {{2}} ({{3}}).',
        relay_delivered_v1: 'Hi {{1}}, {{2}} delivered your order {{3}}!',
      };
      return Response.json({
        data:
          name && bodies[name]
            ? [
                {
                  name,
                  language: 'en',
                  status: 'APPROVED',
                  components: [{ type: 'BODY', text: bodies[name] }],
                },
              ]
            : [],
      });
    }
    if (url.includes('graph.facebook.com') && url.includes('/messages')) {
      const parsed = JSON.parse(String(init?.body)) as (typeof metaSends)[number];
      metaSends.push(parsed);
      return Response.json({ messages: [{ id: `wamid.stage-${metaSends.length}` }] });
    }
    return realFetch(input, init);
  };

  try {
    // 1. Save all 5 stage templates + checkout consent settings + custom saved orderView via PUT /settings
    const savedViews = [
      {
        id: 'view-1',
        name: 'Cash pending',
        tab: 'unpaid',
        paymentFilter: 'PENDING',
        fulfillmentFilter: 'IN_TRANSIT',
        search: 'Ayesha',
      },
    ];
    const saveRes = await apiRequest(
      '/settings',
      cookie,
      {
        confirmations: false,
        reminders: true,
        faqs: true,
        tracking: true,
        reminderHours: 6,
        timezone: 'Asia/Karachi',
        policy: 'Standard return policy.',
        shopifySync: {
          ...defaultShopifySync,
          syncCustomerSmsConsent: true,
          checkoutConsentAttributeKey: 'whatsapp_opt_in',
          checkoutConsentValues: ['yes', 'true', '1'],
        },
        dispatchNotifications: {
          enabled: true,
          templateName: 'relay_dispatch_v1',
          languageCode: 'en',
          variables: ['order_number', 'courier', 'tracking_number'],
          includeTrackingButtonUrl: false,
          notifyOnPartial: false,
          deliveredEnabled: true,
          deliveredTemplateName: 'relay_delivered_v1',
          deliveredLanguageCode: 'en',
          deliveredVariables: ['customer_name', 'brand_name', 'order_number'],
          paidEnabled: true,
          paidTemplateName: 'relay_paid_v1',
          paidLanguageCode: 'en',
          paidVariables: ['customer_name', 'order_number', 'total_amount', 'brand_name'],
          inProgressEnabled: true,
          inProgressTemplateName: 'relay_progress_v1',
          inProgressLanguageCode: 'en',
          inProgressVariables: ['customer_name', 'order_number', 'brand_name'],
          onHoldEnabled: true,
          onHoldTemplateName: 'relay_hold_v1',
          onHoldLanguageCode: 'en',
          onHoldVariables: ['customer_name', 'order_number'],
        },
        orderViews: savedViews,
      },
      'PUT',
    );
    assert.equal(saveRes.status, 200);
    assert.deepEqual(
      (await getStore(store.merchant.id))!.workspace.settings.orderViews,
      savedViews,
    );

    // Saving unrelated settings WITHOUT orderViews preserves saved views.
    assert.equal(
      (
        await apiRequest(
          '/settings',
          cookie,
          {
            confirmations: false,
            reminders: false,
            faqs: true,
            tracking: true,
            reminderHours: 6,
            timezone: 'Asia/Karachi',
            policy: 'Standard return policy.',
          },
          'PUT',
        )
      ).status,
      200,
    );
    assert.deepEqual(
      (await getStore(store.merchant.id))!.workspace.settings.orderViews,
      savedViews,
    );

    // 2. Validate new paid / in_progress / on_hold templates via endpoint
    for (const kind of ['paid', 'in_progress', 'on_hold'] as const) {
      const vRes = await apiRequest('/integrations/whatsapp/validate-template', cookie, { kind });
      assert.equal(vRes.status, 200);
    }

    // 3. Explicit checkout consent rules (shipping phone alone never grants consent)
    let o9601Id = '';
    await mutate(store.merchant.id, (s) => {
      const noOpt = ingestOrder(s, shopifyPayload({ id: '9600', name: '#9600' }))!;
      assert.equal(noOpt.consent, false);

      const smsOpt = ingestOrder(
        s,
        shopifyPayload({
          id: '9601',
          name: '#9601',
          customer: { sms_marketing_consent: { state: 'subscribed' } },
        }),
      )!;
      assert.equal(smsOpt.consent, true);
      o9601Id = smsOpt.id;

      const attrOpt = ingestOrder(
        s,
        shopifyPayload({
          id: '9602',
          name: '#9602',
          shipping_address: { name: 'Sara', phone: '+923009990001', country_code: 'PK' },
          note_attributes: [{ name: 'WhatsApp_Opt_In', value: 'YES' }],
        }),
      )!;
      assert.equal(attrOpt.consent, true);

      const declinedAttr = ingestOrder(
        s,
        shopifyPayload({
          id: '9603',
          name: '#9603',
          shipping_address: { name: 'Zain', phone: '+923009990002', country_code: 'PK' },
          note_attributes: [{ name: 'whatsapp_opt_in', value: 'no' }],
        }),
      )!;
      assert.equal(declinedAttr.consent, false);

      // Disabling syncCustomerSmsConsent prevents SMS marketing consent grant
      const clone = structuredClone(s);
      clone.workspace.settings.shopifySync!.syncCustomerSmsConsent = false;
      const smsBlocked = ingestOrder(
        clone,
        shopifyPayload({
          id: '9604',
          name: '#9604',
          customer: { sms_marketing_consent: { state: 'subscribed' } },
        }),
      )!;
      assert.equal(smsBlocked.consent, false);
    });

    // 4. Execute all 5 stage transitions on #9601 and confirm each sends its distinct WhatsApp template
    await apiRequest(`/orders/${o9601Id}/shopify-action`, cookie, { action: 'mark_in_progress' });
    await tick();
    await tick();

    await apiRequest(`/orders/${o9601Id}/shopify-action`, cookie, {
      action: 'hold',
      reasonNotes: 'Confirming flat number',
    });
    await tick();
    await tick();

    await apiRequest(`/orders/${o9601Id}/shopify-action`, cookie, { action: 'release_hold' });
    await tick();

    await apiRequest(`/orders/${o9601Id}/shopify-action`, cookie, {
      action: 'fulfill',
      trackingCompany: 'TCS',
      trackingNumber: 'TCS-9601',
    });
    await tick();
    await tick();

    await apiRequest(`/orders/${o9601Id}/shopify-action`, cookie, { action: 'mark_delivered' });
    await tick();
    await tick();

    await apiRequest(`/orders/${o9601Id}/shopify-action`, cookie, { action: 'mark_paid' });
    await tick();
    await tick();

    assert.deepEqual(
      metaSends.map((m) => m.template.name),
      [
        'relay_progress_v1',
        'relay_hold_v1',
        'relay_dispatch_v1',
        'relay_delivered_v1',
        'relay_paid_v1',
      ],
    );
    const paidSend = metaSends[4]!;
    assert.deepEqual(
      paidSend.template.components[0]?.parameters.map((p) => p.text),
      ['Ayesha Khan', '#9601', 'PKR 4500', 'Khaas Scents'],
    );

    // Re-running planner never duplicates any stage notice
    await mutate(store.merchant.id, (s) => {
      const o = s.workspace.orders.find((o) => o.id === o9601Id)!;
      planDispatchNotification(s, o);
      for (const kind of [
        'PAYMENT_NOTICE',
        'IN_PROGRESS_NOTICE',
        'ON_HOLD_NOTICE',
        'DISPATCH_NOTICE',
        'DELIVERY_NOTICE',
      ]) {
        assert.equal(
          s.workspace.jobs.filter((j) => j.orderId === o.id && j.kind === kind).length,
          1,
        );
      }

      // Customer opted out via STOP never receives stage notifications
      s.workspace.settings.support = {
        ...defaultSupportSettings,
        optedOutPhones: ['923009990001'],
      };
      const o9602 = s.workspace.orders.find((o) => o.shopifyOrderId === '9602')!;
      o9602.financialStatus = 'paid';
      planDispatchNotification(s, o9602, false, true);
      assert.equal(
        s.workspace.jobs.some((j) => j.orderId === o9602.id && j.kind === 'PAYMENT_NOTICE'),
        false,
      );
    });
  } finally {
    await mutate(store.merchant.id, (s) => {
      for (const j of s.workspace.jobs) {
        if (j.state === 'QUEUED' || j.state === 'UNKNOWN') j.state = 'DONE';
      }
    });
    config.demo = prevDemo;
    config.outbound = prevOutbound;
    globalThis.fetch = realFetch;
  }
});
