'use strict';

/**
 * Anonymous upstream cookie jar.
 *
 * Instagram issues an anonymous `csrftoken` and other non-authenticated cookies
 * on first contact, then expects them back on subsequent requests. Relaying them
 * makes this proxy behave like the single browser session it is standing in for:
 * a document request that returns a challenge page can then POST the challenge
 * to the same origin and succeed.
 *
 * Scope is deliberately narrow:
 *   - only the upstream origin's cookies are stored, never anything from the
 *     browser;
 *   - authentication cookies are never stored or relayed (see AUTH_COOKIES), so
 *     no session, login token or user identity is ever collected or forwarded;
 *   - cookies are never sent back down to the browser: the loader strips
 *     Set-Cookie from responses, so nothing lands in the viewer's browser either.
 */

// Names that carry identity or authentication. Never stored, never relayed.
const AUTH_COOKIES = new Set(['sessionid', 'ds_user_id', 'ds_user', 'ig_did', 'rur']);

const MAX_COOKIES = 32;

class CookieJar {
  constructor() {
    this.cookies = new Map(); // name -> { value, expires }
  }

  /** Parse Max-Age / Expires from a single Set-Cookie string. */
  static expiryOf(attributes) {
    const maxAge = attributes.match(/;\s*max-age=(\d+)/i);
    if (maxAge) return Date.now() + Number(maxAge[1]) * 1000;
    const expires = attributes.match(/;\s*expires=([^;]+)/i);
    if (expires) {
      const parsed = Date.parse(expires[1]);
      if (Number.isFinite(parsed)) return parsed;
    }
    // Session cookie: keep it for the life of the process.
    return Number.POSITIVE_INFINITY;
  }

  /** Absorb Set-Cookie headers from an upstream response. */
  store(headers) {
    const setCookies =
      typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : [headers.get('set-cookie')].filter(Boolean);

    for (const raw of setCookies) {
      if (!raw) continue;
      const [pair, ...attributes] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name || AUTH_COOKIES.has(name.toLowerCase())) continue;
      if (value === '') {
        this.cookies.delete(name);
        continue;
      }
      this.cookies.set(name, { value, expires: CookieJar.expiryOf(attributes.join(';')) });
      if (this.cookies.size > MAX_COOKIES) {
        const oldest = this.cookies.keys().next().value;
        this.cookies.delete(oldest);
      }
    }
  }

  /** Build a Cookie header value for an upstream request, or undefined. */
  header() {
    const now = Date.now();
    const parts = [];
    for (const [name, entry] of this.cookies) {
      if (entry.expires <= now) {
        this.cookies.delete(name);
        continue;
      }
      parts.push(`${name}=${entry.value}`);
    }
    return parts.length ? parts.join('; ') : undefined;
  }

  /** Cookie names currently held (for diagnostics; values are not exposed). */
  names() {
    return [...this.cookies.keys()];
  }
}

module.exports = { CookieJar, AUTH_COOKIES };
