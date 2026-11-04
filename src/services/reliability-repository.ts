import { randomUUID } from 'node:crypto';
import type { InboxEvent, ShopifySyncState, Prisma } from '@prisma/client';
import { database, listStores } from './repository.js';
const memoryInbox = new Map<string, InboxEvent>();
const memorySync = new Map<string, ShopifySyncState>();
export async function acceptInbox(
  merchantId: string,
  provider: string,
  eventId: string,
  topic: string,
  payload: unknown,
): Promise<void> {
  const input = {
    id: randomUUID(),
    merchantId,
    provider,
    eventId,
    topic,
    payload: payload as Prisma.InputJsonValue,
  };
  if (database) {
    await database.inboxEvent.upsert({
      where: { merchantId_provider_eventId: { merchantId, provider, eventId } },
      create: input,
      update: {},
    });
    return;
  }
  if (
    [...memoryInbox.values()].some(
      (e) => e.merchantId === merchantId && e.provider === provider && e.eventId === eventId,
    )
  )
    return;
  memoryInbox.set(input.id, {
    ...input,
    payload: input.payload as Prisma.JsonValue,
    state: 'QUEUED',
    attempts: 0,
    dueAt: new Date(),
    leaseToken: null,
    leaseUntil: null,
    error: null,
    createdAt: new Date(),
    processedAt: null,
  });
}
export async function claimInbox(): Promise<InboxEvent | undefined> {
  const now = new Date();
  const eligible = {
    OR: [
      { state: 'QUEUED', dueAt: { lte: now } },
      { state: 'PROCESSING', leaseUntil: { lt: now } },
    ],
  };
  const e = database
    ? await database.inboxEvent.findFirst({ where: eligible, orderBy: { createdAt: 'asc' } })
    : [...memoryInbox.values()].find(
        (v) =>
          (v.state === 'QUEUED' && v.dueAt <= now) ||
          (v.state === 'PROCESSING' && !!v.leaseUntil && v.leaseUntil < now),
      );
  if (!e) return;
  const attempts = e.attempts + 1;
  const token = randomUUID();
  const until = new Date(Date.now() + 120000);
  if (database) {
    const r = await database.inboxEvent.updateMany({
      where: { id: e.id, ...eligible },
      data: {
        state: 'PROCESSING',
        leaseToken: token,
        leaseUntil: until,
        attempts: { increment: 1 },
      },
    });
    if (!r.count) return;
  } else {
    const current = memoryInbox.get(e.id)!;
    if (current.leaseUntil && current.leaseUntil > now && current.state === 'PROCESSING') return;
    Object.assign(current, { state: 'PROCESSING', leaseToken: token, leaseUntil: until, attempts });
  }
  return { ...e, state: 'PROCESSING', leaseToken: token, leaseUntil: until, attempts };
}
export async function finishInbox(e: InboxEvent, error?: string): Promise<void> {
  const failed = !!error && e.attempts >= 8;
  const data = {
    state: error ? (failed ? 'FAILED' : 'QUEUED') : 'DONE',
    error: error ?? null,
    leaseUntil: null,
    leaseToken: null,
    dueAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(e.attempts, 7))),
    processedAt: error ? null : new Date(),
  };
  if (database)
    await database.inboxEvent.updateMany({ where: { id: e.id, leaseToken: e.leaseToken }, data });
  else {
    const v = memoryInbox.get(e.id);
    if (v?.leaseToken === e.leaseToken) Object.assign(v, data);
  }
}
export async function getSyncState(merchantId: string): Promise<ShopifySyncState> {
  if (database)
    return database.shopifySyncState.upsert({
      where: { merchantId },
      create: { merchantId },
      update: {},
    });
  let s = memorySync.get(merchantId);
  if (!s) {
    s = {
      merchantId,
      manualRequested: false,
      restoreArchived: false,
      checkpoint: null,
      windowStart: null,
      windowEnd: null,
      cursor: null,
      leaseToken: null,
      leaseUntil: null,
      nextRunAt: new Date(),
      lastSuccessAt: null,
      error: null,
      attempts: 0,
    };
    memorySync.set(merchantId, s);
  }
  return structuredClone(s);
}
export async function claimSync(merchantId: string): Promise<ShopifySyncState | undefined> {
  const s = await getSyncState(merchantId);
  if (s.nextRunAt > new Date() || (s.leaseUntil && s.leaseUntil > new Date())) return;
  const token = randomUUID(),
    until = new Date(Date.now() + 120000);
  if (database) {
    const r = await database.shopifySyncState.updateMany({
      where: {
        merchantId,
        nextRunAt: { lte: new Date() },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      data: { leaseToken: token, leaseUntil: until },
    });
    if (!r.count) return;
  } else Object.assign(memorySync.get(merchantId)!, { leaseToken: token, leaseUntil: until });
  return { ...s, leaseToken: token, leaseUntil: until };
}
export async function updateSync(
  merchantId: string,
  token: string,
  data: Partial<Omit<ShopifySyncState, 'merchantId'>>,
): Promise<void> {
  if (database)
    await database.shopifySyncState.updateMany({ where: { merchantId, leaseToken: token }, data });
  else {
    const s = memorySync.get(merchantId);
    if (s?.leaseToken === token) Object.assign(s, data);
  }
}
export async function requestSync(merchantId: string): Promise<void> {
  await getSyncState(merchantId);
  if (database)
    await database.shopifySyncState.update({
      where: { merchantId },
      data: { nextRunAt: new Date() },
    });
  else memorySync.get(merchantId)!.nextRunAt = new Date();
}
export async function syncMerchantIds(): Promise<string[]> {
  return database
    ? (
        await database.shopifyIntegration.findMany({
          where: { accessToken: { not: '' } },
          select: { merchantId: true },
        })
      ).map((v) => v.merchantId)
    : (await listStores())
        .filter((s) => s.workspace.integration.shopifyToken)
        .map((s) => s.merchant.id);
}
export async function inboxSummary(merchantId: string) {
  return database
    ? database.inboxEvent.groupBy({ by: ['state'], where: { merchantId }, _count: true })
    : ['QUEUED', 'PROCESSING', 'FAILED'].map((state) => ({
        state,
        _count: [...memoryInbox.values()].filter(
          (e) => e.merchantId === merchantId && e.state === state,
        ).length,
      }));
}
export async function retryInbox(merchantId: string): Promise<void> {
  if (database)
    await database.inboxEvent.updateMany({
      where: { merchantId, state: 'FAILED' },
      data: { state: 'QUEUED', attempts: 0, dueAt: new Date(), error: null },
    });
  else
    for (const e of memoryInbox.values())
      if (e.merchantId === merchantId && e.state === 'FAILED')
        Object.assign(e, { state: 'QUEUED', attempts: 0, dueAt: new Date(), error: null });
}

export async function requestFullSync(
  merchantId: string,
  lookbackDays: number,
  restoreArchived: boolean,
): Promise<void> {
  await getSyncState(merchantId);
  const now = new Date();
  const data = {
    windowStart: new Date(now.getTime() - lookbackDays * 86400000),
    windowEnd: now,
    cursor: null,
    nextRunAt: now,
    manualRequested: true,
    restoreArchived,
    error: null,
    attempts: 0,
  };
  if (database) {
    const updated = await database.shopifySyncState.updateMany({
      where: {
        merchantId,
        manualRequested: false,
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      data,
    });
    if (!updated.count)
      throw Object.assign(
        new Error('A Shopify sync is already in progress. Wait for it to complete.'),
        { status: 409 },
      );
  } else {
    const state = memorySync.get(merchantId)!;
    if (state.manualRequested || (state.leaseUntil && state.leaseUntil > now))
      throw Object.assign(
        new Error('A Shopify sync is already in progress. Wait for it to complete.'),
        { status: 409 },
      );
    Object.assign(state, data);
  }
}
