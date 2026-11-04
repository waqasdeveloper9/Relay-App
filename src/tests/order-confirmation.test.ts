import { randomUUID } from 'node:crypto';
import { createStore, getStore, mutate } from '../services/repository.js';
import { approveCancellation } from '../services/cancellation.js';
import { tick } from '../services/worker.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { demoWorkspace } from '../services/seed.js';
import { encrypt } from '../utils/security.js';
import { handleOrderDecision } from '../services/automation.js';
import {
  buttonPayload,
  parseOrderButton,
  sendOrderConfirmation,
  cancelUnpaidCodOrder,
} from '../services/order-confirmation.js';

function fixtures() {
  const workspace = demoWorkspace();
  const order = workspace.orders.find((o) => o.status === 'PENDING')!;
  workspace.jobs = [];
  workspace.conversations = [];
  workspace.tasks = [];
  const integration = {
    ...workspace.integration,
    shopDomain: 'test.myshopify.com',
    shopifyToken: encrypt('shop-token'),
    whatsappToken: encrypt('meta-token'),
    wabaId: '123',
    phoneNumberId: '456',
    templateName: 'relay_order_confirmation_v1',
    languageCode: 'en_US',
  };
  return { workspace, order, integration };
}
function remoteOrder() {
  return {
    id: 'gid://shopify/Order/99',
    name: '#99',
    cancelledAt: null,
    displayFinancialStatus: 'PENDING',
    displayFulfillmentStatus: 'UNFULFILLED',
    paymentGatewayNames: ['Cash on Delivery'],
    totalReceivedSet: { shopMoney: { amount: '0', currencyCode: 'PKR' } },
    currentTotalPriceSet: { shopMoney: { amount: '500', currencyCode: 'PKR' } },
    shippingAddress: { formatted: ['Test address', 'Islamabad'] },
    lineItems: { nodes: [{ name: 'Test product', quantity: 2 }], pageInfo: { hasNextPage: false } },
  };
}
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

test('order button signatures reject tampering and bind the action and order', () => {
  const signed = buttonPayload('CONFIRM', 'order-123');
  assert.deepEqual(parseOrderButton(signed), { action: 'CONFIRM', orderId: 'order-123' });
  assert.equal(parseOrderButton(signed.replace('CONFIRM', 'CANCEL')), undefined);
  assert.equal(parseOrderButton(signed.replace('order-123', 'order-456')), undefined);
  assert.equal(parseOrderButton('CONFIRM:order-123'), undefined);
});

test('first button decision wins and cancellation is not marked complete prematurely', () => {
  const { workspace, order } = fixtures();
  handleOrderDecision(workspace, order, 'CANCEL');
  handleOrderDecision(workspace, order, 'CONFIRM');
  handleOrderDecision(workspace, order, 'CANCEL');
  assert.equal(order.status, 'NEEDS_REVIEW');
  assert.equal(workspace.jobs.length, 1);
  assert.equal(workspace.jobs[0]!.kind, 'CANCEL');
  assert.equal(workspace.tasks[0]!.status, 'APPROVED');
  const other = fixtures();
  handleOrderDecision(other.workspace, other.order, 'CONFIRM');
  handleOrderDecision(other.workspace, other.order, 'CANCEL');
  assert.equal(other.order.status, 'NEEDS_REVIEW');
  assert.equal(other.workspace.tasks[0]!.status, 'OPEN');
  handleOrderDecision(other.workspace, other.order, 'CANCEL');
  assert.equal(other.workspace.tasks.length, 1);
  assert.equal(other.workspace.jobs.length, 2);
  assert.equal(other.workspace.jobs[0]!.kind, 'TAG');
});

test('approved order template maps Shopify values to six variables and two signed buttons', async () => {
  const { integration, order } = fixtures();
  integration.templateName = 'merchant_order_confirmation';
  integration.languageCode = 'en';
  const before = {
    metaSecret: config.metaSecret,
    metaVerifyToken: config.metaVerifyToken,
    appUrl: config.appUrl,
  };
  const original = globalThis.fetch;
  Object.assign(config, {
    metaSecret: 'test-app-secret',
    metaVerifyToken: 'test-verify-token',
    appUrl: 'https://test.example',
  });
  let sends = 0;
  let approved = true;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/message_templates'))
      return response({
        data: [
          {
            name: integration.templateName,
            language: integration.languageCode,
            status: approved ? 'APPROVED' : 'PENDING',
            components: [
              {
                type: 'BODY',
                text: 'Hi {{1}} from {{2}}, order {{3}} items {{4}} total {{5}} address {{6}}.',
              },
              {
                type: 'BUTTONS',
                buttons: [
                  { type: 'QUICK_REPLY', text: 'Confirm order' },
                  { type: 'QUICK_REPLY', text: 'Cancel order' },
                ],
              },
            ],
          },
        ],
      });
    const body = JSON.parse(String(options?.body));
    if (body.query) return response({ data: { order: remoteOrder() } });
    sends++;
    assert.equal(body.to, order.phone);
    assert.deepEqual(
      body.template.components[0].parameters.map((p: { text: string }) => p.text),
      [order.name, 'Test Store', '#99', 'Test product x2', 'PKR 500', 'Test address, Islamabad'],
    );
    assert.equal(body.template.components.length, 3);
    assert.deepEqual(parseOrderButton(body.template.components[1].parameters[0].payload), {
      action: 'CONFIRM',
      orderId: order.id,
    });
    assert.deepEqual(parseOrderButton(body.template.components[2].parameters[0].payload), {
      action: 'CANCEL',
      orderId: order.id,
    });
    return response({ messages: [{ id: 'order-template-message' }] });
  };
  try {
    assert.equal(
      await sendOrderConfirmation(integration, order, 'Test Store'),
      'order-template-message',
    );
    approved = false;
    await assert.rejects(sendOrderConfirmation(integration, order, 'Test Store'), /approved/);
    assert.equal(sends, 1);
    config.metaSecret = '';
    approved = true;
    assert.equal(
      await sendOrderConfirmation(integration, order, 'Test Store'),
      'order-template-message',
    );
  } finally {
    globalThis.fetch = original;
    Object.assign(config, before);
  }
});

test('Shopify cancellation rejects paid or fulfilled orders and verifies completion', async () => {
  const { integration, order } = fixtures();
  const original = globalThis.fetch;
  let current = remoteOrder();
  let mutations = 0;
  globalThis.fetch = async (_url, options) => {
    const { query } = JSON.parse(String(options?.body));
    if (query.includes('mutation RelayCancel')) {
      mutations++;
      assert.match(query, /restock: true/);
      assert.match(query, /notifyCustomer: false/);
      return response({
        data: {
          orderCancel: {
            job: { id: 'job1', done: false },
            orderCancelUserErrors: [],
            userErrors: [],
          },
        },
      });
    }
    if (query.includes('RelayCancelState'))
      return response({ data: { order: { cancelledAt: new Date().toISOString() } } });
    return response({ data: { order: current } });
  };
  try {
    current.displayFinancialStatus = 'PAID';
    await assert.rejects(cancelUnpaidCodOrder(integration, order), /unpaid/);
    current = remoteOrder();
    current.displayFulfillmentStatus = 'FULFILLED';
    await assert.rejects(cancelUnpaidCodOrder(integration, order), /unpaid/);
    assert.equal(mutations, 0);
    current = remoteOrder();
    await cancelUnpaidCodOrder(integration, order);
    assert.equal(mutations, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('cancellation provider rejection and uncertain completion never report success', async () => {
  const { integration, order } = fixtures();
  const original = globalThis.fetch;
  let rejected = true;
  globalThis.fetch = async (_url, options) => {
    const { query } = JSON.parse(String(options?.body));
    if (query.includes('mutation RelayCancel'))
      return response({
        data: {
          orderCancel: {
            job: rejected ? null : { id: 'job2', done: false },
            orderCancelUserErrors: rejected ? [{ message: 'Not eligible' }] : [],
            userErrors: [],
          },
        },
      });
    if (query.includes('RelayCancelState'))
      throw new Error('Simulated network loss after mutation');
    return response({ data: { order: remoteOrder() } });
  };
  try {
    await assert.rejects(cancelUnpaidCodOrder(integration, order), /rejected cancellation/);
    rejected = false;
    await assert.rejects(
      cancelUnpaidCodOrder(integration, order),
      (error: unknown) =>
        error instanceof Error && 'ambiguous' in error && error.ambiguous === true,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('merchant review cancels Shopify once and cleans confirmation and request tags', async () => {
  const { workspace, order, integration } = fixtures();
  workspace.orders = [order];
  workspace.integration = integration;
  const id = randomUUID();
  await createStore({
    merchant: {
      id,
      email: id + '@test.invalid',
      brandName: 'Test',
      passwordHash: '',
      createdAt: new Date().toISOString(),
      trialEndsAt: new Date(Date.now() + 86400000).toISOString(),
      subscriptionStatus: 'TRIALING',
    },
    workspace,
  });
  const original = globalThis.fetch,
    demo = config.demo;
  const tags = new Set<string>();
  let cancellations = 0;
  globalThis.fetch = async (_url, options) => {
    const { query, variables } = JSON.parse(String(options?.body));
    if (query.includes('tagsRemove')) {
      for (const tag of variables.tags) tags.delete(tag);
      return response({ data: { tagsRemove: { userErrors: [] } } });
    }
    if (query.includes('tagsAdd')) {
      for (const tag of variables.tags) tags.add(tag);
      return response({ data: { tagsAdd: { userErrors: [] } } });
    }
    if (query.includes('mutation RelayCancel')) {
      cancellations++;
      assert.equal(variables.note, 'Customer requested cancellation');
      return response({
        data: {
          orderCancel: {
            job: { id: 'job1', done: true },
            orderCancelUserErrors: [],
            userErrors: [],
          },
        },
      });
    }
    if (query.includes('RelayCancelState'))
      return response({ data: { order: { cancelledAt: new Date().toISOString() } } });
    return response({ data: { order: remoteOrder() } });
  };
  config.demo = false;
  try {
    await mutate(id, (s) => {
      handleOrderDecision(s.workspace, s.workspace.orders[0]!, 'CONFIRM');
    });
    await tick();
    assert.ok(tags.has('COD-CONFIRMED'));
    await mutate(id, (s) => {
      handleOrderDecision(s.workspace, s.workspace.orders[0]!, 'CANCEL');
    });
    await tick();
    assert.ok(!tags.has('COD-CONFIRMED'));
    assert.ok(tags.has('CANCELLATION-REQUESTED'));
    const pending = (await getStore(id))!;
    const taskId = pending.workspace.tasks[0]!.id;
    assert.equal(pending.workspace.orders[0]!.status, 'NEEDS_REVIEW');
    assert.throws(() => approveCancellation(pending.workspace, taskId, '', true));
    assert.throws(() => approveCancellation(pending.workspace, taskId, 'reason', false));
    await mutate(id, (s) =>
      approveCancellation(s.workspace, taskId, 'Customer requested cancellation', true),
    );
    await assert.rejects(
      mutate(id, (s) => approveCancellation(s.workspace, taskId, 'Again', true)),
    );
    await tick();
    assert.equal((await getStore(id))!.workspace.orders[0]!.status, 'CANCELLED');
    await tick();
    await tick();
    assert.equal(cancellations, 1);
    assert.equal(tags.size, 0);
    assert.equal((await getStore(id))!.workspace.tasks[0]!.status, 'VERIFIED');
  } finally {
    globalThis.fetch = original;
    config.demo = demo;
  }
});
