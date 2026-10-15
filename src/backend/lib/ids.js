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

module.exports = { newId, randomToken, timingSafeEqual, hashToken, nowIso, addMs };
