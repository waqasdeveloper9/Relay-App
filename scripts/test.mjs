import { spawnSync } from 'node:child_process';

// Never allow a developer's connected .env file to redirect tests to live data.
const result = spawnSync(
  process.execPath,
  [
    '--import',
    'tsx',
    '--test',
    'src/tests/reliability.test.ts',
    'src/tests/security.test.ts',
    'src/tests/workflow.test.ts',
    'src/tests/api.test.ts',
    'src/tests/shopify-oauth.test.ts',
    'src/tests/order-confirmation.test.ts',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DEMO_MODE: 'true',
      OUTBOUND_ENABLED: 'false',
      WEBHOOK_BASE_URL: '',
    },
  },
);

if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
