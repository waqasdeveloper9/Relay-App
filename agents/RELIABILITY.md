# Integration and recovery invariants

Read the implementation in `incoming-events`, `inbox-worker`, `order-ingestion`, `shopify-reconciliation`, `worker`, and `message-history` services plus [operational setup](../docs/RELIABILITY.md) before changing external workflows.

## Intake and reconciliation

Accept only authenticated provider events; persist before acknowledgment. Workers use expiring leases and bounded retries so crashes do not silently lose accepted work. Preserve failed events and useful reasons for operator recovery.

Shopify webhooks provide prompt intake; checkpointed reconciliation recovers missed events. Use overlapping fixed windows and cursor pagination. Advance progress only after committed records. Preserve newer source versions and tenant/order uniqueness. Respect available history/scopes rather than silently skipping an inaccessible gap.

Manual and scheduled sync share ingestion/eligibility logic. Recheck missing initial confirmation jobs even for unchanged pending orders. Restore archived records only through explicit restore behavior. Do not send again merely because an order was imported again.

## Outbound effects

Persist job identity and claim before calling a provider. Track each message attempt and provider ID. Keep accepted, sent, delivered, read, failed, and unknown outcomes distinct. Apply callbacks monotonically and correlate receipts that arrive before the HTTP response.

Retry only definitive retryable failures with bounded exponential backoff, jitter, Retry-After handling, and lease protection. Authentication/permission/configuration failures require correction. An HTTP timeout can hide a successful send: hold unknown outcomes for reconciliation instead of blindly resending. Safe idempotent Shopify actions can follow a different retry policy from message sends.

Check current Shopify state before cancellation. Mark cancellation complete only when Shopify confirms it. Never convert confirmation into payment collection or fulfillment. Preserve separate customer decision and Shopify synchronization outcomes.

## Operator visibility

Persist actionable failures and notifications with safe provider codes, timestamps, affected order/message, and retry/review guidance. Connection checks prove credential access only; separately show callback verification, sender subscription, last incoming event, and job outcomes where implemented.

Keep sandbox authorization tenant-, recipient-, template-, and time-bound. Never promote a temporary test exception into general outbound permission. A public development tunnel must be reachable and configured; a saved token does not prove ingress works. Do not hardcode temporary URLs.

Exactly-once external delivery is not guaranteed. Describe the actual deduplication, recovery, and unknown-outcome guarantees. Test crash/replay, duplicate intake, changed decisions, stale events, and cross-tenant scenarios when modifying this area.
