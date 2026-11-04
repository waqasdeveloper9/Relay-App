# Relay Commerce — agent instructions

Read this file before changing this repository. These instructions apply throughout the project. Read the relevant guides below before implementation; do not rely on conversation history for product requirements.

## Product and scope

Relay is a merchant operations SaaS connecting Shopify stores with their own official Meta WhatsApp senders. Its initial focus is reliable Cash on Delivery order confirmation, customer decisions, message history, recovery, and merchant review. One shared application serves isolated merchant workspaces. A merchant's customers receive messages from that merchant's configured sender.

The current product is a development/client pilot, not a completed public SaaS release. Preserve the distinction between implemented behavior, sandbox authorization, and production readiness. Registration assigns a seven-day trial; billing and complete self-service onboarding remain future work.

## Required reading

- [Product behavior and current boundaries](agents/PRODUCT.md)
- [Architecture and stack rules](agents/ARCHITECTURE.md)
- [Tenant isolation and security](agents/SECURITY.md)
- [External integrations and recovery](agents/RELIABILITY.md)
- [Frontend and user experience](agents/FRONTEND.md)
- [Spec-driven development and verification](agents/WORKFLOW.md)

## Non-negotiable rules

1. Scope every merchant operation to the authenticated tenant. Verify provider callbacks independently; never trust a tenant ID in a body or URL as authorization.
2. Store merchant integration credentials and preferences in tenant-scoped persistence. Encrypt secrets, return saved-state flags, and preserve existing secrets when replacement fields are blank. Keep infrastructure keys and shared platform application credentials server-side.
3. Never hardcode a merchant, store, sender, recipient, template selection, token, callback hostname, or test authorization into business logic.
4. Preserve durable intake, atomic order/job creation, deduplication, bounded retries, and conservative treatment of unknown external outcomes. Do not claim exactly-once delivery across providers.
5. A Meta message ID means accepted, not delivered. Customer confirmation means neither payment nor fulfillment. A cancellation request means neither successful Shopify cancellation nor deletion.
6. Preserve clean boundaries in the existing modular monolith. Do not introduce a framework rewrite, microservices, paid AI, or infrastructure dependency without a requirement that justifies it.
7. Use strict TypeScript, runtime validation at trust boundaries, readable English code/comments, and the existing formatting conventions.
8. Do not remove security checks to make a test pass. Demo mode must remain isolated from real providers. Live tests must stay within the user's authorized recipient/store/action scope.
9. Update relevant specifications and guides when behavior changes. Report what was actually verified and any remaining external setup.

## Navigation and commands

Backend: `src/`; React UI: `web/`; schema/migrations: `prisma/`; tests: `src/tests/`; operational documentation: `docs/`.

Use the scripts in `package.json`: `npm run dev`, `npm test`, `npm run build`, `npm run db:generate`, and `npm run db:deploy`. Read the workflow guide before database operations. Never print `.env` or credential records.

## Portability

This file is the canonical repository entry point for AI tools. Tools that do not automatically load `AGENTS.md` must be instructed to read it. If a tool requires its own instruction file, make that file reference this guide rather than maintaining conflicting copies. An `agents/` directory is documentation, not an automatic tool hook.

Explicit user instructions take precedence over these repository conventions. If documentation and implementation differ, inspect the code and tests, explain the discrepancy, and update the relevant guide; do not silently implement stale documentation.
