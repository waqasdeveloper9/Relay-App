import { config } from '../config.js';
import { readyStores, mutate } from './repository.js';
import { activity, append, canSend, conversation, enqueue } from './automation.js';
import { addOrderTag, ProviderError, sendHelloWorldTest } from './providers.js';
import { orderTestAllowed } from './order-test.js';
import { freshShopifyIntegration } from './shopify-tokens.js';
import { cancelUnpaidCodOrder, sendOrderConfirmation } from './order-confirmation.js';

import { metaWebhookReady } from './meta-webhook-settings.js';
import { jobRetry } from './retry-policy.js';
import { notify, resolveNotification } from './notifications.js';
import { reliability } from './reliability-settings.js';
import { beginMessage, updateMessage } from './message-history.js';

let running = false;
export async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const store of await readyStores()) {
      const id = store.merchant.id;
      const stale = store.workspace.jobs.find(
        (j) =>
          j.state === 'UNKNOWN' && j.claimedAt && Date.parse(j.claimedAt) < Date.now() - 120000,
      );
      if (stale) {
        await mutate(id, (s) => {
          const j = s.workspace.jobs.find((j) => j.id === stale.id)!;
          j.claimedAt = undefined;
          const receipt = s.workspace.outboundMessages?.find((m) => m.jobId === j.id);
          if (receipt?.messageId) {
            j.state = 'DONE';
            j.messageId = receipt.messageId;
            j.error = undefined;
            resolveNotification(s.workspace, 'job:' + j.id);
            const o = s.workspace.orders.find((o) => o.id === j.orderId);
            if (o && !o.confirmationExpiresAt)
              o.confirmationExpiresAt = new Date(
                Date.parse(receipt.createdAt) +
                  reliability(s.workspace).maxMessageAgeHours * 3600000,
              ).toISOString();
          } else if (j.kind === 'TAG' && j.attempts < 8) {
            j.state = 'QUEUED';
            j.dueAt = new Date().toISOString();
          } else {
            j.error =
              'Worker stopped before the provider result was safely recorded. Reconcile before retrying.';
            notify(
              s.workspace,
              'job:' + j.id,
              'Uncertain action needs review',
              j.error,
              'Check provider history before retrying to avoid duplicate messages.',
            );
            for (const m of s.workspace.outboundMessages ?? [])
              if (m.jobId === j.id && m.status === 'SENDING') {
                m.status = 'UNKNOWN';
                m.error = j.error;
                m.updatedAt = new Date().toISOString();
              }
          }
        });
        continue;
      }
      const candidate = store.workspace.jobs.find(
        (j) => j.state === 'QUEUED' && Date.parse(j.dueAt) <= Date.now(),
      );
      if (!candidate) continue;
      const claimed = await mutate(id, (s) => {
        const j = s.workspace.jobs.find((j) => j.id === candidate.id);
        if (!j || j.state !== 'QUEUED') return false;
        // Persist an uncertain state before an external call to prevent duplicate
        // sends after a crash. Unknown outcomes require operator reconciliation.
        j.state = 'UNKNOWN';
        j.claimedAt = new Date().toISOString();
        j.attempts++;
        return structuredClone(s);
      });
      if (!claimed) continue;
      const order = claimed.workspace.orders.find((o) => o.id === candidate.orderId);
      let historyId: string | undefined;
      try {
        if (order && !['TAG', 'CANCEL'].includes(candidate.kind) && !config.demo)
          historyId = await beginMessage(id, {
            orderId: order.id,
            jobId: candidate.id,
            kind: candidate.kind,
            recipient: order.phone,
            templateName:
              candidate.kind === 'TEST_HELLO'
                ? 'hello_world'
                : claimed.workspace.integration.templateName,
            languageCode:
              candidate.kind === 'TEST_HELLO'
                ? 'en_US'
                : claimed.workspace.integration.languageCode,
            preview:
              candidate.kind === 'TEST_HELLO'
                ? 'Meta hello_world sample (no order details).'
                : 'Order ' + order.number + ' — preparing confirmation',
          });
        if (!order) throw new Error('Order no longer exists');
        if (order.archivedAt)
          throw new Error('Order was removed from Relay. Automation is stopped for this order.');
        if (
          !['TAG', 'CANCEL'].includes(candidate.kind) &&
          Date.now() - Date.parse(order.createdAt) >
            reliability(claimed.workspace).maxMessageAgeHours * 3600000
        )
          throw new Error('Order is too old for automatic confirmation messaging');
        if (candidate.kind === 'TEST_HELLO' || candidate.kind === 'TEST_CONFIRMATION') {
          if (!orderTestAllowed(claimed, order.phone))
            throw new Error(
              'Order test authorization expired or does not match this merchant and recipient',
            );
          if (order.status !== 'PENDING') throw new Error('Order is no longer pending');
          if (claimed.workspace.conversations.some((c) => c.orderId === order.id && c.human))
            throw new Error('Assistant paused for human handling');
        } else if (candidate.kind === 'CANCEL') {
          if (
            order.status !== 'NEEDS_REVIEW' ||
            !claimed.workspace.tasks.some(
              (t) => t.orderId === order.id && t.kind === 'Cancellation' && t.status === 'APPROVED',
            )
          )
            throw new Error('No pending customer cancellation decision');
        } else if (candidate.kind !== 'TAG') {
          if (!canSend(claimed)) throw new Error('Trial expired or subscription inactive');
          if (claimed.workspace.conversations.some((c) => c.orderId === order.id && c.human))
            throw new Error('Assistant paused for human handling');
          if (!order.consent) throw new Error('Messaging permission is not recorded');
          if (order.status !== 'PENDING') throw new Error('Order no longer requires confirmation');
          if (
            !claimed.workspace.settings.confirmations ||
            (candidate.kind === 'REMINDER' && !claimed.workspace.settings.reminders)
          )
            throw new Error('Automation is disabled');
        }
        if (
          !config.demo &&
          ['CONFIRMATION', 'REMINDER'].includes(candidate.kind) &&
          !metaWebhookReady(claimed)
        )
          throw new Error(
            'Incoming WhatsApp replies are not configured for the current callback URL. Complete Meta webhook setup in Integrations.',
          );
        let messageId: string | undefined;
        if (!config.demo) {
          if (candidate.kind === 'TAG') await addOrderTag(await freshShopifyIntegration(id), order);
          else if (candidate.kind === 'CANCEL')
            await cancelUnpaidCodOrder(await freshShopifyIntegration(id), order);
          else if (candidate.kind === 'TEST_CONFIRMATION') {
            const integration = await freshShopifyIntegration(id);
            messageId = await sendOrderConfirmation(
              integration,
              order,
              claimed.merchant.brandName,
              async (preview) => {
                if (historyId) await updateMessage(id, historyId, { preview });
              },
              historyId,
            );
          } else if (candidate.kind === 'TEST_HELLO')
            messageId = await sendHelloWorldTest(
              claimed.workspace.integration,
              order.phone,
              historyId,
            );
          else {
            if (!config.outbound) throw new ProviderError('Outbound messaging is disabled');
            const integration = await freshShopifyIntegration(id);
            messageId = await sendOrderConfirmation(
              integration,
              order,
              claimed.merchant.brandName,
              async (preview) => {
                if (historyId) await updateMessage(id, historyId, { preview });
              },
              historyId,
            );
          }
        } else if (candidate.kind !== 'TAG') messageId = `demo-${candidate.id}`;
        if (historyId && messageId)
          await updateMessage(id, historyId, { status: 'ACCEPTED', messageId });
        await mutate(id, (s) => {
          const j = s.workspace.jobs.find((j) => j.id === candidate.id)!;
          const o = s.workspace.orders.find((o) => o.id === order.id)!;
          j.state = 'DONE';
          j.claimedAt = undefined;
          j.retryable = false;
          resolveNotification(s.workspace, 'job:' + j.id);
          if (messageId && !o.confirmationExpiresAt)
            o.confirmationExpiresAt = new Date(
              Date.now() + reliability(s.workspace).maxMessageAgeHours * 3600000,
            ).toISOString();
          j.messageId = messageId;
          if (j.kind === 'TAG') {
            if (!o.tags.includes('COD-CONFIRMED')) o.tags.push('COD-CONFIRMED');
          } else if (j.kind === 'CANCEL') {
            o.status = 'CANCELLED';
            const task = s.workspace.tasks.find(
              (t) => t.orderId === o.id && t.kind === 'Cancellation' && t.status === 'APPROVED',
            );
            if (task) {
              task.status = 'VERIFIED';
              task.detail += '\nShopify cancelledAt verified by Relay.';
            }
            append(
              conversation(s.workspace, o),
              'note',
              'Shopify cancellation confirmed. No order was deleted.',
            );
          } else if (j.kind === 'TEST_CONFIRMATION') {
            append(
              conversation(s.workspace, o),
              'note',
              `Meta accepted the order confirmation template for ${o.number}. Delivery not yet confirmed. Buttons: Confirm order / Cancel order.`,
            );
          } else if (j.kind === 'TEST_HELLO') {
            append(
              conversation(s.workspace, o),
              'note',
              'Meta accepted a hello_world test request triggered by this order. Delivery is not confirmed. The sample contains no order details or confirmation buttons.',
            );
          } else {
            append(
              conversation(s.workspace, o),
              config.demo ? 'out' : 'note',
              config.demo
                ? `${j.kind === 'REMINDER' ? 'A quick reminder: ' : ''}Hi ${o.name.split(' ')[0]}, please confirm order ${o.number} (${o.currency} ${o.amount.toLocaleString()}). Reply Confirm, Change, or Cancel.`
                : `Meta accepted template ${s.workspace.integration.templateName} for ${o.number}. Confirm/Cancel buttons included. Delivery not yet confirmed.`,
            );
            if (j.kind === 'CONFIRMATION' && s.workspace.settings.reminders)
              enqueue(s.workspace, o, 'REMINDER', s.workspace.settings.reminderHours * 3600000);
          }
          activity(
            s.workspace,
            `${config.demo ? 'Simulated' : 'Completed'} ${j.kind.toLowerCase()} for ${o.number}`,
          );
        });
      } catch (error) {
        if (historyId)
          await updateMessage(id, historyId, {
            status: error instanceof ProviderError && error.ambiguous ? 'UNKNOWN' : 'FAILED',
            error: error instanceof Error ? error.message : 'Operation failed',
          });
        await mutate(id, (s) => {
          const j = s.workspace.jobs.find((j) => j.id === candidate.id)!;
          if (j.state === 'DONE' && !j.claimedAt) return; // Reconciliation already proved completion.
          j.error = error instanceof Error ? error.message : 'Operation failed';
          const policy = jobRetry(j.kind, error, j.attempts);
          j.state = policy.retry ? 'QUEUED' : policy.unknown ? 'UNKNOWN' : 'FAILED';
          j.claimedAt = undefined;
          j.retryable = policy.retry;
          if (policy.retry) j.dueAt = new Date(Date.now() + policy.delay).toISOString();
          notify(
            s.workspace,
            'job:' + j.id,
            policy.unknown
              ? 'Action outcome is uncertain'
              : policy.retry
                ? 'Action scheduled for retry'
                : 'Action failed',
            j.error,
            policy.unknown
              ? 'Check provider history. Relay will not blindly resend.'
              : policy.retry
                ? 'Relay will retry after ' + new Date(j.dueAt).toLocaleString() + '.'
                : 'Review credentials, permissions, or the order, then retry from Automations.',
          );
          if (j.kind === 'CANCEL') {
            conversation(
              s.workspace,
              s.workspace.orders.find((o) => o.id === candidate.orderId)!,
            ).human = true;
          }
          activity(
            s.workspace,
            `${candidate.kind.toLowerCase()} needs attention for ${order?.number ?? 'order'}`,
          );
        });
      }
    }
  } finally {
    running = false;
  }
}
