import { config } from '../config.js';
import type { Store } from '../models/types.js';
export function metaCallbackUrl(merchantId: string): string {
  return (config.webhookUrl || config.appUrl).replace(/\/$/, '') + '/api/webhooks/meta/' + merchantId;
}
export function metaWebhookReady(s: Store): boolean {
  const i = s.workspace.integration;
  return (
    (config.webhookUrl || config.appUrl).startsWith('https://') &&
    !!i.metaAppSecret &&
    !!i.metaVerifyTokenHash &&
    !!i.metaWebhookVerifiedAt &&
    i.metaWebhookUrl === metaCallbackUrl(s.merchant.id) &&
    s.workspace.settings.metaSubscription?.wabaId === i.wabaId
  );
}
