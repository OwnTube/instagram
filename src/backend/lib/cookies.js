'use strict';

/**
 * Cookie helpers.
 *
 * Only this application's own session cookies are handled here. They are scoped
 * to the backend prefix, HttpOnly (session) / readable (CSRF), SameSite=Lax, and
 * optionally Secure. No Instagram cookie is read, written, or forwarded, and the
 * session cookie never leaves this origin.
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
      path: backend.prefix,
      maxAge: maxAgeMs,
      sameSite: 'Lax',
    })
  );
}

function clearSessionCookie(res) {
  res.append(
    'set-cookie',
    serializeCookie(backend.cookieName, '', { httpOnly: true, path: backend.prefix, maxAge: 0 })
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
      path: backend.prefix,
      maxAge: backend.sessionTtlMs,
      sameSite: 'Lax',
    })
  );
}

function clearCsrfCookie(res) {
  res.append(
    'set-cookie',
    serializeCookie(backend.csrfCookieName, '', { httpOnly: false, path: backend.prefix, maxAge: 0 })
  );
}

module.exports = {
  parseCookies,
  serializeCookie,
  setSessionCookie,
  clearSessionCookie,
  setCsrfCookie,
  clearCsrfCookie,
};
