# Architecture rules

## Stack and dependency boundaries

Use the existing Node.js 20+ ESM, strict TypeScript, Express 5, React 19/Vite, Prisma 6, and PostgreSQL stack. Check `package.json` and lockfile for actual versions. Confirm current official provider documentation when changing API contracts or versions.

Keep the modular monolith. The request path is routes/middleware → controllers → application services → repository/provider adapters. Domain contracts live in `src/models/types.ts`; persistence schema lives in `prisma/schema.prisma`.

- Controllers validate input, invoke use cases, and map responses. Keep orchestration and business decisions in services.
- Business rules must not depend on Express request/response objects or React components.
- Provider adapters own external HTTP protocols, timeouts, error classification, and response validation. Do not duplicate provider calls in controllers or UI.
- Repository operations own persistence and transaction behavior. Avoid scattered Prisma writes that bypass workspace invariants.
- The UI uses public domain/API contracts, never Prisma internals or encrypted persistence records.
- Keep demo and connected adapters compatible with the same business rules; simulation belongs at adapter boundaries.

Use cohesive functions and explicit types; avoid unchecked casts, broad `any`, hidden side effects, and speculative abstractions. Introduce smaller modules when responsibilities grow, without creating layers solely for naming conventions.

## Persistence

Maintain tenant compound keys/foreign keys and unique order identities. Order ingestion plus initial job scheduling must commit atomically. Preserve revision checks and bounded transaction-conflict retries.

Use additive, reviewed migrations and safe backfills. Never reset a connected database, drop tables, or rewrite applied migrations as a routine fix. Apply deployment migrations deliberately against the intended environment. Preserve encryption-key continuity.

Store amounts with currency using database decimal types. Current display contracts contain JavaScript numbers; do not extend those into payment calculations. Introduce a decimal-safe domain representation before financial arithmetic/reconciliation.

## Known scaling work

The repository currently hydrates a workspace for domain operations. Do not describe that as unbounded production scalability. Larger workloads need paginated read models, narrower write aggregates, bounded query sizes, provider rate budgets, and independent durable workers. Avoid adding new full-table scans or unbounded Promise concurrency.

Timer-based workers require a persistent process or equivalent durable runner. Do not assume Vercel request functions keep background timers alive. Public callback hosting and dashboard hosting may differ; preserve their distinct configuration.
