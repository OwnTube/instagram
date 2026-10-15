'use strict';

/**
 * Cookie helpers.
 *
 * Only this application's own session cookies are handled here. They are scoped
 * to the whole origin (documents and the original client's API calls must both
 * see the session), HttpOnly (session) / readable (CSRF, viewer id),
 * SameSite=Lax, and optionally Secure. The session cookie never leaves this
 * origin: the upstream fetcher drops every browser cookie.
 */

const backend = require('../config');

function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure ?? backend.secureCookies) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  return parts.join('; ');
}

function setSessionCookie(res, token, maxAgeMs = backend.sessionTtlMs) {
  res.append(
    'set-cookie',
    serializeCookie(backend.cookieName, token, {
      httpOnly: true,
      path: backend.cookiePath,
      maxAge: maxAgeMs,
      sameSite: 'Lax',
    })
  );
}

function clearSessionCookie(res) {
  res.append(
    'set-cookie',
    serializeCookie(backend.cookieName, '', { httpOnly: true, path: backend.cookiePath, maxAge: 0 })
  );
}

/**
 * The CSRF cookie is deliberately readable by script: the client must be able to
 * echo it in a header, which a cross-site attacker cannot do.
 */
function setCsrfCookie(res, secret) {
  res.append(
    'set-cookie',
    serializeCookie(backend.csrfCookieName, secret, {
      httpOnly: false,
      path: backend.cookiePath,
      maxAge: backend.sessionTtlMs,
      sameSite: 'Lax',
    })
  );
}

function clearCsrfCookie(res) {
  res.append(
    'set-cookie',
    serializeCookie(backend.csrfCookieName, '', { httpOnly: false, path: backend.cookiePath, maxAge: 0 })
  );
}

function setViewerCookie(res, pk) {
  res.append(
    'set-cookie',
    serializeCookie(backend.viewerCookieName, String(pk), {
      httpOnly: false,
      path: backend.cookiePath,
      maxAge: backend.sessionTtlMs,
      sameSite: 'Lax',
    })
  );
}

function clearViewerCookie(res) {
  res.append(
    'set-cookie',
    serializeCookie(backend.viewerCookieName, '', { httpOnly: false, path: backend.cookiePath, maxAge: 0 })
  );
}

module.exports = {
  setViewerCookie,
  clearViewerCookie,
  parseCookies,
  serializeCookie,
  setSessionCookie,
  clearSessionCookie,
  setCsrfCookie,
  clearCsrfCookie,
};
