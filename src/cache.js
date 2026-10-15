'use strict';

const config = require('./config');

/**
 * Small in-memory LRU-ish cache with HTTP validators.
 *
 * Keyed by absolute upstream URL. Stores the raw body plus the headers we need
 * to replay the response locally (content-type, content-encoding, etag,
 * last-modified). Entries carry the validators so an expired entry can be
 * revalidated with a conditional request instead of being downloaded again.
 */
class ResponseCache {
  constructor({ ttlMs = config.cacheTtlMs, maxEntries = config.cacheMaxEntries, maxBodyBytes = config.cacheMaxBodyBytes } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.maxBodyBytes = maxBodyBytes;
    this.map = new Map();
    this.stats = { hits: 0, misses: 0, revalidated: 0, evictions: 0 };
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Refresh recency for LRU ordering.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  /** A fresh entry can be served without contacting the origin at all. */
  isFresh(entry, ttlMs = this.ttlMs) {
    return Boolean(entry) && Date.now() - entry.storedAt < (entry.ttlMs ?? ttlMs);
  }

  /**
   * Whether a previously successful entry may still be served even though it is
   * stale, e.g. because the origin is throttling or erroring.
   */
  isServableWhenStale(entry, staleMs) {
    if (!entry || staleMs <= 0) return false;
    return Date.now() - entry.storedAt < staleMs;
  }

  set(key, entry) {
    if (entry.body && entry.body.length > this.maxBodyBytes) {
      // Too large to keep; still serve it once but do not retain it.
      return;
    }
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { ...entry, storedAt: Date.now() });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
      this.stats.evictions += 1;
    }
  }

  /** Update validators after a successful 304 without touching the body. */
  touch(key, headers) {
    const entry = this.map.get(key);
    if (!entry) return;
    if (headers.etag) entry.etag = headers.etag;
    if (headers['last-modified']) entry.lastModified = headers['last-modified'];
    entry.storedAt = Date.now();
  }

  size() {
    return this.map.size;
  }
}

module.exports = { ResponseCache };
