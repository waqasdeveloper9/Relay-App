import { useState } from 'react';
import { api, type PublicWorkspace } from '../api';
import type { Act } from '../lib/format';

const KIND_LABELS: Record<string, string> = {
  CONFIRMATION: 'Order confirmation',
  REMINDER: 'COD reminder',
  DISPATCH_NOTICE: 'Dispatch notice',
  DELIVERY_NOTICE: 'Delivery notice',
  PAYMENT_NOTICE: 'Payment notice',
  IN_PROGRESS_NOTICE: 'In-progress notice',
  ON_HOLD_NOTICE: 'On-hold notice',
  TEST_CONFIRMATION: 'Order test',
  TEST_HELLO: 'Sample test',
  INBOX_REPLY: 'Inbox reply',
  SUPPORT_MENU: 'Support menu',
  SUPPORT_REPLY: 'Support reply',
  SAMPLE: 'Sample test',
};

export function Messages({
  workspace: w,
  metaWebhookConfigured,
  busy,
  act,
}: {
  workspace: PublicWorkspace;
  metaWebhookConfigured: boolean;
  busy: boolean;
  act: Act;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('ALL');
  const [page, setPage] = useState(0);
  const messages = [...(w.outboundMessages ?? [])]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .filter(
      (m) =>
        (filter === 'ALL' || m.status === filter) &&
        ([
          m.recipient,
          m.templateName,
          w.orders.find((o) => o.id === m.orderId)?.number ?? '',
          KIND_LABELS[m.kind] ?? m.kind,
        ]
          .join(' ')
          .toLowerCase()
          .includes(search.trim().toLowerCase()) ||
          (/^[+\d\s().-]+$/.test(search.trim()) &&
            m.recipient.replace(/\D/g, '').includes(search.replace(/\D/g, '').replace(/^0+/, '')))),
    );
  return (
    <>
      <p className="message-help muted">
        Accepted means Meta received the request; delivery is tracked separately.
        {!metaWebhookConfigured && ' Complete Meta webhook setup for delivery updates.'}
      </p>
      <section className="panel">
        <search className="table-toolbar message-filters">
          <div className="field">
            <label htmlFor="msg-search">Search messages</label>
            <input
              id="msg-search"
              type="search"
              name="messageQuery"
              value={search}
              placeholder="Order, type, recipient, or template"
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="msg-status">Status</label>
            <select
              id="msg-status"
              name="status"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setPage(0);
              }}
            >
              {['ALL', 'SENDING', 'ACCEPTED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'UNKNOWN'].map(
                (s) => (
                  <option key={s} value={s}>
                    {s === 'ACCEPTED' ? 'Meta accepted' : s}
                  </option>
                ),
              )}
            </select>
          </div>
        </search>
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Outbound messages table"
        >
          <table>
            <caption className="sr-only">Tracked outbound WhatsApp messages</caption>
            <thead>
              <tr>
                <th scope="col">Created</th>
                <th scope="col">Order / type</th>
                <th scope="col">Recipient</th>
                <th scope="col">Template</th>
                <th scope="col">Status</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {messages.slice(page * 20, page * 20 + 20).map((m) => {
                const orderNum = w.orders.find((o) => o.id === m.orderId)?.number;
                const kindLabel = KIND_LABELS[m.kind] ?? 'Message';
                return (
                  <tr key={m.id}>
                    <th scope="row">{new Date(m.createdAt).toLocaleString()}</th>
                    <td>
                      {orderNum ? (
                        <>
                          {orderNum}
                          {[
                            'DISPATCH_NOTICE',
                            'DELIVERY_NOTICE',
                            'PAYMENT_NOTICE',
                            'IN_PROGRESS_NOTICE',
                            'ON_HOLD_NOTICE',
                          ].includes(m.kind) && (
                            <small className="tracking-snippet">{kindLabel}</small>
                          )}
                        </>
                      ) : m.orderId ? (
                        `Removed order (${kindLabel})`
                      ) : (
                        kindLabel
                      )}
                    </td>
                    <td>+{m.recipient}</td>
                    <td>
                      {m.templateName ? (
                        <>
                          {m.templateName}
                          <small className="muted"> / {m.languageCode}</small>
                        </>
                      ) : (
                        <span className="muted">
                          {m.kind === 'SUPPORT_MENU' ? 'Interactive menu' : 'Free-form text'}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={'message-status ' + m.status.toLowerCase()}>
                        {m.status === 'ACCEPTED' ? 'Meta accepted' : m.status.toLowerCase()}
                      </span>
                    </td>
                    <td>
                      <details>
                        <summary>View message</summary>
                        <p className="message-preview">{m.preview}</p>
                        {m.error && <p role="alert">{m.error}</p>}
                        {m.status === 'FAILED' && m.jobId && (
                          <button
                            type="button"
                            className="button secondary"
                            disabled={busy}
                            onClick={() => {
                              void act(
                                () => api('/messages/' + m.id + '/retry', {}),
                                'Retry scheduled after eligibility checks',
                              );
                            }}
                          >
                            Retry failed message
                          </button>
                        )}
                        <small>
                          Message ID: {m.messageId ?? 'Not returned'}
                          <br />
                          Last update: {new Date(m.updatedAt).toLocaleString()}
                        </small>
                      </details>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!messages.length && (
            <div className="empty">
              <h3>No tracked messages yet</h3>
              <p>New samples and order-message attempts will appear here.</p>
            </div>
          )}
        </div>
        <div className="table-pagination">
          <span>{messages.length} messages</span>
          <div>
            <button
              type="button"
              className="button secondary"
              disabled={!page}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={(page + 1) * 20 >= messages.length}
              onClick={() => setPage(page + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
