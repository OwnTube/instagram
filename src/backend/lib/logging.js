'use strict';

/**
 * Request logging and the request id.
 *
 * The rule this module exists to enforce: nothing secret is ever logged. Cookies,
 * Authorization headers, CSRF tokens, session ids and passwords are never
 * written, and the body is never logged at all (it may contain a password on
 * the login route).
 */

const { newId } = require('./ids');

// Query/body keys whose values must never appear in a log line.
const SECRET_KEYS = new Set([
  'password',
  'new_password',
  'current_password',
  'token',
  'csrf',
  'csrf_token',
  'authorization',
  'cookie',
  'set-cookie',
  'session',
  'sessionid',
]);

function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  // Only accept a sane client-supplied id; otherwise mint one.
  const id = incoming && /^[A-Za-z0-9._-]{1,64}$/.test(incoming) ? incoming : newId('req');
  req.id = id;
  res.setHeader('x-request-id', id);
  next();
}

function redact(value, depth = 0) {
  if (depth > 3) return '[deep]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SECRET_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(val, depth + 1);
  }
  return out;
}

function requestLogger(logger = console) {
  return function log(req, res, next) {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      logger.log(
        `[backend] ${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(1)}ms rid=${req.id}` +
          (req.user ? ` user=${req.user.id}` : '')
      );
    });
    next();
  };
}

module.exports = { requestId, requestLogger, redact, SECRET_KEYS };
