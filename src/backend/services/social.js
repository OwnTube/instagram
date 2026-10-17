'use strict';

/**
 * Comments, follows, saved posts, notifications, stories, messaging and settings.
 *
 * All of these operate on data created in THIS application. None of them reads
 * or fabricates Instagram data. Every read that could expose another user's
 * private state is scoped by the requesting user's id.
 */

const { newId, nowIso, addMs, newPk } = require('../lib/ids');
const { notFound, forbidden, conflict, badRequest } = require('../lib/errors');
const { paginate } = require('../lib/pagination');
const posts = require('./posts');
const visibility = require('./visibility');

const COMMENT_SELECT = `SELECT c.*, u.username AS author_username, u.pk AS author_pk, u.avatar_url AS author_avatar_url,
       u.display_name AS author_display_name FROM comments c JOIN users u ON u.id = c.author_id`;

/* ------------------------------- comments -------------------------------- */

const comments = {
  toPublic(row) {
    return {
      id: row.id,
      pk: row.pk,
      postId: row.post_id,
      authorId: row.author_id,
      authorPk: row.author_pk ?? null,
      authorUsername: row.author_username ?? null,
      authorDisplayName: row.author_display_name ?? null,
      authorAvatarUrl: row.author_avatar_url ?? null,
      body: row.body,
      parentId: row.parent_id ?? null,
      createdAt: row.created_at,
    };
  },

  create(db, postId, authorId, { body, parentId }) {
    const post = visibility.requireVisiblePost(db, postId, authorId);
    if (post.comments_disabled) throw forbidden('Comments are turned off for this post');
    if (parentId) {
      const parent = db.prepare('SELECT post_id FROM comments WHERE id = ? AND deleted_at IS NULL').get(parentId);
      if (!parent) throw notFound('Parent comment not found');
      if (parent.post_id !== postId) throw badRequest('Parent comment belongs to a different post');
    }
    const id = newId('cmt');
    db.prepare(
      `INSERT INTO comments (id, pk, post_id, author_id, body, parent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, newPk(), postId, authorId, body, parentId ?? null, nowIso());
    visibility.notify(db, { userId: post.author_id, kind: 'comment', actorId: authorId, subjectType: 'comment', subjectId: id, body });
    return this.get(db, id);
  },

  get(db, id) {
    const row = db
      .prepare(`${COMMENT_SELECT} WHERE c.id = ? AND c.deleted_at IS NULL`)
      .get(id);
    if (!row) throw notFound('Comment not found');
    return this.toPublic(row);
  },

  resolveId(db, ref) {
    const row =
      db.prepare('SELECT id FROM comments WHERE pk = ? AND deleted_at IS NULL').get(String(ref)) ||
      db.prepare('SELECT id FROM comments WHERE id = ? AND deleted_at IS NULL').get(String(ref));
    return row ? row.id : null;
  },

  list(db, postId, { limit, cursor }, viewerId = null) {
    visibility.requireVisiblePost(db, postId, viewerId);
    const { items, nextCursor } = paginate(
      { limit, cursor },
      (take, cur) =>
        cur
          ? db
              .prepare(
                `${COMMENT_SELECT}
                 WHERE c.post_id = ? AND c.deleted_at IS NULL
                   AND (c.created_at < ? OR (c.created_at = ? AND c.id < ?))
                 ORDER BY c.created_at DESC, c.id DESC LIMIT ?`
              )
              .all(postId, cur.createdAt, cur.createdAt, cur.id, take)
          : db
              .prepare(
                `${COMMENT_SELECT}
                 WHERE c.post_id = ? AND c.deleted_at IS NULL
                 ORDER BY c.created_at DESC, c.id DESC LIMIT ?`
              )
              .all(postId, take),
      (row) => ({ createdAt: row.created_at, id: row.id })
    );
    return { items: items.map((r) => this.toPublic(r)), nextCursor };
  },

  /** The comment's author or the post's author may delete it. */
  remove(db, id, userId) {
    const row = db
      .prepare(
        `SELECT c.author_id, p.author_id AS post_author_id FROM comments c JOIN posts p ON p.id = c.post_id
         WHERE c.id = ? AND c.deleted_at IS NULL`
      )
      .get(id);
    if (!row) throw notFound('Comment not found');
    if (row.author_id !== userId && row.post_author_id !== userId) throw forbidden('You do not own this comment');
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
    notifications.create(db, {
      userId: followeeId,
      kind: state === 'accepted' ? 'follow' : 'follow_request',
      actorId: followerId,
      subjectType: 'user',
      subjectId: followerId,
      body: state === 'accepted' ? 'started following you' : 'requested to follow you',
    });
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
    return visibility.canView(db, viewerId, targetId);
  },

  /** Relationship flags between two users, from the viewer's side. */
  status(db, viewerId, targetId) {
    if (!viewerId) return { following: false, followedBy: false, outgoingRequest: false, incomingRequest: false };
    const out = db.prepare('SELECT state FROM follows WHERE follower_id = ? AND followee_id = ?').get(viewerId, targetId);
    const inc = db.prepare('SELECT state FROM follows WHERE follower_id = ? AND followee_id = ?').get(targetId, viewerId);
    return {
      following: out?.state === 'accepted',
      outgoingRequest: out?.state === 'pending',
      followedBy: inc?.state === 'accepted',
      incomingRequest: inc?.state === 'pending',
    };
  },

  counts(db, userId) {
    return {
      followers: db.prepare("SELECT COUNT(*) AS n FROM follows WHERE followee_id = ? AND state = 'accepted'").get(userId).n,
      following: db.prepare("SELECT COUNT(*) AS n FROM follows WHERE follower_id = ? AND state = 'accepted'").get(userId).n,
    };
  },
};

/* ------------------------------ saved posts ------------------------------ */

const saved = {
  save(db, userId, postId, collectionId) {
    visibility.requireVisiblePost(db, postId, userId);
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
                `SELECT s.created_at AS saved_at, s.collection_id, p.*, u.username AS author_username, u.pk AS author_pk,
                        m.width AS media_width, m.height AS media_height,
                        (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
                        (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count
                 FROM saved_posts s JOIN posts p ON p.id = s.post_id JOIN users u ON u.id = p.author_id
                 LEFT JOIN media m ON m.id = p.media_id
                 WHERE s.user_id = ? AND p.deleted_at IS NULL AND ${visibility.visibleAuthorSql('p.author_id', 'u')}
                   AND (? IS NULL OR s.collection_id = ?)
                   AND (s.created_at < ? OR (s.created_at = ? AND s.post_id < ?))
                 ORDER BY s.created_at DESC, s.post_id DESC LIMIT ?`
              )
              .all(userId, userId, userId, collectionId, collectionId, cur.createdAt, cur.createdAt, cur.id, take)
          : db
              .prepare(
                `SELECT s.created_at AS saved_at, s.collection_id, p.*, u.username AS author_username, u.pk AS author_pk,
                        m.width AS media_width, m.height AS media_height,
                        (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
                        (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count
                 FROM saved_posts s JOIN posts p ON p.id = s.post_id JOIN users u ON u.id = p.author_id
                 LEFT JOIN media m ON m.id = p.media_id
                 WHERE s.user_id = ? AND p.deleted_at IS NULL AND ${visibility.visibleAuthorSql('p.author_id', 'u')}
                   AND (? IS NULL OR s.collection_id = ?)
                 ORDER BY s.created_at DESC, s.post_id DESC LIMIT ?`
              )
              .all(userId, userId, userId, collectionId, collectionId, take),
      (row) => ({ createdAt: row.saved_at, id: row.id })
    );
    return {
      items: items.map((r) => ({ ...posts.toPublic(r, { viewerId: userId, ...posts.viewerFlags(db, userId, r.id) }), savedAt: r.saved_at, collectionId: r.collection_id ?? null })),
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
      actorPk: row.actor_pk ?? null,
      actorAvatarUrl: row.actor_avatar_url ?? null,
      subjectType: row.subject_type ?? null,
      subjectId: row.subject_id ?? null,
      body: row.body ?? null,
      read: Boolean(row.read_at),
      createdAt: row.created_at,
    };
  },

  create(db, fields) {
    return visibility.notify(db, fields);
  },

  list(db, userId, { limit, cursor }, { unreadOnly = false } = {}) {
    const { items, nextCursor } = paginate(
      { limit, cursor },
      (take, cur) =>
        cur
          ? db
              .prepare(
                `SELECT n.*, u.username AS actor_username, u.pk AS actor_pk, u.avatar_url AS actor_avatar_url FROM notifications n
                 LEFT JOIN users u ON u.id = n.actor_id
                 WHERE n.user_id = ? ${unreadOnly ? 'AND n.read_at IS NULL' : ''}
                   AND (n.created_at < ? OR (n.created_at = ? AND n.id < ?))
                 ORDER BY n.created_at DESC, n.id DESC LIMIT ?`
              )
              .all(userId, cur.createdAt, cur.createdAt, cur.id, take)
          : db
              .prepare(
                `SELECT n.*, u.username AS actor_username, u.pk AS actor_pk, u.avatar_url AS actor_avatar_url FROM notifications n
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

const STORY_SELECT = `SELECT s.*, u.username AS author_username, u.pk AS author_pk, u.avatar_url AS author_avatar_url,
       m.width AS media_width, m.height AS media_height
  FROM stories s JOIN users u ON u.id = s.author_id LEFT JOIN media m ON m.id = s.media_id`;

const stories = {
  toPublic(row, viewerId = null, db = null) {
    return {
      id: row.id,
      pk: row.pk,
      authorId: row.author_id,
      authorPk: row.author_pk ?? null,
      authorUsername: row.author_username ?? null,
      authorAvatarUrl: row.author_avatar_url ?? null,
      mediaUrl: row.media_url ?? null,
      mediaWidth: row.media_width ?? null,
      mediaHeight: row.media_height ?? null,
      caption: row.caption ?? null,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      expired: Date.parse(row.expires_at) <= Date.now(),
      seenByViewer:
        viewerId && db ? Boolean(db.prepare('SELECT 1 FROM story_views WHERE story_id = ? AND viewer_id = ?').get(row.id, viewerId)) : false,
      likedByViewer:
        viewerId && db ? Boolean(db.prepare('SELECT 1 FROM story_likes WHERE story_id = ? AND user_id = ?').get(row.id, viewerId)) : false,
    };
  },

  /** Like or unlike a story the viewer can see (idempotent). */
  setLike(db, storyId, viewerId, liked) {
    const story = this.get(db, storyId, viewerId);
    if (liked) db.prepare('INSERT OR IGNORE INTO story_likes (story_id, user_id, created_at) VALUES (?, ?, ?)').run(story.id, viewerId, nowIso());
    else db.prepare('DELETE FROM story_likes WHERE story_id = ? AND user_id = ?').run(story.id, viewerId);
    return { ...story, likedByViewer: liked };
  },

  create(db, authorId, { mediaUrl, caption, ttlMs = 24 * 60 * 60 * 1000, mediaId }) {
    const id = newId('story');
    const now = nowIso();
    db.prepare(
      'INSERT INTO stories (id, pk, author_id, media_url, media_id, caption, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, newPk(), authorId, mediaUrl ?? null, mediaId ?? null, caption ?? null, now, addMs(ttlMs));
    return this.get(db, id, authorId);
  },

  get(db, id, viewerId = null) {
    const row = db.prepare(`${STORY_SELECT} WHERE s.id = ? OR s.pk = ?`).get(id, id);
    if (!row || !visibility.canView(db, viewerId, row.author_id)) throw notFound('Story not found');
    return this.toPublic(row, viewerId, db);
  },

  /** Active (unexpired) stories by an author, oldest first as a reel plays them. */
  listActiveByAuthor(db, authorId, viewerId = null) {
    if (!visibility.canView(db, viewerId, authorId)) return [];
    const rows = db.prepare(`${STORY_SELECT} WHERE s.author_id = ? AND s.expires_at > ? ORDER BY s.created_at ASC`).all(authorId, nowIso());
    return rows.map((r) => this.toPublic(r, viewerId, db));
  },

  /** The author's own stories, active or expired, newest first (the story archive). */
  listArchive(db, authorId) {
    const rows = db.prepare(`${STORY_SELECT} WHERE s.author_id = ? ORDER BY s.created_at DESC`).all(authorId);
    return rows.map((r) => this.toPublic(r, authorId, db));
  },

  /** Authors with active stories the viewer may see: the viewer and accepted followees. */
  tray(db, viewerId) {
    const rows = db
      .prepare(
        `SELECT s.author_id, MAX(s.created_at) AS latest,
           EXISTS (SELECT 1 FROM relationship_lists m WHERE m.owner_id = ? AND m.list = 'muted_stories' AND m.target_id = s.author_id) AS muted
         FROM stories s
         WHERE s.expires_at > ? AND (s.author_id = ? OR s.author_id IN (
           SELECT followee_id FROM follows WHERE follower_id = ? AND state = 'accepted'))
         GROUP BY s.author_id ORDER BY (s.author_id = ?) DESC, muted ASC, latest DESC`
      )
      .all(viewerId, nowIso(), viewerId, viewerId, viewerId);
    // Muted accounts' stories stay in the tray, after all the others.
    return rows.map((r) => ({ authorId: r.author_id, muted: Boolean(r.muted), items: this.listActiveByAuthor(db, r.author_id, viewerId) }));
  },

  markSeen(db, storyId, viewerId) {
    const story = this.get(db, storyId, viewerId);
    db.prepare('INSERT OR IGNORE INTO story_views (story_id, viewer_id, seen_at) VALUES (?, ?, ?)').run(story.id, viewerId, nowIso());
    return { id: story.id, seen: true };
  },

  /** Viewers of a story; only its author may list them. */
  viewers(db, storyId, userId) {
    const row = db.prepare('SELECT id, author_id FROM stories WHERE id = ? OR pk = ?').get(storyId, storyId);
    if (!row) throw notFound('Story not found');
    if (row.author_id !== userId) throw forbidden('Only the author can see who viewed a story');
    return db
      .prepare(
        `SELECT u.id, u.pk, u.username, u.display_name, u.avatar_url, v.seen_at FROM story_views v
         JOIN users u ON u.id = v.viewer_id WHERE v.story_id = ? ORDER BY v.seen_at DESC`
      )
      .all(row.id);
  },

  remove(db, id, userId) {
    const row = db.prepare('SELECT id, author_id FROM stories WHERE id = ? OR pk = ?').get(id, id);
    if (!row) throw notFound('Story not found');
    if (row.author_id !== userId) throw forbidden('You do not own this story');
    db.prepare('DELETE FROM stories WHERE id = ?').run(row.id);
    return { id: row.id, deleted: true };
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
      pk: row.pk,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      senderPk: row.sender_pk ?? null,
      senderUsername: row.sender_username ?? null,
      body: row.body,
      clientContext: row.client_context ?? null,
      createdAt: row.created_at,
    };
  },

  /**
   * Whether `senderId` may start a conversation with `recipientId`, per the
   * recipient's allow_messages_from setting: everyone, people the recipient
   * follows, or nobody.
   */
  assertCanMessage(db, senderId, recipientId) {
    const row = db.prepare('SELECT allow_messages_from FROM user_settings WHERE user_id = ?').get(recipientId);
    const policy = row ? row.allow_messages_from : 'everyone';
    if (policy === 'everyone') return;
    if (policy === 'following') {
      const follows = db
        .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ? AND state = 'accepted'")
        .get(recipientId, senderId);
      if (follows) return;
    }
    throw forbidden('This user does not accept messages from you');
  },

  /** Create a conversation with exactly the given members (at least two). */
  createConversation(db, creatorId, memberIds) {
    const members = [...new Set([creatorId, ...memberIds])];
    if (members.length < 2) throw badRequest('A conversation needs at least two members');
    for (const id of members) {
      if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw notFound(`Unknown user: ${id}`);
      if (id !== creatorId) this.assertCanMessage(db, creatorId, id);
    }
    const id = newId('conv');
    const now = nowIso();
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO conversations (id, pk, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, newPk(), now, now);
      const stmt = db.prepare('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)');
      for (const member of members) stmt.run(id, member, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { id, memberIds: members, createdAt: now };
  },

  /** The existing two-person conversation between a and b, or a new one. */
  findOrCreateDirect(db, creatorId, otherId) {
    const row = db
      .prepare(
        `SELECT c.id FROM conversations c
         WHERE (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id) = 2
           AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = ?)
           AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = ?)
         ORDER BY c.created_at ASC LIMIT 1`
      )
      .get(creatorId, otherId);
    if (row) return { id: row.id, created: false };
    return { id: this.createConversation(db, creatorId, [otherId]).id, created: true };
  },

  resolveConversation(db, ref) {
    const row = db.prepare('SELECT id FROM conversations WHERE id = ? OR pk = ?').get(String(ref), String(ref));
    return row ? row.id : null;
  },

  requireMembership(db, conversationId, userId) {
    const row = db
      .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .get(conversationId, userId);
    if (!row) throw forbidden('You are not a member of this conversation');
    return true;
  },

  members(db, conversationId) {
    return db
      .prepare(
        `SELECT u.id, u.pk, u.username, u.display_name, u.avatar_url, u.is_private, m.last_seen_at FROM conversation_members m
         JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ? ORDER BY m.joined_at ASC`
      )
      .all(conversationId);
  },

  /** Send a message. A repeated client_context from the same sender returns the original message. */
  send(db, conversationId, senderId, body, { clientContext } = {}) {
    this.requireMembership(db, conversationId, senderId);
    if (clientContext) {
      const existing = db.prepare('SELECT id FROM messages WHERE sender_id = ? AND client_context = ?').get(senderId, clientContext);
      if (existing) return this.get(db, existing.id, senderId);
    }
    const id = newId('msg');
    const now = nowIso();
    db.exec('BEGIN');
    try {
      db.prepare(
        'INSERT INTO messages (id, pk, conversation_id, sender_id, body, client_context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(id, newPk(), conversationId, senderId, body, clientContext ?? null, now);
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
      db.prepare('UPDATE conversation_members SET last_seen_at = ? WHERE conversation_id = ? AND user_id = ?').run(now, conversationId, senderId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return this.get(db, id, senderId);
  },

  markSeen(db, conversationId, userId) {
    this.requireMembership(db, conversationId, userId);
    db.prepare('UPDATE conversation_members SET last_seen_at = ? WHERE conversation_id = ? AND user_id = ?').run(nowIso(), conversationId, userId);
    return { conversationId, seen: true };
  },

  unseenCount(db, userId) {
    return db
      .prepare(
        `SELECT COUNT(DISTINCT m.conversation_id) AS n FROM conversation_members cm
         JOIN messages m ON m.conversation_id = cm.conversation_id
         WHERE cm.user_id = ? AND m.sender_id != ? AND m.deleted_at IS NULL
           AND (cm.last_seen_at IS NULL OR m.created_at > cm.last_seen_at)`
      )
      .get(userId, userId).n;
  },

  get(db, id, viewerId) {
    const row = db
      .prepare(
        `SELECT m.*, u.username AS sender_username, u.pk AS sender_pk FROM messages m JOIN users u ON u.id = m.sender_id
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
        `SELECT c.id, c.pk, c.updated_at, m.last_seen_at,
                (SELECT COUNT(*) FROM conversation_members cm WHERE cm.conversation_id = c.id) AS member_count
         FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
         WHERE m.user_id = ? ORDER BY c.updated_at DESC`
      )
      .all(userId);
    return rows.map((r) => ({ id: r.id, pk: r.pk, updatedAt: r.updated_at, lastSeenAt: r.last_seen_at ?? null, memberCount: r.member_count }));
  },

  listMessages(db, conversationId, userId, { limit, cursor }) {
    this.requireMembership(db, conversationId, userId);
    const select = `SELECT m.*, u.username AS sender_username, u.pk AS sender_pk FROM messages m JOIN users u ON u.id = m.sender_id`;
    const { items, nextCursor } = paginate(
      { limit, cursor },
      (take, cur) =>
        cur
          ? db
              .prepare(
                `${select} WHERE m.conversation_id = ? AND m.deleted_at IS NULL
                   AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))
                 ORDER BY m.created_at DESC, m.id DESC LIMIT ?`
              )
              .all(conversationId, cur.createdAt, cur.createdAt, cur.id, take)
          : db
              .prepare(`${select} WHERE m.conversation_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at DESC, m.id DESC LIMIT ?`)
              .all(conversationId, take),
      (row) => ({ createdAt: row.created_at, id: row.id })
    );
    return { items: items.map((r) => this.toPublic(r)), nextCursor };
  },

  /** Unsend: only the sender may delete their own message. */
  remove(db, messageId, userId) {
    const row = db.prepare('SELECT id, sender_id FROM messages WHERE (id = ? OR pk = ?) AND deleted_at IS NULL').get(messageId, messageId);
    if (!row) throw notFound('Message not found');
    if (row.sender_id !== userId) throw forbidden('You can only unsend your own messages');
    db.prepare('UPDATE messages SET deleted_at = ? WHERE id = ?').run(nowIso(), row.id);
    return { id: row.id, deleted: true };
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
   * Home feed: the viewer's own posts and those of accounts they follow
   * (accepted), except accounts whose posts the viewer muted.
   */
  home(db, viewerId, { limit, cursor }) {
    const where = `p.deleted_at IS NULL AND (p.author_id = ? OR p.author_id IN (
                     SELECT followee_id FROM follows WHERE follower_id = ? AND state = 'accepted'))
                   AND p.author_id NOT IN (SELECT target_id FROM relationship_lists WHERE owner_id = ? AND list = 'muted_posts')`;
    const { items, nextCursor } = paginate(
      { limit, cursor },
      (take, cur) =>
        cur
          ? db
              .prepare(
                `${posts.POST_SELECT} WHERE ${where} AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))
                 ORDER BY p.created_at DESC, p.id DESC LIMIT ?`
              )
              .all(viewerId, viewerId, viewerId, cur.createdAt, cur.createdAt, cur.id, take)
          : db.prepare(`${posts.POST_SELECT} WHERE ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`).all(viewerId, viewerId, viewerId, take),
      (row) => ({ createdAt: row.created_at, id: row.id })
    );
    return { items: items.map((r) => posts.toPublic(r, { viewerId, ...posts.viewerFlags(db, viewerId, r.id) })), nextCursor };
  },

  /** Public discovery: posts from public accounts only. */
  explore(db, viewerId, { limit, cursor }) {
    const { items, nextCursor } = paginate(
      { limit, cursor },
      (take, cur) =>
        cur
          ? db
              .prepare(
                `${posts.POST_SELECT} WHERE p.deleted_at IS NULL AND u.is_private = 0
                   AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))
                 ORDER BY p.created_at DESC, p.id DESC LIMIT ?`
              )
              .all(cur.createdAt, cur.createdAt, cur.id, take)
          : db.prepare(`${posts.POST_SELECT} WHERE p.deleted_at IS NULL AND u.is_private = 0 ORDER BY p.created_at DESC, p.id DESC LIMIT ?`).all(take),
      (row) => ({ createdAt: row.created_at, id: row.id })
    );
    return { items: items.map((r) => posts.toPublic(r, { viewerId, ...posts.viewerFlags(db, viewerId, r.id) })), nextCursor };
  },
};

/* -------------------------------- search --------------------------------- */

const search = {
  /** Users whose username or display name starts with or contains the query. */
  users(db, query, { limit = 20 } = {}) {
    const q = String(query || '').trim().toLowerCase().replace(/^@/, '');
    if (!q) return [];
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const prefix = `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return db
      .prepare(
        `SELECT id, pk, username, display_name, avatar_url, is_private FROM users
         WHERE status = 'active' AND (username_ci LIKE ? ESCAPE '\\' OR LOWER(COALESCE(display_name, '')) LIKE ? ESCAPE '\\')
         ORDER BY (username_ci LIKE ? ESCAPE '\\') DESC, username_ci ASC LIMIT ?`
      )
      .all(like, like, prefix, limit);
  },
};

module.exports = { comments, follows, saved, notifications, stories, messages, settings, feed, search };
