'use strict';

/**
 * Session persistence and lifecycle.
 *
 * Design choices that matter:
 *
 *   - The session token is a random 32-byte value handed to the client once. The
 *     database stores only its SHA-256 hash, so reading the sessions table does
 *     not yield a usable token.
 *   - A session carries its own CSRF secret. For cookie-authenticated requests
 *     the client must echo it in a header, which a cross-site form cannot read.
 *   - Sessions expire, can be revoked individually or wholesale, and rotate: the
 *     token is reissued after a configured age while the session id is kept.
 *   - These sessions authenticate a user to THIS backend only. Nothing here
 *     authenticates anyone to Instagram, and no Instagram credential is stored.
 */

const { newId, randomToken, hashToken, nowIso, addMs } = require('../lib/ids');
const backend = require('../config');

function createSession(db, { userId, userAgent }) {
  const id = newId('sess');
  const token = randomToken(32);
  const csrfSecret = randomToken(24);
  const now = nowIso();
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, csrf_secret, user_agent, created_at, last_seen_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
  ).run(id, userId, hashToken(token), csrfSecret, userAgent ? String(userAgent).slice(0, 300) : null, now, now, addMs(backend.sessionTtlMs));
  return { id, token, csrfSecret, expiresAt: addMs(backend.sessionTtlMs) };
}

function findActiveByToken(db, token) {
  if (!token || typeof token !== 'string') return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token));
  if (!row) return null;
  if (row.revoked_at) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  return row;
}

function touch(db, sessionId) {
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(nowIso(), sessionId);
}

/**
 * Rotate the token of an existing session in place.
 *
 * Returns the new token, or null if the session is no longer active. Rotation
 * keeps the session id and its CSRF secret stable so an in-flight client can
 * continue, while the previously issued bearer token stops working.
 */
function rotate(db, sessionId) {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!row || row.revoked_at) return null;
  const token = randomToken(32);
  db.prepare('UPDATE sessions SET token_hash = ?, last_seen_at = ? WHERE id = ?').run(
    hashToken(token),
    nowIso(),
    sessionId
  );
  return token;
}

/** True when the session is old enough that its token should be reissued. */
function shouldRotate(session) {
  return Date.now() - Date.parse(session.created_at) >= backend.sessionRotateMs;
}

function revoke(db, sessionId) {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(
    nowIso(),
    sessionId
  );
}

function revokeAllForUser(db, userId) {
  const info = db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(nowIso(), userId);
  return Number(info.changes || 0);
}

function listForUser(db, userId) {
  return db
    .prepare('SELECT id, user_agent, created_at, last_seen_at, expires_at, revoked_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId);
}

function purgeExpired(db, now = Date.now()) {
  const info = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date(now).toISOString());
  return Number(info.changes || 0);
}

module.exports = {
  createSession,
  findActiveByToken,
  touch,
  rotate,
  shouldRotate,
  revoke,
  revokeAllForUser,
  listForUser,
  purgeExpired,
};
