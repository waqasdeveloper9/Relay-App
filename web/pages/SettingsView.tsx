import { useState } from 'react';
import { Check, ShieldCheck } from 'lucide-react';
import { api, type Snapshot } from '../api';
import { type Act } from '../lib/format';

export function SettingsView({ data, busy, act }: { data: Snapshot; busy: boolean; act: Act }) {
  const [form, setForm] = useState(data.workspace.settings);
  return (
    <div className="settings-layout">
      <section className="panel settings-card">
        <div className="panel-heading">
          <div>
            <h2>Store preferences</h2>
            <p>Reliable defaults for your daily operations.</p>
          </div>
        </div>
        <div className="form-stack">
          <label className="field">
            <span>Store name</span>
            <input value={data.merchant.brandName} readOnly />
            <small>Account branding is set during registration.</small>
          </label>
          <div className="form-row">
            <label className="field">
              <span>Reporting timezone</span>
              <select
                value={form.timezone}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              >
                {[
                  'Asia/Karachi',
                  'Asia/Dubai',
                  'Asia/Kolkata',
                  'Europe/London',
                  'America/New_York',
                  'UTC',
                ].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Reminder delay (hours)</span>
              <input
                type="number"
                min="1"
                max="72"
                value={form.reminderHours}
                onChange={(e) => setForm({ ...form, reminderHours: Number(e.target.value) })}
              />
              <small>Choose a whole number from 1 to 72.</small>
            </label>
          </div>
          <label className="field">
            <span>Approved FAQ response</span>
            <textarea
              rows={6}
              maxLength={3000}
              value={form.policy}
              onChange={(e) => setForm({ ...form, policy: e.target.value })}
            />
            <small>
              The rules-based assistant uses this exact text for matching policy questions.
            </small>
          </label>
          <button
            className="button primary"
            disabled={
              busy ||
              !form.policy.trim() ||
              !Number.isInteger(form.reminderHours) ||
              form.reminderHours < 1 ||
              form.reminderHours > 72
            }
            onClick={() => {
              void act(() => api('/settings', form, 'PUT'));
            }}
          >
            <Check size={16} />
            Save preferences
          </button>
        </div>
      </section>
      <section className="panel safety-card">
        <span className="automation-icon green">
          <ShieldCheck size={25} />
        </span>
        <h2>Control stays with you.</h2>
        <p>These safeguards are part of every workspace.</p>
        <ul>
          <li>
            <Check size={16} />
            Human takeover pauses the assistant
          </li>
          <li>
            <Check size={16} />
            No automatic refunds or cancellations
          </li>
          <li>
            <Check size={16} />
            Approval and completion are separate
          </li>
          <li>
            <Check size={16} />
            Tokens never appear in API responses
          </li>
          <li>
            <Check size={16} />
            No AI subscription required
          </li>
        </ul>
        <div className="notice">
          {data.mode === 'demo'
            ? 'Demo data is isolated to your browser session account and stored in server memory. Restarting the server resets all demo accounts.'
            : 'Persistent mode uses PostgreSQL. Trial expiry blocks new confirmation messages; incoming messages remain available for review.'}
        </div>
      </section>
    </div>
  );
}
