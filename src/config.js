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
  // Upstream origin that actually serves the client we fetch at runtime.
  upstream: process.env.UPSTREAM_ORIGIN || 'https://www.instagram.com',

  // Hosts whose assets the upstream document is allowed to reference and that
  // we will fetch on the browser's behalf. Anything outside this allow-list is
  // left untouched so we never turn into an open proxy.
  allowedAssetHosts: (process.env.ALLOWED_ASSET_HOSTS ||
    'static.cdninstagram.com,www.instagram.com,instagram.com,scontent.cdninstagram.com')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean),

  host: process.env.HOST || '0.0.0.0',
  port: int(process.env.PORT, 12000),

  // How long a cached upstream response is considered fresh before we
  // revalidate it against the origin with If-None-Match / If-Modified-Since.
  cacheTtlMs: int(process.env.CACHE_TTL_MS, 5 * 60 * 1000),
  // Documents change more often than hashed assets, so they get a shorter
  // freshness window. A cached successful document is also served when the
  // origin is throttling or erroring, which keeps the mirror usable.
  documentCacheTtlMs: int(process.env.DOCUMENT_CACHE_TTL_MS, 60 * 1000),
  // How long a stale-but-successful document may still be served when the
  // origin is unreachable or rate-limiting. 0 disables stale serving.
  documentStaleMs: int(process.env.DOCUMENT_STALE_MS, 30 * 60 * 1000),
  // Hard cap on entries kept in the in-memory cache.
  cacheMaxEntries: int(process.env.CACHE_MAX_ENTRIES, 500),
  // Hard cap on a single cached body (upstream bundles are large).
  cacheMaxBodyBytes: int(process.env.CACHE_MAX_BODY_BYTES, 20 * 1024 * 1024),

  requestTimeoutMs: int(process.env.REQUEST_TIMEOUT_MS, 20000),

  // Transient upstream failures (429 throttling, 5xx) are retried with
  // exponential backoff. Only idempotent requests are retried by default so a
  // POST is never duplicated.
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
 * There is deliberately no server-side Instagram session here.
 *
 * The loader is a logged-out mirror of the public client. It does not hold an
 * account, and it never presents one account's identity to every viewer. An
 * earlier revision injected a configured `IG_SESSIONID` upstream, which made
 * every visitor receive one account's personalised document; that is removed.
 *
 * Personalisation, when it exists at all, is per-viewer and comes from the
 * viewer's own browser session; see viewerSessionCookie() in src/server.js.
 * Nothing about a viewer is configured globally.
 */

// Prefix that rewritten asset URLs are served under, e.g.
// https://<our-host>/__ig/static.cdninstagram.com/rsrc.php/v4/yC/r/x.js
config.assetPrefix = '/__ig';

/*
 * Per-viewer personalisation.
 *
 * When enabled, a viewer's own Instagram session cookies are relayed upstream
 * for that viewer's own requests, so each viewer sees their own account rather
 * than a shared one. Off by default: the loader is an anonymous mirror, and
 * turning this on means accepting traffic that carries credentials.
 *
 * This is not authentication. The loader has no login and no accounts of its
 * own; it only passes through a session the viewer already holds.
 */
config.allowViewerSessions = bool(process.env.ALLOW_VIEWER_SESSIONS, false);

module.exports = config;
