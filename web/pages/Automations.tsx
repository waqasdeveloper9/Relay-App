import {
  ArrowRight,
  CheckCheck,
  Clock3,
  MessageCircle,
  Package,
  Workflow,
  Zap,
} from 'lucide-react';
import { api, type PublicWorkspace } from '../api';
import { type Act } from '../lib/format';
import { Empty, Toggle } from '../components/ui';

export function Automations({
  workspace: w,
  busy,
  act,
}: {
  workspace: PublicWorkspace;
  busy: boolean;
  act: Act;
}) {
  const flows = [
    {
      key: 'confirmations' as const,
      icon: CheckCheck,
      title: 'COD order confirmation',
      desc: 'Request confirmation after an eligible COD order arrives.',
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
      title: 'Order tracking assistance',
      desc: 'Answer tracking questions with the available order status.',
      trigger: 'Customer asks about a parcel',
      action: 'Look up order information',
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
                  if (!busy)
                    void act(
                      () => api('/settings', { ...w.settings, [f.key]: !w.settings[f.key] }, 'PUT'),
                      'Automation preference saved',
                    );
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
                      {j.kind.toLowerCase().replace('_', ' ')} ·{' '}
                      {w.orders.find((o) => o.id === j.orderId)?.number ?? 'General support'}
                    </strong>
                    <small>
                      {j.error ??
                        (j.messageId?.startsWith('demo-')
                          ? 'Simulated execution — nothing sent externally'
                          : j.state === 'DONE'
                            ? j.kind === 'CANCEL'
                              ? 'Shopify cancellation verified'
                              : j.kind === 'TAG'
                                ? 'Shopify tag applied'
                                : 'Meta accepted the message request; delivery not confirmed'
                            : `Scheduled ${new Date(j.dueAt).toLocaleString()}`)}
                    </small>
                  </div>
                  <span className={`pill ${j.state === 'DONE' ? 'green' : ''}`}>
                    {j.state.toLowerCase()}
                  </span>
                  {j.state === 'FAILED' && j.attempts < 8 && (
                    <button
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
