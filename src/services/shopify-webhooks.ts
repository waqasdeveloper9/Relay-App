import { z } from 'zod';
import { shopifyGraphql, ProviderError } from './providers.js';
import type { Integration } from '../models/types.js';
import { hasShopifyScope } from '../models/workspace-defaults.js';

const CORE_TOPICS = [
  'ORDERS_CREATE',
  'ORDERS_UPDATED',
  'ORDERS_CANCELLED',
  'ORDERS_FULFILLED',
  'ORDERS_PARTIALLY_FULFILLED',
  'ORDERS_PAID',
  'ORDERS_DELETE',
  'APP_UNINSTALLED',
] as const;

const FULFILLMENT_TOPICS = [
  'FULFILLMENTS_CREATE',
  'FULFILLMENTS_UPDATE',
  'FULFILLMENT_EVENTS_CREATE',
] as const;

const FULFILLMENT_ORDER_TOPICS = [
  'FULFILLMENT_ORDERS_PLACED_ON_HOLD',
  'FULFILLMENT_ORDERS_HOLD_RELEASED',
  'FULFILLMENT_ORDERS_PROGRESS_REPORTED',
  'FULFILLMENT_ORDERS_MANUALLY_REPORTED_PROGRESS_STOPPED',
] as const;

export function desiredShopifyWebhookTopics(integration: Integration): string[] {
  const topics: string[] = [...CORE_TOPICS];
  if (hasShopifyScope(integration, 'read_fulfillments')) topics.push(...FULFILLMENT_TOPICS);
  if (hasShopifyScope(integration, 'read_merchant_managed_fulfillment_orders'))
    topics.push(...FULFILLMENT_ORDER_TOPICS);
  return topics;
}

export async function ensureShopifyWebhooks(
  integration: Integration,
  uri: string,
): Promise<string[]> {
  const existing = z
    .object({
      webhookSubscriptions: z.object({
        nodes: z.array(z.object({ id: z.string(), topic: z.string(), uri: z.string() })),
        pageInfo: z.object({ hasNextPage: z.boolean() }),
      }),
    })
    .parse(
      await shopifyGraphql(
        integration,
        'query { webhookSubscriptions(first: 250) { nodes { id topic uri } pageInfo { hasNextPage } } }',
      ),
    );
  if (existing.webhookSubscriptions.pageInfo.hasNextPage)
    throw new ProviderError(
      'Too many webhook subscriptions to reconcile automatically. Review them in Shopify.',
    );
  const desired = desiredShopifyWebhookTopics(integration);
  for (const topic of desired) {
    if (existing.webhookSubscriptions.nodes.some((n) => n.topic === topic && n.uri === uri))
      continue;
    const stale = existing.webhookSubscriptions.nodes.filter(
      (n) => n.topic === topic && n.uri.endsWith('/api/webhooks/shopify'),
    );
    if (stale.length) {
      for (const subscription of stale) {
        const response = z
          .object({
            webhookSubscriptionUpdate: z.object({
              userErrors: z.array(z.object({ message: z.string() })),
            }),
          })
          .parse(
            await shopifyGraphql(
              integration,
              'mutation Update($id: ID!, $input: WebhookSubscriptionInput!) { webhookSubscriptionUpdate(id: $id, webhookSubscription: $input) { userErrors { message } } }',
              { id: subscription.id, input: { uri, format: 'JSON' } },
            ),
          );
        if (response.webhookSubscriptionUpdate.userErrors.length)
          throw new ProviderError(
            'Shopify could not update a webhook subscription. Check app permissions.',
          );
      }
    } else {
      const response = z
        .object({
          webhookSubscriptionCreate: z.object({
            userErrors: z.array(z.object({ message: z.string() })),
          }),
        })
        .parse(
          await shopifyGraphql(
            integration,
            'mutation Subscribe($topic: WebhookSubscriptionTopic!, $input: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: $input) { userErrors { message } } }',
            { topic, input: { uri, format: 'JSON' } },
          ),
        );
      if (response.webhookSubscriptionCreate.userErrors.length)
        throw new ProviderError(
          'Shopify could not register a webhook subscription. Check app permissions.',
        );
    }
  }
  return desired;
}
