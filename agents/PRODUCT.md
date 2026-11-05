# Product contract

## Purpose and experience

Reduce routine merchant effort while keeping customer decisions, external action outcomes, and exceptions visible. Relay should offer a calm, professional workspace for orders, messages, inbox, integrations, reliability, and reports. Merchants retain control of their business identities and credentials.

## Core workflow

1. Merchant registers a workspace and authorizes a Shopify store through Relay's shared Shopify application.
2. Merchant connects their Meta sender, token, incoming webhook credentials, and an approved template. These settings belong to that workspace.
3. Signed Shopify events enter a durable inbox. Reconciliation recovers missed orders using the same ingestion rules.
4. Eligible COD orders create an initial confirmation job atomically. Existing jobs and message history prevent duplicate initial sends.
5. Workers fill the selected approved template with order values and send through the saved merchant sender. Template approval happens before use, not for every order.
6. Signed Meta callbacks record delivery events and customer decisions. Match tenant, sender, recipient, order payload, and message context before acting.
7. Relay records the result and queues any Shopify action. Display external synchronization separately from the customer decision.

## Decision semantics

- Confirm: Relay confirms the order and queues `COD-CONFIRMED` tagging. Payment remains pending and fulfillment remains unchanged.
- Cancel while awaiting a decision: request cancellation; verify current Shopify eligibility and completion before displaying Cancelled.
- Cancel after confirmation: move to Needs review, save an open cancellation request, and hand over to a human. Do not automatically cancel Shopify. Queue removal of COD-CONFIRMED and addition of CANCELLATION-REQUESTED. Merchant approval with a reason queues guarded Shopify cancellation; only verified cancelledAt moves Relay to Cancelled. Tag cleanup is separately tracked and retryable.
- Duplicate delivery of the same event must be harmless. A distinct changed decision must not be mistaken for the same webhook delivery.
- Late, ambiguous, paid, fulfilled, or conflicting cases need explicit review according to the current policy. Do not reopen a cancelled order automatically.
- Removing an order from Relay archives it and retains history/deduplication. Explicit restore may show it again without repeating completed sends. Shopify orders are not deleted.

## Messaging rules

Phone collection alone is not messaging permission. Preserve recorded permission, opt-out, subscription, age, automation, sender readiness, and platform controls. An explicitly authorized sandbox recipient is a limited test exception, never general customer consent.

The current confirmation adapter supports six positional body values: customer name, store name, order number, items/quantities, COD total, and delivery address; then Confirm and Cancel quick replies. Name and language are tenant settings. Additional template layouts require deliberate adapter support and validation.

No phone means no WhatsApp send; record an actionable reason. Do not infer a WhatsApp number from email. Missing replies, unavailable callbacks, and provider acceptance must not be presented as customer confirmation.

## Current boundaries and next stages

Implemented areas include tenant persistence, authentication, Shopify OAuth/intake/catch-up, message attempts, incoming Meta processing, guarded order actions, review, and bulk/archive operations. Verify individual capabilities in code/tests before making claims.

Public SaaS work remains: production consent/onboarding, account recovery and email verification, team roles, billing, privacy lifecycle and Shopify distribution requirements, backup/recovery validation, and production worker deployment. Human live replies, courier integrations, refunds, and address edits must not be advertised as automated unless implemented and verified.

Older README and operational paragraphs contain historical limits; the current implementation and regression tests must be checked when those descriptions conflict. Do not copy live identifiers, secrets, or temporary tunnel addresses into specifications.

Inbox groups order threads and general replies by customer phone inside each merchant workspace. Order labels preserve message context; ambiguous free-text replies never select an order or trigger Shopify actions. General live replies remain unavailable.
