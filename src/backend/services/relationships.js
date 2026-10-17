'use strict';

/**
 * A viewer's own lists of other accounts (migration 0003): close friends,
 * favorites, restricted, muted posts, muted stories. Membership is private to the owner: every read and
 * change is scoped by `ownerId`, and only the owner's own requests reach it.
 */

const { nowIso } = require('../lib/ids');
const { badRequest } = require('../lib/errors');

const LISTS = new Set(['close_friends', 'favorites', 'restricted', 'muted_posts', 'muted_stories']);

function checkList(list) {
  if (!LISTS.has(list)) throw new Error(`unknown relationship list ${list}`);
}

/** Whether `targetId` is on `ownerId`'s `list`. */
function has(db, ownerId, targetId, list) {
  checkList(list);
  if (!ownerId || !targetId) return false;
  return Boolean(db.prepare('SELECT 1 FROM relationship_lists WHERE owner_id = ? AND list = ? AND target_id = ?').get(ownerId, list, targetId));
}

/** Add and remove users (ids) on the owner's list; idempotent. */
function update(db, ownerId, list, { add = [], remove = [] } = {}) {
  checkList(list);
  for (const id of add) if (id === ownerId) throw badRequest('You cannot add yourself to your own list');
  const insert = db.prepare('INSERT OR IGNORE INTO relationship_lists (owner_id, target_id, list, created_at) VALUES (?, ?, ?, ?)');
  const del = db.prepare('DELETE FROM relationship_lists WHERE owner_id = ? AND list = ? AND target_id = ?');
  const now = nowIso();
  for (const id of add) insert.run(ownerId, id, list, now);
  for (const id of remove) del.run(ownerId, list, id);
}

/** The ids on the owner's list, most recently added first. */
function members(db, ownerId, list) {
  checkList(list);
  return db.prepare('SELECT target_id FROM relationship_lists WHERE owner_id = ? AND list = ? ORDER BY created_at DESC, target_id').all(ownerId, list).map((r) => r.target_id);
}

module.exports = { has, update, members, LISTS };
