'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createPasswordCodec, encryptLikeClient, PasswordFormatError } = require('../src/clone/passwordEncryption');

const DIR = path.join(__dirname, '..', '.scratch', 'test', `codec-${process.pid}`);

test('enc_password decryption', async (t) => {
  fs.rmSync(DIR, { recursive: true, force: true });
  const keyFile = path.join(DIR, 'key.json');
  const codec = createPasswordCodec({ keyFile });
  const cfg = codec.clientConfig();
  const now = Math.floor(Date.now() / 1000);
  t.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

  await t.test('decrypts what the client format produces', () => {
    const enc = encryptLikeClient({ keyId: cfg.key_id, publicKeyHex: cfg.public_key, password: 'pässwörd 123', time: now });
    assert.strictEqual(codec.decrypt(enc), 'pässwörd 123');
  });

  await t.test('the keypair persists across restarts with a private file mode', () => {
    const again = createPasswordCodec({ keyFile });
    assert.deepStrictEqual(again.clientConfig(), cfg);
    assert.strictEqual(fs.statSync(keyFile).mode & 0o077, 0, 'key file must not be group/world readable');
    assert.ok(!JSON.stringify(cfg).includes(JSON.parse(fs.readFileSync(keyFile, 'utf8')).secretKey));
  });

  await t.test('tampering, a foreign key id, a stale timestamp and a swapped AAD all fail', () => {
    const enc = encryptLikeClient({ keyId: cfg.key_id, publicKeyHex: cfg.public_key, password: 'secret 123', time: now });
    const [prefix, version, time, payload] = enc.split(':');
    const buf = Buffer.from(payload, 'base64');
    buf[buf.length - 1] ^= 1;
    assert.throws(() => codec.decrypt([prefix, version, time, buf.toString('base64')].join(':')), PasswordFormatError);
    assert.throws(() => codec.decrypt([prefix, version, String(now - 1), payload].join(':')), PasswordFormatError);
    const foreign = encryptLikeClient({ keyId: (Number(cfg.key_id) % 255) + 1, publicKeyHex: cfg.public_key, password: 'x', time: now });
    assert.throws(() => codec.decrypt(foreign), /unknown key id/);
    const stale = encryptLikeClient({ keyId: cfg.key_id, publicKeyHex: cfg.public_key, password: 'x', time: now - 3 * 86400 });
    assert.throws(() => codec.decrypt(stale), /stale/);
    assert.throws(() => codec.decrypt('plain password'), PasswordFormatError);
  });

  await t.test('version 0 is accepted only when plaintext is allowed', () => {
    assert.strictEqual(codec.decrypt(`#PWD_INSTAGRAM_BROWSER:0:${now}:hunter2 42`), 'hunter2 42');
    const strict = createPasswordCodec({ keyFile, allowPlaintext: false });
    assert.throws(() => strict.decrypt(`#PWD_INSTAGRAM_BROWSER:0:${now}:hunter2 42`), /disabled/);
  });

  await t.test("the CAA forms' envelope under Meta's default label is accepted; other labels are not", () => {
    const mk = (tag, version) => encryptLikeClient({ keyId: cfg.key_id, publicKeyHex: cfg.public_key, password: 'caa pass 42', time: now, tag, version });
    assert.strictEqual(codec.decrypt(mk('#PWD_BROWSER', '10')), 'caa pass 42', 'what the genuine sign-up form sends');
    assert.strictEqual(codec.decrypt(mk('#PWD_BROWSER', '5')), 'caa pass 42');
    assert.throws(() => codec.decrypt(mk('#PWD_BROWSER', '9')), /unsupported/);
    assert.throws(() => codec.decrypt(mk('#PWD_OTHER', '10')), /unrecognised/);
    assert.throws(() => codec.decrypt(`#PWD_BROWSER:0:${now}:plain 42`), PasswordFormatError, 'plaintext only under the Instagram tag');
  });
});
