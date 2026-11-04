import { randomUUID } from 'node:crypto';
import type { Workspace } from '../models/types.js';
export function notify(
  w: Workspace,
  key: string,
  title: string,
  detail: string,
  action: string,
  severity: 'warning' | 'error' | 'info' = 'error',
): void {
  const all = (w.notifications ??= []);
  const existing = all.find((n) => n.key === key);
  const now = new Date().toISOString();
  if (existing) {
    if (existing.detail !== detail || existing.resolvedAt) existing.readAt = undefined;
    Object.assign(existing, {
      title,
      detail,
      action,
      severity,
      resolvedAt: undefined,
      updatedAt: now,
    });
  } else
    all.unshift({
      id: randomUUID(),
      key,
      title,
      detail,
      action,
      severity,
      createdAt: now,
      updatedAt: now,
    });
}
export function resolveNotification(w: Workspace, key: string): void {
  const n = w.notifications?.find((n) => n.key === key);
  if (n) {
    n.resolvedAt = new Date().toISOString();
    n.updatedAt = n.resolvedAt;
  }
}
