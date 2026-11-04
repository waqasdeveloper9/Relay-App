# Controlled Shopify order test

Configure the test in **Reliability**. The saved merchant settings authorize a 24-hour test for one owned, Meta-verified recipient and the selected template. They live in the merchant database record; no customer-specific environment settings are used. Saving a test requires explicit ownership confirmation. General production outbound remains independently disabled during sandbox testing.

A new signed COD order matching the authorized number can queue a test job. Selecting `hello_world` / `en_US` sends Meta's sample without order details. An approved six-variable confirmation template sends the current order details with signed Confirm order and Cancel order buttons. Confirmation tests require completed incoming webhook setup, including the merchant App Secret, verified callback, sender-account subscription and Meta messages field.

The worker rechecks recipient, expiry, verified sender, order eligibility, age and human takeover. Test authorization never implies customer consent or changes subscription eligibility. It does not schedule reminders. Nonmatching recipients do not receive test messages. Each attempt is visible in Messages; Meta acceptance does not prove delivery.

A failed definitive request can be retried after correction and eligibility checks. Ambiguous send outcomes are held for reconciliation. Signed delivery callbacks can recover a lost response using the attempt correlation ID. Recovered historical orders default to review before messaging; Reliability exposes explicit recheck controls.

Shopify and Meta require reachable HTTPS callbacks. A temporary tunnel changing or stopping requires updating and reverifying callback configuration. The local server and workers must remain running for real-time testing; after restart, durable queue and catch-up processing resume.

See [confirmation template](CONFIRMATION_TEMPLATE.md) and [reliability setup](RELIABILITY.md).
