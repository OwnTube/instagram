'use strict';

/**
 * Notes (migration 0006): a short text an author shares in the Direct inbox
 * tray for 24 hours. Audience 0 is the followers the author follows back
 * (mutual follows), audience 1 the author's close friends (PolarisNotesTypes
 * NoteAudienceOptionValues MUTUAL_FOLLOWS / BESTIES). One active note per
 * author: sharing a new one replaces it. The author always sees their own.
 */

const { newId, nowIso, addMs, newPk } = require('../lib/ids');
const { badRequest, notFound, forbidden } = require('../lib/errors');
const relationships = require('./relationships');

const NOTE_CHAR_LIMIT = 80; // PolarisInboxTrayComposerConstants.NOTE_CHAR_LIMIT
const TTL_MS = 24 * 60 * 60 * 1000;
const AUDIENCES = new Set([0, 1]);

function toPublic(row) {
  return { id: row.id, pk: row.pk, authorId: row.author_id, text: row.text, audience: row.audience, createdAt: row.created_at, expiresAt: row.expires_at };
}

function mutual(db, a, b) {
  const q = db.prepare("SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ? AND state = 'accepted'");
  return Boolean(q.get(a, b) && q.get(b, a));
}

/** Whether `viewerId` may see `note`. */
function canSee(db, viewerId, note) {
  if (!viewerId) return false;
  if (note.authorId === viewerId) return true;
  if (note.audience === 1) return relationships.has(db, note.authorId, viewerId, 'close_friends');
  return mutual(db, note.authorId, viewerId);
}

const notes = {
  NOTE_CHAR_LIMIT,

  create(db, authorId, { text, audience = 0 }) {
    const body = String(text ?? '').trim();
    if (!body) throw badRequest('A note needs some text');
    if ([...body].length > NOTE_CHAR_LIMIT) throw badRequest(`A note can be at most ${NOTE_CHAR_LIMIT} characters`);
    const aud = Number(audience);
    if (!AUDIENCES.has(aud)) throw badRequest('Unknown note audience');
    const now = nowIso();
    const id = newId('note');
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE notes SET deleted_at = ? WHERE author_id = ? AND deleted_at IS NULL').run(now, authorId);
      db.prepare('INSERT INTO notes (id, pk, author_id, text, audience, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, newPk(), authorId, body, aud, now, addMs(TTL_MS));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return toPublic(db.prepare('SELECT * FROM notes WHERE id = ?').get(id));
  },

  /** Delete the author's own note (by pk); deleting it twice is harmless. */
  remove(db, ref, authorId) {
    const row = db.prepare('SELECT * FROM notes WHERE pk = ? OR id = ?').get(String(ref), String(ref));
    if (!row) throw notFound('Note not found');
    if (row.author_id !== authorId) throw forbidden('You can only delete your own note');
    db.prepare('UPDATE notes SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?').run(nowIso(), row.id);
    return { id: row.id, deleted: true };
  },

  /** An active note the viewer may see, by pk (for replies). */
  get(db, ref, viewerId) {
    const row = db.prepare('SELECT * FROM notes WHERE (pk = ? OR id = ?) AND deleted_at IS NULL AND expires_at > ?').get(String(ref), String(ref), nowIso());
    const note = row && toPublic(row);
    if (!note || !canSee(db, viewerId, note)) throw notFound('Note not found');
    return note;
  },

  /** Active notes the viewer may see: their own first, then the newest. Optionally one author's. */
  visibleTo(db, viewerId, { authorId = null } = {}) {
    if (!viewerId) return [];
    const rows = db
      .prepare(`SELECT * FROM notes WHERE deleted_at IS NULL AND expires_at > ? ${authorId ? 'AND author_id = ?' : ''} ORDER BY created_at DESC, id DESC`)
      .all(...(authorId ? [nowIso(), authorId] : [nowIso()]));
    const out = rows.map(toPublic).filter((n) => canSee(db, viewerId, n));
    return [...out.filter((n) => n.authorId === viewerId), ...out.filter((n) => n.authorId !== viewerId)];
  },
};

module.exports = { notes };
