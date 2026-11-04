import { useState } from 'react';
import { Check } from 'lucide-react';
import type { Order } from '../../src/models/types';
import { api, type PublicWorkspace } from '../api';
import { money, type Act } from '../lib/format';
import { Badge, Modal } from './ui';

export function OrderDrawer({
  order: o,
  workspace: w,
  close,
  busy,
  act,
}: {
  order: Order;
  workspace: PublicWorkspace;
  close: () => void;
  busy: boolean;
  act: Act;
}) {
  const [evidence, setEvidence] = useState('');
  const [cancellationReason, setCancellationReason] = useState('');
  const [cancellationConfirmed, setCancellationConfirmed] = useState(false);
  const cancelJob = w.jobs.find((j) => j.orderId === o.id && j.kind === 'CANCEL');
  const tagJob = w.jobs.find(
    (j) =>
      j.orderId === o.id &&
      j.kind === (o.status === 'CANCELLED' ? 'CANCEL_CLEANUP' : 'CANCEL_TAGS'),
  );
  const cancellationPending = w.tasks.some(
    (t) => t.orderId === o.id && t.kind === 'Cancellation' && o.status !== 'CANCELLED',
  );
  return (
    <Modal
      title={`Order ${o.number}`}
      subtitle={`${o.name} · ${money(o.amount, o.currency)}`}
      close={close}
    >
      <div className="order-detail">
        <Badge status={o.status} />
        <span className="fulfillment">{o.delivery}</span>
      </div>
      <dl className="detail-grid">
        <div>
          <dt>Customer phone</dt>
          <dd>{o.phone ? `+${o.phone}` : 'Not available'}</dd>
        </div>
        <div>
          <dt>Payment method</dt>
          <dd>Cash on delivery</dd>
        </div>
        <div>
          <dt>Messaging permission</dt>
          <dd>{o.consent ? 'Recorded' : 'Not recorded'}</dd>
        </div>
        <div>
          <dt>Shopify tags</dt>
          <dd>{o.tags.join(', ') || 'None applied'}</dd>
        </div>
      </dl>
      <div className="notice">
        <strong>Shopify sync</strong>
        <p>
          {tagJob
            ? 'Cancellation tags: ' + tagJob.state
            : o.tags.includes('COD-CONFIRMED')
              ? 'COD-CONFIRMED tag applied successfully.'
              : w.jobs.find((j) => j.orderId === o.id && j.kind === 'TAG')
                ? 'Tag job: ' + w.jobs.find((j) => j.orderId === o.id && j.kind === 'TAG')!.state
                : 'No confirmation tag queued.'}
        </p>
        {w.jobs
          .filter(
            (j) =>
              j.orderId === o.id &&
              ['TAG', 'CANCEL_TAGS', 'CANCEL_CLEANUP', 'CANCEL'].includes(j.kind) &&
              j.error,
          )
          .map((j) => (
            <p key={j.id}>{j.error}</p>
          ))}
        {o.messageBlockedReason && <p>{o.messageBlockedReason}</p>}
      </div>
      <div className="drawer-actions order-dialog-actions">
        <button
          className="button secondary"
          disabled={
            busy ||
            o.status !== 'PENDING' ||
            w.jobs.some(
              (j) =>
                j.orderId === o.id &&
                ['CONFIRMATION', 'TEST_CONFIRMATION', 'TEST_HELLO'].includes(j.kind),
            )
          }
          onClick={() =>
            void act(
              () => api(`/orders/${o.id}/queue-confirmation`, {}),
              'Confirmation checked and queued. Track the result in Messages.',
            )
          }
        >
          Send confirmation
        </button>
        <button
          className="button primary"
          disabled={
            busy || cancellationPending || o.status === 'CONFIRMED' || o.status === 'CANCELLED'
          }
          onClick={() => {
            void act(
              () => api(`/orders/${o.id}/action`, { action: 'confirm' }),
              'Order confirmed. Shopify tag queued.',
            );
          }}
        >
          <Check size={16} />
          Confirm order
        </button>
        <button
          className="button secondary"
          disabled={busy || o.status === 'CANCELLED' || o.status === 'NEEDS_REVIEW'}
          onClick={() => {
            void act(
              () => api(`/orders/${o.id}/action`, { action: 'review' }),
              'Order moved to review',
            );
          }}
        >
          Mark for review
        </button>
      </div>
      {!w.integration.metaWebhookVerifiedAt && (
        <p className="muted">
          Incoming WhatsApp replies are not verified. An authorized sandbox send can be tested, but
          Confirm/Cancel clicks and delivery receipts require completing Meta webhook setup.
        </p>
      )}
      <h3 className="section-subtitle">Customer requests</h3>
      {w.tasks
        .filter((t) => t.orderId === o.id)
        .map((t) => (
          <div className="request-card" key={t.id}>
            <div>
              <strong>{t.kind}</strong>
              <span className="pill">
                {t.kind === 'Cancellation'
                  ? o.status === 'CANCELLED'
                    ? 'Cancelled in Shopify'
                    : cancelJob
                      ? 'Cancellation: ' + cancelJob.state.toLowerCase()
                      : 'Review required'
                  : t.status === 'VERIFIED'
                    ? 'Merchant verified'
                    : t.status.toLowerCase()}
              </span>
            </div>
            <p>{t.detail}</p>
            {t.kind === 'Cancellation' && o.status !== 'CANCELLED' && !cancelJob && (
              <>
                <label className="field">
                  <span>Cancellation reason</span>
                  <textarea
                    maxLength={255}
                    value={cancellationReason}
                    onChange={(e) => setCancellationReason(e.target.value)}
                    placeholder="Record why this order should be cancelled"
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={cancellationConfirmed}
                    onChange={(e) => setCancellationConfirmed(e.target.checked)}
                  />{' '}
                  I reviewed payment, fulfillment and dispatch. Cancel this order in Shopify (cannot
                  be undone).
                </label>
                <button
                  className="button danger"
                  disabled={busy || !cancellationReason.trim() || !cancellationConfirmed}
                  onClick={() =>
                    void act(
                      () =>
                        api(`/tasks/${t.id}/action`, {
                          action: 'cancel',
                          reason: cancellationReason,
                          confirmed: cancellationConfirmed,
                        }),
                      'Cancellation queued. Track Shopify completion here.',
                    )
                  }
                >
                  Approve &amp; cancel in Shopify
                </button>
              </>
            )}
            {t.kind === 'Cancellation' && cancelJob && o.status !== 'CANCELLED' && (
              <p>
                Shopify cancellation: {cancelJob.state.toLowerCase()}.{' '}
                {cancelJob.error || 'Awaiting verified completion.'} Check Reliability for failed or
                uncertain actions.
              </p>
            )}
            {t.kind !== 'Cancellation' && t.status === 'OPEN' && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  void act(
                    () => api(`/tasks/${t.id}/action`, { action: 'approve' }),
                    'Approved for manual execution. No external order change has been made.',
                  );
                }}
              >
                Approve for action
              </button>
            )}
            {t.kind !== 'Cancellation' && t.status === 'APPROVED' && (
              <>
                <label className="field">
                  <span>Completed action / verification reference</span>
                  <textarea
                    value={evidence}
                    onChange={(e) => setEvidence(e.target.value)}
                    placeholder="For example: address updated in Shopify and courier portal; reference…"
                  />
                </label>
                <button
                  className="button primary"
                  disabled={busy || !evidence.trim()}
                  onClick={() => {
                    void act(
                      () => api(`/tasks/${t.id}/action`, { action: 'verify', evidence }),
                      'Completion recorded with merchant verification.',
                    );
                  }}
                >
                  Record completion
                </button>
              </>
            )}
          </div>
        ))}
      {!w.tasks.some((t) => t.orderId === o.id) && (
        <p className="muted">No customer requests for this order.</p>
      )}
      <div className="notice">
        Cancellation approval queues a Shopify action; Cancelled appears only after Shopify
        confirms. Address edits and courier actions still require manual completion.
      </div>
    </Modal>
  );
}
