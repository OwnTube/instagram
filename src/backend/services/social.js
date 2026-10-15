'use strict';

/**
 * Comments, follows, saved posts, notifications, stories, messaging and settings.
 *
 * All of these operate on data created in THIS application. None of them reads
 * or fabricates Instagram data. Every read that could expose another user's
 * private state is scoped by the requesting user's id.
 */

const { newId, nowIso, addMs } = require('../lib/ids');
const { notFound, forbidden, conflict, badRequest } = require('../lib/errors');
const { paginate } = require('../lib/pagination');
const posts = require('./posts');

/* ------------------------------- comments -------------------------------- */

const comments = {
  toPublic(row) {
    return {
      id: row.id,
      postId: row.post_id,
      authorId: row.author_id,
      authorUsername: row.author_username ?? null,
      body: row.body,
      parentId: row.parent_id ?? null,
      createdAt: row.created_at,
    };
  },

  create(db, postId, authorId, { body, parentId }) {
    const post = db.prepare('SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL').get(postId);
    if (!post) throw notFound('Post not found');
    if (parentId) {
      const parent = db.prepare('SELECT post_id FROM comments WHERE id = ? AND deleted_at IS NULL').get(parentId);
      if (!parent) throw notFound('Parent comment not found');
      if (parent.post_id !== postId) throw badRequest('Parent comment belongs to a different post');
    }
    const id = newId('cmt');
    db.prepare(
      `INSERT INTO comments (id, post_id, author_id, body, parent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, postId, authorId, body, parentId ?? null, nowIso());
    return this.get(db, id);
  },

  get(db, id) {
    const row = db
      .prepare(
        `SELECT c.*, u.username AS author_username FROM comments c
         JOIN users u ON u.id = c.author_id
         WHERE c.id = ? AND c.deleted_at IS NULL`
      )
      .get(id);
    if (!row) throw notFound('Comment not found');
    return this.toPublic(row);
  },

  list(db, postId, { limit, cursor }) {
    const { items, nextCursor } = paginate(
      { limit, cursor },
      (take, cur) =>
        cur
          ? db
              .prepare(
                `SELECT c.*, u.username AS author_username FROM comments c JOIN users u ON u.id = c.author_id
                 WHERE c.post_id = ? AND c.deleted_at IS NULL
                   AND (c.created_at < ? OR (c.created_at = ? AND c.id < ?))
                 ORDER BY c.created_at DESC, c.id DESC LIMIT ?`
              )
              .all(postId, cur.createdAt, cur.createdAt, cur.id, take)
          : db
              .prepare(
                `SELECT c.*, u.username AS author_username FROM comments c JOIN users u ON u.id = c.author_id
                 WHERE c.post_id = ? AND c.deleted_at IS NULL
                 ORDER BY c.created_at DESC, c.id DESC LIMIT ?`
              )
              .all(postId, take),
      (row) => ({ createdAt: row.created_at, id: row.id })
    );
    return { items: items.map((r) => this.toPublic(r)), nextCursor };
  },

  remove(db, id, userId) {
    const row = db.prepare('SELECT author_id FROM comments WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!row) throw notFound('Comment not found');
    if (row.author_id !== userId) throw forbidden('You do not own this comment');
    db.prepare('UPDATE comments SET deleted_at = ? WHERE id = ?').run(nowIso(), id);
    return { id, deleted: true };
  },
};

/* -------------------------------- follows -------------------------------- */

const follows = {
  /** Request or create a follow, honouring the target's private setting. */
  follow(db, followerId, followeeId) {
    if (followerId === followeeId) throw badRequest('You cannot follow yourself');
    const target = db.prepare('SELECT id, is_private FROM users WHERE id = ?').get(followeeId);
    if (!target) throw notFound('User not found');
    const existing = db.prepare('SELECT state FROM follows WHERE follower_id = ? AND followee_id = ?').get(followerId, followeeId);
    if (existing) throw conflict('You already follow this user', { state: existing.state });

    const state = target.is_private ? 'pending' : 'accepted';
    const now = nowIso();
    db.prepare(
      'INSERT INTO follows (follower_id, followee_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(followerId, followeeId, state, now, now);
    if (state === 'accepted') {
      notifications.create(db, {
        userId: followeeId,
        kind: 'follow',
        actorId: followerId,
        subjectType: 'user',
        subjectId: followerId,
        body: 'started following you',
      });
    }
    return { followerId, followeeId, state };
  },

  unfollow(db, followerId, followeeId) {
    const info = db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(followerId, followeeId);
    if (!info.changes) throw notFound('You do not follow this user');
    return { followerId, followeeId, deleted: true };
  },

  /** Accept a pending request. Only the followee may do this. */
  accept(db, followeeId, followerId) {
    const row = db.prepare('SELECT state FROM follows WHERE follower_id = ? AND followee_id = ?').get(followerId, followeeId);
    if (!row) throw notFound('No follow request from that user');
    if (row.state !== 'pending') throw conflict('That request is not pending');
    db.prepare("UPDATE follows SET state = 'accepted', updated_at = ? WHERE follower_id = ? AND followee_id = ?").run(
      nowIso(),
      followerId,
      followeeId
    );
    notifications.create(db, {
      userId: followerId,
      kind: 'follow_accepted',
      actorId: followeeId,
      subjectType: 'user',
      subjectId: followeeId,
      body: 'accepted your follow request',
    });
    return { followerId, followeeId, state: 'accepted' };
  },

  reject(db, followeeId, followerId) {
    const row = db.prepare('SELECT state FROM follows WHERE follower_id = ? AND followee_id = ?').get(followerId, followeeId);
    if (!row) throw notFound('No follow request from that user');
    db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(followerId, followeeId);
    return { followerId, followeeId, rejected: true };
  },

  listFollowers(db, userId, { limit, cursor }) {
    const { items, nextCursor } = paginate(
      { limit, cursor },
      (take, cur) =>
        cur
          ? db
              .prepare(
                `SELECT f.*, u.username FROM follows f JOIN users u ON u.id = f.follower_id
                 WHERE f.followee_id = ? AND f.state = 'accepted'
                   AND (f.created_at < ? OR (f.created_at = ? AND f.follower_id < ?))
                 ORDER BY f.created_at DESC, f.follower_id DESC LIMIT ?`
              )
              .all(userId, cur.createdAt, cur.createdAt, cur.id, take)
          : db
              .prepare(
                `SELECT f.*, u.username FROM follows f JOIN users u ON u.id = f.follower_id
                 WHERE f.followee_id = ? AND f.state = 'accepted'
                 ORDER BY f.created_at DESC, f.follower_id DESC LIMIT ?`
              )
              .all(userId, take),
      (row) => ({ createdAt: row.created_at, id: row.follower_id })
    );
    return { items: items.map((r) => ({ id: r.follower_id, username: r.username, state: r.state })), nextCursor };
  },

  listFollowing(db, userId, { limit, cursor }) {
    const { items, nextCursor } = paginate(
      { limit, cursor },
      (take, cur) =>
        cur
          ? db
              .prepare(
                `SELECT f.*, u.username FROM follows f JOIN users u ON u.id = f.followee_id
                 WHERE f.follower_id = ? AND f.state = 'accepted'
                   AND (f.created_at < ? OR (f.created_at = ? AND f.followee_id < ?))
                 ORDER BY f.created_at DESC, f.followee_id DESC LIMIT ?`
              )
              .all(userId, cur.createdAt, cur.createdAt, cur.id, take)
          : db
              .prepare(
                `SELECT f.*, u.username FROM follows f JOIN users u ON u.id = f.followee_id
                 WHERE f.follower_id = ? AND f.state = 'accepted'
                 ORDER BY f.created_at DESC, f.followee_id DESC LIMIT ?`
              )
              .all(userId, take),
      (row) => ({ createdAt: row.created_at, id: row.followee_id })
    );
    return { items: items.map((r) => ({ id: r.followee_id, username: r.username, state: r.state })), nextCursor };
  },

  listPending(db, userId, { limit, cursor }) {
    const { items, nextCursor } = paginate(
      { limit, cursor },
      (take, cur) =>
        cur
          ? db
              .prepare(
                `SELECT f.*, u.username FROM follows f JOIN users u ON u.id = f.follower_id
                 WHERE f.followee_id = ? AND f.state = 'pending'
                   AND (f.created_at < ? OR (f.created_at = ? AND f.follower_id < ?))
                 ORDER BY f.created_at DESC, f.follower_id DESC LIMIT ?`
              )
              .all(userId, cur.createdAt, cur.createdAt, cur.id, take)
          : db
              .prepare(
                `SELECT f.*, u.username FROM follows f JOIN users u ON u.id = f.follower_id
                 WHERE f.followee_id = ? AND f.state = 'pending'
                 ORDER BY f.created_at DESC, f.follower_id DESC LIMIT ?`
              )
              .all(userId, take),
      (row) => ({ createdAt: row.created_at, id: row.follower_id })
    );
    return { items: items.map((r) => ({ id: r.follower_id, username: r.username, requestedAt: r.created_at })), nextCursor };
  },

  /** Whether viewer may see a target's private content. */
  canView(db, viewerId, targetId) {
    if (viewerId && viewerId === targetId) return true;
    const target = db.prepare('SELECT is_private FROM users WHERE id = ?').get(targetId);
    if (!target) return false;
    if (!target.is_private) return true;
    if (!viewerId) return false;
    const rel = db
      .prepare("SELECT state FROM follows WHERE follower_id = ? AND followee_id = ? AND state = 'accepted'")
      .get(viewerId, targetId);
    return Boolean(rel);
  },
};

/* ------------------------------ saved posts ------------------------------ */

const saved = {
  save(db, userId, postId, collectionId) {
    const post = db.prepare('SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL').get(postId);
    if (!post) throw notFound('Post not found');
    if (collectionId) {
      const col = db.prepare('SELECT owner_id FROM collections WHERE id = ?').get(collectionId);
      if (!col) throw notFound('Collection not found');
      if (col.owner_id !== userId) throw forbidden('That collection belongs to another user');
    }
    db.prepare(
      `INSERT INTO saved_posts (user_id, post_id, collection_id, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, post_id) DO UPDATE SET collection_id = excluded.collection_id`
    ).run(userId, postId, collectionId ?? null, nowIso());
    return { postId, collectionId: collectionId ?? null, saved: true };
  },

  unsave(db, userId, postId) {
    const info = db.prepare('DELETE FROM saved_posts WHERE user_id = ? AND post_id = ?').run(userId, postId);
    if (!info.changes) throw notFound('That post is not saved');
    return { postId, saved: false };
  },

  list(db, userId, { limit, cursor }, collectionId = null) {
    const { items, nextCursor } = paginate(
      { limit, cursor },
      (take, cur) =>
        cur
          ? db
              .prepare(
                `SELECT s.created_at AS saved_at, s.collection_id, p.*, u.username AS author_username
                 FROM saved_posts s JOIN posts p ON p.id = s.post_id JOIN users u ON u.id = p.author_id
                 WHERE s.user_id = ? AND p.deleted_at IS NULL
                   AND (? IS NULL OR s.collection_id = ?)
                   AND (s.created_at < ? OR (s.created_at = ? AND s.post_id < ?))
                 ORDER BY s.created_at DESC, s.post_id DESC LIMIT ?`
              )
              .all(userId, collectionId, collectionId, cur.createdAt, cur.createdAt, cur.id, take)
          : db
              .prepare(
                `SELECT s.created_at AS saved_at, s.collection_id, p.*, u.username AS author_username
                 FROM saved_posts s JOIN posts p ON p.id = s.post_id JOIN users u ON u.id = p.author_id
                 WHERE s.user_id = ? AND p.deleted_at IS NULL
                   AND (? IS NULL OR s.collection_id = ?)
                 ORDER BY s.created_at DESC, s.post_id DESC LIMIT ?`
              )
              .all(userId, collectionId, collectionId, take),
      (row) => ({ createdAt: row.saved_at, id: row.id })
    );
    return {
      items: items.map((r) => ({ ...posts.toPublic(r, { viewerId: userId }), savedAt: r.saved_at, collectionId: r.collection_id ?? null })),
      nextCursor,
    };
  },

  createCollection(db, ownerId, name) {
    const id = newId('col');
    db.prepare('INSERT INTO collections (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)').run(id, ownerId, name, nowIso());
    return { id, name, ownerId };
  },

  listCollections(db, ownerId) {
    return db.prepare('SELECT id, name, created_at FROM collections WHERE owner_id = ? ORDER BY created_at DESC').all(ownerId);
  },
};

/* ----------------------------- notifications ----------------------------- */

const notifications = {
  toPublic(row) {
    return {
      id: row.id,
      kind: row.kind,
      actorId: row.actor_id ?? null,
      actorUsername: row.actor_username ?? null,
      subjectType: row.subject_type ?? null,
      subjectId: row.subject_id ?? null,
      body: row.body ?? null,
      read: Boolean(row.read_at),
      createdAt: row.created_at,
    };
  },

  create(db, { userId, kind, actorId, subjectType, subjectId, body }) {
    const id = newId('ntf');
    db.prepare(
      `INSERT INTO notifications (id, user_id, kind, actor_id, subject_type, subject_id, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, userId, kind, actorId ?? null, subjectType ?? null, subjectId ?? null, body ?? null, nowIso());
    return id;
  },

  list(db, userId, { limit, cursor }, { unreadOnly = false } = {}) {
    const { items, nextCursor } = paginate(
      { limit, cursor },
      (take, cur) =>
        cur
          ? db
              .prepare(
                `SELECT n.*, u.username AS actor_username FROM notifications n
                 LEFT JOIN users u ON u.id = n.actor_id
                 WHERE n.user_id = ? ${unreadOnly ? 'AND n.read_at IS NULL' : ''}
                   AND (n.created_at < ? OR (n.created_at = ? AND n.id < ?))
                 ORDER BY n.created_at DESC, n.id DESC LIMIT ?`
              )
              .all(userId, cur.createdAt, cur.createdAt, cur.id, take)
          : db
              .prepare(
                `SELECT n.*, u.username AS actor_username FROM notifications n
                 LEFT JOIN users u ON u.id = n.actor_id
                 WHERE n.user_id = ? ${unreadOnly ? 'AND n.read_at IS NULL' : ''}
                 ORDER BY n.created_at DESC, n.id DESC LIMIT ?`
              )
              .all(userId, take),
      (row) => ({ createdAt: row.created_at, id: row.id })
    );
    return { items: items.map((r) => this.toPublic(r)), nextCursor };
  },

  markRead(db, userId, id) {
    const info = db
      .prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL')
      .run(nowIso(), id, userId);
    if (!info.changes) {
      const exists = db.prepare('SELECT 1 FROM notifications WHERE id = ? AND user_id = ?').get(id, userId);
      if (!exists) throw notFound('Notification not found');
    }
    return { id, read: true };
  },

  markAllRead(db, userId) {
    const info = db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(nowIso(), userId);
    return { updated: Number(info.changes || 0) };
  },

  unreadCount(db, userId) {
    return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).n;
  },
};

/* -------------------------------- stories -------------------------------- */

const stories = {
  toPublic(row) {
    return {
      id: row.id,
      authorId: row.author_id,
      authorUsername: row.author_username ?? null,
      mediaUrl: row.media_url ?? null,
      caption: row.caption ?? null,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      expired: Date.parse(row.expires_at) <= Date.now(),
    };
  },

  create(db, authorId, { mediaUrl, caption, ttlMs = 24 * 60 * 60 * 1000 }) {
    const id = newId('story');
    const now = nowIso();
    db.prepare(
      'INSERT INTO stories (id, author_id, media_url, caption, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, authorId, mediaUrl ?? null, caption ?? null, now, addMs(ttlMs));
    return this.get(db, id);
  },

  get(db, id) {
    const row = db
      .prepare(
        `SELECT s.*, u.username AS author_username FROM stories s JOIN users u ON u.id = s.author_id WHERE s.id = ?`
      )
      .get(id);
    if (!row) throw notFound('Story not found');
    return this.toPublic(row);
  },

  /** Active (unexpired) stories by an author, newest first. */
  listActiveByAuthor(db, authorId) {
    const rows = db
      .prepare(
        `SELECT s.*, u.username AS author_username FROM stories s JOIN users u ON u.id = s.author_id
         WHERE s.author_id = ? AND s.expires_at > ? ORDER BY s.created_at DESC`
      )
      .all(authorId, nowIso());
    return rows.map((r) => this.toPublic(r));
  },

  remove(db, id, userId) {
    const row = db.prepare('SELECT author_id FROM stories WHERE id = ?').get(id);
    if (!row) throw notFound('Story not found');
    if (row.author_id !== userId) throw forbidden('You do not own this story');
    db.prepare('DELETE FROM stories WHERE id = ?').run(id);
    return { id, deleted: true };
  },

  purgeExpired(db, now = Date.now()) {
    const info = db.prepare('DELETE FROM stories WHERE expires_at <= ?').run(new Date(now).toISOString());
    return Number(info.changes || 0);
  },
};

/* ------------------------------- messaging ------------------------------- */

const messages = {
  toPublic(row) {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      senderUsername: row.sender_username ?? null,
      body: row.body,
      createdAt: row.created_at,
    };
  },

  /** Create a conversation with exactly the given members (at least two). */
  createConversation(db, creatorId, memberIds) {
    const members = [...new Set([creatorId, ...memberIds])];
    if (members.length < 2) throw badRequest('A conversation needs at least two members');
    for (const id of members) {
      if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw notFound(`Unknown user: ${id}`);
    }
    const id = newId('conv');
    const now = nowIso();
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)').run(id, now, now);
      const stmt = db.prepare('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)');
      for (const member of members) stmt.run(id, member, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { id, memberIds: members, createdAt: now };
  },

  requireMembership(db, conversationId, userId) {
    const row = db
      .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .get(conversationId, userId);
    if (!row) throw forbidden('You are not a member of this conversation');
    return true;
  },

  send(db, conversationId, senderId, body) {
    this.requireMembership(db, conversationId, senderId);
    const id = newId('msg');
    const now = nowIso();
    db.prepare(
      'INSERT INTO messages (id, conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, conversationId, senderId, body, now);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
    return this.get(db, id, senderId);
  },

  get(db, id, viewerId) {
    const row = db
      .prepare(
        `SELECT m.*, u.username AS sender_username FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.id = ? AND m.deleted_at IS NULL`
      )
      .get(id);
    if (!row) throw notFound('Message not found');
    if (viewerId) this.requireMembership(db, row.conversation_id, viewerId);
    return this.toPublic(row);
  },

  listConversations(db, userId) {
    const rows = db
      .prepare(
        `SELECT c.id, c.updated_at,
                (SELECT COUNT(*) FROM conversation_members cm WHERE cm.conversation_id = c.id) AS member_count
         FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
         WHERE m.user_id = ? ORDER BY c.updated_at DESC`
      )
      .all(userId);
    return rows.map((r) => ({ id: r.id, updatedAt: r.updated_at, memberCount: r.member_count }));
  },

  listMessages(db, conversationId, userId, { limit, cursor }) {
    this.requireMembership(db, conversationId, userId);
    const { items, nextCursor } = paginate(
      { limit, cursor },
      (take, cur) =>
        cur
          ? db
              .prepare(
                `SELECT m.*, u.username AS sender_username FROM messages m JOIN users u ON u.id = m.sender_id
                 WHERE m.conversation_id = ? AND m.deleted_at IS NULL
                   AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))
                 ORDER BY m.created_at DESC, m.id DESC LIMIT ?`
              )
              .all(conversationId, cur.createdAt, cur.createdAt, cur.id, take)
          : db
              .prepare(
                `SELECT m.*, u.username AS sender_username FROM messages m JOIN users u ON u.id = m.sender_id
                 WHERE m.conversation_id = ? AND m.deleted_at IS NULL
                 ORDER BY m.created_at DESC, m.id DESC LIMIT ?`
              )
              .all(conversationId, take),
      (row) => ({ createdAt: row.created_at, id: row.id })
    );
    return { items: items.map((r) => this.toPublic(r)), nextCursor };
  },
};

/* -------------------------------- settings ------------------------------- */

const settings = {
  get(db, userId) {
    const row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId);
    if (!row) throw notFound('Settings not found');
    return {
      locale: row.locale,
      theme: row.theme,
      isPrivate: Boolean(row.is_private),
      allowMessagesFrom: row.allow_messages_from,
      updatedAt: row.updated_at,
    };
  },

  update(db, userId, fields) {
    const sets = [];
    const values = [];
    if (fields.locale !== undefined) {
      sets.push('locale = ?');
      values.push(fields.locale);
    }
    if (fields.theme !== undefined) {
      sets.push('theme = ?');
      values.push(fields.theme);
    }
    if (fields.isPrivate !== undefined) {
      sets.push('is_private = ?');
      values.push(fields.isPrivate ? 1 : 0);
    }
    if (fields.allowMessagesFrom !== undefined) {
      sets.push('allow_messages_from = ?');
      values.push(fields.allowMessagesFrom);
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      values.push(nowIso(), userId);
      db.prepare(`UPDATE user_settings SET ${sets.join(', ')} WHERE user_id = ?`).run(...values);
      // Privacy is mirrored onto the user row, which is what other services read.
      if (fields.isPrivate !== undefined) {
        db.prepare('UPDATE users SET is_private = ?, updated_at = ? WHERE id = ?').run(
          fields.isPrivate ? 1 : 0,
          nowIso(),
          userId
        );
      }
    }
    return this.get(db, userId);
  },
};

/* --------------------------------- feed ---------------------------------- */

const feed = {
  /**
   * Home feed: posts from accounts the viewer follows, plus their own.
   * Private accounts are only included when the follow is accepted, which
   * `follows.canView` already guarantees for the follow edge itself.
   */
  home(db, viewerId, { limit, cursor }) {
    const { items, nextCursor } = paginate(
      { limit, cursor },
      (take, cur) =>
        cur
          ? db
              .prepare(
                `SELECT p.*, u.username AS author_username,
                        (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
                        (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count
                 FROM posts p JOIN users u ON u.id = p.author_id
                 WHERE p.deleted_at IS NULL
                   AND (p.author_id = ? OR p.author_id IN (
                        SELECT followee_id FROM follows WHERE follower_id = ? AND state = 'accepted'))
                   AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))
                 ORDER BY p.created_at DESC, p.id DESC LIMIT ?`
              )
              .all(viewerId, viewerId, cur.createdAt, cur.createdAt, cur.id, take)
          : db
              .prepare(
                `SELECT p.*, u.username AS author_username,
                        (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
                        (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count
                 FROM posts p JOIN users u ON u.id = p.author_id
                 WHERE p.deleted_at IS NULL
                   AND (p.author_id = ? OR p.author_id IN (
                        SELECT followee_id FROM follows WHERE follower_id = ? AND state = 'accepted'))
                 ORDER BY p.created_at DESC, p.id DESC LIMIT ?`
              )
              .all(viewerId, viewerId, take),
      (row) => ({ createdAt: row.created_at, id: row.id })
    );
    return { items: items.map((r) => posts.toPublic(r, { viewerId })), nextCursor };
  },

  /** Public discovery: posts from public accounts only. */
  explore(db, viewerId, { limit, cursor }) {
    const { items, nextCursor } = paginate(
      { limit, cursor },
      (take, cur) =>
        cur
          ? db
              .prepare(
                `SELECT p.*, u.username AS author_username,
                        (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
                        (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count
                 FROM posts p JOIN users u ON u.id = p.author_id
                 WHERE p.deleted_at IS NULL AND u.is_private = 0
                   AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))
                 ORDER BY p.created_at DESC, p.id DESC LIMIT ?`
              )
              .all(cur.createdAt, cur.createdAt, cur.id, take)
          : db
              .prepare(
                `SELECT p.*, u.username AS author_username,
                        (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
                        (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count
                 FROM posts p JOIN users u ON u.id = p.author_id
                 WHERE p.deleted_at IS NULL AND u.is_private = 0
                 ORDER BY p.created_at DESC, p.id DESC LIMIT ?`
              )
              .all(take),
      (row) => ({ createdAt: row.created_at, id: row.id })
    );
    return { items: items.map((r) => posts.toPublic(r, { viewerId })), nextCursor };
  },
};


module.exports = { comments, follows, saved, notifications, stories, messages, settings, feed };
