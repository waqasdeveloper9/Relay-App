import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { config } from '../config.js';

export function encrypt(value: string): string {
  if (!value) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(config.encryptionKey, 'base64'), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((v) => v.toString('base64')).join('.');
}
export function decrypt(value: string): string {
  if (!value) return '';
  const [iv, tag, data] = value.split('.').map((v) => Buffer.from(v, 'base64'));
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(config.encryptionKey, 'base64'), iv!);
  cipher.setAuthTag(tag!);
  return Buffer.concat([cipher.update(data!), cipher.final()]).toString('utf8');
}
export function verifyHmac(
  raw: Buffer,
  secret: string,
  signature: string,
  encoding: 'base64' | 'hex',
): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  const actual = Buffer.from(signature, encoding);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function phone(value: string, country?: CountryCode): string {
  const normalized = value.startsWith('+')
    ? value
    : /^\d{10,15}$/.test(value) && !country
      ? `+${value}`
      : value;
  const parsed = parsePhoneNumberFromString(normalized, country);
  if (!parsed?.isValid()) throw new Error('A valid customer phone number and country are required');
  return parsed.number.slice(1);
}
