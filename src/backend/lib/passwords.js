'use strict';

/**
 * Password hashing for THIS application's accounts.
 *
 * This handles passwords a user chooses for the loader's own backend. It never
 * receives, derives, or stores an Instagram password: there is no code path
 * here that accepts one, and the login endpoint has no field for one.
 *
 * scrypt is used because it is memory-hard and available in Node's standard
 * library, so the backend needs no third-party crypto dependency.
 */

const crypto = require('node:crypto');
const backend = require('../config');
const { timingSafeEqual } = require('./ids');

const PARAMS = {
  N: backend.scryptCost,
  r: backend.scryptBlockSize,
  p: backend.scryptParallelism,
  keylen: backend.scryptKeyLen,
};

function derive(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.from(String(password), 'utf8'),
      Buffer.from(salt, 'utf8'),
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key))
    );
  });
}

/** Returns { hash, salt, params } ready to store. */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const key = await derive(password, salt, PARAMS);
  return {
    hash: key.toString('base64url'),
    salt,
    params: `${PARAMS.N}:${PARAMS.r}:${PARAMS.p}:${PARAMS.keylen}`,
  };
}

/** Verify a candidate password against a stored record. */
async function verifyPassword(password, record) {
  if (!record || !record.hash || !record.salt || !record.params) return false;
  const [N, r, p, keylen] = String(record.params).split(':').map(Number);
  if (![N, r, p, keylen].every(Number.isFinite)) return false;
  const key = await derive(password, record.salt, { N, r, p, keylen });
  return timingSafeEqual(key.toString('base64url'), record.hash);
}

module.exports = { hashPassword, verifyPassword };
