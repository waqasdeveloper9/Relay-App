# Shopify OAuth development setup

Relay is one standalone Shopify app owned by the platform developer. Each merchant authorizes their own store through Relay; store domains, access tokens, refresh tokens, scopes, and expiry metadata are stored per merchant in PostgreSQL. Never place a merchant's domain or token in the shared server environment.

## Current temporary HTTPS workspace

Use your configured HTTPS hostname (placeholder below):

```text
App URL:
https://YOUR-RELAY-HOST.example

Allowed redirection URL:
https://YOUR-RELAY-HOST.example/api/integrations/shopify/callback
```

The local machine and tunnel must remain running. A newly started quick tunnel can have a different hostname. The authenticated Integrations page displays the current configured URLs; use those if this document's temporary URL is no longer active.

In the Relay app's Shopify Dev Dashboard version:

- Set App URL and Allowed redirection URL to the exact values above.
- Disable embedding in the Shopify admin; Relay is a standalone dashboard.
- Keep `write_orders` as the required scope and webhook API version `2026-10`.
- Keep legacy installation disabled and release the updated configuration.
- Ensure the app's distribution permits the intended store to install it. A custom-distributed single-client pilot and a public multi-merchant app have different distribution/review requirements; do not choose a distribution method casually because it cannot simply be switched later.

Then:

1. Open the HTTPS workspace, register/sign in, and navigate to Integrations.
2. Enter the **merchant's** actual `store.myshopify.com` domain.
3. Click **Connect Shopify** and approve permissions in Shopify.
4. After returning, confirm the Shopify card shows Verified.
5. Click **Register webhooks** to subscribe to `orders/create` and `app/uninstalled`. This is a separate explicit action; receiving a token alone does not mean webhooks are registered.
6. Place a COD test order with a test customer and check Relay's Orders page.

If Shopify blocks installation, inspect the app distribution and store eligibility. A client-credentials grant is not a substitute for merchant OAuth when the app and store belong to different organizations.

## Server configuration

The ignored `.env` contains the Relay app's shared `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`. The client secret also verifies app-owned Shopify webhooks. `SHOPIFY_APP_SECRET` is a compatibility fallback only; when a client secret is present it takes precedence.

`APP_URL` must be the public HTTPS origin for browser OAuth. `SERVE_WEB=true` serves the production-built frontend from the API, avoiding exposure of the Vite development server through the tunnel. WhatsApp outbound messaging remains independently disabled.

After restarting a tunnel, configure its new origin, rebuild if code changed, restart the API, update Shopify URLs/release, and verify webhooks again:

```sh
node scripts/configure-public-url.mjs https://your-new-tunnel-host
npm run build
npm start
```

The verified Cloudflare executable is local to `.tools` and is not committed:

```powershell
.\.tools\cloudflared.exe tunnel --url http://127.0.0.1:3001 --no-autoupdate --protocol http2 --metrics 127.0.0.1:20241
```

OAuth state expires after ten minutes, is consumed once, and is tied to the initiating browser and merchant. Callback HMAC, timestamp, shop domain, requested scopes, and token response are validated before a connection is marked verified. Expiring offline tokens are refreshed with encrypted refresh credentials and a database refresh lease.

OAuth tests mock Shopify. The real token exchange, store installation, webhook delivery, and protected customer data access can only be verified after the merchant completes Shopify authorization. Connecting Shopify does not enable WhatsApp sending or automatically modify customer orders.
