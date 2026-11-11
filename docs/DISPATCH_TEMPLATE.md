# Dispatch, delivery, and order-stage WhatsApp templates (optional)

Relay supports tenant-configured Meta **Utility** templates for proactive shipping dispatch (`In transit` / `Partially fulfilled`), delivery confirmation (`Delivered`), payment confirmation (`Paid`), packing (`In progress`), and hold (`On hold`) alerts without hardcoding template names or variable layouts.

## Flexible variable mapping

1. Create and get a Meta **Utility** template approved in your Meta WhatsApp Manager using any copy in any language, using positional body placeholders `{{1}}`, `{{2}}`, … in order.
2. In Relay **Integrations** (under **Order stage WhatsApp templates**), enter the exact template name, language code, and select the ordered list of Relay data fields matching `{{1}}..{{N}}`:
   - `customer_name` — Customer name from the order
   - `brand_name` — Workspace brand name
   - `order_number` — Shopify order number (for example `#1016`)
   - `courier` — Courier / shipping company name (fallback `Courier` if unavailable)
   - `tracking_number` — Tracking number (fallback `Unavailable` if omitted)
   - `tracking_url` — Tracking URL (or fallback text if absent)
   - `total_amount` — Formatted order total (`PKR 6500`)
3. Optional dynamic URL button: if your Dispatch Meta template includes a Call-to-Action **URL** button whose suffix uses `{{1}}`, toggle **Template has dynamic tracking URL button** and Relay appends the tracking path suffix or tracking URL parameter when valid.
4. Click **Validate template** in Relay before enabling live stage alerts. Relay verifies via Meta Graph API (`message_templates`) that the template exists, is `APPROVED`, and its `BODY` positional placeholder count matches the length of your configured variable list.

## Suggested Utility copy examples

Dispatch example (`{{1}}` = customer name, `{{2}}` = order number, `{{3}}` = courier, `{{4}}` = tracking number, `{{5}}` = tracking URL):

```text
Hi {{1}}, good news — your order {{2}} has been dispatched via {{3}}.
Tracking number: {{4}}
Track here: {{5}}
```

Delivery example (`{{1}}` = customer name, `{{2}}` = order number, `{{3}}` = brand name):

```text
Hi {{1}}, your order {{2}} from {{3}} has been delivered. Thank you for shopping with us!
```

Paid example (`{{1}}` = customer name, `{{2}}` = order number, `{{3}}` = total amount, `{{4}}` = brand name):

```text
Hi {{1}}, we have recorded your payment of {{3}} for order {{2}} at {{4}}. Thank you!
```

In-progress / On-hold example (`{{1}}` = customer name, `{{2}}` = order number, `{{3}}` = brand name):

```text
Hi {{1}}, your order {{2}} at {{3}} is now being packed and prepared for dispatch.
```

## Safeguards

- **Freshness window**: Historical backfills older than `Reliability → maxMessageAgeHours` never send surprise alerts.
- **Permission & opt-out checks**: Respects customer consent (or an active own-number test window) and blocks sends if the recipient texted an opt-out keyword (`STOP` / `UNSUBSCRIBE`).
- **Deduplication**: At most one `DISPATCH_NOTICE`, `DELIVERY_NOTICE`, `PAYMENT_NOTICE`, `IN_PROGRESS_NOTICE`, and `ON_HOLD_NOTICE` job is queued per order. Ambiguous send outcomes move to `UNKNOWN` and never blindly resend.
