# Customer Inbox

Inbox groups legacy order conversations and general messages by customer phone within the authenticated workspace. Storage retains order conversation IDs and their takeover state; customer-wide read/takeover actions apply to all current threads for that phone. Each displayed order message retains its original order label. General messages have no inferred order when ambiguous. Signed order actions retain existing exact correlation and deduplication. Meta interactive button selections retain their button title in Inbox history alongside tracked `SUPPORT_MENU` and `SUPPORT_REPLY` status badges.

Outbound free-form replies from Inbox (`action: 'reply'`) are available in both demo and connected modes:

- Demo mode records simulated outbound messages locally without external network calls and pauses the assistant for that customer.
- Connected mode validates tenant conversation ownership, a valid customer phone number, a verified WhatsApp Cloud API sender, verified Meta callback/subscription readiness, active outbound/trial or unexpired matching 24-hour own-number test authorization, and a customer inbound message received within the last 24 hours.
- Before calling Meta, Relay persists an `OutboundMessage` row (`kind: 'INBOX_REPLY'`, status `'SENDING'`) with a correlation ID, sends via the merchant's verified sender, records `'ACCEPTED'` on Meta message ID receipt, marks all customer threads read with human takeover enabled, and appends the outbound reply to the customer's general thread.
- Ambiguous provider timeouts/5xx responses move the message attempt to `'UNKNOWN'`, record an operator notification and internal Inbox note without fabricating delivery, and hold resending for reconciliation. Definitive provider rejections mark the attempt `'FAILED'` without inserting an outbound chat bubble.
- Delivery webhooks (`sent`, `delivered`, `read`, `failed`) correlate monotonically via Meta message ID or `biz_opaque_callback_data`. Never disable the Inbox composer silently: display the exact missing prerequisite when sending is unavailable.
- When the composer is active, provide compact keyboard-accessible Quick reply snippet chips that populate the editable reply draft without auto-sending.

Acceptance: one Inbox row per customer phone; chronological history with order labels; live Inbox reply accepted and tracked in Messages/Inbox within the 24-hour window; rejects cross-tenant access, expired 24-hour windows, and unauthorized sends; ambiguous failures stay conservative; compact desktop and mobile layouts. No live provider calls during automated tests.
