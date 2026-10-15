'use strict';

/**
 * Authentication and authorization middleware.
 *
 * Two ways to present a session:
 *   1. `Authorization: Bearer <token>` — no ambient authority, so no CSRF
 *      concern. Used by API clients and the test suite.
 *   2. The session cookie — ambient authority, so state-changing methods also
 *      require a matching CSRF token (double submit against the session's own
 *      secret). The cookie is HttpOnly and scoped to the backend prefix.
 *
 * `requireAuth` attaches req.user and req.session. It never trusts a user id
 * supplied by the client: the id comes only from the resolved session.
 */

const backend = require('../config');
const { unauthorized, forbidden } = require('./errors');
const { parseCookies } = require('./cookies');
const sessions = require('../services/sessions');
const users = require('../services/users');
const { timingSafeEqual } = require('./ids');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function bearerToken(req) {
  const header = req.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** Resolve the session for a request without enforcing anything. */
function resolveSession(db, req) {
  const token = bearerToken(req);
  if (token) {
    const session = sessions.findActiveByToken(db, token);
    return session ? { session, source: 'bearer' } : null;
  }
  const cookies = parseCookies(req.get('cookie'));
  const cookieToken = cookies[backend.cookieName];
  if (!cookieToken) return null;
  const session = sessions.findActiveByToken(db, cookieToken);
  return session ? { session, source: 'cookie' } : null;
}

function attachUser(db) {
  return function attach(req, res, next) {
    const resolved = resolveSession(db, req);
    if (!resolved) {
      req.user = null;
      req.session = null;
      req.authSource = null;
      return next();
    }
    const user = users.getById(db, resolved.session.user_id);
    if (!user) {
      req.user = null;
      req.session = null;
      req.authSource = null;
      return next();
    }
    req.user = user;
    req.session = resolved.session;
    req.authSource = resolved.source;
    sessions.touch(db, resolved.session.id);
    next();
  };
}

/**
 * CSRF check for cookie-authenticated state changes.
 *
 * Bearer-authenticated requests are exempt because a bearer token is not sent
 * automatically by the browser. A request with no session at all is exempt too:
 * there is no session to ride, and the route itself will reject it.
 */
function csrfProtection() {
  return function csrf(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    if (!req.session || req.authSource !== 'cookie') return next();

    const cookies = parseCookies(req.get('cookie'));
    const cookieValue = cookies[backend.csrfCookieName];
    const headerValue = req.get('x-csrf-token');

    // The header is the ONLY accepted source. Falling back to the cookie would
    // defeat the mechanism entirely: the browser attaches the cookie to a
    // cross-site request automatically, so accepting it would let a forged
    // request validate itself. Only script on our origin can read the cookie
    // and copy it into a header, which is exactly the capability a cross-site
    // attacker lacks.
    if (!headerValue || !cookieValue || !timingSafeEqual(headerValue, cookieValue)) {
      return next(forbidden('CSRF token missing or invalid'));
    }
    if (!timingSafeEqual(headerValue, req.session.csrf_secret)) {
      return next(forbidden('CSRF token does not match this session'));
    }
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

module.exports = {
  attachUser,
  csrfProtection,
  requireAuth,
  resolveSession,
  bearerToken,
  SAFE_METHODS,
};
