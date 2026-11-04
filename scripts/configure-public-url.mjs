import fs from 'node:fs';

const input = process.argv[2];
if (!input)
  throw new Error('Usage: node scripts/configure-public-url.mjs https://your-testing-host');
const url = new URL(input);
if (
  url.protocol !== 'https:' ||
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  url.pathname !== '/'
)
  throw new Error(
    'Provide a public HTTPS origin without a path, credentials, or query parameters.',
  );
let text = fs.readFileSync('.env', 'utf8');
for (const [name, value] of Object.entries({ APP_URL: url.origin, SERVE_WEB: 'true' })) {
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  text = pattern.test(text)
    ? text.replace(pattern, () => `${name}=${value}`)
    : `${text}\n${name}=${value}\n`;
}
fs.writeFileSync('.env', text);
console.log(
  JSON.stringify({
    appUrl: url.origin,
    callbackUrl: `${url.origin}/api/integrations/shopify/callback`,
    restartRequired: true,
  }),
);
