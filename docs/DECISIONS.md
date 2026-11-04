# Engineering decisions

## Single application, explicit boundaries

React/Vite and Express share TypeScript domain contracts. A modular monolith avoids network boundaries that do not help an initial client pilot. The repository and provider boundaries allow replacing runtime/deployment adapters later. No microservices or paid AI dependencies are required.

## Tenant isolation

The merchant ID comes exclusively from the verified session cookie. Request bodies cannot select another tenant. All order and conversation lookups occur inside the authenticated workspace. PostgreSQL composite foreign keys bind messages, jobs, and customer requests to their tenant's orders/conversations. Provider routing uses uniquely configured store domains and phone IDs. Shared WhatsApp senders are not supported.

## External effects

Webhook handlers verify raw bytes, validate payloads, and commit domain updates before acknowledging. They do not call external messaging APIs inline. Worker claims persist UNKNOWN before an external call. A timeout may mean the provider accepted an action, so unknown sends are not automatically retried. Explicitly failed jobs can be retried up to three attempts with a short exponential delay. Full delivery reconciliation remains a launch requirement.

## Customer requests

OPEN means a request exists. APPROVED means a merchant authorized manual work. VERIFIED means a merchant recorded completion evidence. These states do not imply automated fulfillment holds or provider-verified order changes. The interface states this explicitly.

## Demo truthfulness

The demo has isolated seeded accounts and in-memory persistence. Its integration tests never validate real provider credentials. Demo message IDs are prefixed with `demo-`. Connected inbound handling records suggested replies as notes rather than claiming messages were sent. Reports do not equate confirmed value with collected revenue or successful delivery.

## Initial rollout

This release is for local development and workflow testing. Merchant-bound Shopify OAuth and expiring offline token refresh are implemented. Supabase migrations and persistence have been verified; real Shopify authorization and webhook delivery still require merchant approval and correct distribution settings. There is no paid hosting provisioning, automatic billing, or complete live WhatsApp responder. The dashboard exposes these boundaries, and the README lists production gates.
