'use strict';

/**
 * Clone sessions as seen by the original client.
 *
 * The client authenticates by cookie and proves same-origin intent by echoing
 * the readable `csrftoken` cookie as `X-CSRFToken`. We use exactly that
 * mechanism, bound to our own session:
 *
 *   - anonymous visitors get a random pre-session `csrftoken` (double submit),
 *     which protects login and signup against login-CSRF;
 *   - after login the `csrftoken` cookie IS the session's CSRF secret, so a
 *     write is accepted only when the header matches the secret stored with
 *     the session, not merely a cookie an attacker could plant.
 */

const backend = require('../backend/config');
const sessions = require('../backend/services/sessions');
const users = require('../backend/services/users');
const { resolveSession } = require('../backend/lib/auth');
const { randomToken, timingSafeEqual } = require('../backend/lib/ids');
const { forbidden } = require('../backend/lib/errors');
const {
  parseCookies,
  serializeCookie,
  setSessionCookie,
  clearSessionCookie,
  setCsrfCookie,
  clearCsrfCookie,
  setViewerCookie,
  clearViewerCookie,
} = require('../backend/lib/cookies');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function attachViewer(db) {
  return function viewer(req, res, next) {
    const resolved = resolveSession(db, req);
    const user = resolved ? users.getById(db, resolved.session.user_id) : null;
    req.viewer = user && user.status === 'active' ? user : null;
    req.cloneSession = req.viewer ? resolved.session : null;
    if (req.cloneSession) sessions.touch(db, req.cloneSession.id);
    next();
  };
}

/** Make sure an anonymous browser has a csrftoken to echo. Returns the token. */
function ensureCsrfCookie(req, res) {
  const existing = parseCookies(req.get('cookie'))[backend.csrfCookieName];
  if (existing && /^[A-Za-z0-9_-]{16,128}$/.test(existing)) return existing;
  const token = randomToken(24);
  res.append(
    'set-cookie',
    serializeCookie(backend.csrfCookieName, token, { httpOnly: false, path: backend.cookiePath, maxAge: backend.sessionTtlMs })
  );
  return token;
}

function csrfCheck(req, res, next) {
  if (SAFE.has(req.method)) return next();
  const header = req.get('x-csrftoken') || req.get('x-csrf-token') || '';
  const cookie = parseCookies(req.get('cookie'))[backend.csrfCookieName] || '';
  if (!header || !cookie || !timingSafeEqual(header, cookie)) return next(forbidden('CSRF token missing or incorrect'));
  if (req.cloneSession && !timingSafeEqual(header, req.cloneSession.csrf_secret)) {
    return next(forbidden('CSRF token does not match this session'));
  }
  next();
}

function issueSession(db, req, res, user) {
  const session = sessions.createSession(db, { userId: user.id, userAgent: req.get('user-agent') });
  setSessionCookie(res, session.token);
  setCsrfCookie(res, session.csrfSecret);
  setViewerCookie(res, user.pk);
  return session;
}

function endSession(db, req, res) {
  if (req.cloneSession) sessions.revoke(db, req.cloneSession.id);
  clearSessionCookie(res);
  clearCsrfCookie(res);
  clearViewerCookie(res);
}

module.exports = { attachViewer, ensureCsrfCookie, csrfCheck, issueSession, endSession };
