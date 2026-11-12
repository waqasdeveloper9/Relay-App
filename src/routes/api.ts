import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { compare, hash } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { auth, issueToken, setSession, trustedLocalRequest } from '../middlewares/auth.js';
import { createStore, findByEmail } from '../services/repository.js';
import { demoWorkspace, emptyWorkspace } from '../services/seed.js';
import * as workspace from '../controllers/workspace.js';
import { canSend } from '../services/automation.js';
import { tick } from '../services/worker.js';
import * as shopifyOAuth from '../controllers/shopify-oauth.js';

export const TRIAL_DAYS = 30;
const DAY_MS = 86_400_000;

export const api = Router();
api.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mode: config.demo ? 'demo' : 'connected',
    outboundEnabled: config.outbound,
    appUrl: new URL(config.appUrl).origin,
    localLoginAllowed: trustedLocalRequest(req),
  });
});
const authLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: config.demo ? 100 : 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
const credentials = z.object({
  email: z.string().trim().email().toLowerCase().max(254),
  password: z
    .string()
    .min(12)
    .max(72)
    .refine(
      (v) => Buffer.byteLength(v, 'utf8') <= 72,
      'Password must be no longer than 72 UTF-8 bytes',
    ),
});
api.post('/auth/register', authLimit, async (req, res) => {
  const input = credentials.extend({ brandName: z.string().trim().min(2).max(80) }).parse(req.body);
  const now = Date.now();
  const merchant = {
    id: randomUUID(),
    email: input.email,
    passwordHash: await hash(input.password, 12),
    brandName: input.brandName,
    subscriptionStatus: 'TRIALING' as const,
    createdAt: new Date(now).toISOString(),
    trialEndsAt: new Date(now + TRIAL_DAYS * DAY_MS).toISOString(),
  };
  await createStore({ merchant, workspace: emptyWorkspace() });
  setSession(res, await issueToken(merchant.id), req);
  res.status(201).json({ ok: true });
});
api.post('/auth/login', authLimit, async (req, res) => {
  const input = credentials.parse(req.body);
  const store = await findByEmail(input.email);
  const valid = await compare(
    input.password,
    store?.merchant.passwordHash ?? '$2b$12$0S2B1qjY4pLGWamGvn2bRu.IJ2fMuCdByzqB7gKSth7TJzIE9mwEC',
  );
  if (!store || !valid) {
    res.status(401).json({ error: 'Email or password is incorrect' });
    return;
  }
  setSession(res, await issueToken(store.merchant.id), req);
  res.json({ ok: true });
});
api.post('/auth/demo', authLimit, async (_req, res) => {
  if (!config.demo) {
    res.sendStatus(404);
    return;
  }
  const id = randomUUID();
  const now = Date.now();
  await createStore({
    merchant: {
      id,
      email: `${id}@demo.invalid`,
      passwordHash: '',
      brandName: 'The Everyday Store',
      subscriptionStatus: 'TRIALING',
      createdAt: new Date(now).toISOString(),
      trialEndsAt: new Date(now + TRIAL_DAYS * DAY_MS).toISOString(),
    },
    workspace: demoWorkspace(),
  });
  setSession(res, await issueToken(id));
  res.json({ ok: true });
});
api.post('/auth/logout', (_req, res) => {
  res.clearCookie('relay_session', { path: '/api' });
  res.json({ ok: true });
});
api.get('/integrations/shopify/callback', shopifyOAuth.completeOAuth);
api.use(auth);
api.get('/integrations/shopify/config', shopifyOAuth.oauthConfig);
api.post('/integrations/shopify/connect', shopifyOAuth.beginOAuth);
api.post('/integrations/shopify/webhooks', shopifyOAuth.registerWebhooks);
api.get('/workspace', workspace.snapshot);
api.get('/reliability', workspace.reliabilityStatus);
api.put('/reliability/settings', workspace.saveReliability);
api.post('/reliability/sync', workspace.syncNow);
api.post('/reliability/retry-incoming', workspace.retryIncoming);
api.post('/integrations/meta/verify-token', workspace.generateMetaVerifyToken);
api.post('/integrations/meta/subscribe', workspace.subscribeMetaAccount);
api.post('/notifications/:id/read', workspace.readNotification);
api.post('/orders/sync', workspace.syncOrders);
api.post('/orders/bulk', workspace.bulkOrders);
api.post('/orders/:id/queue-confirmation', workspace.queueOrderConfirmation);
api.post('/orders/:id/permission', workspace.recordPermission);
api.post('/messages/:id/retry', workspace.retryFailedMessage);
api.post('/orders/:id/action', workspace.orderAction);
api.post('/orders/:id/shopify-action', workspace.shopifyOrderAction);
api.post('/demo/simulate', workspace.simulate);
api.post('/integrations', workspace.saveIntegration);
api.post('/integrations/test', workspace.testIntegration);
api.post('/integrations/whatsapp/test-message', workspace.sendWhatsappTest);
api.post('/integrations/whatsapp/templates', workspace.saveTemplate);
api.post('/integrations/whatsapp/templates/delete', workspace.deleteTemplate);
api.post('/integrations/whatsapp/templates/update', workspace.updateTemplate);
api.delete('/integrations/whatsapp/templates/:id', workspace.deleteTemplate);
api.put('/integrations/whatsapp/templates/:id', workspace.updateTemplate);
api.post('/integrations/whatsapp/validate-template', workspace.testOrderTemplate);
api.put('/settings', workspace.saveSettings);
api.post('/tasks/:id/action', workspace.taskAction);
api.post('/conversations/:id/action', workspace.conversationAction);
api.post('/conversations/:id/read', workspace.readConversation);
api.post('/jobs/:id/retry', workspace.retryJob);
api.post('/jobs/run', async (_req, res) => {
  // The manual trigger is demo-only; connected workers run independently.
  if (!config.demo) {
    res.status(403).json({ error: 'Manual worker execution is only available in demo mode' });
    return;
  }
  await tick();
  res.json({ ok: true });
});
api.get('/reports', (req, res) => {
  const w = req.store.workspace;
  const date = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .parse(req.query.date);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: w.settings.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const target = date ?? formatter.format(new Date());
  const orders = w.orders.filter(
    (o) => !o.archivedAt && formatter.format(new Date(o.createdAt)) === target,
  );
  const codOrders = orders.filter((o) => o.isCod !== false);
  const nonCodOrders = orders.filter((o) => o.isCod === false);
  const codConfirmed = codOrders.filter((o) => o.status === 'CONFIRMED').length;
  res.json({
    date: target,
    timezone: w.settings.timezone,
    orders: orders.length,
    codOrders: codOrders.length,
    nonCodOrders: nonCodOrders.length,
    confirmed: codConfirmed,
    codConfirmed,
    pending: codOrders.filter((o) => o.status === 'PENDING').length,
    review: codOrders.filter((o) => o.status === 'NEEDS_REVIEW').length,
    openRequests: w.tasks.filter((t) => t.status !== 'VERIFIED').length,
    queued: w.jobs.filter((j) => j.state === 'QUEUED').length,
    failures: w.jobs.filter((j) => j.state === 'FAILED' || j.state === 'UNKNOWN').length,
    outboundEligible: canSend(req.store),
  });
});
