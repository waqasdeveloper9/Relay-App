import { useEffect, useId, useRef, useState } from 'react';
import {
  BookmarkPlus,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  CreditCard,
  Flag,
  Lock,
  RefreshCw,
  Search,
  Trash2,
  Unlock,
  X,
} from 'lucide-react';
import type { Order, OrderView } from '../../src/models/types';
import { shopifySyncSettings } from '../../src/models/workspace-defaults';
import { api, type PublicWorkspace } from '../api';
import { type Act } from '../lib/format';
import { Modal, OrderTable } from '../components/ui';

type Action =
  | 'confirm'
  | 'review'
  | 'remove'
  | 'mark_paid'
  | 'mark_delivered'
  | 'mark_in_progress'
  | 'hold'
  | 'release_hold';

const SHOPIFY_BULK_ACTIONS = new Set<Action>([
  'mark_paid',
  'mark_delivered',
  'mark_in_progress',
  'hold',
  'release_hold',
]);

const DAILY_TABS = [
  { id: 'All orders', label: 'All orders' },
  { id: 'To confirm', label: 'To confirm' },
  { id: 'Ready to pack', label: 'Ready to pack' },
  { id: 'Fulfilled · Unpaid', label: 'Fulfilled · Unpaid' },
  { id: 'Paid', label: 'Paid' },
  { id: 'Delivered', label: 'Delivered' },
  { id: 'Needs review', label: 'Needs review' },
  { id: 'Cancelled', label: 'Cancelled' },
] as const;

function matchesDailyTab(o: Order, tab: string): boolean {
  const fin = (o.financialStatus ?? 'pending').toLowerCase();
  switch (tab) {
    case 'All orders':
      return true;
    case 'To confirm':
      return o.isCod !== false && o.status === 'PENDING' && fin === 'pending';
    case 'Ready to pack':
      return (
        o.status !== 'CANCELLED' && ['Unfulfilled', 'In progress', 'Scheduled'].includes(o.delivery)
      );
    case 'Fulfilled · Unpaid':
      return (
        o.status !== 'CANCELLED' &&
        ['In transit', 'Partially fulfilled', 'Delivered'].includes(o.delivery) &&
        fin !== 'paid'
      );
    case 'Paid':
      return fin === 'paid';
    case 'Delivered':
      return o.delivery === 'Delivered';
    case 'Needs review':
      return o.status === 'NEEDS_REVIEW';
    case 'Cancelled':
      return o.status === 'CANCELLED';
    default:
      return true;
  }
}

function matchesPaymentFilter(o: Order, paymentFilter: string): boolean {
  const fin = (o.financialStatus ?? (o.isCod === false ? 'paid' : 'pending')).toLowerCase();
  switch (paymentFilter) {
    case 'ALL':
      return true;
    case 'PENDING':
      return fin === 'pending';
    case 'PAID':
      return fin === 'paid';
    case 'PARTIAL':
      return fin === 'partially_paid' || fin === 'authorized';
    case 'REFUNDED':
      return fin === 'refunded' || fin === 'partially_refunded' || fin === 'voided';
    default:
      return true;
  }
}

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
  mode = 'connected',
  search,
  setSearch,
  onSelect,
  busy,
  act,
}: {
  workspace: PublicWorkspace;
  mode?: 'demo' | 'connected';
  search: string;
  setSearch: (s: string) => void;
  onSelect: (o: Order) => void;
  busy: boolean;
  act: Act;
}) {
  const sync = shopifySyncSettings(w);
  const savedViews = w.settings.orderViews ?? [];
  const [filter, setFilter] = useState('All orders'),
    [paymentFilter, setPaymentFilter] = useState('ALL'),
    [secondaryFilter, setSecondaryFilter] = useState('ALL'),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<Set<string>>(new Set());
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [viewName, setViewName] = useState('');
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
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const baseId = useId();
  const viewNameId = useId();

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

  const tabCounts = {
    'All orders': w.orders.length,
    'To confirm': w.orders.filter((o) => matchesDailyTab(o, 'To confirm')).length,
    'Ready to pack': w.orders.filter((o) => matchesDailyTab(o, 'Ready to pack')).length,
    'Fulfilled · Unpaid': w.orders.filter((o) => matchesDailyTab(o, 'Fulfilled · Unpaid')).length,
  } as Record<string, number>;

  const filtered = w.orders.filter(
    (o) =>
      matchesDailyTab(o, filter) &&
      matchesPaymentFilter(o, paymentFilter) &&
      (secondaryFilter === 'ALL'
        ? true
        : secondaryFilter === 'COD'
          ? o.isCod !== false
          : secondaryFilter === 'NON_COD'
            ? o.isCod === false
            : o.delivery === secondaryFilter) &&
      `${o.number} ${o.name} ${o.phone} ${o.trackingNumber ?? ''} ${o.trackingCompany ?? ''} ${o.paymentMethod ?? ''}`
        .toLowerCase()
        .includes(search.toLowerCase()),
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

  const selectTab = (index: number, focusTarget = false) => {
    const tab = DAILY_TABS[index];
    if (!tab) return;
    setFilter(tab.id);
    setOffset(0);
    setSelected(new Set());
    const btn = tabRefs.current[index];
    if (btn) {
      if (focusTarget) btn.focus();
      btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  };

  const applyView = (v: OrderView) => {
    setFilter(v.tab || 'All orders');
    setPaymentFilter(v.paymentFilter || 'ALL');
    setSecondaryFilter(v.fulfillmentFilter || 'ALL');
    setSearch(v.search || '');
    setOffset(0);
    setSelected(new Set());
  };

  const isViewActive = (v: OrderView) =>
    v.tab === filter &&
    v.paymentFilter === paymentFilter &&
    v.fulfillmentFilter === secondaryFilter &&
    v.search === search.trim();

  const saveViewsList = (nextViews: OrderView[], msg: string) => {
    void act(
      () =>
        api(
          '/settings',
          {
            ...w.settings,
            orderViews: nextViews,
            ...(w.settings.support
              ? { support: { ...w.settings.support, optedOutPhones: undefined } }
              : {}),
          },
          'PUT',
        ),
      msg,
    );
  };

  const modalTitle = (action: Action, count: number) => {
    switch (action) {
      case 'remove':
        return `Remove ${count} order(s)?`;
      case 'confirm':
        return `Confirm ${count} order(s)?`;
      case 'review':
        return `Mark ${count} order(s) for review?`;
      case 'mark_paid':
        return `Mark ${count} order(s) paid in Shopify?`;
      case 'mark_delivered':
        return `Mark ${count} order(s) delivered in Shopify?`;
      case 'mark_in_progress':
        return `Mark ${count} order(s) in progress?`;
      case 'hold':
        return `Hold fulfillment for ${count} order(s)?`;
      case 'release_hold':
        return `Release Relay holds for ${count} order(s)?`;
    }
  };

  const modalDetail = (action: Action) => {
    switch (action) {
      case 'remove':
        return 'These orders will be hidden in Relay and their queued automation stopped. Shopify orders, message history and audit records remain unchanged. Use Restore removed orders when syncing to bring them back.';
      case 'confirm':
        return `Relay will confirm eligible COD orders and queue ${sync.confirmedTag} tags in Shopify. This does not mark orders paid or fulfilled. Cancelled orders cannot be confirmed.`;
      case 'review':
        return 'These orders will be marked for review in Relay. Shopify tags or holds apply only if configured in Settings.';
      case 'mark_paid':
        return 'Relay will mark eligible payment-pending, authorized, or partially paid orders as Paid in Shopify, move pending orders to Confirmed, and stop queued COD confirmation reminders. Already paid orders are skipped.';
      case 'mark_delivered':
        return 'Relay will record a Shopify Delivered fulfillment event for eligible fulfilled orders in transit. Unfulfilled or already delivered orders are skipped.';
      case 'mark_in_progress':
        return 'Relay will mark open Shopify fulfillment orders as In progress so your packing team can track them.';
      case 'hold':
        return 'Relay will place a Relay-owned fulfillment hold (handle: relay-hold) on eligible Unfulfilled/In-progress orders.';
      case 'release_hold':
        return 'Relay will release Relay-owned fulfillment holds on selected On-hold orders; third-party holds in Shopify are untouched.';
    }
  };

  const modalConfirmLabel = (action: Action) => {
    switch (action) {
      case 'remove':
        return 'Remove from Relay';
      case 'confirm':
        return 'Confirm orders';
      case 'review':
        return 'Mark for review';
      case 'mark_paid':
        return 'Mark paid in Shopify';
      case 'mark_delivered':
        return 'Mark delivered';
      case 'mark_in_progress':
        return 'Mark in progress';
      case 'hold':
        return 'Place holds';
      case 'release_hold':
        return 'Release holds';
    }
  };

  const activeTabButtonId = `${baseId}-tab-${DAILY_TABS.findIndex((t) => t.id === filter)}`;

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
            type="button"
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
        <div className="table-toolbar orders-toolbar">
          <div className="tabs-header">
            <div className="tabs-list" role="tablist" aria-label="Daily order views">
              {DAILY_TABS.map((t, index) => {
                const selectedTab = filter === t.id;
                const count = tabCounts[t.id];
                return (
                  <button
                    key={t.id}
                    ref={(el) => {
                      tabRefs.current[index] = el;
                    }}
                    id={`${baseId}-tab-${index}`}
                    type="button"
                    role="tab"
                    aria-selected={selectedTab}
                    tabIndex={selectedTab ? 0 : -1}
                    onKeyDown={(e) => {
                      let next = index;
                      if (e.key === 'ArrowRight') next = (index + 1) % DAILY_TABS.length;
                      else if (e.key === 'ArrowLeft')
                        next = (index - 1 + DAILY_TABS.length) % DAILY_TABS.length;
                      else if (e.key === 'Home') next = 0;
                      else if (e.key === 'End') next = DAILY_TABS.length - 1;
                      else return;
                      e.preventDefault();
                      selectTab(next, true);
                    }}
                    onClick={() => selectTab(index, false)}
                  >
                    {t.label}
                    {count !== undefined && <span>{count}</span>}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className="button secondary save-view-trigger"
              aria-expanded={saveViewOpen}
              disabled={busy || savedViews.length >= 20}
              onClick={() => setSaveViewOpen((v) => !v)}
            >
              <BookmarkPlus size={15} />
              Save view
            </button>
          </div>
          {saveViewOpen && (
            <form
              method="POST"
              className="save-view-form"
              onSubmit={(e) => {
                e.preventDefault();
                const trimmed = viewName.trim();
                if (!trimmed || busy) return;
                const nextView: OrderView = {
                  id:
                    typeof crypto !== 'undefined' && crypto.randomUUID
                      ? crypto.randomUUID()
                      : String(Date.now()),
                  name: trimmed,
                  tab: filter,
                  paymentFilter,
                  fulfillmentFilter: secondaryFilter,
                  search: search.trim(),
                };
                saveViewsList([...savedViews, nextView], `Saved custom view "${trimmed}".`);
                setViewName('');
                setSaveViewOpen(false);
              }}
            >
              <div className="field">
                <label htmlFor={viewNameId}>Custom view name</label>
                <input
                  id={viewNameId}
                  name="viewName"
                  required
                  maxLength={40}
                  value={viewName}
                  placeholder="e.g. TCS Cash Pending"
                  onChange={(e) => setViewName(e.target.value)}
                />
              </div>
              <button type="submit" className="button primary" disabled={busy || !viewName.trim()}>
                Save current filters
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  setSaveViewOpen(false);
                  setViewName('');
                }}
              >
                Cancel
              </button>
            </form>
          )}
          {savedViews.length > 0 && (
            <div className="saved-views-bar" aria-label="Custom saved views">
              <small>Custom views:</small>
              {savedViews.map((v) => (
                <span key={v.id} className={`saved-view-chip ${isViewActive(v) ? 'active' : ''}`}>
                  <button type="button" className="saved-view-apply" onClick={() => applyView(v)}>
                    {v.name}
                  </button>
                  <button
                    type="button"
                    className="chip-icon-btn"
                    aria-label={`Delete view ${v.name}`}
                    disabled={busy}
                    onClick={() =>
                      saveViewsList(
                        savedViews.filter((item) => item.id !== v.id),
                        `Deleted view "${v.name}".`,
                      )
                    }
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <search className="table-search-controls">
            <select
              className="secondary-filter-select"
              aria-label="Filter by payment status"
              value={paymentFilter}
              onChange={(e) => {
                setPaymentFilter(e.target.value);
                setOffset(0);
                setSelected(new Set());
              }}
            >
              <option value="ALL">All payments</option>
              <option value="PENDING">Payment pending</option>
              <option value="PAID">Paid</option>
              <option value="PARTIAL">Partially paid / Authorized</option>
              <option value="REFUNDED">Refunded / Voided</option>
            </select>
            <select
              className="secondary-filter-select"
              aria-label="Filter by fulfillment status or order type"
              value={secondaryFilter}
              onChange={(e) => {
                setSecondaryFilter(e.target.value);
                setOffset(0);
                setSelected(new Set());
              }}
            >
              <option value="ALL">All fulfillment &amp; types</option>
              <option value="COD">COD orders only</option>
              <option value="NON_COD">Prepaid / Non-COD</option>
              <option value="Unfulfilled">Unfulfilled</option>
              <option value="In progress">In progress</option>
              <option value="On hold">On hold</option>
              <option value="Scheduled">Scheduled</option>
              <option value="Partially fulfilled">Partially fulfilled</option>
              <option value="In transit">In transit</option>
              <option value="Delivered">Delivered</option>
              <option value="Restocked">Restocked</option>
            </select>
            <label className="search">
              <Search size={16} />
              <input
                type="search"
                name="orderQuery"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-label="Search orders, customer, phone, or tracking"
                placeholder="Order, phone, tracking…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setOffset(0);
                  setSelected(new Set());
                }}
              />
            </label>
          </search>
        </div>
        <div role="tabpanel" aria-labelledby={activeTabButtonId}>
          <div className="order-bulk-toolbar">
            <strong>
              {selected.size ? selected.size + ' selected across pages' : 'Select orders'}
            </strong>
            <div className="integration-quick-actions">
              {filtered.length > 0 && filtered.length <= 500 && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => setSelected(new Set(filtered.map((o) => o.id)))}
                >
                  Select all {filtered.length} matching
                </button>
              )}
              {selected.size > 0 && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => setSelected(new Set())}
                >
                  Clear selection
                </button>
              )}
              <button
                type="button"
                className="button secondary"
                disabled={busy || !selected.size}
                onClick={() => choose('confirm')}
              >
                <Check size={16} />
                Confirm selected
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy || !selected.size}
                onClick={() => choose('mark_paid')}
              >
                <CreditCard size={16} />
                Mark paid
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy || !selected.size}
                onClick={() => choose('mark_in_progress')}
              >
                <Clock3 size={16} />
                In progress
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy || !selected.size}
                onClick={() => choose('hold')}
              >
                <Lock size={16} />
                Hold
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy || !selected.size}
                onClick={() => choose('release_hold')}
              >
                <Unlock size={16} />
                Release hold
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy || !selected.size}
                onClick={() => choose('mark_delivered')}
              >
                <CheckCircle2 size={16} />
                Mark delivered
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy || !selected.size}
                onClick={() => choose('review')}
              >
                <Flag size={16} />
                Mark for review
              </button>
              <button
                type="button"
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
              type="button"
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
                type="button"
                className="icon-button"
                aria-label="Previous page"
                disabled={!pageOffset}
                onClick={() => setOffset(Math.max(0, pageOffset - 8))}
              >
                <ChevronLeft size={17} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Next page"
                disabled={pageOffset + 8 >= filtered.length}
                onClick={() => setOffset(pageOffset + 8)}
              >
                <ChevronRight size={17} />
              </button>
            </div>
          </div>
        </div>
      </section>
      {pending && (
        <Modal
          title={modalTitle(pending.action, pending.count)}
          subtitle={pending.all ? 'All currently visible Relay orders' : 'Selected orders'}
          close={() => {
            if (!busy) setPending(undefined);
          }}
        >
          <p>{modalDetail(pending.action)}</p>
          <div className="drawer-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setPending(undefined)}
            >
              Keep current orders
            </button>
            <button
              type="button"
              className={'button ' + (pending.action === 'remove' ? 'danger' : 'primary')}
              disabled={busy}
              onClick={() =>
                void act(
                  async () => {
                    const action = pending.action;
                    const res = await api<{ message?: string }>('/orders/bulk', {
                      action,
                      ids: pending.ids,
                      all: pending.all,
                      expectedCount: pending.all ? pending.count : undefined,
                      confirmed: true,
                    });
                    if (mode === 'demo' && SHOPIFY_BULK_ACTIONS.has(action)) {
                      await api('/jobs/run', {});
                    }
                    setSelected(new Set());
                    setPending(undefined);
                    return res.message;
                  },
                  pending.action === 'remove'
                    ? 'Orders removed from Relay. Shopify unchanged.'
                    : 'Bulk order action saved.',
                )
              }
            >
              {busy ? 'Processing…' : modalConfirmLabel(pending.action)}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
