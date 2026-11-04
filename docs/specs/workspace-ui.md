# Workspace UI refinement

Keep the existing theme while making operational records visible sooner.

- Orders: compact heading and sync toolbar, period/restore controls and last sync; retain errors, move remove-all to footer, preserve bulk behavior.
- Messages: concise delivery explanation, normalized recipient search that accepts punctuation and local leading-zero searches, retain status accuracy and retry rules.
- Order dialog: grouped details and clearly separated, wrapping action buttons.
- Integrations: one top action checks both saved connections and reports each outcome; Save all plus scoped provider saves that do not persist the other provider's unsaved edits. Existing backend authorization and secret-preservation rules remain enforced.
- Move setup guidance into expandable sections; keep essential callback/subscription status visible. No automatic external sends or subscription changes from connection checks.

Verify TypeScript/build and existing regressions. No schema migration or new provider protocol is needed. Browser review should cover desktop/narrow layouts when available.

Authentication must compare parsed URL origins, not full URL strings. A configured trailing slash, path, default HTTPS port, or hostname casing must not disable sign-in on the same origin. A different configured HTTPS origin still directs users to the canonical workspace; explicitly permitted local login remains supported. Server origin validation is unchanged.
