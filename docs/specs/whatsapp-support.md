# Rule-based WhatsApp support

Handle rule-based read-only customer questions for order status, tracking, shipping/delivery policies, return/refund policies, and general store policy inquiries without paid AI:

- Order status, tracking, and clarifying replies apply to customers with a prior confirmed/reminded Relay order message (or reply quoting one) and an order-status/tracking question (`settings.tracking`). If multiple active orders could match, ask for the order number.
- Shipping/delivery timing or policy, return/refund policy (distinct from an active cancellation/return/refund action request), and general policy inquiries (`settings.faqs`) may reply even when no order is attached to the job (`AutomationJob.orderId` nullable), using the merchant's published Shopify `shopPolicies` (`SHIPPING_POLICY`, `REFUND_POLICY`, `PRIVACY_POLICY`, `TERMS_OF_SERVICE`) via `read_legal_policies` and/or saved store policy text (`settings.policy`). Never invent an arrival date.
- Active cancellation, return, refund action, address edit, wrong/damaged item, or explicit human-agent requests do not auto-reply; they escalate to human handling and remain in Inbox / Tasks for merchant review. Casual unmatched greetings in general Inbox threads do not lock `human = true` permanently.
- Human takeover (manual `Take over` or sending a manual live reply from Inbox) takes precedence and pauses automated replies across the customer's threads until `Resume assistant` is used.

Persist each recognized inbound reply and its `SUPPORT_REPLY` job together. Check the 24-hour inbound customer-service window and existing live outbound or owned-number test authorization both at intake and before sending. Track provider acceptance, delivery, and failures through `Messages` (`kind: 'SUPPORT_REPLY'`) and `Reliability`. Keep unknown send outcomes for review. Test with fixtures and mocked providers.
