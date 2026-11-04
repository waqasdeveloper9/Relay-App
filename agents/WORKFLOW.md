# Spec-driven development workflow

## Before implementation

Read `AGENTS.md`, relevant guides, nearby implementation/tests, and existing operational docs. Inspect actual versions and scripts. Preserve unrelated work. Do not assume an earlier chat, screenshot, or stale README proves current runtime behavior.

For a meaningful feature or workflow change, create/update a focused Markdown specification in `docs/specs/` before coding. Small fixes can use a short acceptance checklist in the task report or existing spec. Specifications should record:

- Problem, user outcome, scope, and exclusions.
- Tenant authorization, data ownership, and state transitions.
- API/UI/schema changes and external effects.
- Duplicate, retry, crash, timeout, late-response, and recovery behavior.
- Observable acceptance criteria, verification, migration/rollout needs, and remaining questions.

Avoid speculative frameworks and large rewrites. Prefer the smallest coherent change that satisfies the requirement while preserving invariants. Resolve routine choices autonomously; ask only when missing information materially changes behavior or authorization.

## Implementation and checks

Keep code, schema, public contracts, UI labels, and documentation consistent. Use English for code/comments. Do not bypass tenant/security controls, manufacture consent, silently mark provider actions successful, or use production customer data in tests.

Run targeted meaningful tests for behavioral changes, then `npm test` and `npm run build` where applicable. Tests use isolated demo/memory accounts and must not contact real providers. Use mocks for failure paths. Database changes also need Prisma generation/schema validation and migration review; verify migrations on an intended disposable/development database before claiming persistence behavior.

Regression scenarios for order/integration work include cross-tenant access, duplicate imports, missed webhooks, recovery, duplicate initial sends, provider timeouts, delivery receipts, Confirm then Cancel, and paid/fulfilled cancellation guards. Choose scenarios relevant to the change; do not create tests that merely repeat implementation details.

Documentation-only changes need formatting and link/path validation, not unrelated live provider calls. Do not send messages, cancel orders, change provider settings, or create billable resources merely to verify documentation.

## Completion and handoff

Report the concrete behavior changed, checks run, and any unverified live setup or limitation. Never claim a browser, database, webhook, or delivery test was run when only mocks/builds ran. Update the relevant guide/spec when requirements change.

Keep instructions portable and free of secrets/live identifiers. When moving to another AI tool, provide the repository and ask it to read root `AGENTS.md` first. Tool-specific instruction discovery varies; do not promise automatic loading by every agent.
