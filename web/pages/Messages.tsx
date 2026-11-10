import { useState } from 'react';
import { api, type PublicWorkspace } from '../api';
import type { Act } from '../lib/format';
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
          w.orders.find((o) => o.id === m.orderId)?.number ??
            (m.kind === 'INBOX_REPLY'
              ? 'Inbox reply'
              : m.kind === 'SUPPORT_MENU'
                ? 'Support menu'
                : m.kind === 'SUPPORT_REPLY'
                  ? 'Support reply'
                  : 'Sample'),
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
        <div className="table-toolbar message-filters">
          <label className="field">
            <span>Search messages</span>
            <input
              value={search}
              placeholder="Order, recipient, or template"
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
            />
          </label>
          <label className="field">
            <span>Status</span>
            <select
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
          </label>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Created</th>
                <th>Order / type</th>
                <th>Recipient</th>
                <th>Template</th>
                <th>Status</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {messages.slice(page * 20, page * 20 + 20).map((m) => (
                <tr key={m.id}>
                  <td>{new Date(m.createdAt).toLocaleString()}</td>
                  <td>
                    {w.orders.find((o) => o.id === m.orderId)?.number ??
                      (m.orderId
                        ? 'Removed order'
                        : m.kind === 'INBOX_REPLY'
                          ? 'Inbox reply'
                          : m.kind === 'SUPPORT_MENU'
                            ? 'Support menu'
                            : m.kind === 'SUPPORT_REPLY'
                              ? 'Support reply'
                              : 'Sample test')}
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
              ))}
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
            <button className="button secondary" disabled={!page} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <button
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
