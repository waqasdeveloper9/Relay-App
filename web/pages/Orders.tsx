import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Search, RefreshCw, Trash2, Check, Flag } from 'lucide-react';
import type { Order } from '../../src/models/types';
import { api, type PublicWorkspace } from '../api';
import { statusLabels, type Act } from '../lib/format';
import { Modal, OrderTable } from '../components/ui';
type Action = 'confirm' | 'review' | 'remove';
interface SyncStatus {
  sync: {
    manualRequested: boolean;
    recovering: boolean;
    lastSuccessAt: string | null;
    nextRunAt: string;
    error: string | null;
  };
}
export function Orders({
  workspace: w,
  search,
  setSearch,
  onSelect,
  busy,
  act,
}: {
  workspace: PublicWorkspace;
  search: string;
  setSearch: (s: string) => void;
  onSelect: (o: Order) => void;
  busy: boolean;
  act: Act;
}) {
  const [filter, setFilter] = useState('All orders'),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<{
    action: Action;
    all: boolean;
    ids: string[];
    count: number;
  }>();
  const [days, setDays] = useState(60),
    [restoreRemoved, setRestoreRemoved] = useState(true),
    [status, setStatus] = useState<SyncStatus>(),
    [syncError, setSyncError] = useState('');
  useEffect(() => {
    let active = true;
    const load = () =>
      void api<SyncStatus>('/reliability')
        .then((v) => {
          if (active) {
            setStatus(v);
            setSyncError('');
          }
        })
        .catch((e) => {
          if (active) setSyncError(e.message);
        });
    load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    const visible = new Set(w.orders.map((o) => o.id));
    setSelected((prev) => new Set([...prev].filter((id) => visible.has(id))));
  }, [w.orders]);
  const filters = ['All orders', 'Confirmed', 'Awaiting reply', 'Needs review', 'Cancelled'];
  const filtered = w.orders.filter(
    (o) =>
      (filter === 'All orders' || statusLabels[o.status] === filter) &&
      `${o.number} ${o.name} ${o.phone}`.toLowerCase().includes(search.toLowerCase()),
  );
  const pageOffset = Math.min(offset, Math.max(0, Math.floor((filtered.length - 1) / 8) * 8)),
    pageOrders = filtered.slice(pageOffset, pageOffset + 8);
  const syncing = !!(status?.sync.manualRequested || status?.sync.recovering);
  const choose = (action: Action, all = false) =>
    setPending({
      action,
      all,
      ids: all ? [] : [...selected],
      count: all ? w.orders.length : selected.size,
    });
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 500) next.add(id);
      return next;
    });
  return (
    <>
      <section className="panel order-operations-panel">
        <div className="order-sync-controls">
          <label className="field">
            <span>Sync period</span>
            <select
              value={days}
              disabled={busy || syncing}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {[7, 30, 60].map((n) => (
                <option value={n} key={n}>
                  Last {n} days
                </option>
              ))}
            </select>
          </label>
          <label className="integration-test-consent">
            <input
              type="checkbox"
              checked={restoreRemoved}
              disabled={busy || syncing}
              onChange={(e) => setRestoreRemoved(e.target.checked)}
            />
            Restore removed orders
          </label>
          <button
            className="button primary"
            disabled={busy || syncing || !w.integration.hasShopifyToken}
            onClick={() =>
              void act(async () => {
                await api('/orders/sync', { lookbackDays: days, restoreRemoved });
                setStatus((v) => ({
                  sync: {
                    ...v?.sync,
                    lastSuccessAt: v?.sync.lastSuccessAt ?? null,
                    nextRunAt: v?.sync.nextRunAt ?? new Date().toISOString(),
                    error: null,
                    recovering: true,
                    manualRequested: true,
                  },
                }));
              }, 'Shopify sync started. Progress appears above the order list.')
            }
          >
            <RefreshCw size={16} className={syncing ? 'spin' : undefined} />
            {syncing ? 'Syncing Shopify…' : 'Sync from Shopify'}
          </button>
        </div>
        <p className="muted" role="status">
          {syncError ||
            status?.sync.error ||
            (syncing
              ? 'Sync is queued or processing. The list refreshes automatically.'
              : status?.sync.lastSuccessAt
                ? 'Last sync: ' + new Date(status.sync.lastSuccessAt).toLocaleString()
                : 'No completed sync yet.')}
        </p>
        {!w.integration.hasShopifyToken && (
          <p>Connect Shopify in Integrations before synchronizing.</p>
        )}
      </section>
      <section className="panel">
        <div className="table-toolbar">
          <div className="tabs">
            {filters.map((f) => (
              <button
                className={filter === f ? 'active' : ''}
                key={f}
                onClick={() => {
                  setFilter(f);
                  setOffset(0);
                  setSelected(new Set());
                }}
              >
                {f}
                {f === 'All orders' && <span>{w.orders.length}</span>}
              </button>
            ))}
          </div>
          <label className="search">
            <Search size={16} />
            <input
              aria-label="Search orders"
              placeholder="Search orders…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
                setSelected(new Set());
              }}
            />
          </label>
        </div>
        <div className="order-bulk-toolbar">
          <strong>
            {selected.size ? selected.size + ' selected across pages' : 'Select orders'}
          </strong>
          <div className="integration-quick-actions">
            {filtered.length > 0 && filtered.length <= 500 && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => setSelected(new Set(filtered.map((o) => o.id)))}
              >
                Select all {filtered.length} matching
              </button>
            )}
            {selected.size > 0 && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => setSelected(new Set())}
              >
                Clear selection
              </button>
            )}
            <button
              className="button secondary"
              disabled={busy || !selected.size}
              onClick={() => choose('confirm')}
            >
              <Check size={16} />
              Confirm selected
            </button>
            <button
              className="button secondary"
              disabled={busy || !selected.size}
              onClick={() => choose('review')}
            >
              <Flag size={16} />
              Mark for review
            </button>
            <button
              className="button danger"
              disabled={busy || !selected.size}
              onClick={() => choose('remove')}
            >
              <Trash2 size={16} />
              Remove selected
            </button>
          </div>
          <small>
            Up to 500 orders per action. Removal affects Relay only; history is retained.
          </small>
        </div>
        <OrderTable
          orders={pageOrders}
          onSelect={onSelect}
          messages={w.outboundMessages ?? []}
          selectedIds={selected}
          selectionDisabled={busy}
          onToggle={toggle}
          onTogglePage={() =>
            setSelected((prev) => {
              const next = new Set(prev);
              const all = pageOrders.every((o) => next.has(o.id));
              for (const o of pageOrders)
                if (all) next.delete(o.id);
                else if (next.size < 500) next.add(o.id);
              return next;
            })
          }
        />
        <div className="table-pagination">
          <button
            className="text-button danger-text"
            disabled={busy || !w.orders.length || w.orders.length > 500}
            onClick={() => choose('remove', true)}
          >
            <Trash2 size={14} /> Remove all from Relay
          </button>
          <span>
            {filtered.length
              ? `${pageOffset + 1}–${Math.min(pageOffset + 8, filtered.length)}`
              : '0'}{' '}
            of {filtered.length} orders
          </span>
          <div>
            <button
              className="icon-button"
              aria-label="Previous page"
              disabled={!pageOffset}
              onClick={() => setOffset(Math.max(0, pageOffset - 8))}
            >
              <ChevronLeft size={17} />
            </button>
            <button
              className="icon-button"
              aria-label="Next page"
              disabled={pageOffset + 8 >= filtered.length}
              onClick={() => setOffset(pageOffset + 8)}
            >
              <ChevronRight size={17} />
            </button>
          </div>
        </div>
      </section>
      {pending && (
        <Modal
          title={
            (pending.action === 'remove'
              ? 'Remove'
              : pending.action === 'confirm'
                ? 'Confirm'
                : 'Review') +
            ' ' +
            pending.count +
            ' order(s)?'
          }
          subtitle={pending.all ? 'All currently visible Relay orders' : 'Selected orders'}
          close={() => {
            if (!busy) setPending(undefined);
          }}
        >
          <p>
            {pending.action === 'remove'
              ? 'These orders will be hidden in Relay and their queued automation stopped. Shopify orders, message history and audit records remain unchanged. Use Restore removed orders when syncing to bring them back.'
              : pending.action === 'confirm'
                ? 'Relay will confirm these orders and queue COD-CONFIRMED tags in Shopify. This does not mark orders paid or fulfilled. Cancelled orders cannot be confirmed.'
                : 'These orders will be marked for review in Relay. This action does not change Shopify orders.'}
          </p>
          <div className="drawer-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setPending(undefined)}
            >
              Keep current orders
            </button>
            <button
              className={'button ' + (pending.action === 'remove' ? 'danger' : 'primary')}
              disabled={busy}
              onClick={() =>
                void act(
                  async () => {
                    await api('/orders/bulk', {
                      action: pending.action,
                      ids: pending.ids,
                      all: pending.all,
                      expectedCount: pending.all ? pending.count : undefined,
                      confirmed: true,
                    });
                    setSelected(new Set());
                    setPending(undefined);
                  },
                  pending.action === 'remove'
                    ? 'Orders removed from Relay. Shopify unchanged.'
                    : 'Bulk order action saved.',
                )
              }
            >
              {busy
                ? 'Processing…'
                : pending.action === 'remove'
                  ? 'Remove from Relay'
                  : pending.action === 'confirm'
                    ? 'Confirm orders'
                    : 'Mark for review'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
