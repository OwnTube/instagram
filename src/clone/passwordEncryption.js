'use strict';

/**
 * `enc_password` handling for the original login and signup forms.
 *
 * The original client never posts a bare password. It reads an encryption
 * config ({ key_id, public_key, version }) from the page's bootstrap data and
 * sends `#PWD_INSTAGRAM_BROWSER:<version>:<unix time>:<payload>`:
 *
 *   version 0   payload is the password itself (used when no key is configured)
 *   version 10  payload = base64( 0x01 | key_id | u16le(len) | sealed_key | tag | ciphertext )
 *               sealed_key = crypto_box_seal(aes_key, public_key)   (80 bytes)
 *               ciphertext/tag = AES-256-GCM(aes_key, iv = 12 zero bytes, aad = time)
 *
 * The newer CAA login and sign-up forms encrypt through FBBrowserPasswordEncryption,
 * which writes the SAME envelope under either Instagram's tag (with the page's
 * configured version) or Meta's default tag `#PWD_BROWSER`, with the page's
 * version (10) or the module default (5), depending on per-page hooks. The
 * genuine sign-up form was observed sending `#PWD_BROWSER:10:...`. These labels
 * are accepted for the envelope; nothing else is.
 *
 * The page we serve carries OUR public key in place of Instagram's (see
 * src/shell), so the unmodified client encrypts to us and only this server can
 * read the password. The keypair is generated on first start and stored with
 * mode 0600 under the data directory; it is never logged or sent to a client
 * except for the public half.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const nacl = require('tweetnacl');
const { blake2b } = require('blakejs');

const PREFIX = '#PWD_INSTAGRAM_BROWSER';
/** Tag -> versions whose payload is the envelope above (read from FBBrowserPasswordEncryption). */
const ENVELOPE_LABELS = { [PREFIX]: new Set(['10']), '#PWD_BROWSER': new Set(['5', '10']) };
const MAX_AGE_SECONDS = 24 * 60 * 60;

class PasswordFormatError extends Error {}

function sealNonce(ephemeralPublicKey, recipientPublicKey) {
  const input = new Uint8Array(64);
  input.set(ephemeralPublicKey, 0);
  input.set(recipientPublicKey, 32);
  return blake2b(input, undefined, 24);
}

function sealedBoxSeal(message, recipientPublicKey) {
  const eph = nacl.box.keyPair();
  const boxed = nacl.box(message, sealNonce(eph.publicKey, recipientPublicKey), recipientPublicKey, eph.secretKey);
  const out = new Uint8Array(32 + boxed.length);
  out.set(eph.publicKey, 0);
  out.set(boxed, 32);
  return out;
}

function sealedBoxOpen(sealed, recipientPublicKey, recipientSecretKey) {
  if (sealed.length < 48) return null;
  const epk = sealed.subarray(0, 32);
  return nacl.box.open(sealed.subarray(32), sealNonce(epk, recipientPublicKey), epk, recipientSecretKey);
}

/** Load or create the server's keypair. */
function loadKeyPair(file) {
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      keyId: stored.keyId,
      publicKey: Buffer.from(stored.publicKey, 'hex'),
      secretKey: Buffer.from(stored.secretKey, 'hex'),
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const pair = nacl.box.keyPair();
  const record = {
    keyId: crypto.randomInt(1, 256),
    publicKey: Buffer.from(pair.publicKey).toString('hex'),
    secretKey: Buffer.from(pair.secretKey).toString('hex'),
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
  return { keyId: record.keyId, publicKey: Buffer.from(pair.publicKey), secretKey: Buffer.from(pair.secretKey) };
}

function createPasswordCodec({ keyFile, allowPlaintext = true, now = () => Math.floor(Date.now() / 1000) }) {
  const keys = loadKeyPair(keyFile);

  /** The config object the original client reads, in Instagram's own shape. */
  function clientConfig() {
    return { key_id: String(keys.keyId), public_key: keys.publicKey.toString('hex'), version: '10' };
  }

  function decrypt(encPassword) {
    if (typeof encPassword !== 'string' || encPassword.length > 4096) throw new PasswordFormatError('missing enc_password');
    const parts = encPassword.split(':');
    if (parts.length < 4 || !ENVELOPE_LABELS[parts[0]]) throw new PasswordFormatError('unrecognised enc_password');
    const [tagName, version, time] = parts;
    const payload = parts.slice(3).join(':');
    if (!/^\d{1,12}$/.test(time)) throw new PasswordFormatError('bad timestamp');
    if (Math.abs(now() - Number(time)) > MAX_AGE_SECONDS) throw new PasswordFormatError('stale enc_password');

    if (version === '0' && tagName === PREFIX) {
      if (!allowPlaintext) throw new PasswordFormatError('plaintext passwords are disabled');
      return payload;
    }
    if (!ENVELOPE_LABELS[tagName].has(version)) throw new PasswordFormatError('unsupported enc_password version');

    const buf = Buffer.from(payload, 'base64');
    if (buf.length < 4 + 80 + 16 || buf[0] !== 1) throw new PasswordFormatError('malformed payload');
    if (buf[1] !== keys.keyId) throw new PasswordFormatError('unknown key id');
    const sealedLen = buf.readUInt16LE(2);
    if (sealedLen !== 80 || buf.length < 4 + sealedLen + 16) throw new PasswordFormatError('malformed payload');
    const sealed = buf.subarray(4, 4 + sealedLen);
    const tag = buf.subarray(4 + sealedLen, 4 + sealedLen + 16);
    const ciphertext = buf.subarray(4 + sealedLen + 16);

    const aesKey = sealedBoxOpen(new Uint8Array(sealed), new Uint8Array(keys.publicKey), new Uint8Array(keys.secretKey));
    if (!aesKey || aesKey.length !== 32) throw new PasswordFormatError('could not open sealed key');
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(aesKey), Buffer.alloc(12));
      decipher.setAAD(Buffer.from(time, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new PasswordFormatError('authentication failed');
    }
  }

  return { clientConfig, decrypt, keyId: keys.keyId };
}

/**
 * Reference encryptor in the client's format. Used by the tests to prove the
 * server decrypts what the client produces; never used by the server itself.
 */
function encryptLikeClient({ keyId, publicKeyHex, password, time, tag: label = PREFIX, version = '10' }) {
  const aesKey = crypto.randomBytes(32);
  const sealed = sealedBoxSeal(new Uint8Array(aesKey), new Uint8Array(Buffer.from(publicKeyHex, 'hex')));
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, Buffer.alloc(12));
  cipher.setAAD(Buffer.from(String(time), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header = Buffer.from([1, Number(keyId), sealed.length & 0xff, (sealed.length >> 8) & 0xff]);
  const payload = Buffer.concat([header, Buffer.from(sealed), tag, ciphertext]).toString('base64');
  return `${label}:${version}:${time}:${payload}`;
}

module.exports = { createPasswordCodec, encryptLikeClient, PasswordFormatError, PREFIX };
