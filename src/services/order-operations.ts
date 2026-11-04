import type { Store } from '../models/types.js';
import { InputError } from '../utils/errors.js';
import { activity, confirm } from './automation.js';
import { resolveNotification } from './notifications.js';
export type BulkOrderAction = 'confirm' | 'review' | 'remove';
export function applyBulkOrderAction(
  s: Store,
  action: BulkOrderAction,
  ids: string[],
  all = false,
  expectedCount?: number,
): { affected: number; skipped: number } {
  const visible = s.workspace.orders.filter((o) => !o.archivedAt);
  if (all && action !== 'remove') throw new InputError('Select specific orders for this action');
  if (all && visible.length !== expectedCount)
    throw Object.assign(
      new Error('The order list changed. Refresh it and review the removal again.'),
      { status: 409 },
    );
  const unique = [...new Set(ids)];
  const selected = all ? visible : unique.map((id) => visible.find((o) => o.id === id));
  if (selected.some((o) => !o))
    throw Object.assign(
      new Error('One or more selected orders are unavailable in this workspace'),
      { status: 404 },
    );
  const orders = selected.filter((o) => !!o);
  if (!orders.length) throw new InputError('Select at least one order');
  if (orders.length > 500) throw new InputError('Process at most 500 orders per batch');
  if (action !== 'remove' && orders.some((o) => o.status === 'CANCELLED'))
    throw new InputError(
      'Cancelled orders cannot be confirmed or marked for review. Remove them from the selection.',
    );
  if (
    action === 'remove' &&
    s.workspace.jobs.some(
      (j) => orders.some((o) => o.id === j.orderId) && j.state === 'UNKNOWN' && j.claimedAt,
    )
  )
    throw new InputError(
      'An action is processing for a selected order. Wait for it to finish before removing the order.',
    );
  let affected = 0,
    skipped = 0;
  const now = new Date().toISOString();
  for (const o of orders) {
    if (action === 'confirm') {
      if (o.status === 'CONFIRMED') {
        skipped++;
        continue;
      }
      confirm(s.workspace, o);
    } else if (action === 'review') {
      if (o.status === 'NEEDS_REVIEW') {
        skipped++;
        continue;
      }
      o.status = 'NEEDS_REVIEW';
      activity(s.workspace, o.number + ' marked for review by merchant');
    } else {
      o.archivedAt = now;
      for (const j of s.workspace.jobs.filter((j) => j.orderId === o.id && j.state === 'QUEUED')) {
        j.state = 'FAILED';
        j.retryable = false;
        j.error = 'Order removed from Relay. This queued action was stopped.';
        resolveNotification(s.workspace, 'job:' + j.id);
      }
      activity(s.workspace, o.number + ' removed from Relay; Shopify order unchanged');
    }
    affected++;
  }
  return { affected, skipped };
}
