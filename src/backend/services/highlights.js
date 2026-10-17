'use strict';

/**
 * Story highlights (migration 0005): an owner's named collections of their
 * own stories, shown on the profile after the stories expire. Only the owner
 * creates or edits them; anyone who may see the owner's profile may read them.
 * A highlight whose stories were all deleted is not shown; an edit that
 * removes every story deletes it.
 */

const { newId, nowIso, newPk } = require('../lib/ids');
const { notFound, forbidden, badRequest } = require('../lib/errors');
const visibility = require('./visibility');
const { stories } = require('./social');

const MAX_TITLE = 16;
const MAX_ITEMS = 100;

function cleanTitle(title) {
  const t = String(title ?? '').trim();
  if (!t) throw badRequest('A highlight needs a name');
  return [...t].slice(0, MAX_TITLE).join('');
}

/** The owner's story rows for these pks; every one must be the owner's. */
function ownStories(db, ownerId, storyPks) {
  if (!Array.isArray(storyPks)) throw badRequest('media_ids must be a list');
  if (storyPks.length > MAX_ITEMS) throw badRequest('Too many stories');
  return [...new Set(storyPks.map(String))].map((pk) => {
    const row = db.prepare('SELECT id, author_id FROM stories WHERE pk = ?').get(pk);
    if (!row) throw notFound('Story not found');
    if (row.author_id !== ownerId) throw forbidden('You can only add your own stories');
    return row.id;
  });
}

function coverId(db, ownerId, coverPk, itemIds) {
  if (coverPk == null || coverPk === '') return itemIds[0] ?? null;
  const [id] = ownStories(db, ownerId, [coverPk]);
  return id;
}

function row(db, ref) {
  return db.prepare('SELECT * FROM highlights WHERE pk = ? OR id = ?').get(String(ref), String(ref));
}

function toPublic(db, h, viewerId) {
  const items = db
    .prepare('SELECT s.id FROM highlight_items i JOIN stories s ON s.id = i.story_id WHERE i.highlight_id = ? ORDER BY s.created_at ASC, s.id')
    .all(h.id)
    .map((r) => stories.get(db, r.id, viewerId));
  const cover = (h.cover_story_id && items.find((s) => s.id === h.cover_story_id)) || items[0] || null;
  return { id: h.id, pk: h.pk, ownerId: h.owner_id, title: h.title, createdAt: h.created_at, updatedAt: h.updated_at, cover, items };
}

const highlights = {
  create(db, ownerId, { title, storyPks, coverPk }) {
    const name = cleanTitle(title);
    const itemIds = ownStories(db, ownerId, storyPks);
    if (!itemIds.length) throw badRequest('Choose at least one story');
    const cover = coverId(db, ownerId, coverPk, itemIds);
    const id = newId('highlight');
    const now = nowIso();
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO highlights (id, pk, owner_id, title, cover_story_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, newPk(), ownerId, name, cover, now, now);
      const add = db.prepare('INSERT OR IGNORE INTO highlight_items (highlight_id, story_id, added_at) VALUES (?, ?, ?)');
      for (const s of itemIds) add.run(id, s, now);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return this.get(db, id, ownerId);
  },

  /** Rename, re-cover, add and remove stories; the highlight is deleted when it ends up empty. */
  edit(db, ref, ownerId, { title, coverPk, addPks = [], removePks = [] }) {
    const h = row(db, ref);
    if (!h) throw notFound('Highlight not found');
    if (h.owner_id !== ownerId) throw forbidden('You do not own this highlight');
    const name = title == null ? h.title : cleanTitle(title);
    const add = ownStories(db, ownerId, addPks);
    const remove = ownStories(db, ownerId, removePks);
    const now = nowIso();
    db.exec('BEGIN');
    try {
      const ins = db.prepare('INSERT OR IGNORE INTO highlight_items (highlight_id, story_id, added_at) VALUES (?, ?, ?)');
      for (const s of add) ins.run(h.id, s, now);
      const del = db.prepare('DELETE FROM highlight_items WHERE highlight_id = ? AND story_id = ?');
      for (const s of remove) del.run(h.id, s);
      const left = db.prepare('SELECT story_id FROM highlight_items WHERE highlight_id = ?').all(h.id).map((r) => r.story_id);
      if (!left.length) {
        db.prepare('DELETE FROM highlights WHERE id = ?').run(h.id);
        db.exec('COMMIT');
        return null;
      }
      let cover = coverPk == null || coverPk === '' ? h.cover_story_id : coverId(db, ownerId, coverPk, left);
      if (!left.includes(cover)) cover = null;
      db.prepare('UPDATE highlights SET title = ?, cover_story_id = ?, updated_at = ? WHERE id = ?').run(name, cover, now, h.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return this.get(db, h.id, ownerId);
  },

  get(db, ref, viewerId = null) {
    const h = row(db, ref);
    if (!h || !visibility.canView(db, viewerId, h.owner_id)) throw notFound('Highlight not found');
    const out = toPublic(db, h, viewerId);
    if (!out.items.length) throw notFound('Highlight not found');
    return out;
  },

  /** An owner's non-empty highlights, newest first, as the profile tray shows them. */
  listByOwner(db, ownerId, viewerId = null) {
    if (!visibility.canView(db, viewerId, ownerId)) return [];
    return db
      .prepare('SELECT * FROM highlights WHERE owner_id = ? ORDER BY created_at DESC, id DESC')
      .all(ownerId)
      .map((h) => toPublic(db, h, viewerId))
      .filter((h) => h.items.length);
  },

  count(db, ownerId, viewerId = null) {
    return this.listByOwner(db, ownerId, viewerId).length;
  },
};

module.exports = { highlights, MAX_TITLE };
