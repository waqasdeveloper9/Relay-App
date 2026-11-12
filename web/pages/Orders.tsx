import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookmarkPlus,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { Order, OrderView } from '../../src/models/types';
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
  const [alsoMarkDelivered, setAlsoMarkDelivered] = useState(true);
  const [showWarningStep, setShowWarningStep] = useState(false);
  const [days, setDays] = useState(60),
    [restoreRemoved, setRestoreRemoved] = useState(true),
    [status, setStatus] = useState<SyncStatus>(),
    [syncError, setSyncError] = useState('');
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const baseId = useId();
  const viewNameId = useId();
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!actionsOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (actionsRef.current && !actionsRef.current.contains(e.target as Node)) {
        setActionsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setActionsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [actionsOpen]);

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
  const choose = (action: Action, all = false) => {
    setAlsoMarkDelivered(true);
    setShowWarningStep(false);
    setPending({
      action,
      all,
      ids: all ? [] : [...selected],
      count: all ? w.orders.length : selected.size,
    });
  };
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 500) next.add(id);
      return next;
    });

  const selectedOrders = useMemo(() => {
    if (!pending) return [];
    if (pending.all) return filtered.filter((o) => !o.archivedAt);
    const idSet = new Set(pending.ids);
    return w.orders.filter((o) => idSet.has(o.id));
  }, [pending, filtered, w.orders]);

  const undeliveredOrders = useMemo(
    () => selectedOrders.filter((o) => o.delivery !== 'Delivered'),
    [selectedOrders],
  );

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
        return `Mark ${count} order(s) as Paid in Shopify?`;
      case 'mark_delivered':
        return `Mark ${count} order(s) as Delivered in Shopify?`;
      case 'mark_in_progress':
        return `Mark ${count} order(s) In Progress in Shopify?`;
      case 'hold':
        return `Place fulfillment hold on ${count} order(s)?`;
      case 'release_hold':
        return `Release fulfillment hold for ${count} order(s)?`;
    }
  };

  const promptText = (action: Action, orders: Order[]) => {
    const single = orders.length === 1;
    const first = orders[0];
    switch (action) {
      case 'mark_paid':
        return single && first
          ? `Order number: ${first.number}, Customer: ${first.name || 'Customer'}${first.phone ? ` (${first.phone})` : ''}. Would you like to set this order status as Paid? This will also update the payment status directly in your Shopify store.`
          : `Would you like to set the payment status as Paid for these ${orders.length} selected orders? This will also update the payment status directly in your Shopify store.`;
      case 'mark_delivered':
        return single && first
          ? `Order number: ${first.number}, Customer: ${first.name || 'Customer'}${first.phone ? ` (${first.phone})` : ''}. Would you like to mark this order as Delivered? This will also record the delivery event directly in your Shopify store.`
          : `Would you like to mark these ${orders.length} selected orders as Delivered? This will also record the delivery events directly in your Shopify store.`;
      case 'mark_in_progress':
        return single && first
          ? `Order number: ${first.number}, Customer: ${first.name || 'Customer'}${first.phone ? ` (${first.phone})` : ''}. Would you like to set this order status as In Progress? This will also update the fulfillment status directly in your Shopify store.`
          : `Would you like to set the fulfillment status as In Progress for these ${orders.length} selected orders? This will also update the fulfillment status directly in your Shopify store.`;
      case 'hold':
        return single && first
          ? `Order number: ${first.number}, Customer: ${first.name || 'Customer'}${first.phone ? ` (${first.phone})` : ''}. Would you like to place a fulfillment hold on this order? This will hold fulfillment directly in your Shopify store to prevent dispatch.`
          : `Would you like to place a fulfillment hold on these ${orders.length} selected orders? This will hold fulfillment directly in your Shopify store to prevent dispatch.`;
      case 'release_hold':
        return single && first
          ? `Order number: ${first.number}, Customer: ${first.name || 'Customer'}${first.phone ? ` (${first.phone})` : ''}. Would you like to release the fulfillment hold on this order? This will clear the hold directly in your Shopify store so fulfillment can proceed.`
          : `Would you like to release the fulfillment hold on these ${orders.length} selected orders? This will clear the holds directly in your Shopify store so fulfillment can proceed.`;
      case 'confirm':
        return single && first
          ? `Order number: ${first.number}, Customer: ${first.name || 'Customer'}${first.phone ? ` (${first.phone})` : ''}. Would you like to mark this order as Confirmed? This will confirm the order and sync the verified confirmation tag directly to your Shopify store.`
          : `Would you like to mark these ${orders.length} selected orders as Confirmed? This will confirm the orders and sync the verified confirmation tags directly to your Shopify store.`;
      case 'review':
        return single && first
          ? `Order number: ${first.number}, Customer: ${first.name || 'Customer'}${first.phone ? ` (${first.phone})` : ''}. Would you like to mark this order for review? This will flag it for merchant review and update any configured review tags in your Shopify store.`
          : `Would you like to mark these ${orders.length} selected orders for review? This will flag them for merchant review and update any configured review tags in your Shopify store.`;
      case 'remove':
        return single && first
          ? `Order number: ${first.number}, Customer: ${first.name || 'Customer'}${first.phone ? ` (${first.phone})` : ''}. Would you like to remove this order from Relay? This will hide it from your Relay workspace. Your Shopify order and store data remain completely unchanged.`
          : `Would you like to remove these ${orders.length} selected orders from Relay? This will hide them from your Relay workspace. Your Shopify orders and store data remain completely unchanged.`;
    }
  };

  const modalConfirmLabel = (action: Action) => {
    switch (action) {
      case 'remove':
        return 'Remove from Relay';
      case 'confirm':
        return 'Confirm order(s)';
      case 'review':
        return 'Mark for review';
      case 'mark_paid':
        return 'Set order status Paid';
      case 'mark_delivered':
        return 'Set status Delivered';
      case 'mark_in_progress':
        return 'Set status In Progress';
      case 'hold':
        return 'Place fulfillment hold';
      case 'release_hold':
        return 'Release hold';
    }
  };

  const activeTabButtonId = `${baseId}-tab-${DAILY_TABS.findIndex((t) => t.id === filter)}`;

  return (
    <>
      <h1 className="sr-only">Orders</h1>
      <section className="panel order-operations-panel compact-sync-panel">
        <div className="order-sync-bar">
          <div className="order-sync-inputs">
            <select
              aria-label="Sync lookback period"
              className="sync-days-select"
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
            <label className="sync-checkbox-label">
              <input
                type="checkbox"
                checked={restoreRemoved}
                disabled={busy || syncing}
                onChange={(e) => setRestoreRemoved(e.target.checked)}
              />
              Restore removed orders
            </label>
            <span className="order-sync-status muted" role="status">
              {syncError ||
                status?.sync.error ||
                (syncing
                  ? 'Syncing with Shopify…'
                  : status?.sync.lastSuccessAt
                    ? 'Last sync: ' + new Date(status.sync.lastSuccessAt).toLocaleString()
                    : 'No completed sync yet')}
            </span>
          </div>
          <button
            type="button"
            className="button primary compact-sync-btn"
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
            <RefreshCw size={14} className={syncing ? 'spin' : undefined} />
            {syncing ? 'Syncing…' : 'Sync from Shopify'}
          </button>
        </div>
        {!w.integration.hasShopifyToken && (
          <p className="sync-warn muted">Connect Shopify in Integrations before synchronizing.</p>
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
            <div className="order-bulk-left">
              <strong>
                {selected.size ? selected.size + ' selected across pages' : 'Select orders'}
              </strong>
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
                  onClick={() => {
                    setSelected(new Set());
                    setActionsOpen(false);
                  }}
                >
                  Clear selection
                </button>
              )}
            </div>
            <div className="order-bulk-actions">
              <button
                type="button"
                className="button primary"
                disabled={busy || !selected.size}
                onClick={() => {
                  setActionsOpen(false);
                  choose('confirm');
                }}
              >
                <Check size={16} />
                Confirm selected
              </button>
              <div className="bulk-dropdown-container" ref={actionsRef}>
                <button
                  type="button"
                  className="button secondary dropdown-toggle"
                  disabled={busy || !selected.size}
                  aria-haspopup="menu"
                  aria-expanded={actionsOpen}
                  onClick={() => setActionsOpen((v) => !v)}
                >
                  Actions
                  <ChevronDown size={14} />
                </button>
                {actionsOpen && selected.size > 0 && (
                  <div className="bulk-actions-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      className="bulk-menu-item"
                      onClick={() => {
                        setActionsOpen(false);
                        choose('mark_paid');
                      }}
                    >
                      Mark paid
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="bulk-menu-item"
                      onClick={() => {
                        setActionsOpen(false);
                        choose('mark_in_progress');
                      }}
                    >
                      In progress
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="bulk-menu-item"
                      onClick={() => {
                        setActionsOpen(false);
                        choose('hold');
                      }}
                    >
                      Hold
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="bulk-menu-item"
                      onClick={() => {
                        setActionsOpen(false);
                        choose('release_hold');
                      }}
                    >
                      Release hold
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="bulk-menu-item"
                      onClick={() => {
                        setActionsOpen(false);
                        choose('mark_delivered');
                      }}
                    >
                      Mark delivered
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="bulk-menu-item"
                      onClick={() => {
                        setActionsOpen(false);
                        choose('review');
                      }}
                    >
                      Mark for review
                    </button>
                    <div className="bulk-menu-divider" role="separator" />
                    <button
                      type="button"
                      role="menuitem"
                      className="bulk-menu-item danger"
                      onClick={() => {
                        setActionsOpen(false);
                        choose('remove');
                      }}
                    >
                      Remove selected
                    </button>
                  </div>
                )}
              </div>
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
          title={
            showWarningStep
              ? 'Warning: Confirm Payment for Undelivered Orders'
              : modalTitle(pending.action, pending.count)
          }
          subtitle={
            showWarningStep
              ? 'Action requires explicit merchant confirmation'
              : pending.all
                ? 'All currently visible orders'
                : 'Selected order details'
          }
          close={() => {
            if (!busy) {
              setPending(undefined);
              setShowWarningStep(false);
            }
          }}
        >
          {showWarningStep ? (
            <div>
              <div
                style={{
                  display: 'flex',
                  gap: '12px',
                  background: '#fef2f2',
                  border: '1px solid #ef4444',
                  borderRadius: '8px',
                  padding: '14px 16px',
                  marginBottom: '16px',
                  color: '#991b1b',
                  fontSize: '13px',
                  lineHeight: '1.5',
                }}
              >
                <AlertTriangle size={22} style={{ color: '#dc2626', flexShrink: 0, marginTop: '2px' }} />
                <div>
                  <div style={{ fontWeight: 600, marginBottom: '4px' }}>
                    Warning: Order(s) Not Yet Delivered
                  </div>
                  <div>
                    {undeliveredOrders.length === 1
                      ? `Order ${undeliveredOrders[0].number} is in "${undeliveredOrders[0].delivery}" state and has not been marked Delivered yet.`
                      : `The following orders are not delivered yet: ${undeliveredOrders.map((o) => `${o.number} (${o.delivery})`).join(', ')}.`}
                  </div>
                  <div style={{ marginTop: '8px', fontWeight: 500 }}>
                    {alsoMarkDelivered
                      ? 'Are you sure you want to proceed? Relay will set the status to Paid AND mark fulfillment as Delivered directly in Shopify and Relay.'
                      : 'Are you sure you want to proceed? Relay will mark the order as Paid in Shopify, while fulfillment will remain in its current state.'}
                  </div>
                </div>
              </div>
              <div className="drawer-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setShowWarningStep(false)}
                >
                  Go back
                </button>
                <button
                  type="button"
                  className="button primary"
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
                          alsoMarkDelivered,
                        });
                        if (mode === 'demo' && SHOPIFY_BULK_ACTIONS.has(action)) {
                          await api('/jobs/run', {});
                        }
                        setSelected(new Set());
                        setPending(undefined);
                        setShowWarningStep(false);
                        return res.message;
                      },
                      alsoMarkDelivered
                        ? 'Orders marked as Delivered and Paid in Shopify.'
                        : 'Orders marked as Paid in Shopify.',
                    )
                  }
                >
                  {busy
                    ? 'Processing…'
                    : alsoMarkDelivered
                      ? 'Yes, Mark Delivered & Paid'
                      : 'Yes, Mark Paid'}
                </button>
              </div>
            </div>
          ) : (
            <div>
              {pending.action === 'mark_paid' && undeliveredOrders.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    gap: '12px',
                    background: '#fffbeb',
                    border: '1px solid #f59e0b',
                    borderRadius: '8px',
                    padding: '12px 14px',
                    marginBottom: '16px',
                    color: '#92400e',
                    fontSize: '13px',
                    lineHeight: '1.45',
                  }}
                >
                  <AlertTriangle size={20} style={{ color: '#d97706', flexShrink: 0, marginTop: '2px' }} />
                  <div>
                    <div style={{ fontWeight: 600 }}>Delivery Warning</div>
                    <div>
                      {undeliveredOrders.length === 1
                        ? `Order ${undeliveredOrders[0].number} is in "${undeliveredOrders[0].delivery}" state and has not been marked Delivered yet.`
                        : `${undeliveredOrders.length} order(s) (${undeliveredOrders.map((o) => `${o.number} [${o.delivery}]`).join(', ')}) have not been marked Delivered yet.`}
                    </div>
                    <div style={{ marginTop: '4px' }}>
                      In Cash on Delivery (COD) workflows, payment is collected upon customer delivery.
                    </div>
                  </div>
                </div>
              )}

              <div
                style={{
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  borderRadius: '8px',
                  padding: '12px 14px',
                  marginBottom: '16px',
                  fontSize: '13px',
                }}
              >
                {selectedOrders.length === 1 && selectedOrders[0] ? (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'auto 1fr',
                      gap: '6px 14px',
                      color: '#334155',
                    }}
                  >
                    <span style={{ fontWeight: 600, color: '#64748b' }}>Order:</span>
                    <span style={{ fontWeight: 600 }}>{selectedOrders[0].number}</span>

                    <span style={{ fontWeight: 600, color: '#64748b' }}>Customer:</span>
                    <span>
                      {selectedOrders[0].name || 'Customer'}{' '}
                      {selectedOrders[0].phone ? `(${selectedOrders[0].phone})` : ''}
                    </span>

                    <span style={{ fontWeight: 600, color: '#64748b' }}>Amount:</span>
                    <span>
                      {selectedOrders[0].currency} {selectedOrders[0].amount.toLocaleString()}
                      {selectedOrders[0].paymentMethod ? ` (${selectedOrders[0].paymentMethod})` : ''}
                    </span>

                    <span style={{ fontWeight: 600, color: '#64748b' }}>Fulfillment:</span>
                    <span>{selectedOrders[0].delivery}</span>

                    <span style={{ fontWeight: 600, color: '#64748b' }}>Payment:</span>
                    <span style={{ textTransform: 'capitalize' }}>
                      {selectedOrders[0].financialStatus || 'Pending'}
                    </span>
                  </div>
                ) : (
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: '8px', color: '#475569' }}>
                      Selected Orders ({selectedOrders.length}):
                    </div>
                    <div
                      style={{
                        maxHeight: '140px',
                        overflowY: 'auto',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                      }}
                    >
                      {selectedOrders.slice(0, 6).map((o) => (
                        <div
                          key={o.id}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            fontSize: '12px',
                            padding: '6px 10px',
                            background: '#ffffff',
                            borderRadius: '4px',
                            border: '1px solid #e2e8f0',
                          }}
                        >
                          <span style={{ fontWeight: 600 }}>
                            {o.number} · {o.name || 'Customer'} {o.phone ? `(${o.phone})` : ''}
                          </span>
                          <span style={{ color: '#64748b' }}>
                            {o.delivery} · {o.financialStatus || 'Pending'} · {o.currency}{' '}
                            {o.amount.toLocaleString()}
                          </span>
                        </div>
                      ))}
                      {selectedOrders.length > 6 && (
                        <div
                          style={{
                            color: '#64748b',
                            fontSize: '12px',
                            fontStyle: 'italic',
                            textAlign: 'center',
                            marginTop: '2px',
                          }}
                        >
                          + {selectedOrders.length - 6} more orders
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <p style={{ margin: '0 0 16px', fontSize: '14px', lineHeight: '1.5', color: '#1e293b' }}>
                {promptText(pending.action, selectedOrders)}
              </p>

              {pending.action === 'mark_paid' && undeliveredOrders.length > 0 && (
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    margin: '0 0 16px',
                    fontSize: '13px',
                    fontWeight: 500,
                    cursor: 'pointer',
                    color: '#334155',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={alsoMarkDelivered}
                    onChange={(e) => setAlsoMarkDelivered(e.target.checked)}
                  />
                  <span>
                    Also mark{' '}
                    {undeliveredOrders.length === 1
                      ? `this order (${undeliveredOrders[0].number})`
                      : 'these order(s)'}{' '}
                    as Delivered in Shopify and Relay
                  </span>
                </label>
              )}

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
                  onClick={() => {
                    if (pending.action === 'mark_paid' && undeliveredOrders.length > 0) {
                      setShowWarningStep(true);
                      return;
                    }
                    void act(
                      async () => {
                        const action = pending.action;
                        const res = await api<{ message?: string }>('/orders/bulk', {
                          action,
                          ids: pending.ids,
                          all: pending.all,
                          expectedCount: pending.all ? pending.count : undefined,
                          confirmed: true,
                          alsoMarkDelivered:
                            pending.action === 'mark_paid' ? alsoMarkDelivered : undefined,
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
                    );
                  }}
                >
                  {busy ? 'Processing…' : modalConfirmLabel(pending.action)}
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
