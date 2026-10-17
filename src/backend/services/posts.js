'use strict';

/**
 * Posts service.
 *
 * Posts are rows created through THIS application. There is no import path from
 * Instagram. Every read and every interaction goes through the visibility rule
 * in ./visibility.js: a private author's post is invisible (404, existence not
 * revealed) to anyone who is not an accepted follower.
 */

const { newId, nowIso, newPk, shortcodeFromPk } = require('../lib/ids');
const { notFound, forbidden, badRequest } = require('../lib/errors');
const { paginate } = require('../lib/pagination');
const { canView, visibleAuthorSql, requireVisiblePost, notify } = require('./visibility');

const POST_SELECT = `SELECT p.*, u.username AS author_username, u.pk AS author_pk,
       m.width AS media_width, m.height AS media_height, m.content_type AS media_content_type,
       m.duration_ms AS media_duration_ms, (SELECT c.storage_key FROM media c WHERE c.id = m.cover_media_id) AS cover_key,
       (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
       (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count
  FROM posts p JOIN users u ON u.id = p.author_id LEFT JOIN media m ON m.id = p.media_id`;

function toPublic(row, { viewerId, likeCount, commentCount, likedByViewer, savedByViewer } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    pk: row.pk,
    code: row.code,
    authorId: row.author_id,
    authorPk: row.author_pk ?? null,
    authorUsername: row.author_username ?? null,
    caption: row.caption ?? null,
    mediaUrl: row.media_url ?? null,
    mediaType: row.media_type,
    mediaWidth: row.media_width ?? null,
    mediaHeight: row.media_height ?? null,
    // Videos: the cover frame (served like the video) and the length.
    coverUrl: row.cover_key ? `/__media/${row.cover_key}` : null,
    durationMs: row.media_duration_ms ?? null,
    location: row.location ?? null,
    commentsDisabled: Boolean(row.comments_disabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    likeCount: likeCount ?? row.like_count ?? 0,
    commentCount: commentCount ?? row.comment_count ?? 0,
    likedByViewer: Boolean(likedByViewer ?? row.liked_by_viewer),
    savedByViewer: Boolean(savedByViewer ?? row.saved_by_viewer),
    viewerIsAuthor: viewerId ? row.author_id === viewerId : false,
  };
}

function getRow(db, id) {
  return db.prepare(`${POST_SELECT} WHERE p.id = ? AND p.deleted_at IS NULL`).get(id);
}

function viewerFlags(db, viewerId, postId) {
  if (!viewerId) return { likedByViewer: false, savedByViewer: false };
  return {
    likedByViewer: Boolean(db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?').get(viewerId, postId)),
    savedByViewer: Boolean(db.prepare('SELECT 1 FROM saved_posts WHERE user_id = ? AND post_id = ?').get(viewerId, postId)),
  };
}

function get(db, id, { viewerId } = {}) {
  const row = getRow(db, id);
  if (!row || !canView(db, viewerId, row.author_id)) throw notFound('Post not found');
  return toPublic(row, { viewerId, ...viewerFlags(db, viewerId, id) });
}

/** Resolve a post by numeric pk, media id ("<pk>_<authorPk>") or shortcode. */
function resolveId(db, ref) {
  if (typeof ref !== 'string' || !ref) return null;
  const pk = ref.includes('_') ? ref.split('_')[0] : ref;
  const row =
    db.prepare('SELECT id FROM posts WHERE pk = ? AND deleted_at IS NULL').get(pk) ||
    db.prepare('SELECT id FROM posts WHERE code = ? AND deleted_at IS NULL').get(ref) ||
    db.prepare('SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL').get(ref);
  return row ? row.id : null;
}

function create(db, authorId, { caption, mediaUrl, mediaType, location, mediaId }) {
  const id = newId('post');
  const pk = newPk();
  const now = nowIso();
  db.prepare(
    `INSERT INTO posts (id, pk, code, author_id, caption, media_url, media_type, location, media_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, pk, shortcodeFromPk(pk), authorId, caption ?? null, mediaUrl ?? null, mediaType || 'image', location ?? null, mediaId ?? null, now, now);
  return get(db, id, { viewerId: authorId });
}

function requireOwnership(db, id, userId) {
  const row = db.prepare('SELECT author_id FROM posts WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) throw notFound('Post not found');
  if (row.author_id !== userId) throw forbidden('You do not own this post');
  return row;
}

function update(db, id, userId, fields) {
  requireOwnership(db, id, userId);
  const sets = [];
  const values = [];
  const map = { caption: 'caption', location: 'location', mediaUrl: 'media_url' };
  for (const [key, column] of Object.entries(map)) {
    if (fields[key] !== undefined) {
      sets.push(`${column} = ?`);
      values.push(fields[key]);
    }
  }
  if (fields.commentsDisabled !== undefined) {
    sets.push('comments_disabled = ?');
    values.push(fields.commentsDisabled ? 1 : 0);
  }
  if (!sets.length) return get(db, id, { viewerId: userId });
  sets.push('updated_at = ?');
  values.push(nowIso(), id);
  db.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return get(db, id, { viewerId: userId });
}

function remove(db, id, userId) {
  requireOwnership(db, id, userId);
  db.prepare('UPDATE posts SET deleted_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), id);
  return { id, deleted: true };
}

function listByAuthor(db, authorId, { limit, cursor }, { viewerId } = {}) {
  if (!canView(db, viewerId, authorId)) return { items: [], nextCursor: null, restricted: true };
  const { items, nextCursor } = paginate(
    { limit, cursor },
    (take, cur) =>
      cur
        ? db
            .prepare(
              `${POST_SELECT} WHERE p.author_id = ? AND p.deleted_at IS NULL
                 AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))
               ORDER BY p.created_at DESC, p.id DESC LIMIT ?`
            )
            .all(authorId, cur.createdAt, cur.createdAt, cur.id, take)
        : db
            .prepare(`${POST_SELECT} WHERE p.author_id = ? AND p.deleted_at IS NULL ORDER BY p.created_at DESC, p.id DESC LIMIT ?`)
            .all(authorId, take),
    (row) => ({ createdAt: row.created_at, id: row.id })
  );
  return { items: items.map((row) => toPublic(row, { viewerId, ...viewerFlags(db, viewerId, row.id) })), nextCursor };
}

/** Reels (video posts) the viewer may see, newest first: the Reels tab. */
function listClips(db, viewerId, { limit, cursor }) {
  const where = `p.deleted_at IS NULL AND p.media_type = 'video' AND ${visibleAuthorSql('p.author_id', 'u')}`;
  const { items, nextCursor } = paginate(
    { limit, cursor },
    (take, cur) =>
      cur
        ? db
            .prepare(`${POST_SELECT} WHERE ${where} AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?)) ORDER BY p.created_at DESC, p.id DESC LIMIT ?`)
            .all(viewerId, viewerId, cur.createdAt, cur.createdAt, cur.id, take)
        : db.prepare(`${POST_SELECT} WHERE ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`).all(viewerId, viewerId, take),
    (row) => ({ createdAt: row.created_at, id: row.id })
  );
  return { items: items.map((row) => toPublic(row, { viewerId, ...viewerFlags(db, viewerId, row.id) })), nextCursor };
}

function countByAuthor(db, authorId) {
  return db.prepare('SELECT COUNT(*) AS n FROM posts WHERE author_id = ? AND deleted_at IS NULL').get(authorId).n;
}

function setLike(db, postId, userId, liked) {
  const post = requireVisiblePost(db, postId, userId);
  if (liked) {
    const info = db
      .prepare('INSERT OR IGNORE INTO likes (user_id, post_id, created_at) VALUES (?, ?, ?)')
      .run(userId, postId, nowIso());
    if (info.changes) {
      notify(db, { userId: post.author_id, kind: 'like', actorId: userId, subjectType: 'post', subjectId: postId, body: 'liked your post' });
    }
  } else {
    db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(userId, postId);
  }
  return get(db, postId, { viewerId: userId });
}

function listLikers(db, postId, viewerId, { limit = 50 } = {}) {
  requireVisiblePost(db, postId, viewerId);
  return db
    .prepare(
      `SELECT u.id, u.pk, u.username, u.display_name, u.avatar_url, u.is_private FROM likes l
       JOIN users u ON u.id = l.user_id WHERE l.post_id = ? ORDER BY l.created_at DESC LIMIT ?`
    )
    .all(postId, limit);
}

function assertMediaType(value) {
  const allowed = ['image', 'video', 'carousel'];
  if (value !== undefined && !allowed.includes(value)) {
    throw badRequest(`"mediaType" must be one of: ${allowed.join(', ')}`, { field: 'mediaType' });
  }
}

module.exports = {
  POST_SELECT,
  create,
  get,
  getRow,
  resolveId,
  update,
  remove,
  listByAuthor,
  listClips,
  countByAuthor,
  setLike,
  listLikers,
  toPublic,
  viewerFlags,
  assertMediaType,
  visibleAuthorSql,
};
