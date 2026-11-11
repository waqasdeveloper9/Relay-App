import { metaCallbackUrl } from '../services/meta-webhook-settings.js';
import type { Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { decrypt, verifyHmac } from '../utils/security.js';
import { webhookShopTarget, webhookMetaTargets, getStore, mutate } from '../services/repository.js';
import {
  isSupportedShopifyTopic,
  metaPayload,
  validateShopifyWebhookPayload,
} from '../services/incoming-events.js';
import { acceptInbox, drainInbox } from '../services/inbox-worker.js';
export async function shopify(req: Request, res: Response): Promise<void> {
  if (
    !verifyHmac(
      req.body as Buffer,
      config.shopifySecret,
      req.get('X-Shopify-Hmac-Sha256') ?? '',
      'base64',
    )
  ) {
    res.status(401).json({ error: 'Invalid webhook signature' });
    return;
  }
  const domain = req.get('X-Shopify-Shop-Domain'),
    eventId = req.get('X-Shopify-Webhook-Id'),
    topic = req.get('X-Shopify-Topic') ?? '';
  if (!eventId || eventId.length > 200) {
    res.status(400).json({ error: 'Webhook ID is required' });
    return;
  }
  const merchantId = domain ? await webhookShopTarget(domain) : undefined;
  if (!merchantId) {
    res.status(404).json({ error: 'Store is not connected' });
    return;
  }
  if (!isSupportedShopifyTopic(topic)) {
    res.status(400).json({ error: 'Unsupported webhook topic' });
    return;
  }
  const payload = JSON.parse((req.body as Buffer).toString('utf8'));
  validateShopifyWebhookPayload(topic, payload);
  await acceptInbox(merchantId, 'shopify', eventId, topic, payload);
  if (config.demo) await drainInbox();
  res.json({ ok: true });
}
export async function meta(req: Request, res: Response): Promise<void> {
  const raw = req.body as Buffer;
  const parsed = JSON.parse(raw.toString('utf8'));
  const payload = metaPayload.parse(parsed);
  const requested = typeof req.params.merchantId === 'string' ? req.params.merchantId : undefined;
  const stores = await webhookMetaTargets(
    payload.entry
      .flatMap((e) => e.changes.map((c) => c.value.metadata?.phone_number_id ?? ''))
      .filter(Boolean),
    requested,
  );
  let verified = false;
  for (const store of stores) {
    if (!store) continue;
    const i = store;
    if (
      !payload.entry.some((e) =>
        e.changes.some((c) => c.value.metadata?.phone_number_id === i.phoneNumberId),
      )
    )
      continue;
    const secret = i.metaAppSecret
      ? decrypt(i.metaAppSecret)
      : config.demo
        ? config.metaSecret
        : '';
    if (
      !verifyHmac(
        raw,
        secret,
        (req.get('X-Hub-Signature-256') ?? '').replace(/^sha256=/, ''),
        'hex',
      )
    )
      continue;
    verified = true;
    const id = createHash('sha256').update(raw).digest('hex');
    await acceptInbox(store.merchantId, 'meta', id, 'messages', parsed);
  }
  if (!verified) {
    res.status(401).json({ error: 'Invalid webhook signature or sender' });
    return;
  }
  if (config.demo) await drainInbox();
  res.json({ ok: true });
}
export async function metaChallenge(req: Request, res: Response): Promise<void> {
  const token =
    typeof req.query['hub.verify_token'] === 'string' ? req.query['hub.verify_token'] : '';
  const store =
    typeof req.params.merchantId === 'string' ? await getStore(req.params.merchantId) : undefined;
  const expected = store?.workspace.integration.metaVerifyTokenHash;
  const actual = createHash('sha256').update(token).digest('hex');
  const valid =
    !!expected &&
    expected.length === actual.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  if (
    (valid || (config.demo && token === config.metaVerifyToken && !!token)) &&
    req.query['hub.mode'] === 'subscribe' &&
    typeof req.query['hub.challenge'] === 'string'
  ) {
    if (store)
      await mutate(store.merchant.id, (s) => {
        s.workspace.integration.metaWebhookVerifiedAt = new Date().toISOString();
        s.workspace.integration.metaWebhookUrl = metaCallbackUrl(s.merchant.id);
      });
    res.type('text').send(req.query['hub.challenge']);
    return;
  }
  res.sendStatus(403);
}
