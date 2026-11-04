# Render deployment

Deploy a Node Web Service from the repository root. Use Free for development testing; sleeping instances do not run background timers. Choose an always-running service before production automation.

Build: `npm ci --include=dev && npm run db:generate && npm run build`

Start: `npm run db:deploy && npm start`

Health check: `/api/health`. Use Node 24. Render supplies PORT; do not copy the local PORT override.

Set these Render environment variables:

```env
NODE_ENV=production
NODE_VERSION=24
HOST=0.0.0.0
TRUST_PROXY=1
DEMO_MODE=false
SERVE_WEB=true
OUTBOUND_ENABLED=false
APP_URL=https://YOUR-SERVICE.onrender.com
WEBHOOK_BASE_URL=https://YOUR-SERVICE.onrender.com
ALLOWED_ORIGINS=
```

TRUST_PROXY=1 assumes exactly one trusted ingress proxy and no direct public path to the Node process. Reassess the proxy trust configuration if the hosting topology changes.

Copy DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_API_VERSION, and META_API_VERSION privately from the existing configuration into Render's environment settings. Keep the existing ENCRYPTION_KEY exactly: changing it makes saved provider credentials unreadable. Use the intended Supabase database/schema and TLS-capable connection. Never commit the actual values. GitHub Actions secrets do not automatically become Render environment variables.

Merchant Shopify/Meta tokens, Meta App Secrets, template choices and test settings remain in the tenant database. Sandbox authorization does not enable production sends; OUTBOUND_ENABLED remains false until the live workflow is explicitly ready.

After deployment, set the actual assigned hostname in APP_URL and WEBHOOK_BASE_URL. Update Shopify app/redirect URLs, re-register Shopify webhooks, and verify the tenant callback in Meta with the generated verification token and messages subscription. Inspect incoming-event and message history before claiming end-to-end success.

Stop the local connected Relay worker before hosted testing against the same database. Durable leases reduce duplicate execution, but two environments should not independently operate the same live workspace with different callback configuration.
