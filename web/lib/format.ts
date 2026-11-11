import type { DeliveryStatus, Order } from '../../src/models/types';

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
const deliveryClasses: Record<DeliveryStatus, string> = {
  Unfulfilled: '',
  'In progress': 'progress',
  'On hold': 'hold',
  Scheduled: 'scheduled',
  'Partially fulfilled': 'partial',
  'In transit': 'transit',
  Delivered: 'delivered',
  Restocked: 'restocked',
  'Fulfillment not required': 'not-required',
};
export function deliveryClass(delivery: DeliveryStatus): string {
  return deliveryClasses[delivery] ?? '';
}
export function paymentLabel(financialStatus?: string, isCod?: boolean): string {
  switch ((financialStatus ?? '').trim().toLowerCase()) {
    case 'paid':
      return 'Paid';
    case 'pending':
      return 'Payment pending';
    case 'authorized':
      return 'Authorized';
    case 'partially_paid':
      return 'Partially paid';
    case 'partially_refunded':
      return 'Partially refunded';
    case 'refunded':
      return 'Refunded';
    case 'voided':
      return 'Voided';
    default:
      return isCod === false ? 'Paid' : 'Payment pending';
  }
}
export function paymentClass(financialStatus?: string, isCod?: boolean): string {
  switch ((financialStatus ?? '').trim().toLowerCase()) {
    case 'paid':
      return 'paid';
    case 'partially_paid':
    case 'authorized':
      return 'partial';
    case 'partially_refunded':
    case 'refunded':
    case 'voided':
      return 'refunded';
    case 'pending':
      return 'pending';
    default:
      return isCod === false ? 'paid' : 'pending';
  }
}
export function safeExternalUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.toString();
    return undefined;
  } catch {
    return undefined;
  }
}
export function time(value: string) {
  return new Date(value).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });
}
