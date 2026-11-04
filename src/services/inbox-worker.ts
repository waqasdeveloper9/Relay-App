import { acceptInbox, claimInbox, finishInbox } from './reliability-repository.js';
import { processMetaEvent, processShopifyEvent } from './incoming-events.js';
import { mutate } from './repository.js';
import { notify, resolveNotification } from './notifications.js';
export { acceptInbox };
export async function drainInbox(limit = 5): Promise<void> {
  for (let n = 0; n < limit; n++) {
    const e = await claimInbox();
    if (!e) break;
    try {
      if (e.provider === 'shopify')
        await processShopifyEvent(e.merchantId, e.topic, e.eventId, e.payload);
      else await processMetaEvent(e.merchantId, e.payload);
      await finishInbox(e);
      await mutate(e.merchantId, (s) => resolveNotification(s.workspace, 'inbox:' + e.id));
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Webhook processing failed';
      await finishInbox(e, detail);
      await mutate(e.merchantId, (s) =>
        notify(
          s.workspace,
          'inbox:' + e.id,
          'Incoming event needs attention',
          detail,
          e.attempts >= 8
            ? 'Review the event and retry it from Reliability.'
            : 'Relay will retry this saved event automatically.',
        ),
      );
    }
  }
}
