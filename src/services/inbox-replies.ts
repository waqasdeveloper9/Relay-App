import { config } from '../config.js';
import { customerThreads } from '../models/customer-conversations.js';
import { inboxReplyEligibility } from '../models/inbox-eligibility.js';
import type { Store } from '../models/types.js';
import { InputError } from '../utils/errors.js';
import { activity, append, customerConversation } from './automation.js';
import { metaWebhookReady } from './meta-webhook-settings.js';
import { beginMessage, updateMessage } from './message-history.js';
import { notify, resolveNotification } from './notifications.js';
import { ProviderError, sendSupportText } from './providers.js';
import { getStore, mutate } from './repository.js';

export async function sendLiveInboxReply(
  store: Store,
  conversationId: string,
  rawText: string,
): Promise<void> {
  const conv = store.workspace.conversations.find((c) => c.id === conversationId);
  if (!conv) throw Object.assign(new Error('Conversation not found'), { status: 404 });
  const text = rawText.trim();
  if (!text || text.length > 2000)
    throw new InputError('Enter a reply between 1 and 2000 characters.');

  const check = inboxReplyEligibility(
    {
      mode: config.demo ? 'demo' : 'connected',
      outboundEnabled: config.outbound,
      metaWebhookConfigured: metaWebhookReady(store),
      merchant: store.merchant,
      workspace: store.workspace,
    },
    conv,
  );
  if (!check.allowed)
    throw new InputError(check.reason ?? 'Live inbox replies are unavailable right now.');

  const merchantId = store.merchant.id;
  const historyId = await beginMessage(merchantId, {
    kind: 'INBOX_REPLY',
    recipient: check.phone,
    templateName: '',
    languageCode: '',
    preview: text,
  });

  try {
    const current = await getStore(merchantId);
    const freshConv = current?.workspace.conversations.find((c) => c.id === conversationId);
    if (!current || !freshConv)
      throw Object.assign(new Error('Conversation not found'), { status: 404 });
    const recheck = inboxReplyEligibility(
      {
        mode: config.demo ? 'demo' : 'connected',
        outboundEnabled: config.outbound,
        metaWebhookConfigured: metaWebhookReady(current),
        merchant: current.merchant,
        workspace: current.workspace,
      },
      freshConv,
    );
    if (!recheck.allowed)
      throw new InputError(recheck.reason ?? 'Live inbox replies are unavailable right now.');

    const messageId = await sendSupportText(
      current.workspace.integration,
      recheck.phone,
      text,
      historyId,
    );
    await updateMessage(merchantId, historyId, { status: 'ACCEPTED', messageId });
    await mutate(merchantId, (s) => {
      const w = s.workspace;
      const source = w.conversations.find((c) => c.id === conversationId);
      const target = customerConversation(w, recheck.phone);
      for (const thread of customerThreads(w, target)) {
        thread.human = true;
        thread.unread = false;
      }
      if (source) {
        for (const thread of customerThreads(w, source)) {
          thread.human = true;
          thread.unread = false;
        }
      }
      append(target, 'out', text);
      resolveNotification(w, 'reply:' + target.id);
      activity(w, `Live reply sent to +${recheck.phone} from Inbox`);
    });
  } catch (error) {
    const ambiguous = error instanceof ProviderError && error.ambiguous;
    const detail = error instanceof Error ? error.message : 'Message request failed';
    await updateMessage(merchantId, historyId, {
      status: ambiguous ? 'UNKNOWN' : 'FAILED',
      error: detail,
    });
    await mutate(merchantId, (s) => {
      const w = s.workspace;
      const target = customerConversation(w, check.phone);
      for (const thread of customerThreads(w, target)) {
        thread.unread = false;
        if (ambiguous) thread.human = true;
      }
      if (ambiguous) {
        append(
          target,
          'note',
          `Uncertain WhatsApp send outcome — verify in Messages before resending: ${detail}`,
        );
        notify(
          w,
          'message:' + historyId,
          'Uncertain reply send',
          detail,
          'Check WhatsApp and Meta provider logs before resending.',
        );
        activity(w, `Uncertain live Inbox reply outcome for +${check.phone}`);
      } else {
        notify(
          w,
          'message:' + historyId,
          'WhatsApp reply failed',
          detail,
          'Review the error in Messages before retrying.',
        );
        activity(w, `Live Inbox reply failed for +${check.phone}`);
      }
    });
    throw error;
  }
}
