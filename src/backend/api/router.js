'use strict';

/**
 * API v1 router.
 *
 * Mounted under backend.prefix (default /__backend) by src/backend/index.js. It
 * is registered BEFORE the loader's catch-all document handler, so these paths
 * resolve here while everything else keeps flowing to Instagram.
 *
 * Every response uses the envelope from lib/errors.js. Every mutating route
 * requires authentication and is subject to the CSRF check when the session
 * arrived by cookie.
 */

const express = require('express');

const backend = require('../config');
const v = require('../lib/validate');
const { asyncHandler } = require('../lib/async');
const { ok, created, noContent, notFound, badRequest } = require('../lib/errors');
const { requireAuth } = require('../lib/auth');
const { auth: authLimiter, general: generalLimiter, middleware: limit } = require('../lib/ratelimit');

const users = require('../services/users');
const sessions = require('../services/sessions');
const posts = require('../services/posts');
const { comments, follows, saved, notifications, stories, messages, settings, feed } = require('../services/social');
const {
  setSessionCookie,
  clearSessionCookie,
  setCsrfCookie,
  clearCsrfCookie,
} = require('../lib/cookies');

function createRouter(db) {
  const router = express.Router();

  router.use(limit(generalLimiter));

  /* --------------------------------- meta -------------------------------- */

  router.get('/health', (req, res) =>
    ok(res, {
      ok: true,
      service: 'backend',
      version: 'v1',
      time: new Date().toISOString(),
    })
  );

  router.get('/readiness', (req, res) => {
    // Confirms the database answers a trivial query; no secrets are exposed.
    const row = db.prepare('SELECT COUNT(*) AS n FROM users').get();
    ok(res, { ready: true, users: row.n, migrations: db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n });
  });

  /* --------------------------------- auth -------------------------------- */

  router.post(
    '/auth/register',
    limit(authLimiter),
    asyncHandler(async (req, res) => {
      const body = v.asObject(req.body);
      const user = await users.createUserAsync(db, {
        username: v.username(body.username),
        email: body.email ? v.email(body.email) : undefined,
        password: v.password(body.password),
        displayName: v.optionalStr(body.displayName, 'displayName', { max: 100 }),
      });
      const session = sessions.createSession(db, { userId: user.id, userAgent: req.get('user-agent') });
      setSessionCookie(res, session.token);
      setCsrfCookie(res, session.csrfSecret);
      return created(res, {
        user: users.toPublic(user),
        token: session.token,
        csrfToken: session.csrfSecret,
        expiresAt: session.expiresAt,
      });
    })
  );

  router.post(
    '/auth/login',
    limit(authLimiter),
    asyncHandler(async (req, res) => {
      const body = v.asObject(req.body);
      const user = await users.authenticate(db, {
        username: v.str(body.username, 'username', { min: 1, max: 254 }),
        password: v.str(body.password, 'password', { min: 1, max: 200 }),
      });
      const session = sessions.createSession(db, { userId: user.id, userAgent: req.get('user-agent') });
      setSessionCookie(res, session.token);
      setCsrfCookie(res, session.csrfSecret);
      return ok(res, {
        user: users.toPublic(user),
        token: session.token,
        csrfToken: session.csrfSecret,
        expiresAt: session.expiresAt,
      });
    })
  );

  router.post('/auth/logout', requireAuth, (req, res) => {
    sessions.revoke(db, req.session.id);
    clearSessionCookie(res);
    clearCsrfCookie(res);
    return noContent(res);
  });

  router.get('/auth/session', (req, res) =>
    ok(res, {
      authenticated: Boolean(req.user),
      user: req.user ? users.toPublic(req.user) : null,
      expiresAt: req.session ? req.session.expires_at : null,
      csrfToken: req.session ? req.session.csrf_secret : null,
      // Restated on every session read so no client can mistake this for
      // Instagram authorization.
      upstream: { authenticatedToInstagram: false },
    })
  );

  /** Rotate the bearer token for the current session. */
  router.post('/auth/session/rotate', requireAuth, (req, res) => {
    const token = sessions.rotate(db, req.session.id);
    if (!token) return res.status(401).json({ error: { code: 'unauthorized', message: 'Session is no longer active' } });
    setSessionCookie(res, token);
    return ok(res, { token, rotatedAt: new Date().toISOString() });
  });

  router.get('/auth/sessions', requireAuth, (req, res) =>
    ok(
      res,
      sessions.listForUser(db, req.user.id).map((s) => ({
        id: s.id,
        userAgent: s.user_agent,
        createdAt: s.created_at,
        lastSeenAt: s.last_seen_at,
        expiresAt: s.expires_at,
        revoked: Boolean(s.revoked_at),
        current: s.id === req.session.id,
      }))
    )
  );

  router.delete('/auth/sessions/:id', requireAuth, (req, res) => {
    const rows = sessions.listForUser(db, req.user.id);
    const target = rows.find((s) => s.id === req.params.id);
    if (!target) throw notFound('Session not found');
    sessions.revoke(db, target.id);
    return noContent(res);
  });

  router.post('/auth/sessions/revoke-all', requireAuth, (req, res) => {
    const count = sessions.revokeAllForUser(db, req.user.id);
    clearSessionCookie(res);
    clearCsrfCookie(res);
    return ok(res, { revoked: count });
  });

  /* -------------------------------- users -------------------------------- */

  router.get('/users/me', requireAuth, (req, res) =>
    ok(res, { ...users.toPublic(req.user), upstream: users.getUpstreamIdentity(db, req.user.id) })
  );

  router.patch(
    '/users/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      const body = v.asObject(req.body);
      const updated = users.updateProfile(db, req.user.id, {
        displayName: v.optionalStr(body.displayName, 'displayName', { max: 100 }),
        bio: v.optionalStr(body.bio, 'bio', { max: 500 }),
        avatarUrl: v.optionalStr(body.avatarUrl, 'avatarUrl', { max: 2000 }),
        isPrivate: body.isPrivate === undefined ? undefined : v.bool(body.isPrivate, 'isPrivate'),
      });
      return ok(res, users.toPublic(updated));
    })
  );

  router.get('/users/:id', (req, res) => {
    const target = users.getById(db, req.params.id);
    if (!target) throw notFound('User not found');
    const publicUser = users.toPublic(target);
    // A private account's profile is only returned to a viewer who follows it.
    if (target.is_private && !follows.canView(db, req.user?.id, target.id)) {
      return ok(res, { ...publicUser, bio: null, restricted: true });
    }
    return ok(res, publicUser);
  });

  router.get(
    '/users/:id/posts',
    asyncHandler(async (req, res) => {
      const target = users.getById(db, req.params.id);
      if (!target) throw notFound('User not found');
      if (target.is_private && !follows.canView(db, req.user?.id, target.id)) {
        return ok(res, { items: [], nextCursor: null, restricted: true });
      }
      const { limit, cursor } = v.pagination(req.query);
      const page = posts.listByAuthor(db, target.id, { limit, cursor }, { viewerId: req.user?.id });
      return ok(res, page.items, { nextCursor: page.nextCursor });
    })
  );

  router.put(
    '/users/me/upstream-identity',
    requireAuth,
    asyncHandler(async (req, res) => {
      const body = v.asObject(req.body);
      const identity = users.setUpstreamIdentity(
        db,
        req.user.id,
        v.str(body.instagramUsername, 'instagramUsername', { min: 1, max: 30, pattern: /^[a-zA-Z0-9._]+$/ }),
        v.optionalStr(body.note, 'note', { max: 200 })
      );
      return ok(res, identity);
    })
  );

  router.get('/users/me/upstream-identity', requireAuth, (req, res) =>
    ok(res, users.getUpstreamIdentity(db, req.user.id) || { linkState: 'unlinked', authenticatedToInstagram: false })
  );

  /* -------------------------------- posts -------------------------------- */

  router.post(
    '/posts',
    requireAuth,
    asyncHandler(async (req, res) => {
      const body = v.asObject(req.body);
      posts.assertMediaType(body.mediaType);
      const post = posts.create(db, req.user.id, {
        caption: v.optionalStr(body.caption, 'caption', { max: 2200 }),
        mediaUrl: v.optionalStr(body.mediaUrl, 'mediaUrl', { max: 2000 }),
        mediaType: body.mediaType,
        location: v.optionalStr(body.location, 'location', { max: 200 }),
      });
      return created(res, post);
    })
  );

  router.get('/posts/:id', (req, res) => ok(res, posts.get(db, req.params.id, { viewerId: req.user?.id })));

  router.patch(
    '/posts/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
      const body = v.asObject(req.body);
      const post = posts.update(db, req.params.id, req.user.id, {
        caption: body.caption === undefined ? undefined : v.optionalStr(body.caption, 'caption', { max: 2200 }),
        location: body.location === undefined ? undefined : v.optionalStr(body.location, 'location', { max: 200 }),
        mediaUrl: body.mediaUrl === undefined ? undefined : v.optionalStr(body.mediaUrl, 'mediaUrl', { max: 2000 }),
      });
      return ok(res, post);
    })
  );

  router.delete('/posts/:id', requireAuth, (req, res) => {
    posts.remove(db, req.params.id, req.user.id);
    return noContent(res);
  });

  router.post('/posts/:id/likes', requireAuth, (req, res) =>
    ok(res, posts.setLike(db, req.params.id, req.user.id, true))
  );

  router.delete('/posts/:id/likes', requireAuth, (req, res) =>
    ok(res, posts.setLike(db, req.params.id, req.user.id, false))
  );

  /* ------------------------------- comments ------------------------------ */

  router.post(
    '/posts/:id/comments',
    requireAuth,
    asyncHandler(async (req, res) => {
      const body = v.asObject(req.body);
      const comment = comments.create(db, req.params.id, req.user.id, {
        body: v.str(body.body, 'body', { min: 1, max: 2200 }),
        parentId: v.optionalStr(body.parentId, 'parentId', { max: 64 }),
      });
      return created(res, comment);
    })
  );

  router.get('/posts/:id/comments', (req, res) => {
    const { limit, cursor } = v.pagination(req.query);
    const page = comments.list(db, req.params.id, { limit, cursor }, req.user?.id ?? null);
    return ok(res, page.items, { nextCursor: page.nextCursor });
  });

  router.delete('/comments/:id', requireAuth, (req, res) => {
    comments.remove(db, req.params.id, req.user.id);
    return noContent(res);
  });

  /* ------------------------------- follows ------------------------------- */

  router.post(
    '/users/:id/follow',
    requireAuth,
    asyncHandler(async (req, res) => ok(res, follows.follow(db, req.user.id, req.params.id)))
  );

  router.delete('/users/:id/follow', requireAuth, (req, res) =>
    ok(res, follows.unfollow(db, req.user.id, req.params.id))
  );

  router.get('/users/me/followers', requireAuth, (req, res) => {
    const { limit, cursor } = v.pagination(req.query);
    const page = follows.listFollowers(db, req.user.id, { limit, cursor });
    return ok(res, page.items, { nextCursor: page.nextCursor });
  });

  router.get('/users/me/following', requireAuth, (req, res) => {
    const { limit, cursor } = v.pagination(req.query);
    const page = follows.listFollowing(db, req.user.id, { limit, cursor });
    return ok(res, page.items, { nextCursor: page.nextCursor });
  });

  router.get('/users/me/follow-requests', requireAuth, (req, res) => {
    const { limit, cursor } = v.pagination(req.query);
    const page = follows.listPending(db, req.user.id, { limit, cursor });
    return ok(res, page.items, { nextCursor: page.nextCursor });
  });

  router.post(
    '/users/:id/follow/accept',
    requireAuth,
    asyncHandler(async (req, res) => ok(res, follows.accept(db, req.user.id, req.params.id)))
  );

  router.post(
    '/users/:id/follow/reject',
    requireAuth,
    asyncHandler(async (req, res) => ok(res, follows.reject(db, req.user.id, req.params.id)))
  );

  /* --------------------------------- saved ------------------------------- */

  router.get('/users/me/saved', requireAuth, (req, res) => {
    const { limit, cursor } = v.pagination(req.query);
    const page = saved.list(db, req.user.id, { limit, cursor }, req.query.collectionId || null);
    return ok(res, page.items, { nextCursor: page.nextCursor });
  });

  router.put(
    '/users/me/saved/:postId',
    requireAuth,
    asyncHandler(async (req, res) => {
      const body = v.asObject(req.body || {});
      return ok(res, saved.save(db, req.user.id, req.params.postId, v.optionalStr(body.collectionId, 'collectionId', { max: 64 })));
    })
  );

  router.delete('/users/me/saved/:postId', requireAuth, (req, res) =>
    ok(res, saved.unsave(db, req.user.id, req.params.postId))
  );

  router.post(
    '/users/me/collections',
    requireAuth,
    asyncHandler(async (req, res) => {
      const body = v.asObject(req.body);
      return created(res, saved.createCollection(db, req.user.id, v.str(body.name, 'name', { min: 1, max: 100 })));
    })
  );

  router.get('/users/me/collections', requireAuth, (req, res) => ok(res, saved.listCollections(db, req.user.id)));

  /* ----------------------------- notifications --------------------------- */

  router.get('/users/me/notifications', requireAuth, (req, res) => {
    const { limit, cursor } = v.pagination(req.query);
    const page = notifications.list(db, req.user.id, { limit, cursor }, { unreadOnly: req.query.unread === 'true' });
    return ok(res, page.items, { nextCursor: page.nextCursor, unread: notifications.unreadCount(db, req.user.id) });
  });

  router.post('/notifications/:id/read', requireAuth, (req, res) =>
    ok(res, notifications.markRead(db, req.user.id, req.params.id))
  );

  router.post('/notifications/read-all', requireAuth, (req, res) =>
    ok(res, notifications.markAllRead(db, req.user.id))
  );

  /* -------------------------------- stories ------------------------------ */

  router.post(
    '/stories',
    requireAuth,
    asyncHandler(async (req, res) => {
      const body = v.asObject(req.body);
      const story = stories.create(db, req.user.id, {
        mediaUrl: v.optionalStr(body.mediaUrl, 'mediaUrl', { max: 2000 }),
        caption: v.optionalStr(body.caption, 'caption', { max: 500 }),
        ttlMs: body.ttlMs === undefined ? undefined : v.int(body.ttlMs, 'ttlMs', { min: 1000, max: 7 * 24 * 60 * 60 * 1000 }),
      });
      return created(res, story);
    })
  );

  router.get('/stories/:id', (req, res) => ok(res, stories.get(db, req.params.id, req.user?.id ?? null)));

  router.get(
    '/users/:id/stories',
    asyncHandler(async (req, res) => {
      const target = users.getById(db, req.params.id);
      if (!target) throw notFound('User not found');
      if (target.is_private && !follows.canView(db, req.user?.id, target.id)) {
        return ok(res, [], { restricted: true });
      }
      return ok(res, stories.listActiveByAuthor(db, target.id, req.user?.id ?? null));
    })
  );

  router.delete('/stories/:id', requireAuth, (req, res) => {
    stories.remove(db, req.params.id, req.user.id);
    return noContent(res);
  });

  /* ------------------------------- messaging ----------------------------- */

  router.get('/conversations', requireAuth, (req, res) => ok(res, messages.listConversations(db, req.user.id)));

  router.post(
    '/conversations',
    requireAuth,
    asyncHandler(async (req, res) => {
      const body = v.asObject(req.body);
      if (!Array.isArray(body.memberIds)) throw badRequest('"memberIds" must be an array', { field: 'memberIds' });
      const memberIds = body.memberIds.map((id) => v.str(id, 'memberIds[]', { min: 1, max: 64 }));
      return created(res, messages.createConversation(db, req.user.id, memberIds));
    })
  );

  router.get('/conversations/:id/messages', requireAuth, (req, res) => {
    const { limit, cursor } = v.pagination(req.query);
    const page = messages.listMessages(db, req.params.id, req.user.id, { limit, cursor });
    return ok(res, page.items, { nextCursor: page.nextCursor });
  });

  router.post(
    '/conversations/:id/messages',
    requireAuth,
    asyncHandler(async (req, res) => {
      const body = v.asObject(req.body);
      const message = messages.send(db, req.params.id, req.user.id, v.str(body.body, 'body', { min: 1, max: 5000 }));
      return created(res, message);
    })
  );

  /* ------------------------------- settings ------------------------------ */

  router.get('/users/me/settings', requireAuth, (req, res) => ok(res, settings.get(db, req.user.id)));

  router.patch(
    '/users/me/settings',
    requireAuth,
    asyncHandler(async (req, res) => {
      const body = v.asObject(req.body);
      const updated = settings.update(db, req.user.id, {
        locale: v.optionalStr(body.locale, 'locale', { max: 20 }),
        theme: body.theme === undefined ? undefined : v.oneOf(body.theme, 'theme', ['system', 'light', 'dark']),
        isPrivate: body.isPrivate === undefined ? undefined : v.bool(body.isPrivate, 'isPrivate'),
        allowMessagesFrom:
          body.allowMessagesFrom === undefined
            ? undefined
            : v.oneOf(body.allowMessagesFrom, 'allowMessagesFrom', ['everyone', 'following', 'none']),
      });
      return ok(res, updated);
    })
  );

  /* ---------------------------------- feed ------------------------------- */

  router.get('/feed', requireAuth, (req, res) => {
    const { limit, cursor } = v.pagination(req.query);
    const page = feed.home(db, req.user.id, { limit, cursor });
    return ok(res, page.items, { nextCursor: page.nextCursor });
  });

  router.get('/explore', (req, res) => {
    const { limit, cursor } = v.pagination(req.query);
    const page = feed.explore(db, req.user?.id, { limit, cursor });
    return ok(res, page.items, { nextCursor: page.nextCursor });
  });

  return router;
}

module.exports = { createRouter, prefix: backend.prefix };
