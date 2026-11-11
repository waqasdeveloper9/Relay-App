# Product contract

## Purpose and experience

Reduce routine merchant effort while keeping customer decisions, external action outcomes, and exceptions visible. Relay should offer a calm, professional workspace for orders, messages, inbox, integrations, reliability, and reports. Merchants retain control of their business identities and credentials.

## Core workflow

1. Merchant registers a workspace and authorizes a Shopify store through Relay's shared Shopify application (`write_orders`, `read_legal_policies`, plus optional `write_fulfillments` and `write_merchant_managed_fulfillment_orders` when fulfillment creation, tracking updates, delivered events, holds, and courier webhooks are enabled).
2. Merchant connects their Meta sender, token, incoming webhook credentials, confirmation template, and optional stage WhatsApp Utility templates (dispatch, delivery, paid, in progress, on hold) in tenant storage.
3. Signed Shopify events enter a durable inbox (`orders/*` plus scope-gated `fulfillments/*`, `fulfillment_events/*`, `fulfillment_orders/*`). Reconciliation recovers missed orders using the same ingestion rules, and optional checkout consent rules (`syncCustomerSmsConsent`, `checkoutConsentAttributeKey`) record explicit opt-in consent without inferring permission from phone numbers alone.
4. Eligible COD orders (detected from workspace-configurable `codGatewayKeywords`) create an initial confirmation job atomically. Imported prepaid/non-COD orders (`importNonCodOrders`) sync as `CONFIRMED` without queuing COD confirmations or counting toward COD totals, and non-pending financial states suppress/stop COD confirmation sends.
5. Workers fill the selected approved templates with order/tracking values and send through the saved merchant sender. Template approval happens before use, not for every order.
6. Signed Meta callbacks record delivery events, `STOP`/`START` opt-out preferences, Help menu selections, and customer decisions. Match tenant, sender, recipient, order payload, and message context before acting.
7. Relay records the result, syncs Shopify payment & fulfillment/courier/tracking data bidirectionally (supporting merchant-triggered `mark_paid`, `mark_in_progress`, `reopen`, `hold`/`release_hold`, `fulfill`, `update_tracking`, and `mark_delivered` actions as well as daily routine/custom views), and queues tenant-configured Shopify tags or Relay-owned fulfillment holds (`handle: 'relay-hold'`). Display external synchronization separately from the customer decision.

## Decision semantics

- Confirm: Relay confirms the order and queues the workspace-configured confirmation tag (default `COD-CONFIRMED`) plus Relay-owned fulfillment hold release if enabled. Payment remains pending and fulfillment remains unchanged.
- Cancel while awaiting a decision: request cancellation; verify current Shopify eligibility and completion before displaying Cancelled.
- Cancel after confirmation: move to Needs review, save an open cancellation request, and hand over to a human. Do not automatically cancel Shopify. Queue removal of the confirmation tag, addition of the cancellation-request tag (default `CANCELLATION-REQUESTED`), and optional Relay-owned fulfillment hold. Merchant approval with a reason queues guarded Shopify cancellation; only verified cancelledAt moves Relay to Cancelled. Tag cleanup is separately tracked and retryable.
- Duplicate delivery of the same event must be harmless. A distinct changed decision must not be mistaken for the same webhook delivery.
- Late, ambiguous, paid, fulfilled, or conflicting cases need explicit review according to the current policy. Do not reopen a cancelled order automatically.
- Removing an order from Relay archives it and retains history/deduplication. Explicit restore may show it again without repeating completed sends. Shopify orders are not deleted.

## Messaging rules

Phone collection alone is not messaging permission. Preserve recorded permission, opt-out (`STOP` / `START` ledger), subscription, age, automation, sender readiness, and platform controls. An explicitly authorized sandbox recipient is a limited test exception, never general customer consent.

The current confirmation adapter supports six positional body values: customer name, store name, order number, items/quantities, COD total, and delivery address; then Confirm and Cancel quick replies. Stage notification Utility templates (Dispatch, Delivery, Paid, In progress, and On hold) map tenant-selected variables (`customer_name`, `brand_name`, `order_number`, `courier`, `tracking_number`, `tracking_url`, `total_amount`) to approved Meta placeholders without hardcoded layouts. Name and language are tenant settings.

No phone means no WhatsApp send; record an actionable reason. Do not infer a WhatsApp number from email. Missing replies, unavailable callbacks, and provider acceptance must not be presented as customer confirmation.

## Current boundaries and next stages

Implemented areas include tenant persistence, authentication, Shopify OAuth/intake/catch-up, bidirectional Shopify payment, fulfillment, tracking & hold operations, configurable tags and scope-gated Relay-owned fulfillment holds, daily-routine & saved custom order views, non-COD order import and explicit checkout opt-in sync, message attempts, incoming Meta processing, guarded order actions, customizable stage WhatsApp Utility alerts (dispatch, delivery, paid, in progress, on hold), configurable rule-based read-only WhatsApp support/policy auto-replies & Help menus, `STOP`/`START` opt-out ledger, manual live Inbox replies + editable Quick replies + order-thread linking within Meta's 24-hour customer service window, review, and bulk/archive operations. Verify individual capabilities in code/tests before making claims.

Public SaaS work remains: production consent/onboarding, account recovery and email verification, team roles, billing, privacy lifecycle and Shopify distribution requirements, backup/recovery validation, and production worker deployment. Courier integrations, automatic refunds, and automated address edits must not be advertised as automated unless implemented and verified.

Older README and operational paragraphs contain historical limits; the current implementation and regression tests must be checked when those descriptions conflict. Do not copy live identifiers, secrets, or temporary tunnel addresses into specifications.

Inbox groups order threads and general replies by customer phone inside each merchant workspace. Order labels preserve message context; ambiguous free-text replies never select an order or trigger Shopify actions. Manual live Inbox replies pause automated replies (`human = true`) and send free-form text via the merchant's verified WhatsApp sender only within 24 hours of the customer's latest inbound message.

## Rule-based WhatsApp support replies

Use rules, Shopify order/legal-policy data, and merchant-editable reply text (`settings.policy`). Automate read-only order status, tracking, shipping/delivery policies, store/refund policy questions (`settings.tracking` and `settings.faqs`), and a bounded interactive 3-button Help menu (`Order status`, `Store policies`, `Talk to support`) with a repeat cooldown inside Meta's 24-hour customer reply window. Verify incoming Meta events and match orders strictly against the merchant workspace and verified sender phone (`order.phone === from`); prefer quoted context or explicit order numbers verified against that phone, ask for the order number when several orders match, and reply honestly when no order matches that phone. Hand off `Talk to support` button taps (`human = true`, single polite acknowledgment) and action/issue requests (cancellations, returns, refunds, address edits, complaints) to staff in Inbox / Tasks. Keep unrelated acknowledgments silent and skip automated follow-ups once human takeover is active or outside the 24-hour window.

Read current order facts and published legal policies from Shopify (`read_legal_policies`) and send through the merchant's WhatsApp sender. Record replies, interactive menus, and delivery outcomes in Inbox and Messages (`SUPPORT_REPLY` and `SUPPORT_MENU`). Relay adds no per-reply fee for these service replies; Meta provider charges and rules apply.
