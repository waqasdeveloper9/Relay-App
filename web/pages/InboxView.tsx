import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCheck, Send, Users, Zap } from 'lucide-react';
import { customerConversations } from '../../src/models/customer-conversations';
import { api, type Snapshot } from '../api';
import { initials, time, type Act } from '../lib/format';
import { Empty } from '../components/ui';

export function InboxView({ data, busy, act }: { data: Snapshot; busy: boolean; act: Act }) {
  const w = data.workspace;
  const threads = useMemo(() => customerConversations(w), [w]);
  const [id, setId] = useState(threads[0]?.phone || threads[0]?.id);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const messagesRef = useRef<HTMLDivElement>(null);
  const readAttempts = useRef(new Set<string>());
  const [simulate, setSimulate] = useState(false);
  const c = threads.find((c) => (c.phone || c.id) === id) ?? threads[0];

  const draftKey = c ? `${c.id}:${simulate ? 'incoming' : 'outgoing'}` : '';
  const text = drafts[draftKey] ?? '';
  function setText(value: string) {
    setDrafts((previous) => ({ ...previous, [draftKey]: value }));
  }
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
  return (
    <div className="inbox-layout panel">
      <aside className="conversation-list">
        <div className="conversation-list-title">
          <h2>Conversations</h2>
          <span className="count-pill">{threads.length}</span>
        </div>
        {threads.map((con) => {
          return (
            <button
              key={con.id}
              className={`conversation-item ${c.id === con.id ? 'active' : ''}`}
              onClick={() => setId(con.phone || con.id)}
            >
              <span className="avatar purple">{initials(con.name)}</span>
              <div>
                <strong>{con.name}</strong>
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
            <p>+{c.phone}</p>
          </div>
          <button
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
                <Zap size={15} />
                Resume assistant
              </>
            ) : (
              <>
                <Users size={15} />
                Take over
              </>
            )}
          </button>
        </div>
        <div className="chat-mode">
          <span className={`small-dot ${c.human ? 'amber' : 'green'}`} />
          {c.human ? 'Human handling · assistant paused' : 'Assistant handling'}
          <span>
            {data.mode === 'demo'
              ? 'All messages are simulated'
              : 'Live replies are suggestions only'}
          </span>
        </div>
        <div className="messages" ref={messagesRef}>
          {c.messages.map((m) => (
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
                {m.direction === 'out' && <CheckCheck size={12} />}
              </small>
            </div>
          ))}
        </div>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              async () => {
                await api(`/conversations/${c.id}/action`, {
                  action: simulate ? 'simulate' : 'reply',
                  text,
                });
                setText('');
              },
              simulate ? 'Customer message simulated' : 'Demo reply recorded',
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
          <textarea
            aria-label="Message text"
            disabled={busy || data.mode !== 'demo'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              simulate
                ? 'Try: Confirm, Where is my parcel?, or Please change my address…'
                : 'Write a helpful reply…'
            }
            maxLength={2000}
          />
          <div className="composer-bottom">
            <small>
              {data.mode === 'demo'
                ? 'No messages leave this demo workspace.'
                : 'Live sending is not enabled in this release.'}
            </small>
            <button
              className="button primary"
              disabled={busy || !text.trim() || data.mode !== 'demo'}
            >
              <Send size={15} />
              {simulate ? 'Simulate' : 'Send reply'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
