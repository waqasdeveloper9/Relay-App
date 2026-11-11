import { z } from 'zod';
import { getStore, mutate } from './repository.js';
import { freshShopifyIntegration } from './shopify-tokens.js';
import { shopifyGraphql, shopifyOrderSnapshotSchema } from './providers.js';
import { claimSync, getSyncState, updateSync } from './reliability-repository.js';
import { reliability } from './reliability-settings.js';
import {
  ingestOrder,
  repairMissingConfirmations,
  snapshotToIncomingOrder,
} from './order-ingestion.js';
import { notify, resolveNotification } from './notifications.js';
import { retryDelay } from './retry-policy.js';
import { hasShopifyScope } from '../models/workspace-defaults.js';

const pageSchema = z.object({
  orders: z.object({
    nodes: z.array(shopifyOrderSnapshotSchema),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  }),
});
export async function reconcileMerchant(merchantId: string): Promise<void> {
  const store = await getStore(merchantId);
  if (!store?.workspace.integration.shopifyToken) return;
  const planned = structuredClone(store);
  repairMissingConfirmations(planned);
  if (
    JSON.stringify(planned.workspace.jobs) !== JSON.stringify(store.workspace.jobs) ||
    JSON.stringify(planned.workspace.orders) !== JSON.stringify(store.workspace.orders)
  ) {
    await mutate(merchantId, repairMissingConfirmations);
  }
  const settings = reliability(store.workspace);
  if (!settings.syncEnabled && !(await getSyncState(merchantId)).manualRequested) return;
  const claim = await claimSync(merchantId);
  if (!claim?.leaseToken) return;
  const token = claim.leaseToken;
  const end = claim.windowEnd ?? new Date();
  const start =
    claim.windowStart ??
    new Date(
      claim.checkpoint
        ? claim.checkpoint.getTime() - 300000
        : Date.now() - settings.initialLookbackDays * 86400000,
    );
  try {
    if (!claim.cursor && start.getTime() < Date.now() - 60 * 86400000 - 300000)
      throw new Error(
        'Recovery window exceeds Shopify’s default 60-day order access. Review read_all_orders access before advancing the checkpoint.',
      );
    await updateSync(merchantId, token, { windowStart: start, windowEnd: end });
    const i = await freshShopifyIntegration(merchantId);
    const includeEvents = hasShopifyScope(i, 'read_fulfillments');
    const includeCustomer = hasShopifyScope(i, 'read_customers');
    const query = `query RelayRecovery($after:String,$query:String!) { orders(first:50,after:$after,sortKey:UPDATED_AT,query:$query) { nodes { id name tags phone createdAt updatedAt cancelledAt displayFinancialStatus displayFulfillmentStatus paymentGatewayNames customAttributes { key value } currentTotalPriceSet { shopMoney { amount currencyCode } } shippingAddress { name phone countryCodeV2 }${includeCustomer ? ' customer { smsMarketingConsent { marketingState } }' : ''} fulfillments(first: 10) { id status displayStatus trackingInfo(first: 5) { url number company }${includeEvents ? ' events(first: 10) { nodes { status happenedAt } }' : ''} } } pageInfo { hasNextPage endCursor } } }`;
    const page = pageSchema.parse(
      await shopifyGraphql(i, query, {
        after: claim.cursor,
        query:
          "updated_at:>='" + start.toISOString() + "' updated_at:<='" + end.toISOString() + "'",
      }),
    ).orders;
    for (const node of page.nodes) {
      const id = node.id.split('/').at(-1)!;
      if (!/^\d+$/.test(id)) throw new Error('Shopify returned an invalid order ID');
      const existing = store.workspace.orders.find((o) => o.shopifyOrderId === id);
      if (
        existing &&
        (!existing.archivedAt || !claim.restoreArchived) &&
        existing.sourceUpdatedAt &&
        Date.parse(existing.sourceUpdatedAt) >= Date.parse(node.updatedAt)
      )
        continue;
      await mutate(merchantId, (s) => {
        ingestOrder(s, snapshotToIncomingOrder(node), true, claim.restoreArchived);
      });
      await updateSync(merchantId, token, { leaseUntil: new Date(Date.now() + 120000) });
    }
    if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor)
      throw new Error('Shopify pagination is incomplete; checkpoint was not advanced');
    await updateSync(merchantId, token, {
      manualRequested: page.pageInfo.hasNextPage ? claim.manualRequested : false,
      restoreArchived: page.pageInfo.hasNextPage ? claim.restoreArchived : false,
      cursor: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null,
      checkpoint: page.pageInfo.hasNextPage ? claim.checkpoint : end,
      windowStart: page.pageInfo.hasNextPage ? start : null,
      windowEnd: page.pageInfo.hasNextPage ? end : null,
      nextRunAt: new Date(
        Date.now() + (page.pageInfo.hasNextPage ? 0 : settings.syncIntervalMinutes * 60000),
      ),
      lastSuccessAt: new Date(),
      error: null,
      attempts: 0,
      leaseToken: null,
      leaseUntil: null,
    });
    await mutate(merchantId, (s) => resolveNotification(s.workspace, 'shopify-sync'));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Shopify synchronization failed';
    await updateSync(merchantId, token, {
      error: message,
      attempts: claim.attempts + 1,
      nextRunAt: new Date(Date.now() + retryDelay(claim.attempts + 1)),
      leaseToken: null,
      leaseUntil: null,
    });
    await mutate(merchantId, (s) =>
      notify(
        s.workspace,
        'shopify-sync',
        'Shopify synchronization needs attention',
        message,
        'Check Shopify authorization and scopes. The previous checkpoint is retained; Relay will retry.',
      ),
    );
  }
}
