import { PrismaClient, Prisma } from '@prisma/client';
import { config } from '../config.js';
import type {
  Merchant,
  Store,
  Workspace,
  Order,
  Conversation,
  Task,
  Job,
} from '../models/types.js';

const memory = new Map<string, Store>();
const prisma = config.demo ? undefined : new PrismaClient();
const locks = new Map<string, Promise<unknown>>();
export class ConflictError extends Error {}
const include = {
  workspace: true,
  shopifyIntegration: true,
  whatsappIntegration: true,
  orders: {
    orderBy: { createdAt: 'desc' as const },
    include: {
      conversation: { include: { messages: { orderBy: { createdAt: 'asc' as const } } } },
      tasks: true,
      jobs: true,
    },
  },
  activities: { orderBy: { createdAt: 'desc' as const }, take: 100 },
  receipts: true,
  notifications: { orderBy: { createdAt: 'desc' as const }, take: 100 },
  outboundMessages: { orderBy: { createdAt: 'desc' as const } },
} satisfies Prisma.MerchantInclude;
type Row = Prisma.MerchantGetPayload<{ include: typeof include }>;
function hydrate(m: Row): Store {
  const si = m.shopifyIntegration;
  const wi = m.whatsappIntegration;
  return {
    merchant: {
      id: m.id,
      email: m.email,
      passwordHash: m.passwordHash,
      brandName: m.brandName,
      subscriptionStatus: m.subscriptionStatus,
      trialEndsAt: m.trialEndsAt.toISOString(),
      createdAt: m.createdAt.toISOString(),
    },
    workspace: {
      notifications: m.notifications.map((n) => ({
        id: n.id,
        key: n.key,
        severity: n.severity as 'warning' | 'error' | 'info',
        title: n.title,
        detail: n.detail,
        action: n.action,
        readAt: n.readAt?.toISOString(),
        resolvedAt: n.resolvedAt?.toISOString(),
        createdAt: n.createdAt.toISOString(),
        updatedAt: n.updatedAt.toISOString(),
      })),
      outboundMessages: m.outboundMessages.map((v) => ({
        id: v.id,
        orderId: v.orderId ?? undefined,
        jobId: v.jobId ?? undefined,
        kind: v.kind,
        recipient: v.recipient,
        templateName: v.templateName,
        languageCode: v.languageCode,
        preview: v.preview,
        status: v.status as NonNullable<Workspace['outboundMessages']>[number]['status'],
        messageId: v.messageId ?? undefined,
        error: v.error ?? undefined,
        statusTimestamp: v.statusTimestamp?.toISOString(),
        createdAt: v.createdAt.toISOString(),
        updatedAt: v.updatedAt.toISOString(),
      })),
      settings: m.workspace!.settings as unknown as Workspace['settings'],
      integration: {
        shopDomain: si?.shopDomain ?? '',
        shopifyToken: si?.accessToken ?? '',
        shopifyVerifiedAt: si?.verifiedAt?.toISOString(),
        shopifyRefreshToken: si?.refreshToken ?? undefined,
        shopifyTokenExpiresAt: si?.tokenExpiresAt?.toISOString(),
        shopifyRefreshExpiresAt: si?.refreshExpiresAt?.toISOString(),
        shopifyScopes: si?.scopes ?? [],
        shopifyWebhooksVerifiedAt: si?.webhooksVerifiedAt?.toISOString(),
        shopifyWebhooksUrl: si?.webhooksUrl ?? undefined,
        phoneNumberId: wi?.phoneNumberId ?? '',
        wabaId: wi?.wabaId ?? '',
        whatsappToken: wi?.systemAccessToken ?? '',
        whatsappVerifiedAt: wi?.verifiedAt?.toISOString(),
        metaAppSecret: wi?.metaAppSecret ?? undefined,
        metaVerifyTokenHash: wi?.verifyTokenHash ?? undefined,
        metaWebhookVerifiedAt: wi?.webhookVerifiedAt?.toISOString(),
        metaWebhookUrl: wi?.webhookUrl ?? undefined,
        metaWebhookLastReceivedAt: wi?.webhookLastReceivedAt?.toISOString(),
        templateName: wi?.templateName ?? 'order_confirmation_v1',
        languageCode: wi?.languageCode ?? 'en_US',
      },
      orders: m.orders.map((o) => ({
        id: o.id,
        shopifyOrderId: o.shopifyOrderId,
        number: o.number,
        name: o.name,
        phone: o.phone,
        amount: Number(o.amount),
        currency: o.currency,
        status: o.status,
        delivery: o.delivery as Order['delivery'],
        trackingUrl: o.trackingUrl ?? undefined,
        consent: o.consent,
        archivedAt: o.archivedAt?.toISOString(),
        sourceUpdatedAt: o.sourceUpdatedAt?.toISOString(),
        messageBlockedReason: o.messageBlockedReason ?? undefined,
        confirmationExpiresAt: o.confirmationExpiresAt?.toISOString(),
        tags: o.tags,
        createdAt: o.createdAt.toISOString(),
      })),
      conversations: m.orders.flatMap((o) =>
        o.conversation
          ? [
              {
                id: o.conversation.id,
                orderId: o.id,
                human: o.conversation.human,
                unread: o.conversation.unread,
                messages: o.conversation.messages.map((msg) => ({
                  id: msg.id,
                  direction: msg.direction as Conversation['messages'][number]['direction'],
                  text: msg.text,
                  createdAt: msg.createdAt.toISOString(),
                })),
              },
            ]
          : [],
      ),
      tasks: m.orders.flatMap((o) =>
        o.tasks.map((t) => ({
          id: t.id,
          orderId: o.id,
          kind: t.kind as Task['kind'],
          detail: t.detail,
          status: t.status,
          createdAt: t.createdAt.toISOString(),
        })),
      ),
      jobs: m.orders.flatMap((o) =>
        o.jobs.map((j) => ({
          id: j.id,
          orderId: o.id,
          kind: j.kind as Job['kind'],
          state: j.state,
          attempts: j.attempts,
          dueAt: j.dueAt.toISOString(),
          messageId: j.messageId ?? undefined,
          error: j.error ?? undefined,
          claimedAt: j.claimedAt?.toISOString(),
          retryable: j.retryable,
        })),
      ),
      activity: m.activities.map((a) => ({
        id: a.id,
        text: a.text,
        createdAt: a.createdAt.toISOString(),
      })),
      processedEvents: m.receipts.map((r) => r.eventId),
    },
  };
}
function changed<T extends { id: string }>(before: T[], after: T[]): T[] {
  const old = new Map(before.map((item) => [item.id, JSON.stringify(item)]));
  return after.filter((item) => old.get(item.id) !== JSON.stringify(item));
}
async function persist(
  tx: Prisma.TransactionClient,
  merchantId: string,
  before: Workspace,
  after: Workspace,
): Promise<void> {
  if (JSON.stringify(before.integration) !== JSON.stringify(after.integration)) {
    const i = after.integration;
    const shop = {
      shopDomain: i.shopDomain || null,
      accessToken: i.shopifyToken,
      verifiedAt: i.shopifyVerifiedAt ? new Date(i.shopifyVerifiedAt) : null,
      refreshToken: i.shopifyRefreshToken ?? null,
      tokenExpiresAt: i.shopifyTokenExpiresAt ? new Date(i.shopifyTokenExpiresAt) : null,
      refreshExpiresAt: i.shopifyRefreshExpiresAt ? new Date(i.shopifyRefreshExpiresAt) : null,
      scopes: i.shopifyScopes ?? [],
      webhooksVerifiedAt: i.shopifyWebhooksVerifiedAt
        ? new Date(i.shopifyWebhooksVerifiedAt)
        : null,
      webhooksUrl: i.shopifyWebhooksUrl ?? null,
    };
    const whatsapp = {
      phoneNumberId: i.phoneNumberId || null,
      wabaId: i.wabaId,
      systemAccessToken: i.whatsappToken,
      templateName: i.templateName,
      languageCode: i.languageCode,
      verifiedAt: i.whatsappVerifiedAt ? new Date(i.whatsappVerifiedAt) : null,
      metaAppSecret: i.metaAppSecret ?? null,
      verifyTokenHash: i.metaVerifyTokenHash ?? null,
      webhookVerifiedAt: i.metaWebhookVerifiedAt ? new Date(i.metaWebhookVerifiedAt) : null,
      webhookUrl: i.metaWebhookUrl ?? null,
      webhookLastReceivedAt: i.metaWebhookLastReceivedAt
        ? new Date(i.metaWebhookLastReceivedAt)
        : null,
    };
    await tx.shopifyIntegration.upsert({
      where: { merchantId },
      create: { merchantId, ...shop },
      update: shop,
    });
    await tx.whatsAppIntegration.upsert({
      where: { merchantId },
      create: { merchantId, ...whatsapp },
      update: whatsapp,
    });
  }
  for (const o of changed(before.orders, after.orders)) {
    const { id, ...rest } = o;
    const value = {
      ...rest,
      amount: new Prisma.Decimal(String(o.amount)),
      archivedAt: o.archivedAt ? new Date(o.archivedAt) : null,
      sourceUpdatedAt: o.sourceUpdatedAt ? new Date(o.sourceUpdatedAt) : null,
      messageBlockedReason: o.messageBlockedReason ?? null,
      confirmationExpiresAt: o.confirmationExpiresAt ? new Date(o.confirmationExpiresAt) : null,
      createdAt: new Date(o.createdAt),
      trackingUrl: o.trackingUrl ?? null,
    };
    await tx.orderLog.upsert({
      where: { merchantId_id: { merchantId, id } },
      create: { id, merchantId, ...value },
      update: value,
    });
  }
  for (const c of changed(before.conversations, after.conversations)) {
    const value = { orderId: c.orderId, human: c.human, unread: c.unread };
    await tx.conversation.upsert({
      where: { merchantId_id: { merchantId, id: c.id } },
      create: { id: c.id, merchantId, ...value },
      update: value,
    });
    const previous = before.conversations.find((v) => v.id === c.id)?.messages ?? [];
    for (const msg of changed(previous, c.messages))
      await tx.message.create({
        data: { ...msg, merchantId, conversationId: c.id, createdAt: new Date(msg.createdAt) },
      });
  }
  for (const t of changed(before.tasks, after.tasks)) {
    const { id, ...rest } = t;
    const value = { ...rest, createdAt: new Date(t.createdAt) };
    await tx.customerRequest.upsert({
      where: { id },
      create: { id, merchantId, ...value },
      update: value,
    });
  }
  for (const j of changed(before.jobs, after.jobs)) {
    const { id, ...rest } = j;
    const value = {
      ...rest,
      dueAt: new Date(j.dueAt),
      claimedAt: j.claimedAt ? new Date(j.claimedAt) : null,
      retryable: j.retryable ?? false,
      messageId: j.messageId ?? null,
      error: j.error ?? null,
    };
    await tx.automationJob.upsert({
      where: { id },
      create: { id, merchantId, ...value },
      update: value,
    });
  }
  for (const message of changed(before.outboundMessages ?? [], after.outboundMessages ?? [])) {
    const { id, ...rest } = message;
    const value = {
      ...rest,
      orderId: message.orderId ?? null,
      jobId: message.jobId ?? null,
      messageId: message.messageId ?? null,
      error: message.error ?? null,
      statusTimestamp: message.statusTimestamp ? new Date(message.statusTimestamp) : null,
      createdAt: new Date(message.createdAt),
      updatedAt: new Date(message.updatedAt),
    };
    await tx.outboundMessage.upsert({
      where: { id },
      create: { id, merchantId, ...value },
      update: value,
    });
  }
  for (const n of changed(before.notifications ?? [], after.notifications ?? [])) {
    const { id, ...rest } = n;
    const value = {
      ...rest,
      readAt: n.readAt ? new Date(n.readAt) : null,
      resolvedAt: n.resolvedAt ? new Date(n.resolvedAt) : null,
      createdAt: new Date(n.createdAt),
      updatedAt: new Date(n.updatedAt),
    };
    await tx.merchantNotification.upsert({
      where: { merchantId_key: { merchantId, key: n.key } },
      create: { id, merchantId, ...value },
      update: value,
    });
  }
  const previousActivities = new Set(before.activity.map((a) => a.id));
  const newActivities = after.activity.filter((a) => !previousActivities.has(a.id));
  if (newActivities.length)
    await tx.activity.createMany({
      data: newActivities.map((a) => ({ ...a, merchantId, createdAt: new Date(a.createdAt) })),
    });
  const oldEvents = new Set(before.processedEvents);
  const events = after.processedEvents.filter((event) => !oldEvents.has(event));
  if (events.length)
    await tx.webhookReceipt.createMany({
      data: events.map((eventId) => ({ merchantId, eventId })),
    });
}
export async function createStore(store: Store): Promise<void> {
  if (!prisma) {
    if ([...memory.values()].some((s) => s.merchant.email === store.merchant.email))
      throw new ConflictError('Email already registered');
    memory.set(store.merchant.id, structuredClone(store));
    return;
  }
  try {
    await prisma.merchant.create({
      data: {
        ...store.merchant,
        trialEndsAt: new Date(store.merchant.trialEndsAt),
        createdAt: new Date(store.merchant.createdAt),
        workspace: {
          create: { settings: store.workspace.settings as unknown as Prisma.InputJsonValue },
        },
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      throw new ConflictError('Email already registered');
    throw error;
  }
}
export async function findByEmail(email: string): Promise<Store | undefined> {
  if (!prisma) return structuredClone([...memory.values()].find((s) => s.merchant.email === email));
  const m = await prisma.merchant.findUnique({ where: { email }, include });
  return m?.workspace ? hydrate(m) : undefined;
}
export async function getStore(id: string): Promise<Store | undefined> {
  if (!prisma) return structuredClone(memory.get(id));
  const m = await prisma.merchant.findUnique({ where: { id }, include });
  return m?.workspace ? hydrate(m) : undefined;
}
export async function listStores(): Promise<Store[]> {
  if (!prisma) return structuredClone([...memory.values()]);
  const merchants = await prisma.merchant.findMany({ include });
  return merchants.filter((m) => !!m.workspace).map(hydrate);
}
export async function mutate<T>(id: string, action: (store: Store) => T): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      if (!prisma) {
        const original = memory.get(id);
        if (!original) throw new Error('Workspace not found');
        const store = structuredClone(original);
        const result = action(store);
        for (const other of memory.values()) {
          if (
            other.merchant.id !== id &&
            store.workspace.integration.shopDomain &&
            other.workspace.integration.shopDomain === store.workspace.integration.shopDomain
          )
            throw new ConflictError('This Shopify store is already linked to another workspace');
        }
        memory.set(id, store);
        return result;
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          return await prisma.$transaction(
            async (tx) => {
              const merchant = await tx.merchant.findUniqueOrThrow({ where: { id }, include });
              const original = hydrate(merchant);
              const store = structuredClone(original);
              const result = action(store);
              const updated = await tx.workspace.updateMany({
                where: { merchantId: id, revision: merchant.workspace!.revision },
                data: {
                  settings: store.workspace.settings as unknown as Prisma.InputJsonValue,
                  revision: { increment: 1 },
                },
              });
              if (!updated.count) throw new ConflictError('Concurrent workspace update');
              await persist(tx, id, original.workspace, store.workspace);
              return result;
            },
            {
              isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
              maxWait: 10000,
              timeout: 30000,
            },
          );
        } catch (error) {
          if (
            attempt < 4 &&
            (error instanceof ConflictError ||
              (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034'))
          )
            continue;
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
            throw new ConflictError('This store, phone number, or event is already connected');
          throw error;
        }
      }
      throw new Error('Workspace update failed');
    });
  locks.set(id, run);
  try {
    return await run;
  } finally {
    if (locks.get(id) === run) locks.delete(id);
  }
}
export function publicMerchant(m: Merchant) {
  const { passwordHash: _, ...publicValue } = m;
  return publicValue;
}
export function publicWorkspace(w: Workspace) {
  const {
    shopifyToken,
    whatsappToken,
    shopifyRefreshToken: _refreshToken,
    metaAppSecret: _metaSecret,
    metaVerifyTokenHash: _verifyHash,
    ...integration
  } = w.integration;
  const { processedEvents: _, ...rest } = w;
  return {
    ...rest,
    orders: w.orders.filter((o) => !o.archivedAt),
    integration: {
      ...integration,
      hasShopifyToken: !!shopifyToken,
      hasWhatsappToken: !!whatsappToken,
      hasMetaAppSecret: !!w.integration.metaAppSecret,
      hasMetaVerifyToken: !!w.integration.metaVerifyTokenHash,
    },
  };
}

export interface OAuthAttempt {
  stateHash: string;
  merchantId: string;
  shopDomain: string;
  expiresAt: Date;
  consumedAt?: Date | null;
}
const attempts = new Map<string, OAuthAttempt>();
const refreshLeases = new Map<string, number>();
export async function saveOAuthAttempt(attempt: OAuthAttempt): Promise<void> {
  if (!prisma) {
    for (const [key, value] of attempts)
      if (value.expiresAt.getTime() < Date.now()) attempts.delete(key);
    attempts.set(attempt.stateHash, structuredClone(attempt));
    return;
  }
  await prisma.shopifyOAuthAttempt.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await prisma.shopifyOAuthAttempt.create({ data: attempt });
}
export async function consumeOAuthAttempt(
  stateHash: string,
  shopDomain: string,
): Promise<OAuthAttempt | undefined> {
  if (!prisma) {
    const attempt = attempts.get(stateHash);
    if (
      !attempt ||
      attempt.shopDomain !== shopDomain ||
      attempt.consumedAt ||
      attempt.expiresAt.getTime() <= Date.now()
    )
      return;
    attempt.consumedAt = new Date();
    return structuredClone(attempt);
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.shopifyOAuthAttempt.updateMany({
      where: { stateHash, shopDomain, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (!updated.count) return undefined;
    return (await tx.shopifyOAuthAttempt.findUnique({ where: { stateHash } })) ?? undefined;
  });
}
export async function acquireRefreshLease(merchantId: string): Promise<boolean> {
  const now = new Date();
  const until = new Date(Date.now() + 60000);
  if (!prisma) {
    if ((refreshLeases.get(merchantId) ?? 0) > now.getTime()) return false;
    refreshLeases.set(merchantId, until.getTime());
    return true;
  }
  return (
    (
      await prisma.shopifyIntegration.updateMany({
        where: {
          merchantId,
          OR: [{ refreshLeaseUntil: null }, { refreshLeaseUntil: { lt: now } }],
        },
        data: { refreshLeaseUntil: until },
      })
    ).count === 1
  );
}
export async function releaseRefreshLease(merchantId: string): Promise<void> {
  if (!prisma) {
    refreshLeases.delete(merchantId);
    return;
  }
  await prisma.shopifyIntegration.updateMany({
    where: { merchantId },
    data: { refreshLeaseUntil: null },
  });
}

export const database = prisma;

export async function findByShopDomain(domain: string): Promise<Store | undefined> {
  if (!prisma)
    return structuredClone(
      [...memory.values()].find((s) => s.workspace.integration.shopDomain === domain),
    );
  const m = await prisma.merchant.findFirst({
    where: { shopifyIntegration: { shopDomain: domain } },
    include,
  });
  return m?.workspace ? hydrate(m) : undefined;
}
export async function storesByPhoneIds(ids: string[]): Promise<Store[]> {
  if (!prisma)
    return structuredClone(
      [...memory.values()].filter((s) => ids.includes(s.workspace.integration.phoneNumberId)),
    );
  return (
    await prisma.merchant.findMany({
      where: { whatsappIntegration: { phoneNumberId: { in: ids } } },
      include,
    })
  )
    .filter((m) => m.workspace)
    .map(hydrate);
}
export async function readyStores(): Promise<Store[]> {
  if (!prisma) return listStores();
  const now = new Date(),
    stale = new Date(Date.now() - 120000);
  return (
    await prisma.merchant.findMany({
      where: {
        orders: {
          some: {
            jobs: {
              some: {
                OR: [
                  { state: 'QUEUED', dueAt: { lte: now } },
                  { state: 'UNKNOWN', claimedAt: { lt: stale } },
                ],
              },
            },
          },
        },
      },
      include,
    })
  )
    .filter((m) => m.workspace)
    .map(hydrate);
}

export async function webhookShopTarget(domain: string): Promise<string | undefined> {
  if (database)
    return (
      await database.shopifyIntegration.findUnique({
        where: { shopDomain: domain },
        select: { merchantId: true },
      })
    )?.merchantId;
  return [...memory.values()].find((s) => s.workspace.integration.shopDomain === domain)?.merchant
    .id;
}
export async function webhookMetaTargets(
  ids: string[],
  merchantId?: string,
): Promise<{ merchantId: string; phoneNumberId: string | null; metaAppSecret: string | null }[]> {
  if (database)
    return database.whatsAppIntegration.findMany({
      where: { ...(merchantId ? { merchantId } : {}), phoneNumberId: { in: ids } },
      select: { merchantId: true, phoneNumberId: true, metaAppSecret: true },
    });
  return [...memory.values()]
    .filter(
      (s) =>
        (!merchantId || s.merchant.id === merchantId) &&
        ids.includes(s.workspace.integration.phoneNumberId),
    )
    .map((s) => ({
      merchantId: s.merchant.id,
      phoneNumberId: s.workspace.integration.phoneNumberId,
      metaAppSecret: s.workspace.integration.metaAppSecret ?? null,
    }));
}
