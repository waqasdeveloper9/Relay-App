# Recovery and incoming WhatsApp setup

Merchant integration credentials and recovery settings are stored per merchant in PostgreSQL. Access tokens and Meta App Secrets are encrypted with the server encryption key; verification tokens are random and only their SHA-256 hashes are stored. API snapshots expose saved-state flags, never secrets. The server environment contains infrastructure credentials and the shared Shopify OAuth application credentials, not individual merchant WhatsApp settings.

## Finish Meta setup

1. Open Integrations. Save the App Secret from the Meta app used by the saved sender. Blank secret/token fields preserve the existing encrypted values.
2. Test the saved WhatsApp connection.
3. Generate a verification token. Copy it immediately; it is shown once.
4. In that Meta app's WhatsApp webhook configuration, verify and save the displayed merchant callback URL and token. Subscribe to the `messages` field.
5. In Relay, click **Subscribe sender account to app**. This calls Meta's WABA `subscribed_apps` endpoint with the merchant's saved token. The token needs the appropriate WhatsApp management permission. Keep the Meta `messages` field subscribed.
6. Validate the selected approved six-variable confirmation template.
7. In Reliability, authorize the owned, Meta-verified test recipient for 24 hours. This authorization is tenant-bound, number-bound and template-bound, and does not imply customer consent.
8. Place a recent unpaid, unfulfilled COD order using that number. Inspect Messages, then click Confirm order on WhatsApp. Relay records the decision and queues the Shopify tag. Check the order details for the tag job outcome.

Callback verification is tied to the configured public URL. If a testing tunnel changes, update Meta's callback and verify again. Register Shopify webhooks for the new URL too. A successful API connection check alone does not prove webhook delivery.

## Processing and recovery

- Signature verification happens against raw request bytes before accepting events. Intake performs indexed tenant lookups, stores an inbox event, and acknowledges only after storage succeeds. Invalid signatures are rejected.
- Inbox workers claim durable events with expiring leases. Duplicate deliveries are harmless. Failed events remain stored, retry with backoff, and enter a failed state after eight attempts. Reliability exposes retry controls and persistent notifications.
- Shopify catch-up uses an overlapping, checkpointed `updated_at` window with cursor pagination. A page advances only after its orders are committed. Failed windows resume. Older versions cannot overwrite newer order state.
- New tenants start with a seven-day lookback and five-minute catch-up interval, configurable in Reliability. The implementation refuses to silently advance a checkpoint beyond Shopify's default 60-day access window; broader recovery needs the appropriate Shopify access scope and an extended recovery strategy.
- Recovered orders default to merchant review. Automatic recovery messaging must be selected explicitly and still checks order age, phone, consent, subscription, automation, sender readiness and current Shopify eligibility. The manual recheck control applies the same checks.
- Order ingestion and outgoing-job creation occur in one database transaction. A unique order/action constraint prevents duplicate initial jobs. Job claims are saved before provider calls.
- Retryable definitive failures use bounded exponential backoff with jitter and Retry-After support. Credential and eligibility failures require correction. Uncertain sends are not blindly retried.
- Every message attempt has its own history row and correlation ID. Meta status callbacks can recover a lost HTTP response using the echoed correlation ID. A late send response cannot overwrite delivered/read status. If neither a response nor a receipt proves the outcome, the history remains unknown for review.
- After a worker restart, known persisted send results restore completed jobs without resending. Unknown Shopify tag calls can be safely retried. Catch-up can resolve cancellation and tag jobs when Shopify's resulting state proves completion.
- A verified button is matched to the merchant's sender, recipient, signed order payload and sent-message context. First decision wins. Expired, conflicting, unmatched, paid or fulfilled-order decisions require review. Live free-text replies go to human review rather than executing an ambiguous order action.
- Confirmation updates Relay and queues `COD-CONFIRMED` tagging in Shopify. It does not mark an order paid or fulfilled. Cancellation is marked complete only after Shopify confirms cancellation; no order is deleted.

## Operations and limits

Run `npm run db:generate`, `npm run db:deploy`, `npm run build`, then `npm start`. The local server runs both workers; they resume from database state after restart. Production needs an always-running worker or an equivalent scheduled runner. A Vercel request function alone does not keep these timers alive.

The new recovery tables deny browser roles and enable RLS without public policies. Use the backend table-owner connection. The custom merchant JWT is enforced by Relay, not Supabase Auth; do not expose internal tables through the Data API.

This implementation provides durable recovery, not a claim of exactly-once delivery across external providers. Shopify and Meta availability, token validity, webhook configuration and API retention limits still apply. Larger deployments should replace full workspace hydration with paginated read models and smaller write aggregates, add provider-wide rate budgets, configure backups, and exercise recovery on an independent staging database.

Provider references: [Shopify webhook best practices and reconciliation](https://shopify.dev/docs/apps/build/webhooks), [Meta-owned Cloud API collection: WABA subscriptions](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api).

### Orders management

The Orders page offers a manual Shopify rescan for the last 7, 30, or 60 days of updates. It uses the durable reconciliation cursor and tenant/order identity to merge records without duplicates. A manual request runs even when scheduled reconciliation is disabled. Historical recovered orders follow the configured recovery messaging policy.

Merchants can select orders across pages and bulk confirm, mark for review, or remove up to 500 orders per transaction. Confirmation queues the Shopify confirmation tag; review is a Relay state. Removal archives Relay records, stops queued actions, and retains audit history and duplicate protection. It never deletes Shopify orders. Normal reconciliation leaves archived records hidden; the explicit restore option restores matching records without creating duplicate orders or repeating completed jobs. Remove-all checks the reviewed record count and refuses removal during an in-flight action.

### Missing confirmations after recovery

New tenants default to one-minute reconciliation and SEND_ELIGIBLE recovery. Existing tenant policies remain configurable. Reconciliation rechecks pending, unarchived orders even when their Shopify timestamps have not changed. A saved outbound message or existing confirmation job prevents a second send. Normal messaging still requires permission, active automation/subscription, age/fulfillment checks, platform outbound enablement, and verified incoming webhook setup. An explicitly authorized, unexpired sandbox test may send the selected order template only to its saved owned recipient without implying customer consent; delivery receipts and button replies still require the Meta callback. The order drawer exposes a per-order confirmation queue action and the Orders table shows the blocking reason.

Local instant Shopify ingestion requires a reachable callback. WEBHOOK_BASE_URL optionally separates Shopify webhook hosting from the dashboard APP_URL. The optional scripts/shopify-webhook-gateway.mjs forwards only signed POST requests to /api/webhooks/shopify and denies all other routes. A public tunnel requires authorization because it transports customer/order payloads through the tunnel provider.
