'use strict';

const config = require('./config');
const { CookieJar } = require('./cookies');

// One anonymous upstream session, shared by all proxied requests. See
// src/cookies.js for what is and is not stored.
const cookieJar = new CookieJar();

/** Error carrying the upstream status so callers can map it to a response. */
class UpstreamError extends Error {
  constructor(message, status, url) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.url = url;
  }
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Headers we intentionally do NOT forward to the origin.
 *
 * `cookie` and `authorization` are dropped unconditionally: browser cookies on
 * this origin are clone sessions (`sessionid`, `csrftoken`, `ds_user_id`) and
 * must never reach Instagram. The origin always sees an anonymous request.
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP,
  'host',
  'cookie',
  'authorization',
  'content-length',
  'accept-encoding',
]);

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Statuses that indicate transient throttling or a transient origin error.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Honour a Retry-After header (seconds or HTTP date) when the origin sends one. */
function retryAfterMs(headers) {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * Perform a single upstream request.
 *
 * Returns the decompressed body plus the response metadata needed for caching
 * and replay. Uses the global fetch (undici) which transparently negotiates and
 * decodes gzip/br/deflate, so the body we store is always identity-encoded.
 *
 * Transient failures are retried with exponential backoff and jitter. Retries
 * are confined to idempotent methods so a client POST is never sent twice.
 */
async function fetchUpstream(
  url,
  { method = 'GET', headers = {}, body, timeoutMs = config.requestTimeoutMs } = {},
) {
  const canRetry = IDEMPOTENT_METHODS.has(method.toUpperCase());
  const attempts = canRetry ? Math.max(1, config.maxRetries + 1) : 1;
  let lastResponse = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const outbound = new Headers();
    for (const [name, value] of Object.entries(headers)) {
      if (STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
      if (value === undefined || value === null) continue;
      outbound.set(name, String(value));
    }
    if (!outbound.has('user-agent')) outbound.set('user-agent', config.userAgent);
    if (!outbound.has('accept')) outbound.set('accept', '*/*');
    // Only the loader's own anonymous jar is ever sent upstream; browser
    // cookies were already dropped by STRIPPED_REQUEST_HEADERS.
    const jarCookie = cookieJar.header();
    if (jarCookie) outbound.set('cookie', jarCookie);

    try {
      const response = await fetch(url, {
        method,
        headers: outbound,
        redirect: 'follow',
        signal: controller.signal,
        ...(body && body.length ? { body } : {}),
      });

      cookieJar.store(response.headers);

      if (canRetry && RETRYABLE_STATUSES.has(response.status) && attempt < attempts) {
        const advised = retryAfterMs(response.headers);
        const backoff = Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** (attempt - 1));
        const wait = advised ?? backoff + Math.floor(Math.random() * 250);
        lastResponse = response;
        await sleep(wait);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        status: response.status,
        ok: response.ok,
        finalUrl: response.url || url,
        redirected: response.redirected,
        headers: response.headers,
        body: buffer,
        attempts: attempt,
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        if (canRetry && attempt < attempts) {
          await sleep(Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** (attempt - 1)));
          continue;
        }
        throw new UpstreamError(`upstream request timed out after ${timeoutMs}ms`, 504, url);
      }
      if (canRetry && attempt < attempts) {
        await sleep(Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** (attempt - 1)));
        continue;
      }
      throw new UpstreamError(`upstream request failed: ${error.message}`, 502, url);
    } finally {
      clearTimeout(timer);
    }
  }

  // Exhausted retries on a retryable status: return the last response as-is so
  // the caller relays the origin's real answer rather than a synthesised one.
  if (lastResponse) {
    const buffer = Buffer.from(await lastResponse.arrayBuffer());
    return {
      status: lastResponse.status,
      ok: lastResponse.ok,
      finalUrl: lastResponse.url || url,
      redirected: lastResponse.redirected,
      headers: lastResponse.headers,
      body: buffer,
      attempts,
    };
  }
  throw new UpstreamError('upstream request failed after retries', 502, url);
}

module.exports = { fetchUpstream, UpstreamError, STRIPPED_REQUEST_HEADERS, cookieJar };
