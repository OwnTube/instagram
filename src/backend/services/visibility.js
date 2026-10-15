'use strict';

/**
 * Who may see whose content. One rule, used by every read and every mutation
 * that targets another user's content: the author themself, anyone when the
 * author is public, and accepted followers when the author is private.
 */

const { notFound } = require('../lib/errors');
const { newId, nowIso } = require('../lib/ids');

function canView(db, viewerId, authorId) {
  if (viewerId && viewerId === authorId) return true;
  const author = db.prepare('SELECT is_private FROM users WHERE id = ?').get(authorId);
  if (!author) return false;
  if (!author.is_private) return true;
  if (!viewerId) return false;
  return Boolean(
    db
      .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ? AND state = 'accepted'")
      .get(viewerId, authorId)
  );
}

/**
 * SQL predicate equivalent to canView for an author column, for list queries.
 * Binds the viewer id twice; pass null for an anonymous viewer.
 */
function visibleAuthorSql(authorColumn, userTableAlias) {
  return `(${userTableAlias}.is_private = 0 OR ${authorColumn} = ? OR ${authorColumn} IN (
    SELECT followee_id FROM follows WHERE follower_id = ? AND state = 'accepted'))`;
}

/** Load a live post the viewer may see, or throw 404 (never revealing existence). */
function requireVisiblePost(db, postId, viewerId) {
  const post = db.prepare('SELECT id, author_id, comments_disabled FROM posts WHERE id = ? AND deleted_at IS NULL').get(postId);
  if (!post || !canView(db, viewerId, post.author_id)) throw notFound('Post not found');
  return post;
}

function notify(db, { userId, kind, actorId, subjectType, subjectId, body }) {
  if (actorId && actorId === userId) return null;
  const id = newId('ntf');
  db.prepare(
    `INSERT INTO notifications (id, user_id, kind, actor_id, subject_type, subject_id, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, kind, actorId ?? null, subjectType ?? null, subjectId ?? null, body ?? null, nowIso());
  return id;
}

module.exports = { canView, visibleAuthorSql, requireVisiblePost, notify };
