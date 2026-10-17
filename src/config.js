'use strict';

/**
 * Central configuration for the runtime loader.
 *
 * Everything is overridable through environment variables so the same code can
 * point at a different upstream origin without edits.
 */

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const config = {
  // Instagram's origin. Used to resolve the client's own URLs (asset hosts,
  // rewriting) and by the operator's acquisition command
  // (scripts/client-snapshot.js acquire). The server never contacts it.
  upstream: process.env.UPSTREAM_ORIGIN || 'https://www.instagram.com',

  // Hosts whose public static assets the client references; the server serves
  // them from the pinned snapshot under /__ig/<host>/... Anything outside this
  // allow-list is left untouched.
  allowedAssetHosts: (process.env.ALLOWED_ASSET_HOSTS ||
    'static.cdninstagram.com,www.instagram.com,instagram.com,scontent.cdninstagram.com')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean),

  host: process.env.HOST || '0.0.0.0',
  port: int(process.env.PORT, 12000),

  // Browser cache lifetime (cache-control max-age) for pinned static assets.
  cacheTtlMs: int(process.env.CACHE_TTL_MS, 5 * 60 * 1000),

  // Operator acquisition only (src/upstream.js): request timeout and retries
  // of idempotent requests on transient failures (never on 429, which starts
  // a cooldown instead).
  requestTimeoutMs: int(process.env.REQUEST_TIMEOUT_MS, 20000),
  maxRetries: int(process.env.MAX_RETRIES, 3),
  retryBaseMs: int(process.env.RETRY_BASE_MS, 1000),
  retryMaxMs: int(process.env.RETRY_MAX_MS, 15000),

  userAgent:
    process.env.USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',

  verbose: bool(process.env.VERBOSE, true),
};

/*
 * There is deliberately no Instagram session anywhere in this system.
 *
 * An earlier revision injected a configured `IG_SESSIONID` upstream, and a later
 * one could relay a visitor's own Instagram cookies. Both are removed. Upstream
 * is contacted only by the operator's acquisition command, anonymously;
 * every clone user authenticates against our own backend (src/backend), and
 * every clone-owned API call is answered by src/clone, never by Instagram.
 */

// Prefix that rewritten asset URLs are served under, e.g.
// https://<our-host>/__ig/static.cdninstagram.com/rsrc.php/v4/yC/r/x.js
config.assetPrefix = '/__ig';

module.exports = config;
