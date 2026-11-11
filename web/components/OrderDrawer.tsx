import { useEffect, useId, useState } from 'react';
import { Check, ExternalLink } from 'lucide-react';
import type { Order, ShopifyOrderAction } from '../../src/models/types';
import { hasShopifyScope, shopifySyncSettings } from '../../src/models/workspace-defaults';
import { api, type PublicWorkspace } from '../api';
import {
  deliveryClass,
  money,
  paymentClass,
  paymentLabel,
  safeExternalUrl,
  type Act,
} from '../lib/format';
import { Badge, Modal } from './ui';

export function OrderDrawer({
  order: o,
  workspace: w,
  mode = 'connected',
  close,
  busy,
  act,
}: {
  order: Order;
  workspace: PublicWorkspace;
  mode?: 'demo' | 'connected';
  close: () => void;
  busy: boolean;
  act: Act;
}) {
  const isDemo = mode === 'demo';
  const [evidence, setEvidence] = useState('');
  const [cancellationReason, setCancellationReason] = useState('');
  const [cancellationConfirmed, setCancellationConfirmed] = useState(false);
  const [permissionGranted, setPermissionGranted] = useState(o.consent);
  const [permissionEvidence, setPermissionEvidence] = useState('');
  const [trackingCompany, setTrackingCompany] = useState(o.trackingCompany ?? '');
  const [trackingNumber, setTrackingNumber] = useState(o.trackingNumber ?? '');
  const [trackingUrl, setTrackingUrl] = useState(o.trackingUrl ?? '');
  const [notifyCustomer, setNotifyCustomer] = useState(false);
  const [trackingError, setTrackingError] = useState('');
  useEffect(() => {
    setPermissionGranted(o.consent);
    setTrackingCompany(o.trackingCompany ?? '');
    setTrackingNumber(o.trackingNumber ?? '');
    setTrackingUrl(o.trackingUrl ?? '');
    setNotifyCustomer(false);
    setTrackingError('');
  }, [o.id, o.consent, o.trackingCompany, o.trackingNumber, o.trackingUrl]);
  const permSelectId = useId();
  const permEvidenceId = useId();
  const courierId = useId();
  const trackNumId = useId();
  const trackUrlId = useId();
  const trackUrlHintId = useId();
  const notifyCustId = useId();
  const sync = shopifySyncSettings(w);
  const cancelJob = w.jobs.find((j) => j.orderId === o.id && j.kind === 'CANCEL');
  const tagJob = w.jobs.find(
    (j) =>
      j.orderId === o.id &&
      j.kind === (o.status === 'CANCELLED' ? 'CANCEL_CLEANUP' : 'CANCEL_TAGS'),
  );
  const confirmTagJob = w.jobs.find((j) => j.orderId === o.id && j.kind === 'TAG');
  const reviewTagJob = w.jobs.find((j) => j.orderId === o.id && j.kind === 'REVIEW_TAG');
  const holdJob = w.jobs.find((j) => j.orderId === o.id && j.kind === 'FULFILLMENT_HOLD');
  const releaseJob = w.jobs.find((j) => j.orderId === o.id && j.kind === 'FULFILLMENT_RELEASE');
  const markPaidJob = w.jobs.find((j) => j.orderId === o.id && j.kind === 'MARK_PAID');
  const markProgressJob = w.jobs.find((j) => j.orderId === o.id && j.kind === 'MARK_IN_PROGRESS');
  const markOpenJob = w.jobs.find((j) => j.orderId === o.id && j.kind === 'MARK_OPEN');
  const fulfillJob = w.jobs.find((j) => j.orderId === o.id && j.kind === 'FULFILL_ORDER');
  const updateTrackingJob = w.jobs.find((j) => j.orderId === o.id && j.kind === 'UPDATE_TRACKING');
  const markDeliveredJob = w.jobs.find((j) => j.orderId === o.id && j.kind === 'MARK_DELIVERED');
  const dispatchJob = w.jobs.find((j) => j.orderId === o.id && j.kind === 'DISPATCH_NOTICE');
  const deliveryJob = w.jobs.find((j) => j.orderId === o.id && j.kind === 'DELIVERY_NOTICE');
  const paidNoticeJob = w.jobs.find((j) => j.orderId === o.id && j.kind === 'PAYMENT_NOTICE');
  const progressNoticeJob = w.jobs.find(
    (j) => j.orderId === o.id && j.kind === 'IN_PROGRESS_NOTICE',
  );
  const holdNoticeJob = w.jobs.find((j) => j.orderId === o.id && j.kind === 'ON_HOLD_NOTICE');
  const trackingHref = safeExternalUrl(o.trackingUrl);
  const cancellationPending = w.tasks.some(
    (t) => t.orderId === o.id && t.kind === 'Cancellation' && o.status !== 'CANCELLED',
  );
  const hasActiveJob = (kind: string) =>
    w.jobs.some(
      (j) =>
        j.orderId === o.id && j.kind === kind && (j.state === 'QUEUED' || j.state === 'UNKNOWN'),
    );
  const fin = (o.financialStatus ?? 'pending').toLowerCase();
  const isCancelled = o.status === 'CANCELLED';
  const hasOrderWriteScope = isDemo || hasShopifyScope(w.integration, 'write_orders');
  const hasFoReadScope =
    isDemo || hasShopifyScope(w.integration, 'read_merchant_managed_fulfillment_orders');
  const hasFoWriteScope =
    isDemo || hasShopifyScope(w.integration, 'write_merchant_managed_fulfillment_orders');
  const hasFulfillWriteScope = isDemo || hasShopifyScope(w.integration, 'write_fulfillments');
  const missingFulfillmentScopes =
    !isDemo && (!hasFoWriteScope || !hasFulfillWriteScope || !hasFoReadScope);

  const canMarkPaid =
    !isCancelled &&
    ['pending', 'authorized', 'partially_paid'].includes(fin) &&
    hasOrderWriteScope &&
    !hasActiveJob('MARK_PAID');
  const canInProgress =
    !isCancelled &&
    ['Unfulfilled', 'Scheduled'].includes(o.delivery) &&
    hasFoWriteScope &&
    !hasActiveJob('MARK_IN_PROGRESS');
  const canReopen =
    !isCancelled &&
    ['In progress', 'Scheduled'].includes(o.delivery) &&
    hasFoWriteScope &&
    !hasActiveJob('MARK_OPEN');
  const canHold =
    !isCancelled &&
    ['Unfulfilled', 'In progress', 'Scheduled'].includes(o.delivery) &&
    hasFoWriteScope &&
    !hasActiveJob('FULFILLMENT_HOLD');
  const canReleaseHold =
    !isCancelled &&
    o.delivery === 'On hold' &&
    hasFoWriteScope &&
    !hasActiveJob('FULFILLMENT_RELEASE');
  const isTrackingUpdateMode = ['In transit', 'Partially fulfilled', 'Delivered'].includes(
    o.delivery,
  );
  const canFulfillOrTrack =
    !isCancelled &&
    (isTrackingUpdateMode
      ? hasFulfillWriteScope && !hasActiveJob('UPDATE_TRACKING')
      : ['Unfulfilled', 'In progress', 'Scheduled', 'Partially fulfilled'].includes(o.delivery) &&
        hasFulfillWriteScope &&
        hasFoReadScope &&
        !hasActiveJob('FULFILL_ORDER'));
  const canMarkDelivered =
    !isCancelled &&
    ['In transit', 'Partially fulfilled'].includes(o.delivery) &&
    hasFulfillWriteScope &&
    !hasActiveJob('MARK_DELIVERED');

  const runShopifyAction = (
    payload: {
      action: ShopifyOrderAction;
      trackingCompany?: string;
      trackingNumber?: string;
      trackingUrl?: string;
      notifyCustomer?: boolean;
    },
    successMessage: string,
  ) =>
    void act(async () => {
      const r = await api<{ message?: string }>(`/orders/${o.id}/shopify-action`, payload);
      if (isDemo) await api('/jobs/run', {});
      return r.message || successMessage;
    }, successMessage);

  return (
    <Modal
      title={`Order ${o.number}`}
      subtitle={`${o.name} · ${money(o.amount, o.currency)}`}
      close={close}
    >
      <div className="order-detail">
        <div className="order-detail-badges">
          <Badge status={o.status} />
          <span className={`payment-pill ${paymentClass(o.financialStatus, o.isCod)}`}>
            <span aria-hidden="true" />
            {paymentLabel(o.financialStatus, o.isCod)}
          </span>
        </div>
        <span className={`fulfillment ${deliveryClass(o.delivery)}`}>
          <span />
          {o.delivery}
        </span>
      </div>
      <dl className="detail-grid">
        <div>
          <dt>Customer phone</dt>
          <dd>
            {o.phone ? `+${o.phone}` : 'Not available'}
            {!!o.linkedPhones?.length && (
              <small style={{ display: 'block', marginTop: 4 }}>
                Linked WhatsApp: {o.linkedPhones.map((p) => `+${p}`).join(', ')}
              </small>
            )}
          </dd>
        </div>
        <div>
          <dt>Payment method &amp; status</dt>
          <dd>
            {o.paymentMethod ?? (o.isCod === false ? 'Prepaid' : 'Cash on delivery')} ·{' '}
            {paymentLabel(o.financialStatus, o.isCod)}
          </dd>
        </div>
        <div>
          <dt>Fulfillment &amp; tracking</dt>
          <dd>
            {o.delivery}
            {(o.trackingCompany || o.trackingNumber) && (
              <small style={{ display: 'block', marginTop: 4 }}>
                {[o.trackingCompany, o.trackingNumber].filter(Boolean).join(' · ')}
              </small>
            )}
            {trackingHref && (
              <a
                href={trackingHref}
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4 }}
              >
                Track parcel <ExternalLink size={12} />
              </a>
            )}
          </dd>
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
        <strong>Shopify sync &amp; notices</strong>
        <p>
          {tagJob
            ? `Cancellation tags: ${tagJob.state}`
            : o.tags.includes(sync.confirmedTag)
              ? `${sync.confirmedTag} tag applied in Shopify.`
              : confirmTagJob
                ? `Confirmation tag (${sync.confirmedTag}): ${confirmTagJob.state}`
                : o.isCod === false
                  ? 'Prepaid / non-COD order synced for tracking and delivery updates.'
                  : 'No confirmation tag queued.'}
        </p>
        {reviewTagJob && (
          <p>
            Review tag ({sync.reviewTag}): {reviewTagJob.state.toLowerCase()}
          </p>
        )}
        {(holdJob || releaseJob || markProgressJob || markOpenJob) && (
          <p>
            {[
              holdJob && `Hold: ${holdJob.state.toLowerCase()}`,
              releaseJob && `Release hold: ${releaseJob.state.toLowerCase()}`,
              markProgressJob && `In progress: ${markProgressJob.state.toLowerCase()}`,
              markOpenJob && `Reopen: ${markOpenJob.state.toLowerCase()}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
        {(markPaidJob || fulfillJob || updateTrackingJob || markDeliveredJob) && (
          <p>
            {[
              markPaidJob && `Mark paid: ${markPaidJob.state.toLowerCase()}`,
              fulfillJob && `Fulfill: ${fulfillJob.state.toLowerCase()}`,
              updateTrackingJob && `Tracking update: ${updateTrackingJob.state.toLowerCase()}`,
              markDeliveredJob && `Mark delivered: ${markDeliveredJob.state.toLowerCase()}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
        {(dispatchJob || deliveryJob || paidNoticeJob || progressNoticeJob || holdNoticeJob) && (
          <p>
            {[
              paidNoticeJob && `Paid notice: ${paidNoticeJob.state.toLowerCase()}`,
              progressNoticeJob && `In-progress notice: ${progressNoticeJob.state.toLowerCase()}`,
              holdNoticeJob && `On-hold notice: ${holdNoticeJob.state.toLowerCase()}`,
              dispatchJob && `Dispatch notice: ${dispatchJob.state.toLowerCase()}`,
              deliveryJob && `Delivery notice: ${deliveryJob.state.toLowerCase()}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
        {w.jobs
          .filter(
            (j) =>
              j.orderId === o.id &&
              [
                'TAG',
                'REVIEW_TAG',
                'FULFILLMENT_HOLD',
                'FULFILLMENT_RELEASE',
                'MARK_PAID',
                'MARK_IN_PROGRESS',
                'MARK_OPEN',
                'FULFILL_ORDER',
                'UPDATE_TRACKING',
                'MARK_DELIVERED',
                'DISPATCH_NOTICE',
                'DELIVERY_NOTICE',
                'PAYMENT_NOTICE',
                'IN_PROGRESS_NOTICE',
                'ON_HOLD_NOTICE',
                'CANCEL_TAGS',
                'CANCEL_CLEANUP',
                'CANCEL',
              ].includes(j.kind) &&
              j.error,
          )
          .map((j) => (
            <p key={j.id}>{j.error}</p>
          ))}
        {o.messageBlockedReason && <p>{o.messageBlockedReason}</p>}
      </div>
      <div className="drawer-actions order-dialog-actions">
        <button
          type="button"
          className="button secondary"
          disabled={
            busy ||
            o.isCod === false ||
            fin !== 'pending' ||
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
          type="button"
          className="button primary"
          disabled={
            busy || cancellationPending || o.status === 'CONFIRMED' || o.status === 'CANCELLED'
          }
          onClick={() => {
            void act(
              () => api(`/orders/${o.id}/action`, { action: 'confirm' }),
              `Order confirmed. Shopify ${sync.confirmedTag} tag queued.`,
            );
          }}
        >
          <Check size={16} />
          Confirm order
        </button>
        <button
          type="button"
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
      <section
        className="shopify-actions-card"
        aria-label="Shopify payment and fulfillment actions"
      >
        <h3>Shopify payment &amp; fulfillment</h3>
        <div className="shopify-actions-row">
          <button
            type="button"
            className="button secondary"
            disabled={busy || !canMarkPaid}
            onClick={() =>
              runShopifyAction({ action: 'mark_paid' }, `Mark paid queued for ${o.number}.`)
            }
          >
            Mark paid
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || !canInProgress}
            onClick={() =>
              runShopifyAction(
                { action: 'mark_in_progress' },
                `Mark in progress queued for ${o.number}.`,
              )
            }
          >
            Mark in progress
          </button>
          {canReopen && (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() =>
                runShopifyAction({ action: 'reopen' }, `Reopen fulfillment queued for ${o.number}.`)
              }
            >
              Reopen (Unfulfilled)
            </button>
          )}
          {o.delivery === 'On hold' ? (
            <button
              type="button"
              className="button secondary"
              disabled={busy || !canReleaseHold}
              onClick={() =>
                runShopifyAction(
                  { action: 'release_hold' },
                  `Release Relay hold queued for ${o.number}.`,
                )
              }
            >
              Release hold
            </button>
          ) : (
            <button
              type="button"
              className="button secondary"
              disabled={busy || !canHold}
              onClick={() =>
                runShopifyAction({ action: 'hold' }, `Fulfillment hold queued for ${o.number}.`)
              }
            >
              Hold fulfillment
            </button>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={busy || !canMarkDelivered}
            onClick={() =>
              runShopifyAction(
                { action: 'mark_delivered' },
                `Mark delivered queued for ${o.number}.`,
              )
            }
          >
            Mark delivered
          </button>
        </div>
        {missingFulfillmentScopes && (
          <small className="muted" style={{ display: 'block', marginTop: 8 }}>
            Enable fulfillment write &amp; hold scopes under Integrations → Reconnect Shopify to run
            In progress, Hold, Fulfill, Tracking, and Delivered actions in live Shopify stores.
          </small>
        )}
        <form
          method="POST"
          className="shopify-fulfill-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy || !canFulfillOrTrack) return;
            const company = trackingCompany.trim();
            const num = trackingNumber.trim();
            const url = trackingUrl.trim();
            if (isTrackingUpdateMode && !company && !num && !url) {
              setTrackingError('Enter a courier, tracking number, or tracking URL.');
              return;
            }
            if (url && !url.startsWith('https://')) {
              setTrackingError('Tracking URL must start with https://');
              return;
            }
            setTrackingError('');
            runShopifyAction(
              {
                action: isTrackingUpdateMode ? 'update_tracking' : 'fulfill',
                ...(company ? { trackingCompany: company } : {}),
                ...(num ? { trackingNumber: num } : {}),
                ...(url ? { trackingUrl: url } : {}),
                notifyCustomer,
              },
              isTrackingUpdateMode
                ? `Tracking update queued for ${o.number}.`
                : `Fulfillment queued for ${o.number}.`,
            );
          }}
        >
          <div className="form-row">
            <div className="field">
              <label htmlFor={courierId}>Courier (optional)</label>
              <input
                id={courierId}
                name="trackingCompany"
                maxLength={100}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="e.g. TCS, Leopards, Trax"
                value={trackingCompany}
                onChange={(e) => setTrackingCompany(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor={trackNumId}>Tracking number (optional)</label>
              <input
                id={trackNumId}
                name="trackingNumber"
                maxLength={100}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="Tracking code"
                value={trackingNumber}
                onChange={(e) => setTrackingNumber(e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor={trackUrlId}>Tracking URL (optional)</label>
            <small id={trackUrlHintId}>
              Must start with https:// (for example https://track.example/123).
            </small>
            <input
              id={trackUrlId}
              name="trackingUrl"
              type="url"
              pattern="https://.*"
              maxLength={500}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-describedby={trackUrlHintId}
              placeholder="https://track.example/..."
              value={trackingUrl}
              onChange={(e) => setTrackingUrl(e.target.value)}
            />
          </div>
          <div className="checkbox-row">
            <input
              id={notifyCustId}
              name="notifyCustomer"
              type="checkbox"
              checked={notifyCustomer}
              onChange={(e) => setNotifyCustomer(e.target.checked)}
            />
            <label htmlFor={notifyCustId}>Notify customer by Shopify email as well</label>
          </div>
          {trackingError && (
            <div className="form-error" role="alert">
              {trackingError}
            </div>
          )}
          <div>
            <button
              type="submit"
              className="button secondary"
              disabled={busy || !canFulfillOrTrack}
            >
              {isTrackingUpdateMode ? 'Update Shopify tracking' : 'Mark fulfilled in Shopify'}
            </button>
          </div>
        </form>
      </section>
      <details style={{ marginBottom: 16 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
          Update customer messaging permission
        </summary>
        <form
          method="POST"
          className="form-stack"
          style={{ marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (busy || permissionEvidence.trim().length < 10) return;
            void act(async () => {
              await api(`/orders/${o.id}/permission`, {
                granted: permissionGranted,
                evidence: permissionEvidence.trim(),
              });
              setPermissionEvidence('');
            }, 'Messaging permission recorded.');
          }}
        >
          <div className="field">
            <label htmlFor={permSelectId}>Permission status</label>
            <select
              id={permSelectId}
              name="granted"
              value={permissionGranted ? 'grant' : 'revoke'}
              onChange={(e) => setPermissionGranted(e.target.value === 'grant')}
            >
              <option value="grant">Grant WhatsApp notification permission</option>
              <option value="revoke">Revoke WhatsApp notification permission</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor={permEvidenceId}>
              Consent evidence <span aria-hidden="true">*</span>
            </label>
            <input
              id={permEvidenceId}
              name="evidence"
              required
              minLength={10}
              maxLength={1000}
              value={permissionEvidence}
              onChange={(e) => setPermissionEvidence(e.target.value)}
              placeholder="e.g. Customer opted in via checkout SMS checkbox"
            />
            <small>Minimum 10 characters; stored in the workspace activity log.</small>
          </div>
          <button
            type="submit"
            className="button secondary"
            disabled={busy || permissionEvidence.trim().length < 10}
          >
            Save permission
          </button>
        </form>
      </details>
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
              <form
                method="POST"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (busy || !cancellationReason.trim() || !cancellationConfirmed) return;
                  void act(
                    () =>
                      api(`/tasks/${t.id}/action`, {
                        action: 'cancel',
                        reason: cancellationReason,
                        confirmed: cancellationConfirmed,
                      }),
                    'Cancellation queued. Track Shopify completion here.',
                  );
                }}
              >
                <div className="field">
                  <label htmlFor={`cancel-reason-${t.id}`}>
                    Cancellation reason <span aria-hidden="true">*</span>
                  </label>
                  <textarea
                    id={`cancel-reason-${t.id}`}
                    name="reason"
                    required
                    maxLength={255}
                    value={cancellationReason}
                    onChange={(e) => setCancellationReason(e.target.value)}
                    placeholder="Record why this order should be cancelled"
                  />
                </div>
                <div className="checkbox-row" style={{ marginBottom: 12 }}>
                  <input
                    id={`cancel-confirm-${t.id}`}
                    name="confirmed"
                    type="checkbox"
                    required
                    checked={cancellationConfirmed}
                    onChange={(e) => setCancellationConfirmed(e.target.checked)}
                  />
                  <label htmlFor={`cancel-confirm-${t.id}`}>
                    I reviewed payment, fulfillment and dispatch. Cancel this order in Shopify
                    (cannot be undone).
                  </label>
                </div>
                <button
                  type="submit"
                  className="button danger"
                  disabled={busy || !cancellationReason.trim() || !cancellationConfirmed}
                >
                  Approve &amp; cancel in Shopify
                </button>
              </form>
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
                type="button"
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
              <form
                method="POST"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (busy || !evidence.trim()) return;
                  void act(
                    () => api(`/tasks/${t.id}/action`, { action: 'verify', evidence }),
                    'Completion recorded with merchant verification.',
                  );
                }}
              >
                <div className="field">
                  <label htmlFor={`verify-evidence-${t.id}`}>
                    Completed action / verification reference <span aria-hidden="true">*</span>
                  </label>
                  <textarea
                    id={`verify-evidence-${t.id}`}
                    name="evidence"
                    required
                    value={evidence}
                    onChange={(e) => setEvidence(e.target.value)}
                    placeholder="For example: address updated in Shopify and courier portal; reference…"
                  />
                </div>
                <button
                  type="submit"
                  className="button primary"
                  disabled={busy || !evidence.trim()}
                >
                  Record completion
                </button>
              </form>
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
