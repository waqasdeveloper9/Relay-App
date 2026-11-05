# Rule-based WhatsApp support

Handle order status, tracking, and delivery questions for customers with a recent Relay order message or a reply quoting one. Match orders within the merchant and customer, ask for the order number when ambiguous, and leave unrelated messages in Inbox. Human takeover takes precedence. Read current Shopify order data and link the merchant's published shipping policy when available. Never invent an arrival date.

Persist each recognized inbound reply and its send job together. Check the 24-hour window again before sending and apply the existing live outbound or owned-number test authorization. Track provider acceptance, delivery, and failures through Messages and Reliability. Keep unknown send outcomes for review. Test with fixtures and mocked providers.

Shopify shipping-policy lookup requires the read_legal_policies scope and a published shipping policy. Relay requests write_orders and read_legal_policies during connect. Existing order-only installations need a fresh approval before delivery-policy replies can succeed.
