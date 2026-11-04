import { useEffect, useState } from 'react';
import { CircleCheck, ShoppingBag, Users, AlertCircle, BarChart3 } from 'lucide-react';
import { api, type Snapshot } from '../api';
import { money } from '../lib/format';
import { Stat } from '../components/ui';

export function Reports({ data, totals }: { data: Snapshot; totals: Record<string, number> }) {
  const [report, setReport] = useState<Record<string, string | number | boolean>>();
  const [error, setError] = useState('');
  useEffect(() => {
    void api<Record<string, string | number | boolean>>('/reports')
      .then(setReport)
      .catch((e) => setError(String(e)));
  }, [data.workspace.orders.length, data.workspace.activity[0]?.id]);
  return (
    <>
      <div className="report-hero panel">
        <div>
          <span className="eyebrow">DAILY OPERATIONS</span>
          <h2>Your day, without the noise.</h2>
          <p>
            {report ? `${report.date} · ${report.timezone}` : error || 'Preparing your report…'}
          </p>
        </div>
        <span className="report-illustration">
          <BarChart3 size={46} />
        </span>
      </div>
      <section className="stats-grid">
        {[
          { title: 'Orders received today', value: report?.orders ?? '—', icon: ShoppingBag },
          { title: 'Confirmed today', value: report?.confirmed ?? '—', icon: CircleCheck },
          { title: 'Open requests · all time', value: report?.openRequests ?? '—', icon: Users },
          { title: 'Failed / uncertain jobs', value: report?.failures ?? '—', icon: AlertCircle },
        ].map((s) => (
          <Stat
            key={s.title}
            {...s}
            value={String(s.value)}
            color="violet"
            detail="Recorded workspace events"
            points="0,28 15,24 30,30 45,15 60,19 70,8"
          />
        ))}
      </section>
      <div className="bottom-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Confirmed order value</h2>
              <p>All recorded orders, separated by currency. Not collected revenue.</p>
            </div>
          </div>
          <div className="currency-list">
            {Object.entries(totals).map(([currency, total]) => (
              <div key={currency}>
                <span>{currency}</span>
                <strong>{money(total, currency)}</strong>
              </div>
            ))}
            {!Object.keys(totals).length && <p className="muted">No confirmed order value yet.</p>}
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>What the report means</h2>
              <p>Useful numbers, without inflated claims.</p>
            </div>
          </div>
          <div className="report-definitions">
            <p>
              <strong>Confirmed</strong> means the order was confirmed; it does not prove successful
              delivery.
            </p>
            <p>
              <strong>Open requests</strong> include approved actions awaiting merchant
              verification.
            </p>
            <p>
              <strong>Job success</strong> means an API accepted an action, not necessarily that a
              message was delivered.
            </p>
          </div>
        </section>
      </div>
    </>
  );
}
