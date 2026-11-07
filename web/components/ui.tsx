import React, { useEffect, useRef } from 'react';
import { ArrowUpRight, MoreHorizontal, Package, X, Zap, AlertCircle } from 'lucide-react';
import type { Order, OutboundMessage } from '../../src/models/types';
import { money, initials, statusLabels, time } from '../lib/format';

export function Badge({ status }: { status: Order['status'] }) {
  return (
    <span className={`badge ${status.toLowerCase()}`}>
      <span />
      {statusLabels[status]}
    </span>
  );
}

export function Logo({ small = false }: { small?: boolean }) {
  return (
    <div className={`logo ${small ? 'small' : ''}`}>
      <span className="logo-symbol">
        <Zap size={21} fill="currentColor" />
      </span>
      {!small && (
        <>
          relay<span className="logo-dot">.</span>
        </>
      )}
    </div>
  );
}

export function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty">
      <Package size={30} />
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      className={`toggle ${checked ? 'on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
    >
      <span />
    </button>
  );
}

export function Toast({ value, dismiss }: { value: string; dismiss: () => void }) {
  return value ? (
    <div className="toast" role="status">
      <AlertCircle size={18} />
      <span>{value}</span>
      <button className="icon-button" aria-label="Dismiss notification" onClick={dismiss}>
        <X size={16} />
      </button>
    </div>
  ) : null;
}

export function Stat({
  title,
  value,
  icon: Icon,
  detail,
  color,
  points,
}: {
  title: string;
  value: string;
  icon: typeof Package;
  detail: string;
  color: string;
  points: string;
}) {
  return (
    <div className="stat-card">
      <div className="stat-top">
        <span>{title}</span>
        <span className={`stat-icon ${color}`}>
          <Icon size={17} />
        </span>
      </div>
      <div className="stat-value">
        <strong>{value}</strong>
        <svg viewBox="0 0 72 38" className={`sparkline ${color}`} aria-hidden="true">
          <polyline
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className="stat-detail">
        <span className={`small-dot ${color}`} />
        {detail}
      </div>
    </div>
  );
}

export function ActivityChart({ orders }: { orders: Order[] }) {
  const now = Date.now();
  const slots = 7;
  const span = 24 * 3600000;
  const buckets = Array.from({ length: slots }, (_, i) =>
    orders.filter((o) => {
      const age = now - Date.parse(o.createdAt);
      return age >= (span * (slots - 1 - i)) / slots && age < (span * (slots - i)) / slots;
    }),
  );
  const max = Math.max(4, ...buckets.map((b) => b.length));
  const path = (confirmed: boolean) =>
    buckets
      .map(
        (b, i) =>
          `${i ? 'L' : 'M'} ${54 + i * 80} ${166 - ((confirmed ? b.filter((o) => o.status === 'CONFIRMED').length : b.length) / max) * 128}`,
      )
      .join(' ');
  return (
    <div className="chart-wrap">
      <svg
        viewBox="0 0 590 213"
        role="img"
        aria-label="Orders and confirmed orders grouped into seven time periods over the last 24 hours"
      >
        <defs>
          <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8b7bf0" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#8b7bf0" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line
              x1="54"
              y1={38 + i * 32}
              x2="534"
              y2={38 + i * 32}
              stroke="#edf0f4"
              strokeDasharray="3 5"
            />
            <text x="27" y={42 + i * 32} fill="#9298a4" fontSize="10">
              {Math.round((max * (4 - i)) / 4)}
            </text>
          </g>
        ))}
        <path d={`${path(false)} L 534 166 L 54 166 Z`} fill="url(#chartFill)" />
        <path
          d={path(false)}
          fill="none"
          stroke="#8270e7"
          strokeWidth="2.6"
          strokeLinejoin="round"
        />
        <path
          d={path(true)}
          fill="none"
          stroke="#6ac4a5"
          strokeWidth="2.6"
          strokeLinejoin="round"
        />
        {buckets.map((_, i) => (
          <text key={i} x={54 + i * 80} y="197" fill="#9298a4" fontSize="10" textAnchor="middle">
            {new Date(now - (span * (slots - 1 - i)) / slots).toLocaleTimeString('en', {
              hour: 'numeric',
            })}
          </text>
        ))}
      </svg>
    </div>
  );
}

export function OrderTable({
  orders,
  onSelect,
  messages,
  selectedIds,
  onToggle,
  onTogglePage,
  selectionDisabled,
}: {
  selectedIds?: ReadonlySet<string>;
  onToggle?: (id: string) => void;
  onTogglePage?: () => void;
  selectionDisabled?: boolean;
  messages?: OutboundMessage[];
  orders: Order[];
  onSelect: (o: Order) => void;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {selectedIds && (
              <th className="order-checkbox-cell">
                <input
                  type="checkbox"
                  aria-label="Select all orders on this page"
                  disabled={selectionDisabled || !orders.length}
                  checked={!!orders.length && orders.every((o) => selectedIds.has(o.id))}
                  ref={(el) => {
                    if (el)
                      el.indeterminate =
                        orders.some((o) => selectedIds.has(o.id)) &&
                        !orders.every((o) => selectedIds.has(o.id));
                  }}
                  onChange={onTogglePage}
                />
              </th>
            )}
            <th>Order</th>
            <th>Customer</th>
            <th>Amount</th>
            <th>Confirmation</th>
            {messages && <th>WhatsApp</th>}
            <th>Fulfillment</th>
            <th>Received</th>
            <th>
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o, i) => (
            <tr
              key={o.id}
              className={selectedIds?.has(o.id) ? 'order-selected' : undefined}
              onClick={() => onSelect(o)}
            >
              {selectedIds && (
                <td className="order-checkbox-cell" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={'Select order ' + o.number}
                    disabled={selectionDisabled}
                    checked={selectedIds.has(o.id)}
                    onChange={() => onToggle?.(o.id)}
                  />
                </td>
              )}
              <td>
                <button
                  className="order-number"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(o);
                  }}
                >
                  {o.number}
                  <ArrowUpRight size={12} />
                </button>
              </td>
              <td>
                <div className="customer-cell">
                  <span className={`avatar ${['purple', 'peach', 'blue', 'mint'][i % 4]}`}>
                    {initials(o.name)}
                  </span>
                  <div>
                    <strong>{o.name}</strong>
                    <small>{o.phone ? `+${o.phone}` : 'No phone recorded'}</small>
                  </div>
                </div>
              </td>
              <td className="amount-cell">
                {money(o.amount, o.currency)}
                <small>Cash on delivery</small>
              </td>
              <td>
                <Badge status={o.status} />
              </td>
              {messages && (
                <td>
                  {(() => {
                    const m = messages.find(
                      (m) => m.orderId === o.id && m.kind !== 'SUPPORT_REPLY',
                    );
                    return (
                      <>
                        <span
                          className={'message-status ' + (m?.status.toLowerCase() ?? '')}
                          title={
                            m?.error ??
                            o.messageBlockedReason ??
                            'No tracked outgoing message for this order'
                          }
                        >
                          {m
                            ? m.status === 'ACCEPTED'
                              ? 'Meta accepted'
                              : m.status.toLowerCase()
                            : o.messageBlockedReason
                              ? 'Not sent'
                              : 'Not sent yet'}
                        </span>
                        {!m && o.messageBlockedReason && (
                          <small style={{ display: 'block', maxWidth: 260, whiteSpace: 'normal' }}>
                            {o.messageBlockedReason}
                          </small>
                        )}
                      </>
                    );
                  })()}
                </td>
              )}
              <td>
                <span
                  className={`fulfillment ${o.delivery === 'In transit' ? 'transit' : o.delivery === 'Delivered' ? 'delivered' : ''}`}
                >
                  <span />
                  {o.delivery}
                </span>
              </td>
              <td className="time-cell">{time(o.createdAt)}</td>
              <td>
                <button className="icon-button" aria-label={`View order ${o.number}`}>
                  <MoreHorizontal size={18} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!orders.length && (
        <Empty
          title="No orders here yet"
          detail="Try a different filter, or check your Shopify connection and order webhooks."
        />
      )}
    </div>
  );
}

export function Modal({
  title,
  subtitle,
  close,
  children,
}: {
  title: string;
  subtitle: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const container = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const original = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        container.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]',
        ) ?? [],
      );
    focusables()[0]?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key !== 'Tab') return;
      const list = focusables();
      const first = list[0];
      const last = list.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', listener);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', listener);
      document.body.style.overflow = previous;
      original?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section ref={container} className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <button className="icon-button modal-close" aria-label="Close dialog" onClick={close}>
          <X size={20} />
        </button>
        <h2>{title}</h2>
        <p className="modal-subtitle">{subtitle}</p>
        {children}
      </section>
    </div>
  );
}
