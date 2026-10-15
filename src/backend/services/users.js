'use strict';

/**
 * User accounts belonging to THIS application.
 *
 * These are not Instagram accounts. No field here is an Instagram credential,
 * and `upstream_identity` records at most a username an operator explicitly
 * declared — never a token. The distinction is load-bearing: a user who logs in
 * here is authenticated to the loader's backend and to nothing else.
 */

const { newId, nowIso, newPk } = require('../lib/ids');
const { hashPassword, verifyPassword } = require('../lib/passwords');
const { conflict, notFound, unauthorized, badRequest } = require('../lib/errors');

const PUBLIC_COLUMNS = `id, pk, username, email, display_name, bio, avatar_url, external_url, is_private, status, created_at, updated_at`;

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    pk: row.pk,
    username: row.username,
    displayName: row.display_name ?? null,
    bio: row.bio ?? null,
    avatarUrl: row.avatar_url ?? null,
    externalUrl: row.external_url ?? null,
    isPrivate: Boolean(row.is_private),
    createdAt: row.created_at,
  };
}

function createUser(db, { username, email, password, displayName }) {
  // Synchronous variant for callers that already hold a derived password hash
  // is intentionally not provided: hashing is async, so every creation path
  // goes through createUserAsync. This guard keeps a mistaken sync call loud.
  throw new Error('createUser is async; call createUserAsync');
}

/**
 * Async user creation: hashes the password before inserting.
 * Kept async so scrypt never blocks the event loop synchronously in the caller.
 */
async function createUserAsync(db, { username, email, password, displayName }) {
  const usernameCi = String(username).toLowerCase();
  if (db.prepare('SELECT 1 FROM users WHERE username_ci = ?').get(usernameCi)) {
    throw conflict('That username is already taken', { field: 'username' });
  }
  const emailCi = email ? String(email).toLowerCase() : null;
  if (emailCi && db.prepare('SELECT 1 FROM users WHERE email_ci = ?').get(emailCi)) {
    throw conflict('That email is already registered', { field: 'email' });
  }

  const derived = await hashPassword(password);
  const id = newId('usr');
  const now = nowIso();

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO users (id, pk, username, username_ci, email, email_ci, password_hash, password_salt, password_params, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, newPk(), username, usernameCi, email ?? null, emailCi, derived.hash, derived.salt, derived.params, displayName ?? null, now, now);

    db.prepare(
      `INSERT INTO user_settings (user_id, locale, theme, is_private, allow_messages_from, updated_at)
       VALUES (?, 'en', 'system', 0, 'everyone', ?)`
    ).run(id, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getById(db, id);
}

function getById(db, id) {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`).get(id) || null;
}

function getByPk(db, pk) {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE pk = ?`).get(String(pk)) || null;
}

function getByUsername(db, username) {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE username_ci = ?`).get(String(username).toLowerCase()) || null;
}

/** Credentials by username or, as the original login form allows, by email. */
function getCredentials(db, username) {
  const key = String(username).toLowerCase();
  const sql = 'SELECT id, password_hash, password_salt, password_params, status FROM users WHERE ';
  return (
    db.prepare(`${sql}username_ci = ?`).get(key) ||
    (key.includes('@') ? db.prepare(`${sql}email_ci = ?`).get(key) : null) ||
    null
  );
}

/** Verify a login. Returns the public user, or throws a uniform 401. */
async function authenticate(db, { username, password }) {
  const creds = getCredentials(db, username);
  // Always run a verification, even for an unknown user, so the response time
  // does not reveal whether the account exists.
  const record = creds
    ? { hash: creds.password_hash, salt: creds.password_salt, params: creds.password_params }
    : { hash: 'x', salt: 'y', params: '32768:8:1:32' };
  const valid = await verifyPassword(password, record);
  if (!creds || !valid) throw unauthorized('Invalid username or password');
  if (creds.status !== 'active') throw unauthorized('This account is not active');
  return getById(db, creds.id);
}

function updateProfile(db, id, fields) {
  const sets = [];
  const values = [];
  const map = { displayName: 'display_name', bio: 'bio', avatarUrl: 'avatar_url', externalUrl: 'external_url' };
  for (const [key, column] of Object.entries(map)) {
    if (fields[key] !== undefined) {
      sets.push(`${column} = ?`);
      values.push(fields[key]);
    }
  }
  if (fields.username !== undefined) {
    const usernameCi = String(fields.username).toLowerCase();
    const taken = db.prepare('SELECT id FROM users WHERE username_ci = ?').get(usernameCi);
    if (taken && taken.id !== id) throw conflict('That username is already taken', { field: 'username' });
    sets.push('username = ?', 'username_ci = ?');
    values.push(fields.username, usernameCi);
  }
  if (fields.email !== undefined) {
    const emailCi = fields.email ? String(fields.email).toLowerCase() : null;
    const taken = emailCi && db.prepare('SELECT id FROM users WHERE email_ci = ?').get(emailCi);
    if (taken && taken.id !== id) throw conflict('That email is already registered', { field: 'email' });
    sets.push('email = ?', 'email_ci = ?');
    values.push(fields.email || null, emailCi);
  }
  if (fields.isPrivate !== undefined) {
    sets.push('is_private = ?');
    values.push(fields.isPrivate ? 1 : 0);
    db.prepare('UPDATE user_settings SET is_private = ?, updated_at = ? WHERE user_id = ?').run(fields.isPrivate ? 1 : 0, nowIso(), id);
  }
  if (!sets.length) return getById(db, id);
  sets.push('updated_at = ?');
  values.push(nowIso(), id);
  const info = db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  if (!info.changes) throw notFound('User not found');
  return getById(db, id);
}

function requireUser(row) {
  if (!row) throw notFound('User not found');
  return row;
}

/** Link a declared Instagram username. Stores no token and no password. */
function setUpstreamIdentity(db, userId, instagramUsername, note) {
  if (!getById(db, userId)) throw badRequest('Unknown user');
  const now = nowIso();
  db.prepare(
    `INSERT INTO upstream_identity (user_id, instagram_username, link_state, note, created_at, updated_at)
     VALUES (?, ?, 'declared', ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET instagram_username = excluded.instagram_username, note = excluded.note, updated_at = excluded.updated_at`
  ).run(userId, String(instagramUsername).replace(/^@/, ''), note ?? null, now, now);
  return getUpstreamIdentity(db, userId);
}

function getUpstreamIdentity(db, userId) {
  const row = db.prepare('SELECT * FROM upstream_identity WHERE user_id = ?').get(userId);
  if (!row) return null;
  return {
    instagramUsername: row.instagram_username,
    linkState: row.link_state,
    note: row.note ?? null,
    // Stated explicitly so no caller can mistake this for real authorization.
    authenticatedToInstagram: false,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  toPublic,
  createUserAsync,
  createUser,
  getById,
  getByPk,
  getByUsername,
  getCredentials,
  authenticate,
  updateProfile,
  requireUser,
  setUpstreamIdentity,
  getUpstreamIdentity,
};
