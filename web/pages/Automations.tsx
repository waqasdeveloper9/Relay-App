import {
  ArrowRight,
  BellRing,
  CheckCheck,
  Clock3,
  MessageCircle,
  Package,
  ShieldCheck,
  Workflow,
  Zap,
} from 'lucide-react';
import {
  dispatchSettings,
  hasShopifyScope,
  shopifySyncSettings,
  supportSettings,
} from '../../src/models/workspace-defaults';
import { api, type PublicWorkspace } from '../api';
import { type Act } from '../lib/format';
import { Empty, Toggle } from '../components/ui';

function jobLabel(kind: string): string {
  if (kind.startsWith('SUPPORT_REPLY')) return 'Support reply';
  return (
    {
      CONFIRMATION: 'COD confirmation',
      REMINDER: 'COD reminder',
      TAG: 'Shopify confirmed tag',
      REVIEW_TAG: 'Shopify review tag',
      FULFILLMENT_HOLD: 'Shopify fulfillment hold',
      FULFILLMENT_RELEASE: 'Shopify hold release',
      MARK_PAID: 'Mark order paid in Shopify',
      MARK_IN_PROGRESS: 'Mark fulfillment in progress',
      MARK_OPEN: 'Reopen fulfillment order',
      FULFILL_ORDER: 'Fulfill order in Shopify',
      UPDATE_TRACKING: 'Update Shopify tracking',
      MARK_DELIVERED: 'Mark fulfillment delivered',
      DISPATCH_NOTICE: 'Dispatch WhatsApp notice',
      DELIVERY_NOTICE: 'Delivery WhatsApp notice',
      PAYMENT_NOTICE: 'Payment WhatsApp notice',
      IN_PROGRESS_NOTICE: 'In-progress WhatsApp notice',
      ON_HOLD_NOTICE: 'On-hold WhatsApp notice',
      CANCEL: 'Shopify cancellation',
      CANCEL_TAGS: 'Cancellation tag',
      CANCEL_CLEANUP: 'Cancelled order tag cleanup',
      TEST_CONFIRMATION: 'Test confirmation',
      TEST_HELLO: 'Sample hello',
    }[kind] ?? kind.toLowerCase().replaceAll('_', ' ')
  );
}

function doneJobResult(kind: string): string {
  return (
    {
      CANCEL: 'Shopify cancellation verified',
      TAG: 'Shopify tag updated',
      REVIEW_TAG: 'Shopify tag updated',
      CANCEL_TAGS: 'Shopify tag updated',
      CANCEL_CLEANUP: 'Shopify tag updated',
      FULFILLMENT_HOLD: 'Relay hold applied to Shopify fulfillment order',
      FULFILLMENT_RELEASE: 'Relay hold released in Shopify',
      MARK_PAID: 'Shopify payment marked paid',
      MARK_IN_PROGRESS: 'Shopify fulfillment marked in progress',
      MARK_OPEN: 'Shopify fulfillment reopened (Unfulfilled)',
      FULFILL_ORDER: 'Shopify order fulfilled',
      UPDATE_TRACKING: 'Shopify tracking updated',
      MARK_DELIVERED: 'Shopify delivery event recorded',
    }[kind] ?? 'Meta accepted the message request; delivery not confirmed'
  );
}

export function Automations({
  workspace: w,
  busy,
  act,
}: {
  workspace: PublicWorkspace;
  busy: boolean;
  act: Act;
}) {
  const sync = shopifySyncSettings(w);
  const dispatch = dispatchSettings(w);
  const support = supportSettings(w);
  const holdScopeGranted = hasShopifyScope(
    w.integration,
    'write_merchant_managed_fulfillment_orders',
  );
  const flows = [
    {
      key: 'confirmations' as const,
      icon: CheckCheck,
      title: 'COD order confirmation',
      desc: `Request confirmation after an eligible COD order arrives and apply ${sync.confirmedTag}.`,
      trigger: 'New COD order',
      action: 'Queue WhatsApp template',
      color: 'violet',
    },
    {
      key: 'reminders' as const,
      icon: Clock3,
      title: 'One thoughtful reminder',
      desc: 'Follow up once when a customer has not responded.',
      trigger: `${w.settings.reminderHours} hours without a reply`,
      action: 'Send one reminder',
      color: 'amber',
    },
    {
      key: 'tracking' as const,
      icon: Package,
      title: 'Order tracking & Help menu',
      desc: 'Answer status/tracking questions (COD + Prepaid) by customer phone or Help menu.',
      trigger: 'Greeting or parcel question',
      action: 'Send Help menu or Shopify status',
      color: 'green',
    },
    {
      key: 'faqs' as const,
      icon: MessageCircle,
      title: 'Approved FAQ answers',
      desc: 'Use your saved support information for common questions.',
      trigger: 'Customer asks a policy question',
      action: 'Use approved store information',
      color: 'blue',
    },
  ];
  return (
    <>
      <div className="automation-grid">
        {flows.map((f) => (
          <section key={f.key} className="panel automation-card">
            <div className="automation-top">
              <span className={`automation-icon ${f.color}`}>
                <f.icon size={24} />
              </span>
              <Toggle
                checked={w.settings[f.key]}
                label={`Enable ${f.title}`}
                onChange={() => {
                  if (!busy) {
                    const nextSettings = {
                      ...w.settings,
                      [f.key]: !w.settings[f.key],
                      ...(w.settings.support
                        ? { support: { ...w.settings.support, optedOutPhones: undefined } }
                        : {}),
                    };
                    void act(
                      () => api('/settings', nextSettings, 'PUT'),
                      'Automation preference saved',
                    );
                  }
                }}
              />
            </div>
            <h2>{f.title}</h2>
            <p>{f.desc}</p>
            <div className="flow-step">
              <Zap size={14} />
              <span>{f.trigger}</span>
            </div>
            <div className="flow-connector" />
            <div className="flow-step">
              <ArrowRight size={14} />
              <span>{f.action}</span>
            </div>
            <div className="automation-status">
              <span className={`small-dot ${w.settings[f.key] ? 'green' : 'amber'}`} />
              {w.settings[f.key] ? 'Enabled' : 'Paused'}
            </div>
          </section>
        ))}
      </div>
      <div className="automation-subgrid">
        <section className="panel automation-card">
          <div className="automation-top">
            <span className="automation-icon amber">
              <ShieldCheck size={22} />
            </span>
            <span className={`pill ${holdScopeGranted ? 'green' : ''}`}>
              {holdScopeGranted ? 'Hold scope granted' : 'Optional hold scope needed'}
            </span>
          </div>
          <h2>Shopify holds &amp; review tags</h2>
          <p>
            Tags: <strong>{sync.confirmedTag}</strong> on confirm
            {sync.tagOnReview ? `, ${sync.reviewTag} on review` : ''}. Holds:{' '}
            {[
              sync.autoHoldUnconfirmed && 'unconfirmed COD',
              sync.holdOnReview && 'needs review',
              sync.holdOnCancellationRequest && 'cancellation requests',
            ]
              .filter(Boolean)
              .join(', ') || 'off (configure in Settings)'}
            .
          </p>
        </section>
        <section className="panel automation-card">
          <div className="automation-top">
            <span className="automation-icon green">
              <BellRing size={22} />
            </span>
            <span
              className={`pill ${
                dispatch.enabled ||
                dispatch.deliveredEnabled ||
                dispatch.paidEnabled ||
                dispatch.inProgressEnabled ||
                dispatch.onHoldEnabled
                  ? 'green'
                  : ''
              }`}
            >
              {dispatch.enabled ||
              dispatch.deliveredEnabled ||
              dispatch.paidEnabled ||
              dispatch.inProgressEnabled ||
              dispatch.onHoldEnabled
                ? 'Active'
                : 'Configure in Integrations'}
            </span>
          </div>
          <h2>Proactive order stage notices</h2>
          <p>
            Dispatch: {dispatch.enabled ? dispatch.templateName || 'Unset' : 'Paused'} · Delivery:{' '}
            {dispatch.deliveredEnabled ? dispatch.deliveredTemplateName || 'Unset' : 'Paused'} ·
            Paid: {dispatch.paidEnabled ? dispatch.paidTemplateName || 'Unset' : 'Paused'} · In
            progress:{' '}
            {dispatch.inProgressEnabled ? dispatch.inProgressTemplateName || 'Unset' : 'Paused'} ·
            Hold: {dispatch.onHoldEnabled ? dispatch.onHoldTemplateName || 'Unset' : 'Paused'}.
          </p>
        </section>
        <section className="panel automation-card">
          <div className="automation-top">
            <span className="automation-icon blue">
              <Package size={22} />
            </span>
            <span className="pill green">{support.optedOutPhones.length} opted out</span>
          </div>
          <h2>Prepaid sync &amp; opt-out rules</h2>
          <p>
            Non-COD orders:{' '}
            {sync.importNonCodOrders ? 'imported for tracking & delivery alerts' : 'ignored'}.
            Customers texting <strong>{support.optOutKeywords[0] ?? 'STOP'}</strong> stop all
            automated messages immediately.
          </p>
        </section>
      </div>
      <section className="panel jobs-panel">
        <div className="panel-heading">
          <div>
            <h2>Execution log</h2>
            <p>Every queued action and its outcome.</p>
          </div>
          <span className="pill">{w.jobs.length} jobs</span>
        </div>
        {w.jobs.length ? (
          <div className="job-list">
            {w.jobs
              .slice()
              .reverse()
              .map((j) => (
                <div key={j.id}>
                  <span className="soft-icon">
                    <Workflow size={17} />
                  </span>
                  <div>
                    <strong>
                      {jobLabel(j.kind)} ·{' '}
                      {w.orders.find((o) => o.id === j.orderId)?.number ?? 'General support'}
                    </strong>
                    <small>
                      {j.error ??
                        (j.messageId?.startsWith('demo-')
                          ? 'Simulated execution — nothing sent externally'
                          : j.state === 'DONE'
                            ? doneJobResult(j.kind)
                            : j.state === 'UNKNOWN'
                              ? 'Outcome unconfirmed with provider; waiting for reconciliation'
                              : `Scheduled ${new Date(j.dueAt).toLocaleString()}`)}
                    </small>
                  </div>
                  <span className={`pill ${j.state === 'DONE' ? 'green' : ''}`}>
                    {j.state.toLowerCase()}
                  </span>
                  {j.state === 'FAILED' && j.attempts < 8 && (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy}
                      onClick={() => {
                        void act(() => api(`/jobs/${j.id}/retry`, {}), 'Retry scheduled');
                      }}
                    >
                      Retry
                    </button>
                  )}
                </div>
              ))}
          </div>
        ) : (
          <Empty
            title="No executions yet"
            detail="Run a test workflow to see how actions move through the queue."
          />
        )}
      </section>
    </>
  );
}
