import { z } from 'zod';
import { shopifyGraphql, ProviderError } from './providers.js';
import type { Integration } from '../models/types.js';

export async function ensureShopifyWebhooks(integration: Integration, uri: string): Promise<void> {
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
  for (const topic of ['ORDERS_CREATE', 'ORDERS_UPDATED', 'ORDERS_CANCELLED', 'APP_UNINSTALLED']) {
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
}
