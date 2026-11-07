# Relay Commerce — Technical Handover

> Updated: 2026-11-07. This is a secret-free project handover. Never put passwords, API tokens, app secrets, connection strings, customer data, or callback verification tokens in this file.

## Product

Relay Commerce is a multi-tenant merchant operations SaaS for Shopify stores using each merchant's own official Meta WhatsApp sender. The current pilot focuses on reliable COD order confirmation, customer decisions, message history, recovery, and merchant review. It is not yet a public SaaS release.

One shared application serves isolated merchant workspaces. Every provider credential, template choice, sender, order, conversation, and job must remain tenant-scoped.

## Pilot and hosting state

- Pilot merchant: ScentCode development store.
- Source repository: `waqasdeveloper9/Relay-App` on GitHub.
- PostgreSQL is hosted in Supabase.
- The application has been deployed to Railway. `APP_URL` and `WEBHOOK_BASE_URL` must always use the stable Railway HTTPS domain, never a temporary Cloudflare tunnel.
- Railway infrastructure values are server-only. Merchant Shopify/Meta credentials belong in encrypted tenant-scoped database records, not shared environment variables.

## Core behavior implemented or established

### Shopify

- Shopify custom app is installed with OAuth for the pilot store.
- New-order webhooks are the fast path when the public callback is reachable.
- Manual and scheduled Shopify reconciliation recover missed orders after downtime or delivery failures.
- Imports are deduplicated by tenant and Shopify order ID.
- A recovered/new COD order must also be checked for a missing confirmation-message job; importing an order alone is insufficient.

### WhatsApp / Meta

- Merchant config stores Phone Number ID, WhatsApp Business Account ID, access token, selected template/language, and Meta App Secret encrypted per workspace.
- The approved COD template uses order details and Confirm / Cancel quick replies.
- An API message ID means Meta accepted the request; it does **not** mean delivery. Delivery states are received from Meta webhooks.
- The app receives quick replies, normal inbound messages, and delivery states through the signed Meta `messages` webhook field. The sender account must also be subscribed to the app.
- The Meta App Secret verifies inbound webhook signatures. It is different from the access token.

### COD decisions

- Confirm reply → Relay marks the order `CONFIRMED` and queues a Shopify `COD-CONFIRMED` tag update. It never marks payment paid or fulfillment complete.
- A cancellation after confirmation is a conflict: Relay moves the order to `NEEDS_REVIEW`, records the customer request, and stops automatic cancellation.
- Latest desired business rule: on that post-confirm cancellation request, remove `COD-CONFIRMED` promptly, then require explicit merchant approval before cancelling in Shopify.
- Once the merchant approves cancellation in Relay, Relay must call Shopify's cancellation API, persist the reason/audit trail and external result, then mark the Relay order `CANCELLED` only after Shopify succeeds. Failed/unknown outcomes remain retryable and visible for review.

### Reliability and auditability

- Preserve durable webhook intake, atomic order/job creation, deduplication, bounded retries, provider outcome tracking, and a manual retry/reliability screen.
- Do not claim exactly-once delivery across Shopify or Meta.
- Every provider failure must have a merchant-visible reason and a retry/review path.
- Message history records outgoing messages and states such as accepted, sent, delivered, read, and failed.

## Inbox versus Messages

- **Messages** is the order/message audit trail: template requests, recipient, provider message ID, delivery status, and errors.
- **Inbox** is customer-centric: one conversation per tenant + sender + customer phone. It includes normal customer chat and linked order contexts.
- If a customer has multiple active orders, a general message should not be guessed onto one order. Ask for an order number or show relevant order choices; preserve the conversation independently.
- Customer messages received through Relay's configured sender are stored in Relay. Relay should not take over unrelated WhatsApp communications outside its configured sender/workspace.

## Customer-support automation direction

Start with deterministic, no-paid-AI replies:

- greetings and basic help;
- order status from Relay/Shopify;
- COD confirmation/cancellation status;
- shipping and delivery-policy answers;
- return/cancellation-policy answers;
- clear human handoff for ambiguity, disputes, payment, dispatch, or other risky actions.

When the customer has messaged the business, Meta's 24-hour customer-service window permits free-form replies. After that window, an approved template is required. Relay itself does not charge per reply; Meta's applicable pricing rules do.

## Shopify policy work completed in the pilot

- Default return/cancellation rules were configured for the test store (14-day return window; cancellation until fulfillment).
- A Pakistan-wide COD shipping policy was added and published.
- Policies remain merchant-owned legal/business content; Relay can read and use them for factual replies but must not invent legal advice.

## Exact point where work stopped

The Shopify app version named `shipping-policy-access` was created and made active to add Shopify's `read_legal_policies` scope.

The next feature is policy-backed deterministic customer responses. Relay needs the legal-policy read scope in its OAuth request, then the connected merchant must reauthorize so Shopify grants that new scope. After reauthorization, Relay can safely retrieve the merchant's published policy text for shipping, delivery, return, and cancellation questions.

## Exact next task

1. Inspect the Shopify OAuth scope configuration in code and ensure `read_legal_policies` is requested alongside the existing required scopes.
2. Add or verify a tenant-scoped policy retrieval service with runtime validation, safe caching, and failure handling.
3. Add deterministic inbound reply rules that use policy data only when present and otherwise hand off to a human.
4. Deploy the code, then use **Reconnect Shopify** in Relay and approve the updated Shopify permissions for the pilot merchant.
5. Verify a policy question from WhatsApp reaches the customer-centric Inbox and gets the correct safe response.

## External setup that must remain valid

- Railway service is online with a stable public HTTPS domain.
- Shopify app URLs, redirect URL, and webhooks must point to the deployed Relay URL.
- Meta webhook callback must point to Relay's active tenant callback URL and be verified with its matching verification token.
- Meta must have the `messages` webhook field subscribed and the merchant's sender subscribed to the Meta app.
- Any changed callback URL requires Meta callback verification again.

## Open questions / follow-up work

- Confirm final cancellation UX: collect a merchant reason, remove the confirmation tag, invoke Shopify cancellation only after explicit approval, and surface provider failures.
- Complete remaining merchant-authored legal/business policies: return/refund policy, terms, contact information, and any business-specific exclusions.
- Expand customer-support automation only after deterministic rules, tenant isolation, message-window checks, human handoff, and audit records are verified.
- Before public SaaS release: production onboarding, billing, app review/distribution, production Meta verification, scalable worker/queue scheduling, monitoring, and operational runbooks.

## Verification checklist for future changes

- Run strict build and relevant tests.
- Verify tenant isolation for every query and callback.
- Verify Shopify HMAC and Meta signature handling independently.
- Test: new order webhook, missed-order reconciliation, duplicate import, outbound message accepted/delivered/failed, confirm, cancel-before-confirm, cancel-after-confirm, manual merchant cancellation, and normal inbound customer chat.
- Report what was actually verified versus what still depends on Shopify, Meta, Railway, or merchant configuration.
