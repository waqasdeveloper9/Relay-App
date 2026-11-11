import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, CheckCheck, Link2, Send, Unlink2, Users, Zap } from 'lucide-react';
import { customerConversations } from '../../src/models/customer-conversations';
import { inboxReplyEligibility } from '../../src/models/inbox-eligibility';
import {
  isPhoneOptedOut,
  quickReplies as getQuickReplies,
} from '../../src/models/workspace-defaults';
import { api, type Snapshot } from '../api';
import { initials, time, type Act } from '../lib/format';
import { Empty } from '../components/ui';

export function InboxView({ data, busy, act }: { data: Snapshot; busy: boolean; act: Act }) {
  const w = data.workspace;
  const threads = useMemo(() => customerConversations(w), [w]);
  const [id, setId] = useState(threads[0]?.phone || threads[0]?.id);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [linkOrderId, setLinkOrderId] = useState('');
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const readAttempts = useRef(new Set<string>());
  const [simulate, setSimulate] = useState(false);
  const [activeChip, setActiveChip] = useState(0);
  const supportsFocusGroup =
    typeof HTMLElement !== 'undefined' && 'focusGroup' in HTMLElement.prototype;
  const inputId = useId();
  const hintId = useId();
  const linkSelectId = useId();
  const c = threads.find((c) => (c.phone || c.id) === id) ?? threads[0];
  const quickReplies = useMemo(() => getQuickReplies(w), [w]);
  const optedOut = !!(c?.phone && isPhoneOptedOut(w, c.phone));
  const unlinkedOrders = useMemo(
    () => (c ? w.orders.filter((o) => !o.archivedAt && !c.linkedOrderIds.includes(o.id)) : []),
    [c, w.orders],
  );

  const replyCheck = useMemo(
    () =>
      c
        ? inboxReplyEligibility(
            {
              mode: data.mode,
              outboundEnabled: data.outboundEnabled,
              metaWebhookConfigured: data.metaWebhookConfigured ?? false,
              merchant: data.merchant,
              workspace: w,
            },
            c,
          )
        : { allowed: false, phone: '' },
    [c, data.mode, data.outboundEnabled, data.metaWebhookConfigured, data.merchant, w],
  );
  const canCompose = data.mode === 'demo' || replyCheck.allowed;

  const draftKey = c ? `${c.id}:${simulate ? 'incoming' : 'outgoing'}` : '';
  const text = drafts[draftKey] ?? '';
  function setText(value: string) {
    setDrafts((previous) => ({ ...previous, [draftKey]: value }));
  }
  useEffect(() => {
    setLinkOrderId('');
  }, [c?.id]);
  useEffect(() => {
    const marker = c ? `${c.id}:${c.messages.at(-1)?.id}` : '';
    if (c?.unread && !busy && !readAttempts.current.has(marker)) {
      readAttempts.current.add(marker);
      void act(() => api(`/conversations/${c.id}/read`, {}), '');
    }
  }, [c?.id, c?.unread, c?.messages.at(-1)?.id, busy, act]);
  useEffect(() => {
    if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [c?.id, c?.messages.length]);
  if (!c)
    return (
      <section className="panel">
        <Empty
          title="Your inbox is ready"
          detail="Conversations will appear when customers reply to their order messages."
        />
      </section>
    );

  function trackedStatus(msg: {
    direction: 'in' | 'out' | 'note';
    text: string;
    createdAt: string;
  }) {
    if (msg.direction !== 'out' || data.mode === 'demo') return undefined;
    const msgAt = Date.parse(msg.createdAt);
    const match = (w.outboundMessages ?? []).find(
      (o) =>
        o.recipient === c!.phone &&
        ['INBOX_REPLY', 'SUPPORT_REPLY', 'SUPPORT_MENU'].includes(o.kind) &&
        o.preview === msg.text &&
        Math.abs(Date.parse(o.createdAt) - msgAt) < 120_000,
    );
    return match?.status ?? 'ACCEPTED';
  }

  return (
    <div className="inbox-layout panel">
      <aside className="conversation-list">
        <div className="conversation-list-title">
          <h2>Conversations</h2>
          <span className="count-pill">{threads.length}</span>
        </div>
        {threads.map((con) => {
          const conOptOut = !!(con.phone && isPhoneOptedOut(w, con.phone));
          return (
            <button
              key={con.id}
              type="button"
              className={`conversation-item ${c.id === con.id ? 'active' : ''}`}
              onClick={() => setId(con.phone || con.id)}
            >
              <span className="avatar purple">{initials(con.name)}</span>
              <div>
                <strong>
                  {con.name}
                  {conOptOut && ' (STOP)'}
                </strong>
                <p>{con.messages.at(-1)?.text}</p>
                <small>{con.phone ? '+' + con.phone : 'No phone'}</small>
              </div>
              {con.unread && <i />}
            </button>
          );
        })}
      </aside>
      <section className="chat">
        <div className="chat-header">
          <span className="avatar purple">{initials(c.name)}</span>
          <div>
            <h2>{c.name}</h2>
            <p>{c.phone ? '+' + c.phone : 'No phone recorded'}</p>
          </div>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => {
              void act(
                () =>
                  api(`/conversations/${c.id}/action`, { action: c.human ? 'resume' : 'takeover' }),
                c.human ? 'Assistant resumed' : 'Human takeover enabled. Assistant paused.',
              );
            }}
          >
            {c.human ? (
              <>
                <Zap size={15} aria-hidden="true" />
                Resume assistant
              </>
            ) : (
              <>
                <Users size={15} aria-hidden="true" />
                Take over
              </>
            )}
          </button>
        </div>
        <div className="chat-mode">
          <span className={`small-dot ${c.human ? 'amber' : 'green'}`} />
          {c.human ? 'Human handling · assistant paused' : 'Assistant handling'}
          {optedOut && <span className="pill danger-pill">Unsubscribed (STOP)</span>}
          <span>
            {data.mode === 'demo'
              ? 'All messages are simulated'
              : replyCheck.allowed
                ? 'Live reply pauses assistant and sends via WhatsApp'
                : 'Live reply unavailable'}
          </span>
        </div>
        {c.phone && (
          <div className="inbox-orders-bar">
            <div className="inbox-linked-list">
              <span className="muted">Linked orders:</span>
              {c.linkedOrderIds.length ? (
                c.linkedOrderIds.map((oid) => {
                  const ord = w.orders.find((o) => o.id === oid);
                  if (!ord) return null;
                  const secondary = ord.phone !== c.phone;
                  return (
                    <span key={oid} className="pill linked-order-pill">
                      {ord.number} · {ord.delivery}
                      {secondary && (
                        <button
                          type="button"
                          className="chip-remove"
                          disabled={busy}
                          aria-label={`Unlink ${ord.number} from +${c.phone}`}
                          onClick={() => {
                            void act(
                              () =>
                                api(`/conversations/${c.id}/action`, {
                                  action: 'unlink_order',
                                  orderId: ord.id,
                                }),
                              `Order ${ord.number} unlinked from +${c.phone}.`,
                            );
                          }}
                        >
                          <Unlink2 size={12} aria-hidden="true" />
                        </button>
                      )}
                    </span>
                  );
                })
              ) : (
                <span className="muted">None linked yet</span>
              )}
            </div>
            {unlinkedOrders.length > 0 && (
              <form
                method="POST"
                className="inbox-link-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (busy || !linkOrderId) return;
                  const chosen = w.orders.find((o) => o.id === linkOrderId);
                  void act(
                    async () => {
                      await api(`/conversations/${c.id}/action`, {
                        action: 'link_order',
                        orderId: linkOrderId,
                      });
                      setLinkOrderId('');
                    },
                    `Linked ${chosen?.number ?? 'order'} for WhatsApp tracking lookup.`,
                  );
                }}
              >
                <label htmlFor={linkSelectId} className="sr-only">
                  Link Shopify order to this WhatsApp number
                </label>
                <select
                  id={linkSelectId}
                  name="orderId"
                  disabled={busy}
                  value={linkOrderId}
                  onChange={(e) => setLinkOrderId(e.target.value)}
                >
                  <option value="">Link order number…</option>
                  {unlinkedOrders.map((ord) => (
                    <option key={ord.id} value={ord.id}>
                      {ord.number} · {ord.name} ({ord.delivery})
                    </option>
                  ))}
                </select>
                <button type="submit" className="button secondary" disabled={busy || !linkOrderId}>
                  <Link2 size={14} aria-hidden="true" />
                  Link
                </button>
              </form>
            )}
          </div>
        )}
        <div className="messages" ref={messagesRef}>
          {c.messages.map((m) => {
            const outboundStatus = trackedStatus(m);
            return (
              <div key={m.id} className={`message ${m.direction}`}>
                {m.orderId && (
                  <span className="message-order">
                    {w.orders.find((o) => o.id === m.orderId)?.number}
                  </span>
                )}
                <p>{m.text}</p>
                <small>
                  {m.direction === 'note' ? 'Internal note · ' : ''}
                  {time(m.createdAt)}
                  {m.direction === 'out' &&
                    (data.mode === 'demo' ? (
                      <CheckCheck size={12} aria-hidden="true" />
                    ) : outboundStatus === 'DELIVERED' || outboundStatus === 'READ' ? (
                      <>
                        {' · Delivered '}
                        <CheckCheck size={12} aria-hidden="true" />
                      </>
                    ) : outboundStatus === 'SENT' ? (
                      <>
                        {' · Sent '}
                        <CheckCheck size={12} aria-hidden="true" />
                      </>
                    ) : outboundStatus === 'UNKNOWN' ? (
                      ' · Uncertain'
                    ) : outboundStatus === 'FAILED' ? (
                      ' · Failed'
                    ) : (
                      <>
                        {' · Meta accepted '}
                        <Check size={12} aria-hidden="true" />
                      </>
                    ))}
                </small>
              </div>
            );
          })}
        </div>
        <form
          method="POST"
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canCompose || !text.trim() || busy) return;
            void act(
              async () => {
                await api(`/conversations/${c.id}/action`, {
                  action: simulate ? 'simulate' : 'reply',
                  text,
                });
                setText('');
              },
              simulate
                ? 'Customer message simulated'
                : data.mode === 'demo'
                  ? 'Demo reply recorded'
                  : 'Message sent to WhatsApp (Meta accepted)',
            );
          }}
        >
          <div className="composer-toolbar">
            <span>
              {simulate ? 'Simulate an incoming customer message' : 'Reply as store administrator'}
            </span>
            {data.mode === 'demo' && (
              <button
                type="button"
                disabled={busy}
                className="text-button"
                onClick={() => setSimulate(!simulate)}
              >
                {simulate ? 'Switch to reply' : 'Simulate customer'}
              </button>
            )}
          </div>
          {!simulate && (
            <div
              ref={toolbarRef}
              role="toolbar"
              aria-label="Quick replies"
              aria-controls={inputId}
              className="quick-replies"
              {...({ focusgroup: 'toolbar wrap' } as Record<string, string>)}
              onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
                if (supportsFocusGroup) return;
                const bar = toolbarRef.current;
                if (!bar) return;
                const buttons = [...bar.querySelectorAll<HTMLButtonElement>('button')];
                if (!buttons.length) return;
                const rtl = getComputedStyle(bar).direction === 'rtl';
                const step =
                  e.key === 'ArrowRight'
                    ? rtl
                      ? -1
                      : 1
                    : e.key === 'ArrowLeft'
                      ? rtl
                        ? 1
                        : -1
                      : e.key === 'Home'
                        ? -buttons.length
                        : e.key === 'End'
                          ? buttons.length
                          : 0;
                if (!step) return;
                e.preventDefault();
                const current = Math.max(0, buttons.indexOf(e.target as HTMLButtonElement));
                const next =
                  e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? buttons.length - 1
                      : (current + step + buttons.length) % buttons.length;
                setActiveChip(next);
                buttons[next]?.focus();
              }}
            >
              {quickReplies.map((q, index) => (
                <button
                  key={`${q.label}-${index}`}
                  type="button"
                  className="quick-reply-chip"
                  tabIndex={supportsFocusGroup ? undefined : index === activeChip ? 0 : -1}
                  aria-disabled={!canCompose || busy ? 'true' : undefined}
                  onFocus={() => setActiveChip(index)}
                  onClick={() => {
                    if (!canCompose || busy) return;
                    setText(q.body);
                    textareaRef.current?.focus();
                  }}
                >
                  {q.label}
                </button>
              ))}
            </div>
          )}
          <label htmlFor={inputId} className="sr-only">
            {simulate ? 'Simulate incoming customer message' : 'Message text'}
          </label>
          <textarea
            ref={textareaRef}
            id={inputId}
            name="message"
            aria-describedby={hintId}
            enterKeyHint={simulate ? 'done' : 'send'}
            disabled={busy || !canCompose}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (!busy && canCompose && text.trim()) e.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={
              simulate
                ? 'Try: Confirm, Where is my parcel?, STOP, or Please change my address…'
                : 'Write a helpful reply…'
            }
            maxLength={2000}
          />
          <div className="composer-bottom">
            <small id={hintId}>
              {optedOut
                ? 'This number opted out (STOP); automated alerts and bot replies are disabled until customer replies START or is re-enabled in Settings.'
                : data.mode === 'demo'
                  ? 'No messages leave this demo workspace.'
                  : replyCheck.allowed
                    ? 'Sends via your connected WhatsApp sender within Meta’s 24-hour customer reply window.'
                    : (replyCheck.reason ?? 'Live sending is unavailable for this conversation.')}
            </small>
            <button
              type="submit"
              className="button primary"
              disabled={busy || !text.trim() || !canCompose}
            >
              <Send size={15} aria-hidden="true" />
              {simulate ? 'Simulate' : 'Send reply'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
