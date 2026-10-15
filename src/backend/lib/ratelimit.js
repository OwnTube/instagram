'use strict';

/**
 * Fixed-window rate limiting, in process.
 *
 * A single-process deployment is what this backend targets, so an in-memory
 * window is sufficient and needs no external store. The window is keyed by
 * client identity and route class so that credential endpoints can be limited
 * far more tightly than ordinary reads.
 */

const backend = require('../config');
const { tooMany } = require('./errors');

function createLimiter({ windowMs, max, name }) {
  const buckets = new Map();

  function take(key, now = Date.now()) {
    const bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      const fresh = { count: 1, resetAt: now + windowMs };
      buckets.set(key, fresh);
      return { allowed: true, remaining: max - 1, resetAt: fresh.resetAt };
    }
    bucket.count += 1;
    if (bucket.count > max) {
      return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
    }
    return { allowed: true, remaining: max - bucket.count, resetAt: bucket.resetAt };
  }

  function sweep(now = Date.now()) {
    for (const [key, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(key);
    }
  }

  return { name, windowMs, max, take, sweep, size: () => buckets.size, _buckets: buckets };
}

function clientKey(req) {
  // req.ip honours the trust-proxy setting configured on the app.
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function middleware(limiter) {
  return function limit(req, res, next) {
    const result = limiter.take(`${limiter.name}:${clientKey(req)}`);
    res.setHeader('x-ratelimit-limit', String(limiter.max));
    res.setHeader('x-ratelimit-remaining', String(Math.max(0, result.remaining)));
    res.setHeader('x-ratelimit-reset', String(Math.ceil(result.resetAt / 1000)));
    if (!result.allowed) {
      const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
      res.setHeader('retry-after', String(retryAfter));
      return next(tooMany('Rate limit exceeded', { retryAfterSeconds: retryAfter }));
    }
    next();
  };
}

const general = createLimiter({
  name: 'general',
  windowMs: backend.rateLimitWindowMs,
  max: backend.rateLimitMax,
});

const auth = createLimiter({
  name: 'auth',
  windowMs: backend.rateLimitWindowMs,
  max: backend.authRateLimitMax,
});

module.exports = { createLimiter, middleware, general, auth };
