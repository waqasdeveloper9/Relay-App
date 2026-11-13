# Relay Database Schema Reference (PostgreSQL / Supabase)

**Schema Name:** `relay`  
**Host/Provider:** AWS eu-west-2 Supabase Pooler (`DATABASE_URL`)  
**ORM:** Prisma 6.19.0  

---

## Enums

* **`SubscriptionStatus`**: `TRIALING`, `ACTIVE`, `PAST_DUE`, `CANCELLED`
* **`OrderStatus`**: `PENDING`, `CONFIRMED`, `NEEDS_REVIEW`, `CANCELLED`
* **`RequestStatus`**: `OPEN`, `APPROVED`, `VERIFIED`
* **`JobState`**: `QUEUED`, `DONE`, `FAILED`, `UNKNOWN`

---

## Tables & Models (17 Tables)

### 1. `Merchant`
Core tenant record. Each merchant has an isolated workspace and credentials.
* `id` (UUID PK): Unique merchant identifier.
* `email` (String, Unique): Login email.
* `passwordHash` (String): Bcrypt password hash.
* `brandName` (String): Store/brand name shown to customers in messages.
* `subscriptionStatus` (SubscriptionStatus): Current subscription state.
* `trialStartsAt` (DateTime) & `trialEndsAt` (DateTime): 30-day trial lifecycle.
* `createdAt` / `updatedAt` (DateTime).

### 2. `Workspace`
Merchant configuration container.
* `merchantId` (UUID PK, FK -> Merchant.id, ON DELETE CASCADE).
* `revision` (Int, default 0): Optimistic concurrency control.
* `settings` (Json): JSON document containing workspace preferences (Shopify sync keywords/tags, dispatch notifications, quick replies, saved templates, FAQs, support menus).
* `updatedAt` (DateTime).

### 3. `ShopifyIntegration`
Encrypted Shopify OAuth and store credentials.
* `id` (UUID PK)
* `merchantId` (UUID Unique, FK -> Merchant.id)
* `shopDomain` (String Unique): e.g. `scentcode.myshopify.com`
* `accessToken` (String Encrypted): Encrypted offline access token.
* `refreshToken` (String Encrypted, Optional): Offline refresh token.
* `scopes` (String[]): Granted Shopify OAuth access scopes.
* `webhooksVerifiedAt` / `webhooksUrl`: Registered Shopify webhook state.
* `verifiedAt` (DateTime): When Shopify API connection was tested & verified.

### 4. `WhatsAppIntegration`
Encrypted Meta WhatsApp Cloud API credentials.
* `id` (UUID PK)
* `merchantId` (UUID Unique, FK -> Merchant.id)
* `phoneNumberId` (String Unique): Meta Phone Number ID.
* `wabaId` (String): WhatsApp Business Account ID.
* `systemAccessToken` (String Encrypted): Meta System User Access Token.
* `templateName` (String): Active confirmation template (e.g. `order_confirm_with_address` or `relay_order_confirmation_v1`).
* `languageCode` (String): Template language code (e.g. `en` or `en_US`).
* `metaAppSecret` (String Encrypted, Optional): App secret for HMAC payload verification.
* `verifyTokenHash` (String, Optional): SHA-256 hash of incoming webhook verify token.
* `webhookVerifiedAt` / `webhookUrl` / `webhookLastReceivedAt`: Webhook health tracking.

### 5. `OrderLog`
Shopify orders synced into Relay.
* `id` (UUID PK)
* `merchantId` (UUID, FK -> Merchant.id)
* `shopifyOrderId` (String): Shopify numeric Order GID string.
* `number` (String): Order display name (e.g. `#1025`).
* `name` (String): Customer full name.
* `phone` (String): Normalized E.164 customer phone number.
* `amount` (Decimal 18,4) & `currency` (VarChar 3): Total order price.
* `status` (OrderStatus): `PENDING`, `CONFIRMED`, `NEEDS_REVIEW`, `CANCELLED`.
* `isCod` (Boolean): Cash on Delivery eligibility flag.
* `financialStatus` & `fulfillmentStatus`: Shopify status mirror.
* `trackingUrl`, `trackingNumber`, `trackingCompany`: Fulfillment tracking details.
* `linkedPhones` (String[]): Cross-referenced numbers for Inbox lookup.
* `confirmationExpiresAt` (DateTime): Confirmation validity window (e.g. 24h).
* `archivedAt` (DateTime, Optional): Soft-deleted or cancelled orders.
* `tags` (String[]): Shopify order tags.
* *Constraints:* `UNIQUE(merchantId, shopifyOrderId)`, `INDEX(merchantId, status, createdAt)`.

### 6. `Conversation` & 7. `Message`
Customer messaging threads and WhatsApp transcript.
* **`Conversation`**:
  * `id` (UUID PK), `merchantId` (UUID, FK -> Merchant), `phone` (String, Optional), `orderId` (UUID, FK -> OrderLog).
  * `human` (Boolean): If `true`, automated bot replies are paused for human review.
  * `unread` (Boolean): Flag for merchant attention in Inbox.
* **`Message`**:
  * `id` (UUID PK), `merchantId` (UUID), `conversationId` (UUID, FK -> Conversation).
  * `direction` (String: `'in'` | `'out'` | `'note'`).
  * `text` (String): Message content or quick-reply title.
  * `createdAt` (DateTime).

### 8. `CustomerRequest` (Tasks)
Operational tasks requiring merchant intervention.
* `id` (UUID PK), `merchantId` (UUID), `orderId` (UUID, FK -> OrderLog).
* `kind` (String): e.g. `'Cancellation'`, `'Address change'`, `'Customer support'`.
* `detail` (String): Reason or customer request text.
* `status` (RequestStatus): `OPEN`, `APPROVED`, `VERIFIED`.

### 9. `AutomationJob`
Queued background worker jobs.
* `id` (UUID PK), `merchantId` (UUID), `orderId` (UUID, Optional).
* `kind` (String): `CONFIRMATION`, `REMINDER`, `TAG`, `REVIEW_TAG`, `CANCEL`, `FULFILLMENT_HOLD`, etc.
* `state` (JobState): `QUEUED`, `DONE`, `FAILED`, `UNKNOWN`.
* `attempts` (Int), `dueAt` (DateTime), `claimedAt` (DateTime, Optional).
* `messageId` (String, Optional): Meta message ID returned on send.
* `error` (String, Optional): Diagnostic failure message.
* `payload` (Json, Optional): Additional action arguments.

### 10. `OutboundMessage`
Durable delivery log of every WhatsApp message sent.
* `id` (UUID PK), `merchantId` (UUID), `orderId` (UUID), `jobId` (UUID).
* `recipient` (String), `templateName` (String), `languageCode` (String).
* `preview` (String): Full rendered text preview.
* `status` (String): `SENDING`, `ACCEPTED`, `SENT`, `DELIVERED`, `READ`, `FAILED`, `UNKNOWN`.
* `messageId` (String Unique): Meta WAMID for webhook delivery receipts.
* `statusTimestamp` (DateTime): Timestamp of latest Meta status event.

### 11. `MerchantNotification`
In-app bell notifications.
* `id` (UUID PK), `merchantId` (UUID), `key` (String Unique with merchantId).
* `severity` (`'warning'` | `'error'` | `'info'`).
* `title` & `detail` & `action` (String).
* `readAt` & `resolvedAt` (DateTime, Optional).

### 12. `InboxEvent`
Durable queue of incoming Meta & Shopify webhooks for atomic processing.
* `id` (UUID PK), `merchantId` (UUID), `provider` (`'meta'` | `'shopify'`), `eventId` (String).
* `topic` (String), `payload` (Json), `state` (`'QUEUED'` | `'DONE'` | `'FAILED'`).
* `leaseToken` & `leaseUntil`: Distributed concurrency leasing.

### 13. `ShopifySyncState`
Shopify incremental order polling state.
* `merchantId` (UUID PK), `checkpoint` (DateTime), `cursor` (String).
* `nextRunAt` (DateTime), `lastSuccessAt` (DateTime), `attempts` (Int).

### 14. `Activity`
Audit log of workspace events (e.g. settings saved, cancellations queued, tags synced).

### 15. `WebhookReceipt`
Deduplication ledger for raw incoming webhook events.

### 16. `ShopifyOAuthAttempt`
Temporary OAuth state nonce and PKCE tracking.

### 17. `_prisma_migrations`
Prisma migration tracking table.
