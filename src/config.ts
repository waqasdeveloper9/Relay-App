import 'dotenv/config';
import { randomBytes } from 'node:crypto';

const demo = process.env.DEMO_MODE !== 'false';
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required outside demo mode`);
  return value;
}
export const config = {
  demo,
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? '127.0.0.1',
  trustProxy: process.env.TRUST_PROXY === '1' ? 1 : 'loopback',
  appUrl: process.env.APP_URL ?? 'http://127.0.0.1:5173',
  webhookUrl: process.env.WEBHOOK_BASE_URL ?? '',
  jwtSecret: demo ? randomBytes(32).toString('hex') : required('JWT_SECRET'),
  encryptionKey: demo ? randomBytes(32).toString('base64') : required('ENCRYPTION_KEY'),
  shopifyClientId: process.env.SHOPIFY_CLIENT_ID ?? '',
  shopifySecret: process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_APP_SECRET || '',
  shopifyScopes: ['write_orders'],
  serveWeb: process.env.SERVE_WEB === 'true' || process.env.NODE_ENV === 'production',
  metaSecret: '',
  metaVerifyToken: '',
  shopifyVersion: process.env.SHOPIFY_API_VERSION ?? '2026-10',
  metaVersion: process.env.META_API_VERSION ?? 'v24.0',
  outbound: !demo && process.env.OUTBOUND_ENABLED === 'true',
};
if (config.jwtSecret.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');
if (Buffer.from(config.encryptionKey, 'base64').length !== 32)
  throw new Error('ENCRYPTION_KEY must decode to 32 bytes');
