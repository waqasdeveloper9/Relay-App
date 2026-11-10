import { randomUUID } from 'node:crypto';
import type { OutboundMessage, Workspace } from '../models/types.js';
import { reliability } from './reliability-settings.js';
import { notify, resolveNotification } from './notifications.js';
import { database, listStores, mutate } from './repository.js';
export async function beginMessage(
  merchantId: string,
  input: Pick<
    OutboundMessage,
    'kind' | 'recipient' | 'templateName' | 'languageCode' | 'preview'
  > & { orderId?: string; jobId?: string },
): Promise<string> {
  let id: string = randomUUID();
  await mutate(merchantId, (s) => {
    (s.workspace.outboundMessages ??= []).unshift({
      id,
      ...input,
      status: 'SENDING',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });
  return id;
}
export async function updateMessage(
  merchantId: string,
  id: string,
  value: Partial<Pick<OutboundMessage, 'status' | 'messageId' | 'error' | 'preview'>>,
): Promise<void> {
  await mutate(merchantId, (s) => {
    const message = s.workspace.outboundMessages?.find((m) => m.id === id);
    if (message) {
      const next = { ...value };
      if (
        ['SENT', 'DELIVERED', 'READ', 'FAILED'].includes(message.status) &&
        next.status &&
        ['ACCEPTED', 'SENDING', 'UNKNOWN'].includes(next.status)
      ) {
        delete next.status;
        delete next.error;
      }
      Object.assign(message, next, { updatedAt: new Date().toISOString() });
    }
  });
}
export function applyDeliveryStatus(
  w: Workspace,
  event: {
    id: string;
    status: string;
    recipient_id: string;
    biz_opaque_callback_data?: string;
    timestamp: string;
    errors?: { code: number; title?: string; message?: string }[];
  },
): void {
  const m = w.outboundMessages?.find(
    (m) =>
      (m.messageId === event.id || (!m.messageId && m.id === event.biz_opaque_callback_data)) &&
      m.recipient === event.recipient_id,
  );
  if (!m || !['sent', 'delivered', 'read', 'failed'].includes(event.status)) return;
  const at = Number(event.timestamp) * 1000;
  if (
    !Number.isFinite(at) ||
    Number.isNaN(new Date(at).getTime()) ||
    at < Date.parse(m.statusTimestamp ?? '1970-01-01')
  )
    return;
  const status = event.status.toUpperCase() as OutboundMessage['status'];
  const ranks: Record<string, number> = {
    SENDING: 0,
    UNKNOWN: 0,
    ACCEPTED: 1,
    SENT: 2,
    FAILED: 2,
    DELIVERED: 3,
    READ: 4,
  };
  if (ranks[status]! < ranks[m.status]!) return;
  if (m.status === 'FAILED' && status === 'SENT') return;
  m.messageId = event.id;
  m.status = status;
  if (m.jobId) {
    const job = w.jobs.find((j) => j.id === m.jobId);
    const latest = w.outboundMessages?.find((v) => v.jobId === m.jobId);
    if (job && job.state === 'UNKNOWN' && latest?.id === m.id) {
      job.state = 'DONE';
      job.claimedAt = undefined;
      job.messageId = event.id;
      job.error = undefined;
      const order = w.orders.find((o) => o.id === job.orderId);
      if (
        order &&
        !['SUPPORT_REPLY', 'SUPPORT_MENU'].includes(m.kind) &&
        !order.confirmationExpiresAt
      )
        order.confirmationExpiresAt = new Date(
          Date.parse(m.createdAt) + reliability(w).maxMessageAgeHours * 3600000,
        ).toISOString();
      resolveNotification(w, 'job:' + job.id);
    }
  }
  resolveNotification(w, 'message:' + m.id);
  m.statusTimestamp = new Date(at).toISOString();
  m.updatedAt = new Date().toISOString();
  m.error =
    status === 'FAILED'
      ? event.errors
          ?.map((e) => 'Meta ' + e.code + ': ' + (e.title ?? 'Delivery failed'))
          .join('; ')
          .slice(0, 1000) || 'Meta reported delivery failure'
      : undefined;
}

export async function reconcileStaleSamples(): Promise<void> {
  const cutoff = new Date(Date.now() - 120000);
  const ids = database
    ? [
        ...new Set(
          (
            await database.outboundMessage.findMany({
              where: { jobId: null, status: 'SENDING', createdAt: { lt: cutoff } },
              select: { merchantId: true },
            })
          ).map((m) => m.merchantId),
        ),
      ]
    : (await listStores())
        .filter((s) =>
          s.workspace.outboundMessages?.some(
            (m) => !m.jobId && m.status === 'SENDING' && Date.parse(m.createdAt) < cutoff.getTime(),
          ),
        )
        .map((s) => s.merchant.id);
  for (const id of ids)
    await mutate(id, (s) => {
      for (const m of s.workspace.outboundMessages ?? [])
        if (!m.jobId && m.status === 'SENDING' && Date.parse(m.createdAt) < cutoff.getTime()) {
          const isInboxReply = m.kind === 'INBOX_REPLY';
          m.status = 'UNKNOWN';
          m.updatedAt = new Date().toISOString();
          m.error = isInboxReply
            ? 'The server stopped before the live reply send outcome was recorded. Check WhatsApp and Meta provider logs before resending.'
            : 'The server stopped before the sample send outcome was recorded. Check provider history before sending another sample.';
          notify(
            s.workspace,
            'message:' + m.id,
            isInboxReply ? 'Uncertain reply send' : 'Uncertain sample send',
            m.error,
            'Check WhatsApp and Meta provider logs before resending.',
          );
        }
    });
}
