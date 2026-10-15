'use strict';

/**
 * Posts service.
 *
 * Posts are rows created through THIS backend. There is no import path from
 * Instagram, so a post here is not an Instagram post and is never presented as
 * one. Reads are owner-scoped where the data is private; the public feed only
 * ever exposes public accounts' posts.
 */

const { newId, nowIso } = require('../lib/ids');
const { notFound, forbidden, badRequest } = require('../lib/errors');
const { paginate } = require('../lib/pagination');

function toPublic(row, { viewerId, likeCount, commentCount, likedByViewer } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    authorId: row.author_id,
    authorUsername: row.author_username ?? null,
    caption: row.caption ?? null,
    mediaUrl: row.media_url ?? null,
    mediaType: row.media_type,
    location: row.location ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    likeCount: likeCount ?? row.like_count ?? 0,
    commentCount: commentCount ?? row.comment_count ?? 0,
    likedByViewer: Boolean(likedByViewer ?? row.liked_by_viewer),
    viewerIsAuthor: viewerId ? row.author_id === viewerId : false,
  };
}

function getRow(db, id) {
  return db
    .prepare(
      `SELECT p.*, u.username AS author_username,
              (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
              (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count
       FROM posts p JOIN users u ON u.id = p.author_id
       WHERE p.id = ? AND p.deleted_at IS NULL`
    )
    .get(id);
}

function get(db, id, { viewerId } = {}) {
  const row = getRow(db, id);
  if (!row) throw notFound('Post not found');
  const liked = viewerId
    ? Boolean(db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?').get(viewerId, id))
    : false;
  return toPublic(row, { viewerId, likedByViewer: liked });
}

function create(db, authorId, { caption, mediaUrl, mediaType, location }) {
  const id = newId('post');
  const now = nowIso();
  db.prepare(
    `INSERT INTO posts (id, author_id, caption, media_url, media_type, location, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, authorId, caption ?? null, mediaUrl ?? null, mediaType || 'image', location ?? null, now, now);
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
  const { items, nextCursor } = paginate(
    { limit, cursor },
    (take, cur) => {
      if (cur) {
        return db
          .prepare(
            `SELECT p.*, u.username AS author_username,
                    (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
                    (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count
             FROM posts p JOIN users u ON u.id = p.author_id
             WHERE p.author_id = ? AND p.deleted_at IS NULL
               AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))
             ORDER BY p.created_at DESC, p.id DESC LIMIT ?`
          )
          .all(authorId, cur.createdAt, cur.createdAt, cur.id, take);
      }
      return db
        .prepare(
          `SELECT p.*, u.username AS author_username,
                  (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
                  (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count
           FROM posts p JOIN users u ON u.id = p.author_id
           WHERE p.author_id = ? AND p.deleted_at IS NULL
           ORDER BY p.created_at DESC, p.id DESC LIMIT ?`
        )
        .all(authorId, take);
    },
    (row) => ({ createdAt: row.created_at, id: row.id })
  );
  return {
    items: items.map((row) => toPublic(row, { viewerId })),
    nextCursor,
  };
}

function setLike(db, postId, userId, liked) {
  const post = db.prepare('SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL').get(postId);
  if (!post) throw notFound('Post not found');
  if (liked) {
    db.prepare('INSERT OR IGNORE INTO likes (user_id, post_id, created_at) VALUES (?, ?, ?)').run(
      userId,
      postId,
      nowIso()
    );
  } else {
    db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(userId, postId);
  }
  return get(db, postId, { viewerId: userId });
}

function assertMediaType(value) {
  const allowed = ['image', 'video', 'carousel'];
  if (value !== undefined && !allowed.includes(value)) {
    throw badRequest(`"mediaType" must be one of: ${allowed.join(', ')}`, { field: 'mediaType' });
  }
}

module.exports = { create, get, update, remove, listByAuthor, setLike, toPublic, assertMediaType };
