import type { Order } from '../../src/models/types';

export type Act = (fn: () => Promise<unknown>, message?: string) => Promise<void>;
export const money = (amount: number, currency = 'PKR') =>
  new Intl.NumberFormat('en-PK', { style: 'currency', currency, maximumFractionDigits: 0 }).format(
    amount,
  );
export const initials = (name: string) =>
  name
    .split(' ')
    .slice(0, 2)
    .map((n) => n[0])
    .join('');
export const statusLabels: Record<Order['status'], string> = {
  PENDING: 'Awaiting reply',
  CONFIRMED: 'Confirmed',
  NEEDS_REVIEW: 'Needs review',
  CANCELLED: 'Cancelled',
};
export function time(value: string) {
  return new Date(value).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });
}
