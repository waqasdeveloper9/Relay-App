import type { Conversation, Message, Workspace } from './types.js';
import { orderMatchesPhone } from './workspace-defaults.js';
export function conversationPhone(
  w: Pick<Workspace, 'orders' | 'conversations'>,
  c: Conversation,
): string {
  return (c.phone ?? w.orders.find((o) => o.id === c.orderId)?.phone ?? '').replace(/\D/g, '');
}
export function customerThreads(
  w: Pick<Workspace, 'orders' | 'conversations'>,
  c: Conversation,
): Conversation[] {
  const phone = conversationPhone(w, c);
  return phone ? w.conversations.filter((t) => conversationPhone(w, t) === phone) : [c];
}
export interface CustomerConversation extends Conversation {
  name: string;
  phone: string;
  linkedOrderIds: string[];
  messages: (Message & { orderId?: string })[];
}
export function customerConversations(
  w: Pick<Workspace, 'orders' | 'conversations'>,
): CustomerConversation[] {
  const orders = new Map(w.orders.map((o) => [o.id, o]));
  const groups = new Map<string, CustomerConversation>();
  for (const c of w.conversations) {
    const order = c.orderId ? orders.get(c.orderId) : undefined;
    const phone = (c.phone ?? order?.phone ?? '').replace(/\D/g, '');
    const key = phone || c.id;
    let group = groups.get(key);
    if (!group) {
      const linkedOrderIds = phone
        ? w.orders.filter((o) => !o.archivedAt && orderMatchesPhone(o, phone)).map((o) => o.id)
        : order && !order.archivedAt
          ? [order.id]
          : [];
      group = {
        ...c,
        phone,
        name: order?.name ?? (phone || 'Customer'),
        linkedOrderIds,
        messages: [],
      };
      groups.set(key, group);
    }
    if (order && group.name === phone) group.name = order.name;
    group.human ||= c.human;
    group.unread ||= c.unread;
    group.messages.push(...c.messages.map((m) => ({ ...m, orderId: c.orderId })));
  }
  for (const g of groups.values())
    g.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return [...groups.values()].sort((a, b) =>
    (b.messages.at(-1)?.createdAt ?? '').localeCompare(a.messages.at(-1)?.createdAt ?? ''),
  );
}
