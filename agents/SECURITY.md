# Security and tenancy rules

## Identity and authorization

Derive merchant identity from the verified session. For callbacks, resolve the integration and verify the correct signature; a route merchant ID is only a lookup hint. Every object lookup and mutation must enforce tenant ownership, including bulk actions, retries, exports, notifications, and job claims. Reject mixed-tenant bulk requests atomically.

Keep HTTP-only session cookies, appropriate Secure/SameSite settings, expiry, password hashing, origin checks, and rate limits. Local HTTP exceptions must remain explicit and restricted to configured loopback origins. Do not broadly trust forwarded headers, arbitrary Origins, or disable origin validation for tunnels.

Validate untrusted data with runtime schemas. Bound body sizes, batch sizes, pagination, and string lengths. Restrict Shopify destinations to valid store domains and provider endpoints to approved origins; do not accept arbitrary outbound URLs that enable SSRF.

## Secret ownership

- Tenant database: merchant Shopify tokens, Meta access token/App Secret, sender identifiers, template choices, webhook verification state, and operational preferences.
- Server secret configuration: database credentials, encryption keys, JWT signing key, shared Relay Shopify OAuth app credentials, and infrastructure configuration.

Do not move tenant credentials into global environment variables. Do not move infrastructure root keys into tenant records. An eventual shared Meta onboarding app also needs platform-level credential management rather than duplicating its secret across tenants.

Encrypt recoverable provider secrets with authenticated encryption. Hash verification tokens where only comparison is needed. Never return saved secret values to the browser: use saved-state flags and blank replacement fields. Blank means preserve, not erase. Scope secret rotations and invalidate dependent verification deliberately.

Never log tokens, cookies, authorization headers, connection strings, raw credential payloads, or unnecessary customer data. Redact provider errors before surfacing them; retain safe diagnostic codes and correlation IDs. Do not paste secrets into documentation, fixtures, screenshots, or chat.

## Webhook and data protection

Verify raw bytes using provider HMAC and constant-time comparison before accepting events. Do not replace signature validation with checking that a header exists. Store accepted events durably before acknowledging; use provider event identity and tenant scope for replay deduplication.

Backend authentication and database tenant constraints are both required. Browser clients must not receive a privileged PostgreSQL connection or direct access to internal tables. Supabase RLS/grants must remain restrictive; custom Relay sessions do not automatically create Supabase Auth authorization policies.

Use least-privilege provider scopes and database roles. Preserve audit history while respecting future retention/deletion requirements. Customer-facing errors should explain the action required without leaking secrets, stack traces, or another tenant's existence.
