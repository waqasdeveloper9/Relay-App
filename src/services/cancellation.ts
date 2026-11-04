import type { Workspace } from '../models/types.js';
import { InputError } from '../utils/errors.js';
import { activity, append, conversation, enqueue } from './automation.js';

export function approveCancellation(
  w: Workspace,
  taskId: string,
  reason: string,
  confirmed: boolean,
): void {
  const task = w.tasks.find((t) => t.id === taskId);
  if (!task) throw Object.assign(new Error('Request not found'), { status: 404 });
  if (task.kind !== 'Cancellation') throw new InputError('This request is not a cancellation');
  if (!confirmed || !reason.trim() || reason.trim().length > 255)
    throw new InputError('Confirm cancellation and provide a reason of 1–255 characters');
  const order = w.orders.find((o) => o.id === task.orderId);
  if (!order || order.archivedAt) throw new InputError('Restore this order before cancelling');
  if (order.status === 'CANCELLED') return;
  const existing = w.jobs.find((j) => j.orderId === order.id && j.kind === 'CANCEL');
  if (existing)
    throw new InputError(
      'Cancellation is already queued or attempted. Check its result in Reliability before retrying',
    );
  task.status = 'APPROVED';
  task.detail = reason.trim();
  order.status = 'NEEDS_REVIEW';
  const c = conversation(w, order);
  c.human = true;
  enqueue(w, order, 'CANCEL_TAGS');
  enqueue(w, order, 'CANCEL');
  append(
    c,
    'note',
    'Merchant approved Shopify cancellation. Reason: ' +
      task.detail +
      '. Awaiting Shopify completion.',
  );
  activity(w, 'Merchant approved cancellation for ' + order.number);
}
