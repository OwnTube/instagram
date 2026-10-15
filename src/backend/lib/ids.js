'use strict';

const crypto = require('node:crypto');

/** Random opaque identifier, URL-safe. */
function newId(prefix) {
  const raw = crypto.randomBytes(16).toString('base64url');
  return prefix ? `${prefix}_${raw}` : raw;
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Constant-time comparison that does not throw on length mismatch. */
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still perform a comparison so the failure is not obviously length-based.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Hash a bearer token before it is stored, so a database read cannot mint one. */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function addMs(ms) {
  return new Date(Date.now() + ms).toISOString();
}

/*
 * Numeric primary keys in the shape the original client expects.
 *
 * Instagram's client treats ids as decimal strings ("pk") and derives post URLs
 * from a base64 "shortcode" of the media pk. Ours are generated locally: 41 bits
 * of milliseconds since PK_EPOCH, then 22 random bits. They are strings in every
 * response, so their size never touches JavaScript number precision.
 */
const PK_EPOCH = 1700000000000n;
const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function newPk(now = Date.now()) {
  const ms = BigInt(now) - PK_EPOCH;
  const rand = BigInt(crypto.randomInt(0, 2 ** 22));
  return ((ms << 22n) | rand).toString();
}

function shortcodeFromPk(pk) {
  let n = BigInt(pk);
  if (n === 0n) return 'A';
  let out = '';
  while (n > 0n) {
    out = SHORTCODE_ALPHABET[Number(n % 64n)] + out;
    n /= 64n;
  }
  return out;
}

function pkFromShortcode(code) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,20}$/.test(code)) return null;
  let n = 0n;
  for (const ch of code) n = n * 64n + BigInt(SHORTCODE_ALPHABET.indexOf(ch));
  return n.toString();
}

function isPk(value) {
  return typeof value === 'string' && /^[0-9]{1,25}$/.test(value);
}

/** Seconds since the epoch for an ISO timestamp (Instagram's `taken_at`). */
function epochSeconds(iso) {
  return Math.floor(Date.parse(iso) / 1000);
}

module.exports = {
  newId,
  randomToken,
  timingSafeEqual,
  hashToken,
  nowIso,
  addMs,
  newPk,
  shortcodeFromPk,
  pkFromShortcode,
  isPk,
  epochSeconds,
};
