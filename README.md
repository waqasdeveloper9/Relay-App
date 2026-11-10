# Relay — Shopify + WhatsApp operations

A development-first merchant workspace for COD confirmation, customer conversations, request follow-through, and daily reporting. The default demo is free to run, never contacts Shopify or Meta, and never sends external messages.

## Quick start

Requirements: Node.js 20+ and npm. Node.js 24 is verified in this workspace.

```sh
npm install
npm run db:generate
npm run dev
```

Open **http://127.0.0.1:5173**. The API runs on port 3001. The dashboard automatically opens an isolated, seeded demo account when no session exists. No `.env` file, database, credit card, or provider credentials are required for the demo. API and dashboard must both be running; `npm run dev` starts both.

Use **Test workflow** to create a COD order, simulate a confirmation, ask a tracking question, or request an address change. Use **Inbox → Simulate customer** to test additional messages. The dashboard refreshes after actions and polls every ten seconds.

Demo accounts and data live in server memory. Restarting the API clears them and invalidates demo sessions. Account registration creates an empty workspace rather than silently adding sample orders. The **Explore the demo** button creates a separate seeded account.

## What is implemented

- Responsive React operations dashboard: overview, searchable/paginated orders, inbox, automations, integration setup, reports, and settings.
- Merchant registration and sign-in, bcrypt password hashes, expiring JWTs in HTTP-only SameSite cookies, origin checking, request validation, and rate limiting.
- Seven-day trial assignment and outbound eligibility checks. Trial expiry does not prevent viewing or recording incoming messages.
- Encrypted integration credentials using AES-256-GCM; credential values never appear in workspace API responses.
- Merchant-bound Shopify OAuth, one-time browser state, signed callbacks, encrypted offline token refresh, and explicit idempotent webhook registration.
- Signed Shopify COD order intake, app-uninstall token removal, and webhook deduplication.
- Signed Meta message intake, contextual order matching, ambiguous-match protection, and human takeover.
- Rules-based confirmation, tracking information, approved FAQ text, change requests, and human escalation. No paid AI required.
- Confirmation jobs, one scheduled reminder, Shopify confirmation tags, and execution logs. Demo jobs are simulated.
- Request approval separated from merchant-recorded completion evidence. Approval does not claim an external order edit succeeded.
- Manual retries for definitively failed jobs, with a three-attempt cap. Uncertain outcomes are held for reconciliation instead of blindly resending.
- Timezone-aware daily report and currency-separated confirmed order totals. CSV exports escape spreadsheet formula prefixes.
- Normalized PostgreSQL models, compound tenant foreign keys, idempotency constraints, and serializable workspace mutations with bounded conflict retries.

## Deliberate live-mode boundaries

This is a working development MVP, **not a public production SaaS release**.

| Capability                      | Demo                           | Connected mode                                                                 |
| ------------------------------- | ------------------------------ | ------------------------------------------------------------------------------ |
| COD confirmation workflow       | Fully simulated                | Template adapter exists; outbound disabled by default                          |
| Integration check               | Explicitly simulated           | Real provider metadata request                                                 |
| Customer replies                | Simulated inbound and outbound | Signed inbound messages; rule-based order/policy replies & internal notes      |
| Human inbox reply               | Simulated                      | Live WhatsApp text replies within the 24-hour customer window                  |
| Address/cancel/refund execution | Manual action + evidence       | Manual action + evidence                                                       |
| Tracking                        | Seeded order state             | Intake only; continuous fulfillment/courier synchronization is not implemented |
| Persistence                     | Volatile memory                | Prisma/PostgreSQL                                                              |

Outbound confirmation requires recorded messaging permission. Phone collection at checkout is deliberately **not** treated as permission. Live consent capture is not implemented yet, so newly received live orders are recorded without scheduling confirmation messages. Do not manually alter database consent flags as a substitute for a consent workflow.

Automatic address changes, refunds, cancellation, warehouse holds, courier booking, payment collection, and delivery guarantees are not performed. No claim is made that a successful Meta send response proves delivery.

## Connect Supabase later

1. Create your own Supabase development project; no paid plan is required for initial testing within its limits.
2. Copy `.env.example` to `.env` locally. Keep it out of source control.
3. Set `DEMO_MODE=false`, a PostgreSQL `DATABASE_URL`, a random `JWT_SECRET` of at least 32 characters, and a base64 32-byte `ENCRYPTION_KEY`.
4. Generate keys locally:

   ```sh
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

5. Run `npm run db:generate` and `npm run db:deploy`. The initial SQL migration is included. Use the provider-recommended PostgreSQL connection string and TLS settings. For future schema edits use `npm run db:migrate -- --name descriptive_change` against your development database.
6. Restart the API and register an account. Connected workspaces begin empty.

The server uses a privileged PostgreSQL connection. Browser clients must not receive that connection string or directly access these tables. Application authentication enforces tenant boundaries; do not expose this schema through Supabase's Data API without separate RLS policies and grants. Prefer a dedicated schema/role for deployment.

The development Supabase database is now connected. Both migrations were applied, and encrypted token persistence and one-time OAuth state were verified using a disposable account that was removed afterward. Real Shopify authorization still requires the merchant to approve the app.

## Assisted integration setup

Use **Integrations → Connect Shopify** to authorize a merchant store. The shared Relay app credentials belong in the server environment; merchant tokens are not manually pasted in connected mode. See [Shopify setup](docs/SHOPIFY_SETUP.md) for exact callback URLs and the HTTPS testing workflow. Store domains are restricted to `*.myshopify.com`, and tokens are encrypted with your server key. Preserve that key or stored tokens cannot be recovered.

For WhatsApp testing, configure Meta's official test number, its Phone Number ID, WABA ID, and token. Real check buttons are metadata reads; they do not send messages. Temporary Meta test tokens can expire.

Public HTTPS webhook callbacks:

- Shopify `orders/create`, `orders/updated`, `orders/cancelled`, and `app/uninstalled`: `/api/webhooks/shopify`
- Meta `messages`: `/api/webhooks/meta/:merchantId` (GET challenge and POST events)

Configure Shopify's actual signing secret as `SHOPIFY_APP_SECRET`. Save the working Meta app’s App Secret in Integrations. Generate a merchant verification token there, configure the displayed tenant callback in Meta, and subscribe to `messages`. The App Secret is encrypted in the merchant record; only the verification token hash is stored. For localhost callbacks, use an HTTPS tunnel, and set `APP_URL` to the dashboard origin. The Meta verify token is distinct from its API access token. Do not enter secrets into chat or commit them.

The confirmation adapter expects an approved positional template with six body values: customer name, store name, order number, items with quantities, COD total, and delivery address, followed by two quick-reply buttons: Confirm order and Cancel order. The template name and language are configurable. Other template layouts require an adapter change.

## Architecture

```text
web/                    React UI, API client, responsive design
src/controllers/        HTTP request handling
src/routes/             Authenticated API routes
src/middlewares/        JWT cookie authentication
src/services/
  automation.ts         Deterministic business rules
  repository.ts         Tenant-scoped memory / Prisma persistence
  providers.ts          Shopify GraphQL and Meta adapters
  worker.ts             Job claim and execution
  seed.ts               Explicit demo fixtures
src/models/             Shared domain contracts
src/utils/              Encryption, signatures, phone validation
src/tests/              Security and HTTP workflow tests
prisma/                 Relational schema and initial migration
```

The UI depends on domain contracts and the HTTP API, not database types. Demo and persistent adapters use the same business rules. PostgreSQL stores money as Decimal with currency; the current API presents decimal values as JavaScript numbers for display. Before adding payments or reconciliation, migrate financial calculations to a decimal-value domain type.

Webhook intake uses indexed tenant lookups and a durable inbox. Recovery uses checkpointed Shopify queries and leased inbox processing. Outbound jobs have durable claims, bounded retries, message-attempt history, and conservative handling of uncertain provider outcomes. The domain repository still hydrates a workspace per action; large-scale deployment should add paginated read models and narrower transaction aggregates, a dedicated worker, and per-provider rate budgets. Do not deploy the existing timer-based server worker as a Vercel serverless function; scheduled work needs an independent durable runner.

## Verification

```sh
npm test
npm run build
```

Tests start an ephemeral local API and use disposable in-memory accounts. They never connect to external providers. The build includes strict TypeScript checks for both client and server.

To serve a local production build, set `NODE_ENV=production`, set `APP_URL=http://127.0.0.1:3001`, and run `npm start`. Keep `DEMO_MODE=true` unless you have explicitly configured PostgreSQL and secrets. No paid services are automatically provisioned.

## Before a client launch

- Verify PostgreSQL migrations, backups, transaction conflicts, and cross-tenant constraints against a development database.
- Implement explicit consent capture, opt-out handling, template validation, delivery-status receipts, and live reply outbox processing.
- Implement fulfillment update synchronization and safe order selection for unmatched inbound messages.
- Complete required Shopify privacy/redaction webhooks and distribution review before public distribution.
- Add persistent event inbox/reconciliation, durable scheduling, operator recovery for uncertain jobs, and provider monitoring.
- Add account recovery, email verification, team roles, retention/deletion policy, and subscription billing before self-service SaaS use.
- Verify actual store scopes, Meta permissions, local courier support, and spending limits with the merchant.

All development can run locally without paid services. This repository does not create hosting subscriptions, cloud accounts, or billable API traffic in demo mode.

See [Recovery and incoming WhatsApp setup](docs/RELIABILITY.md) for durable queues, merchant-owned webhook credentials, catch-up synchronization, retries, and operational limits.
