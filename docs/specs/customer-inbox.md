# Customer Inbox

Inbox groups legacy order conversations and general messages by customer phone within the authenticated workspace. Storage retains order conversation IDs and their takeover state; customer-wide read/takeover actions apply to all current threads for that phone. Each displayed order message retains its original order label. General messages have no inferred order when ambiguous. Signed order actions retain existing exact correlation and deduplication.

Add nullable order association and phone to Conversation with an additive migration. Existing history is retained without destructive backfill. New unmatched inbound messages persist in a general thread. Messages remains the outbound attempt ledger. Live free-text replies remain disabled until separately implemented.

Acceptance: one Inbox row for multiple orders with the same phone; chronological history with order labels; ambiguous messages persisted; repeated provider event harmless; no cross-tenant grouping; compact desktop and mobile layouts. No automatic replay of old processed webhooks or live provider actions during tests.
