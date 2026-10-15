'use strict';

/**
 * Configuration for the application backend.
 *
 * The backend is a separate concern from the runtime loader: the loader serves
 * Instagram's own frontend, this serves *our* application data. Keeping the two
 * configuration namespaces apart makes it explicit which side a setting belongs
 * to and prevents one from silently changing the other's behaviour.
 */

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const backend = {
  // Mounted under a dedicated namespace. This is deliberate: Instagram's own
  // frontend calls /api/v1/... and /graphql/query on its own origin, and those
  // requests must keep flowing to the loader's upstream handler. Mounting our
  // API at the root would intercept and break them.
  prefix: process.env.BACKEND_PREFIX || '/__backend',

  databaseFile: process.env.BACKEND_DB || '.data/backend.db',

  // Clone session cookies, issued on OUR origin with the names the original
  // client already understands: it echoes `csrftoken` as X-CSRFToken and reads
  // `ds_user_id` for the viewer id. The values are ours; no Instagram credential
  // exists anywhere in this system, and the loader never forwards browser
  // cookies upstream (src/upstream.js strips them unconditionally).
  cookieName: process.env.BACKEND_COOKIE || 'sessionid',
  csrfCookieName: process.env.BACKEND_CSRF_COOKIE || 'csrftoken',
  viewerCookieName: process.env.BACKEND_VIEWER_COOKIE || 'ds_user_id',
  cookiePath: '/',
  sessionTtlMs: int(process.env.SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000),
  sessionRotateMs: int(process.env.SESSION_ROTATE_MS, 60 * 60 * 1000),

  // scrypt parameters. N=2^15 keeps a login in the tens of milliseconds while
  // staying comfortably inside the default 32 MB scrypt memory limit.
  scryptCost: int(process.env.SCRYPT_COST, 2 ** 15),
  scryptBlockSize: int(process.env.SCRYPT_BLOCK_SIZE, 8),
  scryptParallelism: int(process.env.SCRYPT_PARALLELISM, 1),
  scryptKeyLen: int(process.env.SCRYPT_KEYLEN, 32),

  // Abuse protection: a fixed-window limiter per client, with a stricter window
  // for credential endpoints.
  rateLimitWindowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 60 * 1000),
  rateLimitMax: int(process.env.RATE_LIMIT_MAX, 300),
  authRateLimitMax: int(process.env.AUTH_RATE_LIMIT_MAX, 20),

  maxPageSize: int(process.env.MAX_PAGE_SIZE, 100),
  defaultPageSize: int(process.env.DEFAULT_PAGE_SIZE, 20),

  // Requests are only trusted as same-site when the browser says so. Without a
  // cookie-based session there is nothing to forge, so CSRF is only enforced
  // for cookie-authenticated state changes.
  trustProxy: bool(process.env.TRUST_PROXY, false),

  verbose: bool(process.env.BACKEND_VERBOSE, true),
};

backend.secureCookies = bool(process.env.BACKEND_SECURE_COOKIES, false);

module.exports = backend;
