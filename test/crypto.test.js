'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { hashPassword, verifyPassword } = require('../src/backend/lib/passwords');
const { timingSafeEqual, hashToken } = require('../src/backend/lib/ids');
const { parseCookies, serializeCookie } = require('../src/backend/lib/cookies');
const { redact } = require('../src/backend/lib/logging');

test('password hashing', async (t) => {
  await t.test('a correct password verifies and a wrong one does not', async () => {
    const record = await hashPassword('correct horse 1');
    assert.strictEqual(await verifyPassword('correct horse 1', record), true);
    assert.strictEqual(await verifyPassword('correct horse 2', record), false);
  });

  await t.test('the same password produces different hashes (salted)', async () => {
    const a = await hashPassword('samepassword1');
    const b = await hashPassword('samepassword1');
    assert.notStrictEqual(a.hash, b.hash);
    assert.notStrictEqual(a.salt, b.salt);
  });

  await t.test('a malformed record never verifies', async () => {
    assert.strictEqual(await verifyPassword('x', null), false);
    assert.strictEqual(await verifyPassword('x', { hash: 'a', salt: 'b' }), false);
    assert.strictEqual(await verifyPassword('x', { hash: 'a', salt: 'b', params: 'bad' }), false);
  });
});

test('token helpers', async (t) => {
  await t.test('timingSafeEqual compares correctly across lengths', () => {
    assert.strictEqual(timingSafeEqual('abc', 'abc'), true);
    assert.strictEqual(timingSafeEqual('abc', 'abd'), false);
    assert.strictEqual(timingSafeEqual('abc', 'abcd'), false);
  });

  await t.test('hashToken is deterministic and not the input', () => {
    const token = 'some-token-value';
    assert.strictEqual(hashToken(token), hashToken(token));
    assert.notStrictEqual(hashToken(token), token);
  });
});

test('cookie helpers', async (t) => {
  await t.test('parseCookies handles multiple pairs', () => {
    const parsed = parseCookies('a=1; b=2; c=hello%20world');
    assert.deepStrictEqual(parsed, { a: '1', b: '2', c: 'hello world' });
  });

  await t.test('serializeCookie sets HttpOnly and SameSite', () => {
    const cookie = serializeCookie('s', 'v', { httpOnly: true, path: '/__backend' });
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\/__backend/);
  });

  await t.test('the CSRF cookie is readable by script', () => {
    const cookie = serializeCookie('c', 'v', { httpOnly: false });
    assert.ok(!/HttpOnly/.test(cookie));
  });
});

test('log redaction never emits secrets', async (t) => {
  await t.test('secret keys are replaced', () => {
    const out = redact({ password: 'p', csrf_token: 'c', nested: { authorization: 'Bearer x' } });
    assert.strictEqual(out.password, '[redacted]');
    assert.strictEqual(out.csrf_token, '[redacted]');
    assert.strictEqual(out.nested.authorization, '[redacted]');
  });

  await t.test('ordinary values pass through', () => {
    const out = redact({ username: 'alice', count: 3 });
    assert.deepStrictEqual(out, { username: 'alice', count: 3 });
  });
});
