import { useEffect, useId, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BellRing,
  Check,
  Link2,
  Loader2,
  LockKeyhole,
  MessageCircle,
  Pencil,
  Plus,
  Send,
  ShoppingBag,
  X,
} from 'lucide-react';
import type { DispatchVariableKey } from '../../src/models/types';
import {
  dispatchSettings,
  hasShopifyScope,
  shopifySyncSettings,
} from '../../src/models/workspace-defaults';
import { api, type Snapshot } from '../api';
import { type Act } from '../lib/format';
import { Modal } from '../components/ui';

const DISPATCH_VAR_LABELS: Record<DispatchVariableKey, string> = {
  customer_name: 'Customer name',
  brand_name: 'Brand name',
  order_number: 'Order #',
  courier: 'Courier',
  tracking_number: 'Tracking #',
  tracking_url: 'Tracking URL',
  total_amount: 'Order total',
};

const ALL_DISPATCH_VARS: DispatchVariableKey[] = [
  'customer_name',
  'brand_name',
  'order_number',
  'courier',
  'tracking_number',
  'tracking_url',
  'total_amount',
];

function VariableOrderPicker({
  label,
  selected,
  onChange,
}: {
  label: string;
  selected: DispatchVariableKey[];
  onChange: (next: DispatchVariableKey[]) => void;
}) {
  const remaining = ALL_DISPATCH_VARS.filter((v) => !selected.includes(v));
  const selectId = useId();
  return (
    <div className="field">
      <label htmlFor={selectId}>{label}</label>
      <div className="var-order-list">
        {selected.map((v, idx) => (
          <span key={v} className="var-chip">
            <code>{`{{${idx + 1}}}`}</code>
            <span>{DISPATCH_VAR_LABELS[v]}</span>
            {idx > 0 && (
              <button
                type="button"
                className="chip-icon-btn"
                aria-label={`Move ${DISPATCH_VAR_LABELS[v]} earlier`}
                onClick={() => {
                  const next = [...selected];
                  [next[idx - 1], next[idx]] = [next[idx]!, next[idx - 1]!];
                  onChange(next);
                }}
              >
                <ArrowLeft size={12} aria-hidden="true" />
              </button>
            )}
            {idx < selected.length - 1 && (
              <button
                type="button"
                className="chip-icon-btn"
                aria-label={`Move ${DISPATCH_VAR_LABELS[v]} later`}
                onClick={() => {
                  const next = [...selected];
                  [next[idx + 1], next[idx]] = [next[idx]!, next[idx + 1]!];
                  onChange(next);
                }}
              >
                <ArrowRight size={12} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="chip-icon-btn"
              aria-label={`Remove ${DISPATCH_VAR_LABELS[v]}`}
              onClick={() => onChange(selected.filter((item) => item !== v))}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
        {!selected.length && <small>No body variables selected.</small>}
      </div>
      {remaining.length > 0 && (
        <select
          id={selectId}
          value=""
          onChange={(e) => {
            const val = e.target.value as DispatchVariableKey;
            if (val && !selected.includes(val)) onChange([...selected, val]);
          }}
        >
          <option value="">+ Add variable…</option>
          {remaining.map((v) => (
            <option key={v} value={v}>
              {DISPATCH_VAR_LABELS[v]}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

export function Integrations({ data, busy, act }: { data: Snapshot; busy: boolean; act: Act }) {
  const i = data.workspace.integration;
  const sync = shopifySyncSettings(data.workspace);
  const fulfillmentWriteGranted =
    hasShopifyScope(i, 'write_fulfillments') &&
    hasShopifyScope(i, 'write_merchant_managed_fulfillment_orders');
  const readFulfillmentOnly = !fulfillmentWriteGranted && hasShopifyScope(i, 'read_fulfillments');
  const [includeFulfillmentScopes, setIncludeFulfillmentScopes] = useState(
    fulfillmentWriteGranted || hasShopifyScope(i, 'write_merchant_managed_fulfillment_orders'),
  );
  const [form, setForm] = useState({
    shopDomain: i.shopDomain,
    shopifyToken: '',
    phoneNumberId: i.phoneNumberId,
    wabaId: i.wabaId,
    whatsappToken: '',
    metaAppSecret: '',
    templateName: i.templateName,
    languageCode: i.languageCode,
  });
  const [dispatchForm, setDispatchForm] = useState(() => dispatchSettings(data.workspace));
  const [templateModal, setTemplateModal] = useState<{
    open: boolean;
    mode: 'add' | 'edit';
    oldId: string;
    name: string;
    language: string;
  }>({
    open: false,
    mode: 'add',
    oldId: '',
    name: '',
    language: 'en',
  });
  const [result, setResult] = useState<Record<string, string>>({});
  const [verifyToken, setVerifyToken] = useState('');
  const [copied, setCopied] = useState('');
  const [testRecipient, setTestRecipient] = useState(data.workspace.settings.testRecipient ?? '');
  const [ownVerifiedNumber, setOwnVerifiedNumber] = useState(false);
  const [testSending, setTestSending] = useState(false);
  const holdScopeId = useId();
  const dispatchHeadingId = useId();
  const cooldownKey = 'relay-test-cooldown:' + data.merchant.id;
  const [cooldownUntil, setCooldownUntil] = useState(() => {
    try {
      return Number(sessionStorage.getItem(cooldownKey)) || 0;
    } catch {
      return 0;
    }
  });
  const [now, setNow] = useState(Date.now());
  const cooldownSeconds = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const startCooldown = (seconds: number) => {
    const until = Date.now() + seconds * 1000;
    setNow(Date.now());
    setCooldownUntil(until);
    try {
      sessionStorage.setItem(cooldownKey, String(until));
    } catch {
      /* Storage may be unavailable. */
    }
  };
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);
  const [connecting, setConnecting] = useState(false);
  const [oauth, setOauth] = useState<{
    configured: boolean;
    appUrl: string;
    callbackUrl: string;
    webhookUrl: string;
    scopes: string[];
    fulfillmentScopes?: string[];
    reason: string | null;
  }>();
  useEffect(() => {
    void api<typeof oauth>('/integrations/shopify/config')
      .then(setOauth)
      .catch(() =>
        setResult((r) => ({
          ...r,
          shopify: 'Could not load Shopify settings. Reload to try again.',
        })),
      );
  }, []);
  const correctOrigin = oauth?.appUrl === location.origin;
  const credentialsDirty =
    !!form.whatsappToken || form.phoneNumberId !== i.phoneNumberId || form.wabaId !== i.wabaId;
  const templateDirty =
    form.templateName !== i.templateName || form.languageCode !== i.languageCode;
  const dirty =
    !!form.metaAppSecret ||
    credentialsDirty ||
    templateDirty ||
    testRecipient !== (data.workspace.settings.testRecipient ?? '');
  const sendReason =
    data.mode === 'demo'
      ? 'Live messages are unavailable in demo mode.'
      : credentialsDirty
        ? 'Save your updated WhatsApp credentials, then test the connection.'
        : !i.hasWhatsappToken
          ? 'Save your WhatsApp credentials first.'
          : !i.whatsappVerifiedAt
            ? 'Click Test connections to verify the saved connection first.'
            : !/^\+?[1-9]\d{9,14}$/.test(testRecipient.trim())
              ? 'Enter your test number with its country code.'
              : !ownVerifiedNumber
                ? 'Confirm below that this is your verified test number.'
                : '';
  const rawTemplates = [...(data.workspace.settings.savedTemplates ?? [])];
  for (const value of [i, form]) {
    const id = value.templateName + ':' + value.languageCode;
    if (
      !rawTemplates.some(
        (t) => t.id === id || (t.name === value.templateName && t.language === value.languageCode),
      )
    )
      rawTemplates.push({ id, name: value.templateName, language: value.languageCode });
  }
  const seenTemplates = new Set<string>();
  const templates = rawTemplates.filter((t) => {
    const key = `${t.name}:${t.language}`;
    if (seenTemplates.has(key)) return false;
    seenTemplates.add(key);
    return true;
  });

  const handleSaveTemplateModal = () => {
    const name = templateModal.name.trim();
    const language = templateModal.language.trim();
    if (!name || !language) return;
    void act(async () => {
      if (templateModal.mode === 'add') {
        const res = await api<{ ok: boolean; id: string }>('/integrations/whatsapp/templates', {
          name,
          language,
        });
        setForm((f) => ({ ...f, templateName: name, languageCode: language }));
        const currentSaved = (data.workspace.settings.savedTemplates ??= []);
        if (
          !currentSaved.some((t) => t.id === res.id || (t.name === name && t.language === language))
        ) {
          currentSaved.push({ id: res.id, name, language });
        }
      } else {
        await api('/integrations/whatsapp/templates/update', {
          oldId: templateModal.oldId,
          name,
          language,
        });
        setForm((f) => ({ ...f, templateName: name, languageCode: language }));
        const currentSaved = (data.workspace.settings.savedTemplates ??= []);
        const idx = currentSaved.findIndex(
          (t) => t.id === templateModal.oldId || `${t.name}:${t.language}` === templateModal.oldId,
        );
        const newId = `${name}:${language}`;
        if (idx !== -1) {
          currentSaved[idx] = { id: newId, name, language };
        } else {
          currentSaved.push({ id: newId, name, language });
        }
      }
      setTemplateModal((m) => ({ ...m, open: false }));
    }, templateModal.mode === 'add' ? 'Template saved. Click Save WhatsApp to activate it.' : 'Template updated.');
  };

  const handleDeleteTemplate = (idToDelete: string) => {
    void act(async () => {
      await api('/integrations/whatsapp/templates/delete', { id: idToDelete });
      const currentSaved = (data.workspace.settings.savedTemplates ?? []).filter(
        (t) => t.id !== idToDelete && `${t.name}:${t.language}` !== idToDelete,
      );
      data.workspace.settings.savedTemplates = currentSaved;
      const currentId = `${form.templateName}:${form.languageCode}`;
      if (currentId === idToDelete || form.templateName === idToDelete.split(':')[0]) {
        const fallback = currentSaved[0] ?? { name: 'relay_order_confirmation_v1', language: 'en' };
        setForm((f) => ({ ...f, templateName: fallback.name, languageCode: fallback.language }));
      }
      setTemplateModal((m) => ({ ...m, open: false }));
    }, 'Template removed from saved templates.');
  };
  const checkConnections = () => {
    void act(async () => {
      setResult((v) => ({ ...v, connections: 'Checking saved connections…' }));
      const checks: PromiseSettledResult<{ message: string }>[] = [];
      for (const provider of ['shopify', 'whatsapp']) {
        try {
          checks.push({
            status: 'fulfilled',
            value: await api<{ message: string }>('/integrations/test', { provider }),
          });
        } catch (reason) {
          checks.push({ status: 'rejected', reason });
        }
      }
      const labels = ['Shopify', 'WhatsApp'];
      const lines = checks.map(
        (r, index) =>
          labels[index] +
          ': ' +
          (r.status === 'fulfilled'
            ? data.mode === 'demo'
              ? 'Demo check passed'
              : 'Connected'
            : r.reason instanceof Error
              ? r.reason.message
              : 'Check failed'),
      );
      setResult((v) => ({
        ...v,
        connections:
          lines.join(' · ') +
          (checks.every((r) => r.status === 'fulfilled') ? ' · Both connections successful.' : ''),
      }));
    }, 'Connection checks completed');
  };
  const validateTemplate = () => {
    void act(async () => {
      const r = await api<{ message: string }>('/integrations/whatsapp/validate-template', {
        kind: 'confirmation',
      });
      setResult((v) => ({ ...v, template: r.message }));
    }, 'Template validation complete');
  };
  type NoticeTemplateKind = 'dispatch' | 'delivery' | 'paid' | 'in_progress' | 'on_hold';
  const validateNoticeTemplate = (kind: NoticeTemplateKind) => {
    const configByKind: Record<
      NoticeTemplateKind,
      {
        label: string;
        templateName: string;
        languageCode: string;
        variables: DispatchVariableKey[];
        includeTrackingButtonUrl: boolean;
      }
    > = {
      dispatch: {
        label: 'Dispatch',
        templateName: dispatchForm.templateName.trim(),
        languageCode: dispatchForm.languageCode.trim(),
        variables: dispatchForm.variables,
        includeTrackingButtonUrl: dispatchForm.includeTrackingButtonUrl,
      },
      delivery: {
        label: 'Delivery',
        templateName: dispatchForm.deliveredTemplateName.trim(),
        languageCode: dispatchForm.deliveredLanguageCode.trim(),
        variables: dispatchForm.deliveredVariables,
        includeTrackingButtonUrl: false,
      },
      paid: {
        label: 'Payment confirmation',
        templateName: dispatchForm.paidTemplateName.trim(),
        languageCode: dispatchForm.paidLanguageCode.trim(),
        variables: dispatchForm.paidVariables,
        includeTrackingButtonUrl: false,
      },
      in_progress: {
        label: 'In-progress',
        templateName: dispatchForm.inProgressTemplateName.trim(),
        languageCode: dispatchForm.inProgressLanguageCode.trim(),
        variables: dispatchForm.inProgressVariables,
        includeTrackingButtonUrl: false,
      },
      on_hold: {
        label: 'On-hold',
        templateName: dispatchForm.onHoldTemplateName.trim(),
        languageCode: dispatchForm.onHoldLanguageCode.trim(),
        variables: dispatchForm.onHoldVariables,
        includeTrackingButtonUrl: false,
      },
    };
    const cfg = configByKind[kind];
    void act(async () => {
      const r = await api<{ message: string }>('/integrations/whatsapp/validate-template', {
        kind,
        templateName: cfg.templateName,
        languageCode: cfg.languageCode,
        variables: cfg.variables,
        includeTrackingButtonUrl: cfg.includeTrackingButtonUrl,
      });
      setResult((v) => ({ ...v, [kind]: r.message }));
    }, `${cfg.label} template validated`);
  };
  const save = (scope: 'all' | 'shopify' | 'whatsapp' = 'all') => {
    void act(
      async () => {
        const savedMeta = {
          phoneNumberId: i.phoneNumberId,
          wabaId: i.wabaId,
          templateName: i.templateName,
          languageCode: i.languageCode,
          whatsappToken: '',
          metaAppSecret: '',
        };
        const payload =
          scope === 'shopify'
            ? { ...savedMeta, shopDomain: form.shopDomain, shopifyToken: form.shopifyToken }
            : {
                ...form,
                ...(scope === 'whatsapp' ? { shopDomain: i.shopDomain, shopifyToken: '' } : {}),
                testRecipient,
              };
        await api('/integrations', {
          ...payload,
          ...(data.mode !== 'demo' ? { shopDomain: i.shopDomain, shopifyToken: '' } : {}),
        });
        setForm((f) => ({
          ...f,
          ...(scope !== 'whatsapp' ? { shopifyToken: '' } : {}),
          ...(scope !== 'shopify' ? { whatsappToken: '', metaAppSecret: '' } : {}),
        }));
        setResult((v) => ({
          ...v,
          saved:
            scope === 'all'
              ? 'All settings saved.'
              : scope === 'shopify'
                ? 'Shopify settings saved.'
                : 'WhatsApp settings saved.',
        }));
      },
      scope === 'all'
        ? 'All settings saved'
        : scope === 'shopify'
          ? 'Shopify saved'
          : 'WhatsApp saved',
    );
  };
  const field = (key: keyof typeof form, label: string, placeholder: string, secret = false) => (
    <label className="field">
      <span>{label}</span>
      <input
        name={key}
        autoComplete={secret ? 'new-password' : 'off'}
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        type={secret ? 'password' : 'text'}
        value={form[key]}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        placeholder={placeholder}
      />
      {secret && (
        <small>
          {i.hasWhatsappToken && key === 'whatsappToken'
            ? 'Saved token in use. Leave blank to keep it; enter a new token only to replace it.'
            : 'Leave blank to keep the saved token.'}
        </small>
      )}
    </label>
  );
  return (
    <>
      <section className="panel integration-toolbar" aria-label="Integration actions">
        <div>
          <strong>Connection checks</strong>
          <small>
            {dirty
              ? 'You have unsaved changes. Save before checking updated settings.'
              : 'Checks use saved credentials.'}
          </small>
        </div>
        <div className="integration-quick-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy || testSending}
            onClick={checkConnections}
          >
            <Link2 size={16} />
            Test connections
          </button>
          <button
            type="button"
            className="button primary"
            disabled={busy || testSending}
            onClick={() => save()}
          >
            {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />}Save all
          </button>
        </div>
        {(templateDirty || credentialsDirty) && (
          <small>Save changes to enable checks for the updated connection and template.</small>
        )}
        {Object.entries(result)
          .filter(([key]) => key !== 'testSend' && key !== 'clipboard')
          .map(([key, value]) => (
            <div className="inline-result" role="status" key={key}>
              {value}
            </div>
          ))}
      </section>
      <div className="integration-grid">
        <section className="panel integration-card">
          <div className="integration-title">
            <span className="integration-logo shopify">
              <ShoppingBag size={26} />
            </span>
            <div>
              <h2>Shopify</h2>
              <p>Your orders and store operations</p>
            </div>
            <span className={`pill ${i.shopifyVerifiedAt ? 'green' : ''}`}>
              {i.shopifyVerifiedAt ? 'Verified' : 'Not connected'}
            </span>
          </div>
          <div className="form-stack">
            {field('shopDomain', 'Store domain', 'your-store.myshopify.com')}
            {data.mode === 'demo' &&
              field(
                'shopifyToken',
                'Admin API access token',
                i.hasShopifyToken
                  ? 'A token is securely stored'
                  : 'Enter your authorized store token',
                true,
              )}

            {data.mode !== 'demo' && (
              <>
                <div className="scope-note">
                  <div>
                    <strong>Fulfillment &amp; hold scopes: </strong>
                    <span className={`pill ${fulfillmentWriteGranted ? 'green' : ''}`}>
                      {fulfillmentWriteGranted
                        ? 'Granted'
                        : readFulfillmentOnly
                          ? 'Reconnect required for fulfillment writes'
                          : 'Optional (reconnect to enable fulfillment & holds)'}
                    </span>
                    <small style={{ display: 'block', marginTop: 6 }}>
                      {readFulfillmentOnly
                        ? 'Your store currently grants read-only fulfillment access (read_fulfillments). Reconnect with fulfillment scopes checked to fulfill orders, update tracking, place or release holds, and mark delivered from Relay.'
                        : 'Core order, payment, and cancellation sync works with standard scopes. Reconnect with fulfillment scopes to fulfill orders, update tracking, manage Relay holds, and mark delivered from Relay.'}
                    </small>
                  </div>
                </div>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy || !oauth?.configured || !i.hasShopifyToken}
                  onClick={() => {
                    void act(async () => {
                      const r = await api('/integrations/shopify/webhooks', {});
                      setResult((v) => ({ ...v, shopify: r.message ?? 'Webhooks verified' }));
                    }, 'Shopify webhooks checked');
                  }}
                >
                  <Link2 size={16} />
                  {i.shopifyWebhooksUrl === oauth?.webhookUrl && i.shopifyWebhooksVerifiedAt
                    ? 'Verify webhooks'
                    : 'Register webhooks'}
                </button>
                <small>
                  {i.shopifyWebhooksUrl === oauth?.webhookUrl && i.shopifyWebhooksVerifiedAt
                    ? 'Order, fulfillment, payment, and uninstall callbacks are configured for this URL.'
                    : 'Register callbacks whenever the testing tunnel URL changes.'}
                </small>
                <details>
                  <summary>{i.hasShopifyToken ? 'Reconnect Shopify' : 'Connect Shopify'}</summary>
                  <div className="checkbox-row" style={{ marginBottom: 12 }}>
                    <input
                      id={holdScopeId}
                      type="checkbox"
                      checked={includeFulfillmentScopes}
                      onChange={(e) => setIncludeFulfillmentScopes(e.target.checked)}
                    />
                    <label htmlFor={holdScopeId}>
                      Request fulfillment write &amp; hold scopes (write_fulfillments,
                      write_merchant_managed_fulfillment_orders)
                    </label>
                  </div>
                  {oauth?.configured && !correctOrigin ? (
                    <p>
                      Open <a href={oauth.appUrl}>your HTTPS workspace</a> and sign in to authorize
                      Shopify.
                    </p>
                  ) : (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={
                        busy ||
                        connecting ||
                        !form.shopDomain.trim() ||
                        !oauth?.configured ||
                        !correctOrigin
                      }
                      onClick={() => {
                        setConnecting(true);
                        void api<{ authorizationUrl: string }>('/integrations/shopify/connect', {
                          shopDomain: form.shopDomain,
                          includeFulfillmentScopes,
                        })
                          .then((r) => window.location.assign(r.authorizationUrl))
                          .catch((e: Error) => {
                            setResult((v) => ({ ...v, shopify: e.message }));
                            setConnecting(false);
                          });
                      }}
                    >
                      {connecting ? 'Connecting…' : 'Authorize Shopify'}
                    </button>
                  )}
                  {oauth?.reason && <p>{oauth.reason}</p>}
                </details>
              </>
            )}
          </div>
          <div className="integration-card-footer">
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => save('shopify')}
            >
              Save Shopify
            </button>
          </div>
        </section>
        <section className="panel integration-card">
          <div className="integration-title">
            <span className="integration-logo whatsapp">
              <MessageCircle size={27} />
            </span>
            <div>
              <h2>WhatsApp Cloud API</h2>
              <p>Your official Meta connection</p>
            </div>
            <span className={`pill ${i.whatsappVerifiedAt ? 'green' : ''}`}>
              {i.whatsappVerifiedAt ? 'Verified' : 'Not connected'}
            </span>
          </div>
          <div className="form-stack">
            <div className="form-row">
              {field('phoneNumberId', 'Phone Number ID', 'Meta phone number ID')}
              {field('wabaId', 'Business Account ID', 'Your WABA ID')}
            </div>
            {field(
              'whatsappToken',
              'System access token',
              i.hasWhatsappToken ? 'Saved token in use' : 'Enter your Meta access token',
              true,
            )}
            <div className="field">
              <label htmlFor="templateSelectionSelect">Confirmation template</label>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <select
                  id="templateSelectionSelect"
                  name="templateSelection"
                  style={{ flex: '1 1 200px' }}
                  value={form.templateName + ':' + form.languageCode}
                  onChange={(e) => {
                    const t = templates.find((t) => t.id === e.target.value);
                    if (t) setForm((f) => ({ ...f, templateName: t.name, languageCode: t.language }));
                  }}
                >
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} — {t.language}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="button secondary"
                  style={{ whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                  onClick={() =>
                    setTemplateModal({
                      open: true,
                      mode: 'add',
                      oldId: '',
                      name: '',
                      language: 'en',
                    })
                  }
                >
                  <Plus size={15} />
                  Add Template
                </button>
                <button
                  type="button"
                  className="button secondary"
                  style={{ whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                  title="Edit or delete selected template"
                  onClick={() => {
                    const cur =
                      templates.find(
                        (t) => t.name === form.templateName && t.language === form.languageCode,
                      ) ?? templates[0];
                    if (cur) {
                      setTemplateModal({
                        open: true,
                        mode: 'edit',
                        oldId: cur.id || `${cur.name}:${cur.language}`,
                        name: cur.name,
                        language: cur.language,
                      });
                    }
                  }}
                >
                  <Pencil size={14} />
                  Edit / Delete
                </button>
              </div>
              <small>
                Saved selection: {i.templateName} / {i.languageCode}
              </small>
            </div>
            <details>
              <summary>Order template requirements & support</summary>
              <p>
                Relay supports any approved Meta template for order confirmation. Variable placeholders
                (e.g. customer name, brand name, order number, items, total price, and delivery address)
                are resolved automatically.
              </p>
              <p>
                Quick-reply buttons are detected dynamically (e.g. <strong>Confirm order</strong>,{' '}
                <strong>Edit address / Change address</strong>, and <strong>Cancel order</strong>).
                Save your selection, then click Validate template below.
              </p>
              <p>
                Confirmation adds <strong>{sync.confirmedTag}</strong> in Shopify. Cancellation is
                limited to unpaid, unfulfilled COD orders and is marked complete only after Shopify
                confirms it. Address edit requests create a task and notify you for human follow-up.
              </p>
            </details>
            <button
              type="button"
              className="button secondary"
              disabled={
                busy ||
                credentialsDirty ||
                templateDirty ||
                data.mode === 'demo' ||
                !i.whatsappVerifiedAt
              }
              onClick={validateTemplate}
            >
              Validate template
            </button>
          </div>
          <div className="integration-card-footer">
            <button
              type="button"
              className="button primary"
              disabled={busy || testSending}
              onClick={() => save('whatsapp')}
            >
              Save WhatsApp
            </button>
          </div>
        </section>
      </div>
      <section className="panel integration-test-panel" style={{ marginTop: 20 }}>
        <div className="integration-title" style={{ marginBottom: 14 }}>
          <span className="integration-logo whatsapp">
            <BellRing size={22} />
          </span>
          <div>
            <h2 id={dispatchHeadingId}>Order status &amp; stage WhatsApp templates</h2>
            <p style={{ display: 'block' }}>
              Proactive Meta Utility notifications sent when orders enter Paid, In progress, On
              hold, In transit, or Delivered.
            </p>
          </div>
          <span
            className={`pill ${
              dispatchForm.enabled ||
              dispatchForm.deliveredEnabled ||
              dispatchForm.paidEnabled ||
              dispatchForm.inProgressEnabled ||
              dispatchForm.onHoldEnabled
                ? 'green'
                : ''
            }`}
          >
            {dispatchForm.enabled ||
            dispatchForm.deliveredEnabled ||
            dispatchForm.paidEnabled ||
            dispatchForm.inProgressEnabled ||
            dispatchForm.onHoldEnabled
              ? 'Configured'
              : 'Optional'}
          </span>
        </div>
        <form
          method="POST"
          aria-labelledby={dispatchHeadingId}
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            void act(
              () =>
                api(
                  '/settings',
                  {
                    ...data.workspace.settings,
                    dispatchNotifications: {
                      ...dispatchForm,
                      templateName: dispatchForm.templateName.trim(),
                      languageCode: dispatchForm.languageCode.trim(),
                      deliveredTemplateName: dispatchForm.deliveredTemplateName.trim(),
                      deliveredLanguageCode: dispatchForm.deliveredLanguageCode.trim(),
                      paidTemplateName: dispatchForm.paidTemplateName.trim(),
                      paidLanguageCode: dispatchForm.paidLanguageCode.trim(),
                      inProgressTemplateName: dispatchForm.inProgressTemplateName.trim(),
                      inProgressLanguageCode: dispatchForm.inProgressLanguageCode.trim(),
                      onHoldTemplateName: dispatchForm.onHoldTemplateName.trim(),
                      onHoldLanguageCode: dispatchForm.onHoldLanguageCode.trim(),
                    },
                    ...(data.workspace.settings.support
                      ? {
                          support: {
                            ...data.workspace.settings.support,
                            optedOutPhones: undefined,
                          },
                        }
                      : {}),
                  },
                  'PUT',
                ),
              'Order stage notification templates saved.',
            );
          }}
        >
          <fieldset className="settings-fieldset">
            <legend>Dispatch notifications (In transit / Fulfilled)</legend>
            <div className="checkbox-row">
              <input
                id="dispatch-enabled"
                name="dispatchEnabled"
                type="checkbox"
                checked={dispatchForm.enabled}
                onChange={(e) => setDispatchForm({ ...dispatchForm, enabled: e.target.checked })}
              />
              <label htmlFor="dispatch-enabled">
                Send WhatsApp Utility template when Shopify marks an order In transit / Fulfilled
              </label>
            </div>
            <div className="form-row">
              <div className="field">
                <label htmlFor="dispatch-tpl-name">Meta Utility template name</label>
                <input
                  id="dispatch-tpl-name"
                  name="templateName"
                  pattern="[a-z0-9_]{1,100}"
                  required={dispatchForm.enabled}
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={dispatchForm.templateName}
                  placeholder="relay_order_dispatched_v1"
                  onChange={(e) =>
                    setDispatchForm({ ...dispatchForm, templateName: e.target.value })
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="dispatch-tpl-lang">Language code</label>
                <input
                  id="dispatch-tpl-lang"
                  name="languageCode"
                  pattern="[a-z]{2}(_[A-Z]{2})?"
                  required
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={dispatchForm.languageCode}
                  placeholder="en"
                  onChange={(e) =>
                    setDispatchForm({ ...dispatchForm, languageCode: e.target.value })
                  }
                />
              </div>
            </div>
            <VariableOrderPicker
              label="Body variables in Meta {{1}}..{{N}} order"
              selected={dispatchForm.variables}
              onChange={(variables) => setDispatchForm({ ...dispatchForm, variables })}
            />
            <div className="checkbox-row">
              <input
                id="dispatch-url-btn"
                name="includeTrackingButtonUrl"
                type="checkbox"
                checked={dispatchForm.includeTrackingButtonUrl}
                onChange={(e) =>
                  setDispatchForm({
                    ...dispatchForm,
                    includeTrackingButtonUrl: e.target.checked,
                  })
                }
              />
              <label htmlFor="dispatch-url-btn">
                Template includes dynamic Visit Website URL button appended with tracking number or
                order #
              </label>
            </div>
            <div className="checkbox-row">
              <input
                id="dispatch-partial"
                name="notifyOnPartial"
                type="checkbox"
                checked={dispatchForm.notifyOnPartial}
                onChange={(e) =>
                  setDispatchForm({ ...dispatchForm, notifyOnPartial: e.target.checked })
                }
              />
              <label htmlFor="dispatch-partial">
                Also trigger on Partial fulfillment with tracking details
              </label>
            </div>
            <div>
              <button
                type="button"
                className="button secondary"
                disabled={
                  busy ||
                  data.mode === 'demo' ||
                  !i.whatsappVerifiedAt ||
                  !dispatchForm.templateName.trim()
                }
                onClick={() => validateNoticeTemplate('dispatch')}
              >
                Validate dispatch template
              </button>
            </div>
          </fieldset>
          <fieldset className="settings-fieldset">
            <legend>Delivery notifications (Delivered)</legend>
            <div className="checkbox-row">
              <input
                id="delivery-enabled"
                name="deliveredEnabled"
                type="checkbox"
                checked={dispatchForm.deliveredEnabled}
                onChange={(e) =>
                  setDispatchForm({ ...dispatchForm, deliveredEnabled: e.target.checked })
                }
              />
              <label htmlFor="delivery-enabled">
                Send WhatsApp Utility template when Shopify/carrier marks an order Delivered
              </label>
            </div>
            <div className="form-row">
              <div className="field">
                <label htmlFor="delivery-tpl-name">Meta Utility template name</label>
                <input
                  id="delivery-tpl-name"
                  name="deliveredTemplateName"
                  pattern="[a-z0-9_]{1,100}"
                  required={dispatchForm.deliveredEnabled}
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={dispatchForm.deliveredTemplateName}
                  placeholder="relay_order_delivered_v1"
                  onChange={(e) =>
                    setDispatchForm({ ...dispatchForm, deliveredTemplateName: e.target.value })
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="delivery-tpl-lang">Language code</label>
                <input
                  id="delivery-tpl-lang"
                  name="deliveredLanguageCode"
                  pattern="[a-z]{2}(_[A-Z]{2})?"
                  required
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={dispatchForm.deliveredLanguageCode}
                  placeholder="en"
                  onChange={(e) =>
                    setDispatchForm({ ...dispatchForm, deliveredLanguageCode: e.target.value })
                  }
                />
              </div>
            </div>
            <VariableOrderPicker
              label="Delivery template body variables in Meta {{1}}..{{N}} order"
              selected={dispatchForm.deliveredVariables}
              onChange={(deliveredVariables) =>
                setDispatchForm({ ...dispatchForm, deliveredVariables })
              }
            />
            <div>
              <button
                type="button"
                className="button secondary"
                disabled={
                  busy ||
                  data.mode === 'demo' ||
                  !i.whatsappVerifiedAt ||
                  !dispatchForm.deliveredTemplateName.trim()
                }
                onClick={() => validateNoticeTemplate('delivery')}
              >
                Validate delivery template
              </button>
            </div>
          </fieldset>
          <fieldset className="settings-fieldset">
            <legend>Payment confirmation (Paid)</legend>
            <div className="checkbox-row">
              <input
                id="paid-enabled"
                name="paidEnabled"
                type="checkbox"
                checked={dispatchForm.paidEnabled}
                onChange={(e) =>
                  setDispatchForm({ ...dispatchForm, paidEnabled: e.target.checked })
                }
              />
              <label htmlFor="paid-enabled">
                Send WhatsApp Utility template when Shopify or Relay marks an order Paid
              </label>
            </div>
            <div className="form-row">
              <div className="field">
                <label htmlFor="paid-tpl-name">Meta Utility template name</label>
                <input
                  id="paid-tpl-name"
                  name="paidTemplateName"
                  pattern="[a-z0-9_]{1,100}"
                  required={dispatchForm.paidEnabled}
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={dispatchForm.paidTemplateName}
                  placeholder="relay_payment_received_v1"
                  onChange={(e) =>
                    setDispatchForm({ ...dispatchForm, paidTemplateName: e.target.value })
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="paid-tpl-lang">Language code</label>
                <input
                  id="paid-tpl-lang"
                  name="paidLanguageCode"
                  pattern="[a-z]{2}(_[A-Z]{2})?"
                  required
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={dispatchForm.paidLanguageCode}
                  placeholder="en"
                  onChange={(e) =>
                    setDispatchForm({ ...dispatchForm, paidLanguageCode: e.target.value })
                  }
                />
              </div>
            </div>
            <VariableOrderPicker
              label="Paid template body variables in Meta {{1}}..{{N}} order"
              selected={dispatchForm.paidVariables}
              onChange={(paidVariables) => setDispatchForm({ ...dispatchForm, paidVariables })}
            />
            <div>
              <button
                type="button"
                className="button secondary"
                disabled={
                  busy ||
                  data.mode === 'demo' ||
                  !i.whatsappVerifiedAt ||
                  !dispatchForm.paidTemplateName.trim()
                }
                onClick={() => validateNoticeTemplate('paid')}
              >
                Validate paid template
              </button>
            </div>
          </fieldset>
          <fieldset className="settings-fieldset">
            <legend>Preparing / packing (In progress)</legend>
            <div className="checkbox-row">
              <input
                id="progress-enabled"
                name="inProgressEnabled"
                type="checkbox"
                checked={dispatchForm.inProgressEnabled}
                onChange={(e) =>
                  setDispatchForm({ ...dispatchForm, inProgressEnabled: e.target.checked })
                }
              />
              <label htmlFor="progress-enabled">
                Send WhatsApp Utility template when Shopify or Relay marks fulfillment In progress
              </label>
            </div>
            <div className="form-row">
              <div className="field">
                <label htmlFor="progress-tpl-name">Meta Utility template name</label>
                <input
                  id="progress-tpl-name"
                  name="inProgressTemplateName"
                  pattern="[a-z0-9_]{1,100}"
                  required={dispatchForm.inProgressEnabled}
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={dispatchForm.inProgressTemplateName}
                  placeholder="relay_order_preparing_v1"
                  onChange={(e) =>
                    setDispatchForm({ ...dispatchForm, inProgressTemplateName: e.target.value })
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="progress-tpl-lang">Language code</label>
                <input
                  id="progress-tpl-lang"
                  name="inProgressLanguageCode"
                  pattern="[a-z]{2}(_[A-Z]{2})?"
                  required
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={dispatchForm.inProgressLanguageCode}
                  placeholder="en"
                  onChange={(e) =>
                    setDispatchForm({ ...dispatchForm, inProgressLanguageCode: e.target.value })
                  }
                />
              </div>
            </div>
            <VariableOrderPicker
              label="In-progress template body variables in Meta {{1}}..{{N}} order"
              selected={dispatchForm.inProgressVariables}
              onChange={(inProgressVariables) =>
                setDispatchForm({ ...dispatchForm, inProgressVariables })
              }
            />
            <div>
              <button
                type="button"
                className="button secondary"
                disabled={
                  busy ||
                  data.mode === 'demo' ||
                  !i.whatsappVerifiedAt ||
                  !dispatchForm.inProgressTemplateName.trim()
                }
                onClick={() => validateNoticeTemplate('in_progress')}
              >
                Validate in-progress template
              </button>
            </div>
          </fieldset>
          <fieldset className="settings-fieldset">
            <legend>Fulfillment paused (On hold)</legend>
            <div className="checkbox-row">
              <input
                id="hold-notice-enabled"
                name="onHoldEnabled"
                type="checkbox"
                checked={dispatchForm.onHoldEnabled}
                onChange={(e) =>
                  setDispatchForm({ ...dispatchForm, onHoldEnabled: e.target.checked })
                }
              />
              <label htmlFor="hold-notice-enabled">
                Send WhatsApp Utility template when a Shopify fulfillment order is placed On hold
              </label>
            </div>
            <div className="form-row">
              <div className="field">
                <label htmlFor="hold-tpl-name">Meta Utility template name</label>
                <input
                  id="hold-tpl-name"
                  name="onHoldTemplateName"
                  pattern="[a-z0-9_]{1,100}"
                  required={dispatchForm.onHoldEnabled}
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={dispatchForm.onHoldTemplateName}
                  placeholder="relay_order_on_hold_v1"
                  onChange={(e) =>
                    setDispatchForm({ ...dispatchForm, onHoldTemplateName: e.target.value })
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="hold-tpl-lang">Language code</label>
                <input
                  id="hold-tpl-lang"
                  name="onHoldLanguageCode"
                  pattern="[a-z]{2}(_[A-Z]{2})?"
                  required
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={dispatchForm.onHoldLanguageCode}
                  placeholder="en"
                  onChange={(e) =>
                    setDispatchForm({ ...dispatchForm, onHoldLanguageCode: e.target.value })
                  }
                />
              </div>
            </div>
            <VariableOrderPicker
              label="On-hold template body variables in Meta {{1}}..{{N}} order"
              selected={dispatchForm.onHoldVariables}
              onChange={(onHoldVariables) => setDispatchForm({ ...dispatchForm, onHoldVariables })}
            />
            <div>
              <button
                type="button"
                className="button secondary"
                disabled={
                  busy ||
                  data.mode === 'demo' ||
                  !i.whatsappVerifiedAt ||
                  !dispatchForm.onHoldTemplateName.trim()
                }
                onClick={() => validateNoticeTemplate('on_hold')}
              >
                Validate on-hold template
              </button>
            </div>
          </fieldset>
          <div className="card-actions" style={{ paddingTop: 4 }}>
            <small className="muted">
              Only orders created/updated recently are messaged; opted-out (`STOP`) numbers are
              always skipped.
            </small>
            <button type="submit" className="button primary" disabled={busy}>
              <Check size={16} />
              Save notification templates
            </button>
          </div>
        </form>
      </section>
      <details
        id="whatsapp-replies"
        className="panel integration-test-panel"
        aria-label="WhatsApp reply webhook setup"
      >
        <summary>Incoming replies &amp; webhook setup</summary>

        <p>
          <strong>1. Save the working Meta App Secret</strong>
        </p>
        <p>Meta Developers → Your app → App settings → Basic → App Secret.</p>
        {field(
          'metaAppSecret',
          'Meta App Secret',
          i.hasMetaAppSecret ? 'Saved secret in use' : 'Enter the working Meta App Secret',
          true,
        )}
        <button
          type="button"
          className="button primary"
          disabled={busy || !form.metaAppSecret.trim()}
          onClick={() => save('whatsapp')}
        >
          Save Meta App Secret
        </button>
        <p className="muted">
          Secret: {i.hasMetaAppSecret ? 'Saved securely' : 'Required'} · Callback verification:{' '}
          {i.metaWebhookVerifiedAt && i.metaWebhookUrl === data.metaCallbackUrl
            ? 'Verified'
            : 'Pending for the current URL'}{' '}
          · Last received:{' '}
          {i.metaWebhookLastReceivedAt
            ? new Date(i.metaWebhookLastReceivedAt).toLocaleString()
            : 'No verified event yet'}
        </p>
        <p>
          <strong>2. Configure the callback in Meta</strong>
        </p>
        <p className="muted">Use the active HTTPS callback below.</p>
        <label className="field">
          <span>Merchant callback URL</span>
          <input readOnly value={data.metaCallbackUrl ?? ''} />
        </label>
        <button
          type="button"
          className="button secondary"
          disabled={busy || !i.hasMetaAppSecret}
          onClick={() => {
            void act(async () => {
              const r = await api<{ token: string }>('/integrations/meta/verify-token', {});
              setVerifyToken(r.token);
            }, 'Verification token generated. Copy it into Meta.');
          }}
        >
          Generate verification token
        </button>
        <p>
          <strong>3. Enable messages and subscribe the sender</strong>
        </p>
        <p className="muted">
          Sender account subscription:{' '}
          {data.workspace.settings.metaSubscription?.wabaId === i.wabaId ? 'Subscribed' : 'Pending'}
        </p>
        <button
          type="button"
          className="button secondary"
          disabled={
            busy ||
            !i.hasMetaAppSecret ||
            !i.metaWebhookVerifiedAt ||
            i.metaWebhookUrl !== data.metaCallbackUrl ||
            !i.whatsappVerifiedAt
          }
          onClick={() => {
            void act(
              () => api('/integrations/meta/subscribe', {}),
              'Sender account subscribed. Keep the messages field enabled in Meta.',
            );
          }}
        >
          Subscribe sender account to app
        </button>
        {verifyToken && (
          <label className="field">
            <span>Copy this token now; it is shown only once</span>
            <input readOnly value={verifyToken} />
          </label>
        )}
        <p>
          In the working Meta app, configure this callback URL and token, verify and save, then
          subscribe to the <strong>messages</strong> webhook field. Generating a new token requires
          verifying the callback again.
        </p>
      </details>
      {data.mode !== 'demo' && (
        <details className="panel integration-test-panel" aria-label="WhatsApp sample message">
          <summary>Send a test message</summary>
          <div className="integration-test-heading">
            <div>
              <h2>Send a WhatsApp sample</h2>
              <p>
                Sends Meta’s hello_world sample using your saved sender. Your order template
                selection stays unchanged.
              </p>
            </div>
            <span className="pill">Manual test</span>
          </div>
          <div className="integration-test-controls">
            <label className="field">
              <span>Your verified test number</span>
              <input
                type="tel"
                autoComplete="tel"
                placeholder="+923001234567"
                value={testRecipient}
                onChange={(e) => {
                  setTestRecipient(e.target.value);
                  setOwnVerifiedNumber(false);
                }}
              />
              <small>Save integrations to remember this number in this workspace.</small>
            </label>
            <button
              type="button"
              className="button primary"
              disabled={busy || testSending || cooldownSeconds > 0 || !!sendReason}
              aria-describedby="sample-send-status"
              onClick={() => {
                setTestSending(true);
                startCooldown(60);
                setResult((v) => ({ ...v, testSend: '' }));
                void api<{ message: string }>('/integrations/whatsapp/test-message', {
                  recipient: testRecipient.trim(),
                  ownVerifiedNumber,
                })
                  .then((r) => setResult((v) => ({ ...v, testSend: r.message })))
                  .catch((e: Error & { retryAfterSeconds?: number }) => {
                    if (e.retryAfterSeconds) startCooldown(e.retryAfterSeconds);
                    setResult((v) => ({ ...v, testSend: e.message }));
                  })
                  .finally(() => setTestSending(false));
              }}
            >
              {testSending ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
              {testSending
                ? 'Sending…'
                : cooldownSeconds > 0
                  ? `Retry in ${cooldownSeconds}s`
                  : 'Send sample message'}
            </button>
          </div>
          <label className="integration-test-consent">
            <input
              type="checkbox"
              checked={ownVerifiedNumber}
              onChange={(e) => setOwnVerifiedNumber(e.target.checked)}
            />
            <span>
              This is my number, verified as a recipient in Meta, and I want to receive this test.
            </span>
          </label>
          <p id="sample-send-status" className="muted" role="status">
            {testSending
              ? 'Sending one sample message…'
              : cooldownSeconds > 0
                ? `A test was attempted. Check WhatsApp; you can retry in ${cooldownSeconds} seconds.`
                : sendReason ||
                  'Ready to send one sample message. This does not enable automatic order messaging.'}
          </p>
          {result.testSend && (
            <div className="inline-result" role="status">
              {result.testSend}
            </div>
          )}
        </details>
      )}
      <p className="integration-security-note">
        <LockKeyhole size={15} />
        Credentials are encrypted on the server.
      </p>
      <details className="panel webhook-panel integration-callbacks">
        <summary>App URLs and webhook setup</summary>
        <p>
          Use these URLs in your Shopify and Meta configuration. Keep Shopify embedding disabled.
        </p>
        {[
          { name: 'Shopify App URL', path: oauth?.appUrl ?? location.origin },
          {
            name: 'Shopify Allowed redirection URL',
            path: oauth?.callbackUrl ?? `${location.origin}/api/integrations/shopify/callback`,
          },
          {
            name: 'Shopify orders, fulfillment & uninstall webhooks',
            path: oauth?.webhookUrl ?? `${location.origin}/api/webhooks/shopify`,
          },
          { name: 'Meta messages', path: data.metaCallbackUrl ?? '' },
        ].map((h) => (
          <div className="webhook-row" key={h.path}>
            <div>
              <strong>{h.name}</strong>
              <code>{h.path}</code>
            </div>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(h.path)
                  .then(() => setCopied(h.path))
                  .catch(() =>
                    setResult((v) => ({
                      ...v,
                      clipboard: 'Select and copy the displayed URL manually.',
                    })),
                  );
              }}
            >
              {copied === h.path ? 'Copied' : 'Copy URL'}
            </button>
          </div>
        ))}
        {result.clipboard && <p role="status">{result.clipboard}</p>}
        <p className="muted">
          Meta reply handling requires the working app’s App Secret, verify token, and messages
          webhook subscription. Automatic order messaging has a separate activation step.
        </p>
      </details>
      {templateModal.open && (
        <Modal
          title={templateModal.mode === 'add' ? 'Add confirmation template' : 'Edit or delete template'}
          subtitle={
            templateModal.mode === 'add'
              ? 'Register a template name and language approved in your Meta WhatsApp account.'
              : 'Update or remove this template from your saved selections.'
          }
          close={() => setTemplateModal((m) => ({ ...m, open: false }))}
        >
          <div className="form-stack">
            <div className="form-row">
              <label className="field">
                <span>Template name *</span>
                <input
                  name="modalTemplateName"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={templateModal.name}
                  placeholder="e.g. relay_order_confirmation_v1"
                  onChange={(e) => setTemplateModal((m) => ({ ...m, name: e.target.value }))}
                />
              </label>
              <label className="field">
                <span>Template language *</span>
                <input
                  name="modalTemplateLanguage"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={templateModal.language}
                  placeholder="e.g. en or en_US"
                  onChange={(e) => setTemplateModal((m) => ({ ...m, language: e.target.value }))}
                />
              </label>
            </div>
            <p className="muted" style={{ fontSize: 13, marginTop: -4 }}>
              Tip: In Meta WhatsApp Manager, templates labeled &quot;English&quot; use language code <code>en</code>, while &quot;English (US)&quot; uses <code>en_US</code>.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
              <div>
                {templateModal.mode === 'edit' && (
                  <button
                    type="button"
                    className="button danger"
                    disabled={busy}
                    onClick={() => handleDeleteTemplate(templateModal.oldId)}
                  >
                    Delete template
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setTemplateModal((m) => ({ ...m, open: false }))}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="button primary"
                  disabled={busy || !templateModal.name.trim() || !templateModal.language.trim()}
                  onClick={handleSaveTemplateModal}
                >
                  {templateModal.mode === 'add' ? 'Save template' : 'Update template'}
                </button>
              </div>
            </div>

            {templates.length > 0 && (
              <div style={{ marginTop: 20, borderTop: '1px solid var(--color-border)', paddingTop: 14 }}>
                <span style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 8 }}>
                  All saved templates ({templates.length})
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 180, overflowY: 'auto' }}>
                  {templates.map((t) => {
                    const tid = t.id || `${t.name}:${t.language}`;
                    const isSelected = form.templateName === t.name && form.languageCode === t.language;
                    return (
                      <div
                        key={tid}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '8px 12px',
                          background: isSelected ? 'var(--color-bg-active, #eff6ff)' : 'var(--color-bg-subtle, #f8fafc)',
                          border: isSelected ? '1px solid var(--color-primary-light, #93c5fd)' : '1px solid var(--color-border, #e2e8f0)',
                          borderRadius: 6,
                          fontSize: 13,
                        }}
                      >
                        <div>
                          <strong>{t.name}</strong> <span className="muted">— {t.language}</span>
                          {isSelected && <span style={{ marginLeft: 8, fontSize: 11, background: '#dbeafe', color: '#1e40af', padding: '1px 6px', borderRadius: 4, fontWeight: 500 }}>Selected</span>}
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            type="button"
                            className="button secondary"
                            style={{ padding: '3px 8px', fontSize: 12 }}
                            onClick={() => {
                              setTemplateModal({
                                open: true,
                                mode: 'edit',
                                oldId: tid,
                                name: t.name,
                                language: t.language,
                              });
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="button danger"
                            style={{ padding: '3px 8px', fontSize: 12 }}
                            onClick={() => handleDeleteTemplate(tid)}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
