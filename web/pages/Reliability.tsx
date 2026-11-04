import { useEffect, useState, useRef } from 'react';
import { api, type Snapshot } from '../api';
import type { ReliabilitySettings } from '../../src/models/types';
import type { Act } from '../lib/format';
interface Status {
  settings: ReliabilitySettings;
  sync: {
    checkpoint: string | null;
    lastSuccessAt: string | null;
    nextRunAt: string;
    error: string | null;
    recovering: boolean;
  };
  inbox: { state: string; _count: number }[];
}
export function Reliability({ data, busy, act }: { data: Snapshot; busy: boolean; act: Act }) {
  const initialized = useRef(false);
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState('');
  const [form, setForm] = useState<ReliabilitySettings>();
  const [testEnabled, setTestEnabled] = useState(false);
  const [ownNumberConfirmed, setOwnNumberConfirmed] = useState(false);
  const [recipient, setRecipient] = useState(data.workspace.settings.testRecipient ?? '');
  useEffect(() => {
    const load = () =>
      void api<Status>('/reliability')
        .then((r) => {
          setStatus(r);
          setForm((f) => f ?? r.settings);
          if (!initialized.current) {
            setTestEnabled(
              !!r.settings.testMode && Date.parse(r.settings.testMode.until) > Date.now(),
            );
            initialized.current = true;
          }
        })
        .catch((e) => setError(e.message));
    load();
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, [data.merchant.id]);
  if (!form || !status)
    return (
      <section className="panel integration-test-panel">
        {error || 'Loading recovery settings…'}
      </section>
    );
  const setNumber = (
    key: 'syncIntervalMinutes' | 'initialLookbackDays' | 'maxMessageAgeHours',
    value: string,
  ) => setForm({ ...form, [key]: Number(value) });
  const blocked = data.workspace.orders.filter((o) => o.messageBlockedReason);
  return (
    <>
      <section className="panel integration-test-panel">
        <h2>Shopify recovery</h2>
        <p>
          Incoming events are stored before processing. Catch-up synchronization retrieves changed
          orders from the saved checkpoint and safely merges them without duplicate orders.
        </p>
        <p>
          Last completed page:{' '}
          {status.sync.lastSuccessAt
            ? new Date(status.sync.lastSuccessAt).toLocaleString()
            : 'Not yet'}{' '}
          · Checkpoint:{' '}
          {status.sync.checkpoint
            ? new Date(status.sync.checkpoint).toLocaleString()
            : 'Initial catch-up pending'}
        </p>
        <p>
          {status.sync.recovering ? 'Recovery in progress' : 'Waiting for next scheduled sync'} ·{' '}
          {status.inbox.map((v) => v.state + ': ' + v._count).join(' · ')}
        </p>
        {status.sync.error && <p role="alert">{status.sync.error}</p>}
        <div className="integration-quick-actions">
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void act(() => api('/reliability/sync', {}), 'Catch-up sync scheduled')}
          >
            Sync Shopify now
          </button>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() =>
              void act(
                () => api('/reliability/retry-incoming', {}),
                'Failed incoming events queued',
              )
            }
          >
            Retry failed incoming events
          </button>
        </div>
      </section>
      <section className="panel integration-test-panel">
        <h2>Recovery and order messaging settings</h2>
        <label className="integration-test-consent">
          <input
            type="checkbox"
            checked={form.syncEnabled}
            onChange={(e) => setForm({ ...form, syncEnabled: e.target.checked })}
          />
          Enable scheduled Shopify catch-up
        </label>
        <div className="form-row">
          <label className="field">
            <span>Sync interval (minutes)</span>
            <input
              type="number"
              min="1"
              max="60"
              value={form.syncIntervalMinutes}
              onChange={(e) => setNumber('syncIntervalMinutes', e.target.value)}
            />
          </label>
          <label className="field">
            <span>Initial lookback (days)</span>
            <input
              type="number"
              min="1"
              max="60"
              value={form.initialLookbackDays}
              onChange={(e) => setNumber('initialLookbackDays', e.target.value)}
            />
          </label>
          <label className="field">
            <span>Maximum order age for messaging (hours)</span>
            <input
              type="number"
              min="1"
              max="72"
              value={form.maxMessageAgeHours}
              onChange={(e) => setNumber('maxMessageAgeHours', e.target.value)}
            />
          </label>
        </div>
        <label className="field">
          <span>Messages for recovered orders</span>
          <select
            value={form.recoveryMessaging}
            onChange={(e) =>
              setForm({
                ...form,
                recoveryMessaging: e.target.value as ReliabilitySettings['recoveryMessaging'],
              })
            }
          >
            <option value="REVIEW">Review before sending</option>
            <option value="SEND_ELIGIBLE">Queue eligible recent orders automatically</option>
          </select>
        </label>
        <p>
          Every send checks order eligibility, messaging permission, active automation and
          subscription, and the current saved template. Paid, fulfilled, cancelled, or stale orders
          are excluded. Uncertain send outcomes require reconciliation before resending.
        </p>
        <label className="integration-test-consent">
          <input
            type="checkbox"
            checked={testEnabled}
            onChange={(e) => {
              setTestEnabled(e.target.checked);
              setOwnNumberConfirmed(false);
            }}
          />
          Enable an order-triggered test for my own verified number for 24 hours
        </label>
        {testEnabled && (
          <>
            <label className="field">
              <span>Owned Meta-verified recipient</span>
              <input
                type="tel"
                value={recipient}
                onChange={(e) => {
                  setRecipient(e.target.value);
                  setOwnNumberConfirmed(false);
                }}
              />
            </label>
            <label className="integration-test-consent">
              <input
                type="checkbox"
                checked={ownNumberConfirmed}
                onChange={(e) => setOwnNumberConfirmed(e.target.checked)}
              />
              I own this number, verified it in Meta, and authorize order test messages to it.
            </label>
            <p>
              Uses the saved template: {data.workspace.integration.templateName} /{' '}
              {data.workspace.integration.languageCode}. Saving renews the test for 24 hours.
            </p>
          </>
        )}
        <button
          className="button primary"
          disabled={busy || (testEnabled && !ownNumberConfirmed)}
          onClick={() =>
            void act(
              () =>
                api(
                  '/reliability/settings',
                  { ...form, testEnabled, testRecipient: recipient, ownNumberConfirmed },
                  'PUT',
                ),
              'Recovery settings saved',
            )
          }
        >
          Save recovery settings
        </button>
      </section>
      <section className="panel integration-test-panel">
        <h2>Notifications</h2>
        {!(data.workspace.notifications ?? []).length && <p>No processing failures recorded.</p>}
        {(data.workspace.notifications ?? []).map((n) => (
          <div className="notice" key={n.id}>
            <strong>
              {n.title} {n.resolvedAt ? '— resolved' : ''}
            </strong>
            <p>{n.detail}</p>
            <p>{n.action}</p>
            <small>{new Date(n.updatedAt).toLocaleString()}</small>
            {!n.readAt && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void act(
                    () => api('/notifications/' + n.id + '/read', {}),
                    'Notification marked read',
                  )
                }
              >
                Mark read
              </button>
            )}
          </div>
        ))}
      </section>
      <section className="panel integration-test-panel">
        <h2>Orders without a queued confirmation</h2>
        {!blocked.length && <p>No blocked orders.</p>}
        {blocked.map((o) => (
          <div className="notice" key={o.id}>
            <strong>{o.number}</strong>
            <p>{o.messageBlockedReason}</p>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void act(
                  () => api('/orders/' + o.id + '/queue-confirmation', {}),
                  'Eligible order queued',
                )
              }
            >
              Recheck and queue this order
            </button>
          </div>
        ))}
      </section>
    </>
  );
}
