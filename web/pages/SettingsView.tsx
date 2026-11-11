import { useEffect, useId, useState } from 'react';
import { Check, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import {
  hasShopifyScope,
  quickReplies as getQuickReplies,
  shopifySyncSettings,
  supportSettings,
} from '../../src/models/workspace-defaults';
import { api, type Snapshot } from '../api';
import { type Act } from '../lib/format';

export function SettingsView({ data, busy, act }: { data: Snapshot; busy: boolean; act: Act }) {
  const headingId = useId();
  const [base, setBase] = useState({
    timezone: data.workspace.settings.timezone,
    reminderHours: data.workspace.settings.reminderHours,
    policy: data.workspace.settings.policy,
  });
  const [sync, setSync] = useState(() => shopifySyncSettings(data.workspace));
  const [codKeywordsText, setCodKeywordsText] = useState(() =>
    shopifySyncSettings(data.workspace).codGatewayKeywords.join(', '),
  );
  const [checkoutValuesText, setCheckoutValuesText] = useState(() =>
    shopifySyncSettings(data.workspace).checkoutConsentValues.join(', '),
  );
  const [support, setSupport] = useState(() => supportSettings(data.workspace));
  const [optOutKwText, setOptOutKwText] = useState(() =>
    supportSettings(data.workspace).optOutKeywords.join(', '),
  );
  const [optInKwText, setOptInKwText] = useState(() =>
    supportSettings(data.workspace).optInKeywords.join(', '),
  );
  const [optOutPhones, setOptOutPhones] = useState(
    () => supportSettings(data.workspace).optedOutPhones,
  );
  const [optOutEdited, setOptOutEdited] = useState(false);
  useEffect(() => {
    if (!optOutEdited) {
      setOptOutPhones(supportSettings(data.workspace).optedOutPhones);
    }
  }, [data.workspace, optOutEdited]);
  const [replies, setReplies] = useState(() => getQuickReplies(data.workspace));
  const [formError, setFormError] = useState('');
  const holdScopeGranted = hasShopifyScope(
    data.workspace.integration,
    'write_merchant_managed_fulfillment_orders',
  );

  function parseKeywords(raw: string): string[] {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return (
    <div className="settings-layout">
      <section className="panel settings-card">
        <div className="panel-heading">
          <div>
            <h2 id={headingId}>Store &amp; automation preferences</h2>
            <p>Reliable, configurable defaults with zero hardcoded tags or bot copy.</p>
          </div>
        </div>
        <form
          method="POST"
          aria-labelledby={headingId}
          className="form-stack settings-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            const codGatewayKeywords = parseKeywords(codKeywordsText);
            const checkoutConsentValues = parseKeywords(checkoutValuesText).map((k) =>
              k.toLowerCase(),
            );
            const optOutKeywords = parseKeywords(optOutKwText).map((k) => k.toLowerCase());
            const optInKeywords = parseKeywords(optInKwText).map((k) => k.toLowerCase());
            const cleanReplies = replies
              .map((r) => ({ label: r.label.trim(), body: r.body.trim() }))
              .filter((r) => r.label && r.body);
            if (!codGatewayKeywords.length) {
              setFormError(
                'Enter at least one COD gateway keyword (for example: cash on delivery, cod).',
              );
              return;
            }
            if (sync.checkoutConsentAttributeKey.trim() && !checkoutConsentValues.length) {
              setFormError(
                'Enter at least one accepted opt-in attribute value (or clear the attribute key).',
              );
              return;
            }
            if (!optOutKeywords.length || !optInKeywords.length) {
              setFormError('Enter at least one opt-out and one opt-in keyword.');
              return;
            }
            setFormError('');
            void act(async () => {
              await api(
                '/settings',
                {
                  ...data.workspace.settings,
                  timezone: base.timezone,
                  reminderHours: base.reminderHours,
                  policy: base.policy.trim(),
                  shopifySync: {
                    ...sync,
                    codGatewayKeywords,
                    confirmedTag: sync.confirmedTag.trim(),
                    reviewTag: sync.reviewTag.trim(),
                    cancellationRequestedTag: sync.cancellationRequestedTag.trim(),
                    holdReasonNotes: sync.holdReasonNotes.trim(),
                    syncCustomerSmsConsent: sync.syncCustomerSmsConsent,
                    checkoutConsentAttributeKey: sync.checkoutConsentAttributeKey.trim(),
                    checkoutConsentValues,
                  },
                  support: {
                    ...support,
                    optOutKeywords,
                    optInKeywords,
                    optedOutPhones: optOutEdited ? optOutPhones : undefined,
                  },
                  quickReplies: cleanReplies,
                },
                'PUT',
              );
              setOptOutEdited(false);
            }, 'Store preferences saved');
          }}
        >
          <fieldset className="settings-fieldset">
            <legend>Store &amp; timing defaults</legend>
            <div className="field">
              <label htmlFor="pref-brand">Store name</label>
              <input id="pref-brand" name="brandName" value={data.merchant.brandName} readOnly />
              <small>Account branding is set during registration.</small>
            </div>
            <div className="form-row">
              <div className="field">
                <label htmlFor="pref-tz">Reporting timezone</label>
                <select
                  id="pref-tz"
                  name="timezone"
                  value={base.timezone}
                  onChange={(e) => setBase({ ...base, timezone: e.target.value })}
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
              </div>
              <div className="field">
                <label htmlFor="pref-reminder-hours">
                  Reminder delay (hours) <span aria-hidden="true">*</span>
                </label>
                <input
                  id="pref-reminder-hours"
                  name="reminderHours"
                  type="number"
                  required
                  min={1}
                  max={72}
                  step={1}
                  value={base.reminderHours}
                  onChange={(e) => setBase({ ...base, reminderHours: Number(e.target.value) })}
                />
                <small>Choose a whole number from 1 to 72.</small>
              </div>
            </div>
            <div className="field">
              <label htmlFor="pref-policy">
                Approved FAQ response <span aria-hidden="true">*</span>
              </label>
              <textarea
                id="pref-policy"
                name="policy"
                required
                rows={4}
                maxLength={3000}
                value={base.policy}
                onChange={(e) => setBase({ ...base, policy: e.target.value })}
              />
              <small>
                The rules-based assistant uses this exact text for policy &amp; Help menu replies.
              </small>
            </div>
          </fieldset>

          <fieldset className="settings-fieldset">
            <legend>Shopify sync, tags &amp; fulfillment holds</legend>
            <div className="checkbox-row">
              <input
                id="sync-noncod"
                name="importNonCodOrders"
                type="checkbox"
                checked={sync.importNonCodOrders}
                onChange={(e) => setSync({ ...sync, importNonCodOrders: e.target.checked })}
              />
              <label htmlFor="sync-noncod">
                Import Prepaid / Non-COD orders for read-only WhatsApp tracking and delivery alerts
              </label>
            </div>
            <div className="field">
              <label htmlFor="sync-cod-keywords">
                COD payment gateway keywords <span aria-hidden="true">*</span>
              </label>
              <input
                id="sync-cod-keywords"
                name="codGatewayKeywords"
                required
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                value={codKeywordsText}
                onChange={(e) => setCodKeywordsText(e.target.value)}
              />
              <small>
                Comma-separated gateway names treated as COD (e.g. cash on delivery, cod).
              </small>
            </div>
            <div className="form-row">
              <div className="field">
                <label htmlFor="tag-confirmed">
                  Confirmed Shopify tag <span aria-hidden="true">*</span>
                </label>
                <input
                  id="tag-confirmed"
                  name="confirmedTag"
                  required
                  maxLength={60}
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={sync.confirmedTag}
                  onChange={(e) => setSync({ ...sync, confirmedTag: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="tag-review">
                  Needs review tag <span aria-hidden="true">*</span>
                </label>
                <input
                  id="tag-review"
                  name="reviewTag"
                  required
                  maxLength={60}
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={sync.reviewTag}
                  onChange={(e) => setSync({ ...sync, reviewTag: e.target.value })}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="tag-cancel">
                Cancellation requested tag <span aria-hidden="true">*</span>
              </label>
              <input
                id="tag-cancel"
                name="cancellationRequestedTag"
                required
                maxLength={60}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                value={sync.cancellationRequestedTag}
                onChange={(e) => setSync({ ...sync, cancellationRequestedTag: e.target.value })}
              />
            </div>
            <div className="checkbox-row">
              <input
                id="sync-tag-review"
                name="tagOnReview"
                type="checkbox"
                checked={sync.tagOnReview}
                onChange={(e) => setSync({ ...sync, tagOnReview: e.target.checked })}
              />
              <label htmlFor="sync-tag-review">
                Apply Needs review tag in Shopify when an order moves to review
              </label>
            </div>
            {!holdScopeGranted && (
              <p className="muted" style={{ margin: 0 }}>
                To place or release Shopify holds automatically, enable fulfillment scopes under
                Integrations → Reconnect Shopify.
              </p>
            )}
            <div className="checkbox-row">
              <input
                id="hold-unconfirmed"
                name="autoHoldUnconfirmed"
                type="checkbox"
                checked={sync.autoHoldUnconfirmed}
                onChange={(e) => setSync({ ...sync, autoHoldUnconfirmed: e.target.checked })}
              />
              <label htmlFor="hold-unconfirmed">
                Auto-hold unconfirmed COD fulfillment orders in Shopify until customer confirms
              </label>
            </div>
            <div className="checkbox-row">
              <input
                id="hold-review"
                name="holdOnReview"
                type="checkbox"
                checked={sync.holdOnReview}
                onChange={(e) => setSync({ ...sync, holdOnReview: e.target.checked })}
              />
              <label htmlFor="hold-review">
                Place Shopify fulfillment hold when order moves to Needs review
              </label>
            </div>
            <div className="checkbox-row">
              <input
                id="hold-cancel"
                name="holdOnCancellationRequest"
                type="checkbox"
                checked={sync.holdOnCancellationRequest}
                onChange={(e) => setSync({ ...sync, holdOnCancellationRequest: e.target.checked })}
              />
              <label htmlFor="hold-cancel">
                Place Shopify fulfillment hold on customer cancellation request
              </label>
            </div>
            <div className="checkbox-row">
              <input
                id="hold-release"
                name="releaseHoldOnConfirm"
                type="checkbox"
                checked={sync.releaseHoldOnConfirm}
                onChange={(e) => setSync({ ...sync, releaseHoldOnConfirm: e.target.checked })}
              />
              <label htmlFor="hold-release">
                Release Relay-owned Shopify holds automatically when order is confirmed
              </label>
            </div>
            <div className="field">
              <label htmlFor="hold-reason">
                Shopify hold reason notes <span aria-hidden="true">*</span>
              </label>
              <input
                id="hold-reason"
                name="holdReasonNotes"
                required
                maxLength={250}
                value={sync.holdReasonNotes}
                onChange={(e) => setSync({ ...sync, holdReasonNotes: e.target.value })}
              />
            </div>
            <div className="checkbox-row">
              <input
                id="sync-sms-consent"
                name="syncCustomerSmsConsent"
                type="checkbox"
                checked={sync.syncCustomerSmsConsent}
                onChange={(e) => setSync({ ...sync, syncCustomerSmsConsent: e.target.checked })}
              />
              <label htmlFor="sync-sms-consent">
                Sync explicit Shopify SMS / checkout opt-in into Relay messaging permission
                (entering a phone number alone never grants permission)
              </label>
            </div>
            <div className="form-row">
              <div className="field">
                <label htmlFor="sync-consent-key">Checkout note attribute key</label>
                <input
                  id="sync-consent-key"
                  name="checkoutConsentAttributeKey"
                  maxLength={60}
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={sync.checkoutConsentAttributeKey}
                  placeholder="whatsapp_opt_in"
                  onChange={(e) =>
                    setSync({ ...sync, checkoutConsentAttributeKey: e.target.value })
                  }
                />
                <small>
                  Optional Shopify cart/checkout attribute key recording explicit WhatsApp opt-in.
                </small>
              </div>
              <div className="field">
                <label htmlFor="sync-consent-values">Accepted opt-in values</label>
                <input
                  id="sync-consent-values"
                  name="checkoutConsentValues"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={checkoutValuesText}
                  placeholder="yes, true, 1, opt_in, subscribed"
                  onChange={(e) => setCheckoutValuesText(e.target.value)}
                />
                <small>Comma-separated values treated as explicit consent.</small>
              </div>
            </div>
          </fieldset>

          <fieldset className="settings-fieldset">
            <legend>WhatsApp Help menu &amp; opt-out rules</legend>
            <div className="field">
              <label htmlFor="sup-menu-body">
                Interactive Help menu message <span aria-hidden="true">*</span>
              </label>
              <textarea
                id="sup-menu-body"
                name="menuBody"
                required
                rows={2}
                maxLength={1024}
                value={support.menuBody}
                onChange={(e) => setSupport({ ...support, menuBody: e.target.value })}
              />
              <small>Use {'{{brand_name}}'} to insert your store name dynamically.</small>
            </div>
            <div className="form-row">
              <div className="field">
                <label htmlFor="sup-menu-footer">Menu footer text</label>
                <input
                  id="sup-menu-footer"
                  name="menuFooter"
                  maxLength={60}
                  value={support.menuFooter}
                  onChange={(e) => setSupport({ ...support, menuFooter: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="sup-cooldown">
                  Menu cooldown (hours) <span aria-hidden="true">*</span>
                </label>
                <input
                  id="sup-cooldown"
                  name="menuCooldownHours"
                  type="number"
                  required
                  min={1}
                  max={72}
                  value={support.menuCooldownHours}
                  onChange={(e) =>
                    setSupport({ ...support, menuCooldownHours: Number(e.target.value) })
                  }
                />
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label htmlFor="sup-btn-status">Status button label (max 20 chars)</label>
                <input
                  id="sup-btn-status"
                  name="statusButtonTitle"
                  required
                  maxLength={20}
                  value={support.statusButtonTitle}
                  onChange={(e) => setSupport({ ...support, statusButtonTitle: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="sup-btn-policy">Policy button label (max 20 chars)</label>
                <input
                  id="sup-btn-policy"
                  name="policyButtonTitle"
                  required
                  maxLength={20}
                  value={support.policyButtonTitle}
                  onChange={(e) => setSupport({ ...support, policyButtonTitle: e.target.value })}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="sup-btn-human">Human support button label (max 20 chars)</label>
              <input
                id="sup-btn-human"
                name="humanButtonTitle"
                required
                maxLength={20}
                value={support.humanButtonTitle}
                onChange={(e) => setSupport({ ...support, humanButtonTitle: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="sup-handoff">Human handoff reply</label>
              <textarea
                id="sup-handoff"
                name="handoffText"
                required
                rows={2}
                maxLength={1000}
                value={support.handoffText}
                onChange={(e) => setSupport({ ...support, handoffText: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="sup-no-order">Unmatched phone reply</label>
              <textarea
                id="sup-no-order"
                name="noOrderText"
                required
                rows={2}
                maxLength={1000}
                value={support.noOrderText}
                onChange={(e) => setSupport({ ...support, noOrderText: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="sup-clarify">Multi-order clarify reply</label>
              <input
                id="sup-clarify"
                name="clarifyText"
                required
                maxLength={1000}
                value={support.clarifyText}
                onChange={(e) => setSupport({ ...support, clarifyText: e.target.value })}
              />
              <small>Use {'{{orders}}'} where customer order numbers should appear.</small>
            </div>
            <div className="form-row">
              <div className="field">
                <label htmlFor="sup-optout-kw">Opt-out keywords</label>
                <input
                  id="sup-optout-kw"
                  name="optOutKeywords"
                  required
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={optOutKwText}
                  onChange={(e) => setOptOutKwText(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="sup-optin-kw">Opt-in keywords</label>
                <input
                  id="sup-optin-kw"
                  name="optInKeywords"
                  required
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={optInKwText}
                  onChange={(e) => setOptInKwText(e.target.value)}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="sup-optout-ack">Opt-out confirmation message</label>
              <textarea
                id="sup-optout-ack"
                name="optOutConfirmationText"
                required
                rows={2}
                maxLength={1000}
                value={support.optOutConfirmationText}
                onChange={(e) => setSupport({ ...support, optOutConfirmationText: e.target.value })}
              />
            </div>
            <div className="field">
              <span>Opted-out WhatsApp numbers ({optOutPhones.length})</span>
              <div className="var-order-list">
                {optOutPhones.map((num) => (
                  <span key={num} className="var-chip">
                    +{num}
                    <button
                      type="button"
                      className="chip-icon-btn"
                      aria-label={`Re-enable messages for +${num}`}
                      onClick={() => {
                        setOptOutPhones((prev) => prev.filter((p) => p !== num));
                        setOptOutEdited(true);
                      }}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </span>
                ))}
                {!optOutPhones.length && <small>No customers have opted out.</small>}
              </div>
            </div>
          </fieldset>

          <fieldset className="settings-fieldset">
            <legend>Inbox quick replies</legend>
            {replies.map((reply, idx) => (
              <div key={idx} className="quick-reply-editor">
                <div className="form-row">
                  <div className="field">
                    <label htmlFor={`qr-label-${idx}`}>Chip label</label>
                    <input
                      id={`qr-label-${idx}`}
                      name={`quickReplyLabel_${idx}`}
                      maxLength={40}
                      value={reply.label}
                      onChange={(e) =>
                        setReplies((prev) =>
                          prev.map((item, i) =>
                            i === idx ? { ...item, label: e.target.value } : item,
                          ),
                        )
                      }
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`qr-body-${idx}`}>Message snippet</label>
                    <input
                      id={`qr-body-${idx}`}
                      name={`quickReplyBody_${idx}`}
                      maxLength={1000}
                      value={reply.body}
                      onChange={(e) =>
                        setReplies((prev) =>
                          prev.map((item, i) =>
                            i === idx ? { ...item, body: e.target.value } : item,
                          ),
                        )
                      }
                    />
                  </div>
                </div>
                <button
                  type="button"
                  className="text-button danger-text"
                  onClick={() => setReplies((prev) => prev.filter((_, i) => i !== idx))}
                >
                  <Trash2 size={13} aria-hidden="true" />
                  Remove
                </button>
              </div>
            ))}
            {replies.length < 20 && (
              <div>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setReplies((prev) => [...prev, { label: '', body: '' }])}
                >
                  <Plus size={15} aria-hidden="true" />
                  Add quick reply
                </button>
              </div>
            )}
          </fieldset>

          {formError && (
            <div className="form-error" role="alert">
              {formError}
            </div>
          )}
          <button type="submit" className="button primary" disabled={busy}>
            <Check size={16} />
            Save preferences
          </button>
        </form>
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
            Opt-out keywords (STOP) cancel queued sends
          </li>
          <li>
            <Check size={16} />
            Relay only releases holds that Relay created
          </li>
          <li>
            <Check size={16} />
            No automatic refunds or unapproved edits
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
