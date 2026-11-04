import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { decrypt, encrypt, phone, verifyHmac } from '../utils/security.js';
import { generateStrongPassword } from '../../web/lib/password.js';
import { sendHelloWorldTest } from '../services/providers.js';
import { demoWorkspace } from '../services/seed.js';

test('manual hello_world test uses saved tenant credentials and no unsupported components', async () => {
  const integration = {
    ...demoWorkspace().integration,
    phoneNumberId: '123456',
    whatsappToken: encrypt('test-token'),
    whatsappVerifiedAt: new Date().toISOString(),
    templateName: 'hello_world',
    languageCode: 'en_US',
  };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.ok(String(url).endsWith('/123456/messages'));
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(String(options?.body)), {
      messaging_product: 'whatsapp',
      to: '923001234567',
      type: 'template',
      template: { name: 'hello_world', language: { code: 'en_US' } },
    });
    return new Response(JSON.stringify({ messages: [{ id: 'test-message-id' }] }), { status: 200 });
  };
  try {
    assert.equal(await sendHelloWorldTest(integration, '923001234567'), 'test-message-id');
    assert.equal(
      await sendHelloWorldTest(
        { ...integration, templateName: 'different_template', languageCode: 'en' },
        '923001234567',
      ),
      'test-message-id',
    );
    await assert.rejects(
      sendHelloWorldTest({ ...integration, whatsappVerifiedAt: undefined }, '923001234567'),
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Shopify HMAC binds the original raw bytes', () => {
  const raw = Buffer.from('{"id":42}');
  const secret = 'test-secret';
  const signature = createHmac('sha256', secret).update(raw).digest('base64');
  assert.equal(verifyHmac(raw, secret, signature, 'base64'), true);
  assert.equal(verifyHmac(Buffer.from('{ "id":42}'), secret, signature, 'base64'), false);
  assert.equal(verifyHmac(raw, secret, 'short', 'base64'), false);
  assert.equal(verifyHmac(raw, '', signature, 'base64'), false);
});
test('Meta HMAC rejects a forged signature', () => {
  const raw = Buffer.from('{"entry":[]}');
  const signature = createHmac('sha256', 'secret').update(raw).digest('hex');
  assert.equal(verifyHmac(raw, 'secret', signature, 'hex'), true);
  assert.equal(verifyHmac(raw, 'different', signature, 'hex'), false);
});
test('AES-GCM encrypts credentials with a fresh IV and detects tampering', () => {
  const token = 'private-system-token';
  const first = encrypt(token);
  const second = encrypt(token);
  assert.notEqual(first, second);
  assert.equal(decrypt(first), token);
  assert.ok(!first.includes(token));
  const parts = first.split('.');
  parts[1] = Buffer.alloc(16).toString('base64');
  assert.throws(() => decrypt(parts.join('.')));
});
test('phone normalization uses explicit country context', () => {
  assert.equal(phone('03001234567', 'PK'), '923001234567');
  assert.equal(phone('+923001234567'), '923001234567');
  assert.throws(() => phone('garbage', 'PK'));
});

test('generated passwords meet policy and use fresh randomness', () => {
  const passwords = new Set(Array.from({ length: 50 }, () => generateStrongPassword()));
  assert.equal(passwords.size, 50);
  for (const password of passwords) {
    assert.equal(password.length, 24);
    assert.match(password, /[A-Z]/);
    assert.match(password, /[a-z]/);
    assert.match(password, /\d/);
    assert.match(password, /[!@#$%*\-_+]/);
    assert.ok(Buffer.byteLength(password, 'utf8') <= 72);
  }
});
