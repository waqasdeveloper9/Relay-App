# UI verification — October 20, 2026

Verified in the browser using an isolated demo workspace and a disposable Supabase merchant account.

- Order search, review filtering, pagination, order details, and cancelled-order action guards.
- Conversation-specific drafts, unread-count updates, settings validation, and automation toggles.
- Report rendering and CSV download.
- Registration password generation, masking, visibility, and clipboard feedback.
- Desktop layouts and mobile registration/navigation, including Escape dismissal and background interaction blocking.
- Shopify integration configuration and HTTPS sign-in with database persistence.

Fixed cross-conversation draft leakage, unread conversations remaining unread after opening, invalid reminder intervals, cancelled-order review actions, mobile navigation focus/background handling, sidebar/table overflow, weak text contrast, and misleading integration help text.

Validation: 34 automated tests, TypeScript checks, production build, and Prettier checks passed. Provider calls in automated tests are mocked. Real Shopify installation and live WhatsApp sends remain unverified; they require the merchant's provider setup and authorization. This is a focused regression pass, not a guarantee that every possible browser or device is defect-free.
