import { customerConversations } from '../src/models/customer-conversations';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Bell,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Clock3,
  FlaskConical,
  Inbox,
  LayoutDashboard,
  LifeBuoy,
  Link2,
  Loader2,
  LogOut,
  Menu,
  MessageCircle,
  Package,
  Settings2,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Users,
  Workflow,
  X,
  BarChart3,
  LockKeyhole,
} from 'lucide-react';
import { api, type Snapshot } from './api';
import type { Order, Page } from '../src/models/types';
import { initials, time } from './lib/format';
import { Logo, Toast, Stat, ActivityChart, OrderTable, Modal } from './components/ui';
import { OrderDrawer } from './components/OrderDrawer';
import { Reliability } from './pages/Reliability';
import { Messages } from './pages/Messages';
import { Orders } from './pages/Orders';
import { InboxView } from './pages/InboxView';
import { Integrations } from './pages/Integrations';
import { Automations } from './pages/Automations';
import { SettingsView } from './pages/SettingsView';
import { Reports } from './pages/Reports';
import { Auth } from './pages/Auth';
import './styles.css';

const nav: { name: Page; icon: typeof Package }[] = [
  { name: 'Overview', icon: LayoutDashboard },
  { name: 'Orders', icon: ShoppingBag },
  { name: 'Messages', icon: MessageCircle },
  { name: 'Inbox', icon: Inbox },
  { name: 'Automations', icon: Workflow },
  { name: 'Integrations', icon: Link2 },
  { name: 'Reliability', icon: ShieldCheck },
  { name: 'Reports', icon: BarChart3 },
];
let initialSnapshot: Promise<Snapshot> | undefined;
async function bootstrap(): Promise<Snapshot> {
  try {
    return await api<Snapshot>('/workspace');
  } catch {
    const health = await api<{ mode: string }>('/health');
    if (health.mode !== 'demo') throw new Error('Please sign in to continue.');
    await api('/auth/demo', {});
    return api<Snapshot>('/workspace');
  }
}
function download(name: string, content: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
function csv(value: unknown): string {
  const text = String(value ?? '');
  return `"${(/^[=+@\-\t\r]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`;
}

function App() {
  const [data, setData] = useState<Snapshot>();
  const [loading, setLoading] = useState(true);
  const [auth, setAuth] = useState(false);
  const [page, setPage] = useState<Page>(() =>
    new URLSearchParams(location.search).get('page') === 'integrations'
      ? 'Integrations'
      : 'Overview',
  );
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState(() => {
    const result = new URLSearchParams(location.search).get('shopify');
    return result === 'connected'
      ? 'Shopify connected. Register webhooks to start receiving orders.'
      : result === 'failed'
        ? 'Shopify connection was not completed. Check app credentials, distribution, and permissions, then try again.'
        : '';
  });
  const [busy, setBusy] = useState(false);
  const [simulator, setSimulator] = useState(false);
  const [selected, setSelected] = useState<Order>();
  const [mobile, setMobile] = useState(false);
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 700px)').matches);
  const [notifications, setNotifications] = useState(false);
  const [help, setHelp] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 700px)');
    const update = () => {
      setCompact(media.matches);
      if (!media.matches) setMobile(false);
    };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!mobile || !compact) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.querySelector<HTMLButtonElement>('#workspace-navigation .nav-item')?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobile(false);
        requestAnimationFrame(() =>
          document.querySelector<HTMLButtonElement>('.mobile-menu')?.focus(),
        );
      }
    };
    document.addEventListener('keydown', close);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', close);
    };
  }, [mobile, compact]);
  async function refresh() {
    const next = await api<Snapshot>('/workspace');
    setData(next);
    return next;
  }
  useEffect(() => {
    const expired = () => {
      initialSnapshot = undefined;
      setData(undefined);
      setSelected(undefined);
      setAuth(true);
      setToast('Your session expired. Sign in to load current orders.');
    };
    window.addEventListener('relay-session-expired', expired);
    return () => window.removeEventListener('relay-session-expired', expired);
  }, []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        initialSnapshot ??= bootstrap();
        const snapshot = await initialSnapshot;
        if (!cancelled) setData(snapshot);
      } catch (error) {
        initialSnapshot = undefined;
        if (!cancelled) {
          setToast(
            error instanceof Error
              ? error.message
              : 'API unavailable. Start both services with npm run dev.',
          );
          setAuth(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!data) return;
    const interval = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 10000);
    return () => clearInterval(interval);
  }, [data?.merchant.id]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 6500);
    return () => clearTimeout(timer);
  }, [toast]);
  async function act(fn: () => Promise<unknown>, message = 'Changes saved') {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      await refresh();
      setToast(message);
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }
  function navigate(next: Page) {
    setPage(next);
    setSearch('');
    setMobile(false);
    window.scrollTo({ top: 0 });
  }
  if (loading)
    return (
      <div className="boot">
        <Logo />
        <Loader2 className="spin" />
        <p>Opening your workspace…</p>
      </div>
    );
  if (auth || !data)
    return (
      <>
        <Auth
          onSuccess={async () => {
            await refresh();
            setAuth(false);
          }}
        />
        <Toast value={toast} dismiss={() => setToast('')} />
      </>
    );
  const w = data.workspace;
  const openTasks = w.tasks.filter((t) => t.status !== 'VERIFIED');
  const currentOrder = selected ? w.orders.find((o) => o.id === selected.id) : undefined;
  const currencyTotals = w.orders
    .filter((o) => o.status === 'CONFIRMED')
    .reduce<Record<string, number>>(
      (sum, o) => ({ ...sum, [o.currency]: (sum[o.currency] ?? 0) + o.amount }),
      {},
    );
  return (
    <div className="app-shell">
      <aside
        id="workspace-navigation"
        inert={compact && !mobile}
        className={`sidebar ${mobile ? 'visible' : ''}`}
      >
        <div className="brand-row">
          <Logo />
          <span className="workspace-label">WORKSPACE</span>
        </div>
        <button className="store-select" onClick={() => navigate('Settings')}>
          <span className="store-avatar">
            <ShoppingBag size={19} />
          </span>
          <span>
            <strong>{data.merchant.brandName}</strong>
            <small>{data.mode === 'demo' ? 'Demo workspace' : 'Merchant workspace'}</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {nav.map(({ name, icon: Icon }) => (
            <button
              key={name}
              className={`nav-item ${page === name ? 'active' : ''}`}
              aria-current={page === name ? 'page' : undefined}
              onClick={() => navigate(name)}
            >
              <Icon size={19} />
              <span>{name}</span>
              {name === 'Inbox' && customerConversations(w).filter((c) => c.unread).length > 0 && (
                <span className="nav-count">
                  {customerConversations(w).filter((c) => c.unread).length}
                </span>
              )}
              {name === 'Automations' && <span className="nav-new">NEW</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="trial-card">
            <span className="trial-icon">
              <Sparkles size={17} />
            </span>
            <strong>
              {data.mode === 'demo' ? 'Your ideas. Zero risk.' : 'Your workspace is ready.'}
            </strong>
            <p>
              {data.mode === 'demo'
                ? 'Explore every workflow with sample orders. No messages will be sent.'
                : 'Manage credentials and automation preferences in settings.'}
            </p>
            <button
              onClick={() => (data.mode === 'demo' ? setSimulator(true) : navigate('Integrations'))}
            >
              {data.mode === 'demo' ? 'Try a test workflow' : 'Review integrations'}
              <ArrowUpRight size={15} />
            </button>
          </div>
          <button
            className={`nav-item ${page === 'Settings' ? 'active' : ''}`}
            onClick={() => navigate('Settings')}
          >
            <Settings2 size={19} />
            <span>Settings</span>
          </button>
          <button className="nav-item" onClick={() => setHelp(true)}>
            <LifeBuoy size={19} />
            <span>Help & getting started</span>
            <ArrowUpRight size={14} />
          </button>
          <div className="profile">
            <span className="avatar purple">{initials(data.merchant.brandName)}</span>
            <div>
              <strong>Store administrator</strong>
              <small>{data.mode === 'demo' ? 'Demo account' : data.merchant.email}</small>
            </div>
            <button
              className="icon-button"
              aria-label="Sign out"
              onClick={() => {
                void api('/auth/logout', {})
                  .then(() => {
                    initialSnapshot = undefined;
                    setToast('');
                    setData(undefined);
                    setAuth(true);
                  })
                  .catch(() => setToast('Could not sign out. Please try again.'));
              }}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      {mobile && compact && (
        <button
          className="mobile-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <div className="main-shell" inert={compact && mobile}>
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              aria-controls="workspace-navigation"
              aria-expanded={mobile}
              onClick={() => setMobile(true)}
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>{page}</strong>
          </div>
          <div className="topbar-right">
            <span className="environment">
              <span />
              {data.mode === 'demo' ? 'Demo environment' : 'Connected environment'}
            </span>
            <button
              className={`icon-button notification-button ${notifications ? 'selected' : ''}`}
              aria-label="View activity"
              onClick={() => setNotifications(!notifications)}
            >
              <Bell size={19} />
              {(w.notifications ?? []).some((n) => !n.readAt && !n.resolvedAt) && <i />}
            </button>
            <span className="avatar tiny purple">{initials(data.merchant.brandName)}</span>
          </div>
          {notifications && (
            <div className="notification-popover">
              <strong>Notifications</strong>
              {(w.notifications ?? [])
                .filter((n) => !n.resolvedAt)
                .slice(0, 4)
                .map((n) => (
                  <p key={n.id}>
                    <strong>{n.title}</strong>
                    <br />
                    {n.detail}
                    <small>{n.action}</small>
                  </p>
                ))}
              <button
                className="text-button"
                onClick={() => {
                  navigate('Reliability');
                  setNotifications(false);
                }}
              >
                View reliability and recovery
              </button>
              <strong>Recent activity</strong>
              {w.activity.slice(0, 4).map((a) => (
                <p key={a.id}>
                  {a.text}
                  <small>{time(a.createdAt)}</small>
                </p>
              ))}
              {!w.activity.length && <p>No activity yet.</p>}
            </div>
          )}
        </header>
        <main>
          <div
            className={`page-heading ${['Orders', 'Messages', 'Integrations', 'Inbox'].includes(page) ? 'compact-heading' : ''}`}
          >
            <div>
              {!['Orders', 'Messages', 'Integrations', 'Inbox'].includes(page) && (
                <div className="eyebrow">YOUR COMMERCE, CONNECTED</div>
              )}
              <h1>{page === 'Overview' ? 'A little less busywork.' : page}</h1>
              {!['Orders', 'Messages', 'Integrations', 'Inbox'].includes(page) && (
                <p>
                  {
                    {
                      Overview: 'Your orders, conversations, and next steps. All in one place.',
                      Orders: 'Keep every order moving, from confirmation to dispatch.',
                      Inbox: 'Helpful conversations. Clear handoffs. Nothing lost.',
                      Messages: 'Track message requests, delivery updates, and failures.',
                      Automations:
                        'Let the routine run itself. Keep control of the important things.',
                      Integrations: 'Connect your store and customer conversations securely.',
                      Reliability: 'Recover missed orders and review processing failures.',
                      Reports: 'A clear picture of what happened and what needs attention.',
                      Settings: 'Make Relay work the way your store does.',
                    }[page]
                  }
                </p>
              )}
            </div>
            <div className="heading-actions">
              {(page === 'Overview' || page === 'Reports') && (
                <button
                  className="button secondary"
                  onClick={() => {
                    download(
                      'relay-orders.csv',
                      [
                        ['Order', 'Customer', 'Amount', 'Currency', 'Status', 'Fulfillment'],
                        ...w.orders.map((o) => [
                          o.number,
                          o.name,
                          o.amount,
                          o.currency,
                          o.status,
                          o.delivery,
                        ]),
                      ]
                        .map((row) => row.map(csv).join(','))
                        .join('\r\n'),
                    );
                    setToast('Order report downloaded');
                  }}
                >
                  <ArrowDownToLine size={16} />
                  Export report
                </button>
              )}
              {data.mode === 'demo' && page === 'Overview' && (
                <button
                  className="button primary"
                  disabled={data.mode !== 'demo'}
                  onClick={() => setSimulator(true)}
                >
                  <FlaskConical size={16} />
                  Test workflow
                </button>
              )}
            </div>
          </div>
          {data.mode === 'demo' && (
            <div className="demo-banner">
              <span className="demo-banner-icon">
                <FlaskConical size={18} />
              </span>
              <div>
                <strong>A safe space to see it all work.</strong>
                <span> Sample data · Simulated messages · No external API calls</span>
              </div>
              <button onClick={() => setSimulator(true)}>
                Run a test
                <ArrowRight size={15} />
              </button>
            </div>
          )}
          {page === 'Overview' && (
            <>
              <section className="stats-grid">
                <Stat
                  title="Total orders"
                  value={String(w.orders.length)}
                  icon={ShoppingBag}
                  detail="Orders in this workspace"
                  color="violet"
                  points="0,32 10,26 20,29 30,16 40,22 50,9 60,14 70,3"
                />
                <Stat
                  title="Confirmed orders"
                  value={String(w.orders.filter((o) => o.status === 'CONFIRMED').length)}
                  icon={CircleCheck}
                  detail={`${w.orders.length ? Math.round((w.orders.filter((o) => o.status === 'CONFIRMED').length / w.orders.length) * 100) : 0}% of all orders`}
                  color="green"
                  points="0,33 10,29 20,30 30,20 40,24 50,13 60,15 70,5"
                />
                <Stat
                  title="Awaiting a reply"
                  value={String(w.orders.filter((o) => o.status === 'PENDING').length)}
                  icon={Clock3}
                  detail="Customers yet to confirm"
                  color="amber"
                  points="0,15 10,21 20,10 30,17 40,12 50,23 60,16 70,20"
                />
                <Stat
                  title="Needs your attention"
                  value={String(openTasks.length)}
                  icon={Users}
                  detail="Requests ready for review"
                  color="rose"
                  points="0,26 10,20 20,24 30,11 40,16 50,6 60,13 70,8"
                />
              </section>
              <div className="overview-grid">
                <section className="panel chart-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Order activity</h2>
                      <p>Confirmations across your workspace</p>
                    </div>
                    <span className="mini-select">
                      {data.mode === 'demo' ? 'Sample orders' : 'Recent orders'}
                      <ChevronDown size={13} />
                    </span>
                  </div>
                  <ActivityChart orders={w.orders} />
                  <div className="chart-footer">
                    <span>
                      <i className="legend-dot violet" />
                      All orders
                    </span>
                    <span>
                      <i className="legend-dot mint" />
                      Confirmed
                    </span>
                    <span className="chart-footnote">
                      {data.mode === 'demo'
                        ? 'Illustrates sample order distribution'
                        : 'Grouped by order creation time'}
                    </span>
                  </div>
                </section>
                <section className="panel attention-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>
                        Needs attention <span className="count-pill">{openTasks.length}</span>
                      </h2>
                      <p>A few things that need a human touch</p>
                    </div>
                    <span className="attention-dot" />
                  </div>
                  <div className="attention-list">
                    {openTasks.slice(0, 3).map((t) => {
                      const o = w.orders.find((o) => o.id === t.orderId);
                      return (
                        <button
                          key={t.id}
                          className="attention-item"
                          onClick={() => setSelected(o)}
                        >
                          <span
                            className={`task-icon ${t.kind === 'Cancellation' ? 'rose' : 'amber'}`}
                          >
                            {t.kind === 'Cancellation' ? <X size={16} /> : <Package size={16} />}
                          </span>
                          <div>
                            <strong>{t.kind} requested</strong>
                            <p>
                              {o?.number} · {o?.name}
                            </p>
                          </div>
                          <ChevronRight size={16} />
                        </button>
                      );
                    })}
                    {!openTasks.length && (
                      <div className="all-clear">
                        <CircleCheck size={26} />
                        <p>You're all caught up.</p>
                      </div>
                    )}
                  </div>
                  <div className="attention-note">
                    <ShieldCheck size={17} />
                    <span>Requests stay open until the completed action is recorded.</span>
                  </div>
                  <button className="panel-bottom-link" onClick={() => navigate('Orders')}>
                    Review your orders
                    <ArrowRight size={15} />
                  </button>
                </section>
              </div>
              <section className="panel orders-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Recent orders</h2>
                    <p>From checkout to confirmation, without the chase.</p>
                  </div>
                  <button className="text-button" onClick={() => navigate('Orders')}>
                    View all orders
                    <ArrowRight size={15} />
                  </button>
                </div>
                <OrderTable orders={w.orders.slice(0, 5)} onSelect={setSelected} />
              </section>
              <div className="bottom-grid">
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Automation at a glance</h2>
                      <p>Your everyday workflows</p>
                    </div>
                    <button className="text-button" onClick={() => navigate('Automations')}>
                      Manage
                      <ArrowRight size={14} />
                    </button>
                  </div>
                  <div className="workflow-summary">
                    {[
                      {
                        key: 'confirmations' as const,
                        icon: CheckCheck,
                        name: 'COD confirmations',
                      },
                      { key: 'tracking' as const, icon: Package, name: 'Tracking assistance' },
                      { key: 'faqs' as const, icon: MessageCircle, name: 'Approved FAQ answers' },
                    ].map((f) => (
                      <div key={f.key}>
                        <span className="soft-icon">
                          <f.icon size={17} />
                        </span>
                        <strong>{f.name}</strong>
                        <span className={`pill ${w.settings[f.key] ? 'green' : ''}`}>
                          {w.settings[f.key] ? 'Enabled' : 'Paused'}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Recent activity</h2>
                      <p>The latest in your workspace</p>
                    </div>
                    <Activity size={17} className="muted" />
                  </div>
                  <div className="activity-list">
                    {w.activity.slice(0, 3).map((a) => (
                      <div key={a.id}>
                        <span className="activity-node" />
                        <p>{a.text}</p>
                        <time>{time(a.createdAt)}</time>
                      </div>
                    ))}
                    {!w.activity.length && (
                      <p className="muted">Your store activity will appear here.</p>
                    )}
                  </div>
                </section>
              </div>
            </>
          )}
          {page === 'Orders' && (
            <Orders
              busy={busy}
              act={act}
              workspace={w}
              search={search}
              setSearch={setSearch}
              onSelect={setSelected}
            />
          )}
          {page === 'Inbox' && <InboxView data={data} busy={busy} act={act} />}
          {page === 'Reliability' && <Reliability data={data} busy={busy} act={act} />}
          {page === 'Messages' && (
            <Messages
              busy={busy}
              act={act}
              workspace={w}
              metaWebhookConfigured={data.metaWebhookConfigured ?? false}
            />
          )}
          {page === 'Integrations' && <Integrations data={data} busy={busy} act={act} />}
          {page === 'Automations' && <Automations workspace={w} busy={busy} act={act} />}
          {page === 'Settings' && <SettingsView data={data} busy={busy} act={act} />}
          {page === 'Reports' && <Reports data={data} totals={currencyTotals} />}
          <footer className="page-footer">
            <span>
              <Logo small /> Thoughtful automation. Human when it matters.
            </span>
            <span>
              <LockKeyhole size={12} />
              {data.mode === 'demo'
                ? 'Demo data resets when the server restarts'
                : 'Tenant-scoped workspace'}
            </span>
          </footer>
        </main>
      </div>
      {simulator && (
        <Modal
          title="Try the complete workflow"
          subtitle="Watch a customer action move through your workspace."
          close={() => setSimulator(false)}
        >
          <div className="simulation-note">
            <FlaskConical size={19} />
            <span>Demo only. No customer messages or external API calls.</span>
          </div>
          <div className="scenario-list">
            {[
              {
                id: 'order',
                icon: ShoppingBag,
                name: 'A new COD order arrives',
                desc: 'Create an order and queue its confirmation.',
              },
              {
                id: 'confirm',
                icon: CircleCheck,
                name: 'A customer confirms',
                desc: 'Update the order and queue its Shopify tag.',
              },
              {
                id: 'address',
                icon: Package,
                name: 'A customer requests a change',
                desc: 'Create a request and hand the conversation to a human.',
              },
              {
                id: 'tracking',
                icon: MessageCircle,
                name: 'A customer asks for tracking',
                desc: 'Answer using the available order information.',
              },
            ].map((s) => (
              <button
                disabled={busy}
                key={s.id}
                onClick={() => {
                  void act(async () => {
                    await api('/demo/simulate', { scenario: s.id });
                    await api('/jobs/run', {});
                    setSimulator(false);
                  }, 'Test complete. Your workspace has been updated.');
                }}
              >
                <span className="scenario-icon">
                  <s.icon size={21} />
                </span>
                <div>
                  <strong>{s.name}</strong>
                  <p>{s.desc}</p>
                </div>
                <ArrowRight size={18} />
              </button>
            ))}
          </div>
        </Modal>
      )}
      {currentOrder && (
        <OrderDrawer
          order={currentOrder}
          workspace={w}
          close={() => setSelected(undefined)}
          busy={busy}
          act={act}
        />
      )}
      {help && (
        <Modal
          title="Your first workflow, made simple"
          subtitle="A short checklist to get comfortable with Relay."
          close={() => setHelp(false)}
        >
          <div className="help-steps">
            {[
              'Run a simulated COD order with Test workflow.',
              'Open Orders to review its confirmation state.',
              'Open Inbox to simulate a customer reply or take over.',
              'Approve change requests, then record completion evidence.',
              'Configure store credentials under Integrations when ready.',
            ].map((s, i) => (
              <div key={s}>
                <span>{i + 1}</span>
                <p>{s}</p>
              </div>
            ))}
          </div>
          <div className="notice">
            Connected workspaces support live manual replies within Meta’s 24-hour customer reply
            window and rule-based order-tracking or policy replies. Courier synchronization and
            automatic Shopify order edits or refunds are not enabled in this release.
          </div>
        </Modal>
      )}
      <Toast value={toast} dismiss={() => setToast('')} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
