# Order confirmation and Shopify synchronization

## Meta template to create

Name: `relay_order_confirmation_v1`  
Language: use the exact Meta language code. The current approved pilot template uses English, `en` (not `en_US`).  
Suggested category: Utility (Meta determines final approval/category).

No header. Body:

```text
Hi {{1}}, thank you for ordering from {{2}}.
Order: {{3}}
Items: {{4}}
Total (Cash on Delivery): {{5}}
Delivery address: {{6}}
Please confirm your order or cancel it using the buttons below.
```

Sample variable values, in order: `Test Customer`, `Demo Store`, `#1001`, `Sample Product x1`, `PKR 6500.00`, `Test delivery address, Islamabad`.

Add exactly two Quick Reply buttons, in this order:

1. `Confirm order`
2. `Cancel order`

Fixed text can be customized in Meta, but this implementation requires six positional variables in the order above and the same two buttons. Text formatting inside variable values is normalized to one line and bounded. Up to 25 line items are summarized, with an additional-items marker for longer orders. Current totals and address are read from Shopify at send time, requiring appropriate access to protected customer data. The template is validated against the connected WABA before each send. Approval must be obtained in Meta; this repository does not submit the template automatically.

## Configure after code deployment

1. In Relay save the approved name and exact language code, then select **Validate saved order template**.
2. In Relay Integrations, save the App Secret from the current working Meta developer app. It is encrypted in that merchant's database record.
3. Generate a verification token in Relay. Configure the displayed merchant-specific HTTPS callback and token in Meta, verify/save, and subscribe to the messages field.
4. Click **Subscribe sender account to app** in Relay and test an incoming event. Relay verifies X-Hub-Signature-256 against the raw body. Template approval does not configure webhooks.
5. In Reliability, enable the 24-hour own-number order test for the selected approved template. No customer-specific environment values or restart are required. Keep production outbound disabled during sandbox testing. Existing hello-world jobs are not converted into confirmations.
6. Place a **new** dummy COD order with the verified recipient. Confirm and cancel should be tested on **separate** new orders. This performs real Shopify tagging/cancellation on the test orders.

## Result handling

- Signed button payloads are bound to an order. Sender phone, owning merchant, successfully sent job, and supplied message context must match. A duplicated Meta message ID is ignored. Conflicting/late decisions do not queue a second action.
- Confirm updates Relay to CONFIRMED and queues a `COD-CONFIRMED` Shopify tag. It does not mark payment received or fulfill an order. Shopify synchronization failures remain visible as failed/unknown jobs.
- Cancel moves Relay to NEEDS_REVIEW while cancellation is queued. The provider rechecks that Shopify reports pending payment, no received funds, COD gateway, and no fulfillment. It requests cancellation with restocking, without deleting the order or sending a Shopify email. Relay becomes CANCELLED only after Shopify exposes `cancelledAt`. Other cases remain for human review.
- Cancellation outcome that remains uncertain is UNKNOWN and must be reconciled in Shopify before retrying; it is not blindly retried. A crash after provider success is also uncertain. No final customer acknowledgment is fabricated: automatic reply acknowledgments remain separate work. Delivery receipts update the Messages tab once the signed Meta webhook is configured.
- This remains an expiring own-number test. General merchant consent collection and self-service production activation are not implemented by this test feature. Test authorization never sets customer consent on an order.

## Message history

The Messages tab stores new manual samples and order-message attempts in the tenant-scoped OutboundMessage table, including the actual order-template preview, recipient, provider message ID, request failures, and status. API acceptance is labeled Meta accepted, never delivered. Signed sent/delivered/read/failed receipts match the sender, merchant, recipient, and message ID and do not regress read/delivered status. Older manual samples were not recorded and cannot be reconstructed.
