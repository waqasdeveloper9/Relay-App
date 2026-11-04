import { config } from '../config.js';
import { reconcileStaleSamples } from './message-history.js';
import { drainInbox } from './inbox-worker.js';
import { syncMerchantIds } from './reliability-repository.js';
import { reconcileMerchant } from './shopify-reconciliation.js';
let running = false;
export async function recoveryTick(): Promise<void> {
  if (running || config.demo) return;
  running = true;
  try {
    await reconcileStaleSamples();
    await drainInbox(10);
    const ids = await syncMerchantIds();
    for (let i = 0; i < ids.length; i += 4) {
      const results = await Promise.allSettled(ids.slice(i, i + 4).map(reconcileMerchant));
      for (const result of results)
        if (result.status === 'rejected')
          console.error(JSON.stringify({ level: 'error', event: 'reconciliation_tick_failed' }));
    }
  } finally {
    running = false;
  }
}
