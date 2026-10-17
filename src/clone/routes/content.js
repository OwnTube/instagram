'use strict';

/**
 * Feed, profile, media, comment, like, save, follow, search and activity
 * endpoints of the original client, answered from our database.
 *
 * Paging uses the client's own parameters (`max_id` in, `next_max_id` and
 * `more_available` out); the cursor itself is our opaque keyset cursor.
 */

const users = require('../../backend/services/users');
const posts = require('../../backend/services/posts');
const { comments, follows, saved, notifications, feed, search } = require('../../backend/services/social');
const { badRequest, notFound } = require('../../backend/lib/errors');
const { isPk } = require('../../backend/lib/ids');
const { igOk } = require('../respond');
const present = require('../present');

function page(req, { fallback = 12, max = 50 } = {}) {
  const raw = req.params_.count ?? req.params_.first;
  const n = raw === undefined ? fallback : Number(raw);
  const limit = Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
  const cursor = req.params_.max_id || req.params_.after || undefined;
  return { limit, cursor: cursor ? String(cursor) : undefined };
}

function register(router, ctx) {
  const { db, requireViewer } = ctx;
  const viewerId = (req) => req.viewer?.id ?? null;

  /** Resolve a user from a pk path segment, or 404. */
  function userByPk(pk) {
    const row = isPk(String(pk)) ? users.getByPk(db, pk) : null;
    if (!row) throw notFound('User not found');
    return row;
  }

  /** Resolve a post id / media id / shortcode the viewer may see, or 404. */
  function postRef(ref, req) {
    const id = posts.resolveId(db, String(ref));
    if (!id) throw notFound('Media not found');
    return posts.get(db, id, { viewerId: viewerId(req) });
  }

  /* ---------------------------------- feed -------------------------------- */

  function timeline(req, res) {
    const result = feed.home(db, req.viewer.id, page(req));
    return igOk(res, {
      feed_items: result.items.map((p) => ({ media_or_ad: present.media(db, p, req.viewer.id) })),
      num_results: result.items.length,
      more_available: Boolean(result.nextCursor),
      next_max_id: result.nextCursor,
      auto_load_more_enabled: true,
      is_direct_v2_enabled: true,
    });
  }
  router.get('/api/v1/feed/timeline/', requireViewer, timeline);
  router.post('/api/v1/feed/timeline/', requireViewer, timeline);

  router.get('/api/v1/discover/web/explore_grid/', (req, res) => {
    const result = feed.explore(db, viewerId(req), page(req, { fallback: 24 }));
    return igOk(res, {
      items: result.items.map((p) => ({ media: present.media(db, p, viewerId(req)) })),
      more_available: Boolean(result.nextCursor),
      next_max_id: result.nextCursor,
    });
  });

  /* -------------------------------- profiles ------------------------------ */

  function profileGraph(row, req) {
    const info = present.userInfo(db, row, viewerId(req));
    const visible = follows.canView(db, viewerId(req), row.id);
    const recent = visible ? posts.listByAuthor(db, row.id, { limit: 12 }, { viewerId: viewerId(req) }) : { items: [], nextCursor: null };
    const fs = info.friendship_status || {};
    return {
      id: info.pk,
      fbid: null,
      username: info.username,
      full_name: info.full_name,
      biography: info.biography,
      external_url: info.external_url || null,
      is_private: info.is_private,
      is_verified: false,
      profile_pic_url: info.profile_pic_url,
      profile_pic_url_hd: info.profile_pic_url,
      edge_followed_by: { count: info.follower_count },
      edge_follow: { count: info.following_count },
      followed_by_viewer: Boolean(fs.following),
      follows_viewer: Boolean(fs.followed_by),
      requested_by_viewer: Boolean(fs.outgoing_request),
      has_requested_viewer: Boolean(fs.incoming_request),
      blocked_by_viewer: false,
      has_blocked_viewer: false,
      restricted_by_viewer: false,
      is_business_account: false,
      is_professional_account: false,
      highlight_reel_count: info.highlight_reel_count,
      edge_owner_to_timeline_media: {
        count: info.media_count,
        page_info: { has_next_page: Boolean(recent.nextCursor), end_cursor: recent.nextCursor },
        edges: recent.items.map((p) => ({
          node: {
            __typename: 'GraphImage',
            id: p.pk,
            shortcode: p.code,
            display_url: p.mediaUrl,
            thumbnail_src: p.mediaUrl,
            is_video: false,
            taken_at_timestamp: Math.floor(Date.parse(p.createdAt) / 1000),
            dimensions: { width: p.mediaWidth || 1080, height: p.mediaHeight || 1080 },
            edge_liked_by: { count: p.likeCount },
            edge_media_preview_like: { count: p.likeCount },
            edge_media_to_comment: { count: p.commentCount },
            edge_media_to_caption: { edges: p.caption ? [{ node: { text: p.caption } }] : [] },
            owner: { id: info.pk, username: info.username },
          },
        })),
      },
    };
  }

  router.get('/api/v1/users/web_profile_info/', (req, res) => {
    const row = users.getByUsername(db, String(req.params_.username || ''));
    if (!row) throw notFound('User not found');
    return igOk(res, { data: { user: profileGraph(row, req) } });
  });

  router.get('/api/v1/users/:pk/info/', (req, res) => igOk(res, { user: present.userInfo(db, userByPk(req.params.pk), viewerId(req)) }));
  router.get('/api/v1/users/:username/usernameinfo/', (req, res) => {
    const row = users.getByUsername(db, req.params.username);
    if (!row) throw notFound('User not found');
    return igOk(res, { user: present.userInfo(db, row, viewerId(req)) });
  });

  function userFeed(row, req, res) {
    const result = posts.listByAuthor(db, row.id, page(req), { viewerId: viewerId(req) });
    return igOk(res, {
      items: result.items.map((p) => present.media(db, p, viewerId(req))),
      num_results: result.items.length,
      more_available: Boolean(result.nextCursor),
      next_max_id: result.nextCursor,
      user: present.user(db, row, viewerId(req)),
    });
  }
  router.get('/api/v1/feed/user/:pk/', (req, res) => userFeed(userByPk(req.params.pk), req, res));
  router.get('/api/v1/feed/user/:username/username/', (req, res) => {
    const row = users.getByUsername(db, req.params.username);
    if (!row) throw notFound('User not found');
    return userFeed(row, req, res);
  });

  /* ---------------------------------- media ------------------------------- */

  router.get('/api/v1/media/:id/info/', (req, res) => {
    const post = postRef(req.params.id, req);
    return igOk(res, { items: [present.media(db, post, viewerId(req))], num_results: 1, more_available: false });
  });

  router.get('/api/v1/media/:id/comments/', (req, res) => {
    const post = postRef(req.params.id, req);
    const result = comments.list(db, post.id, page(req, { fallback: 20 }), viewerId(req));
    const mediaId = present.mediaId(post);
    return igOk(res, {
      comments: result.items.map((c) => present.comment(db, c, mediaId, viewerId(req))),
      comment_count: post.commentCount,
      caption: null,
      has_more_comments: Boolean(result.nextCursor),
      has_more_headload_comments: false,
      next_max_id: result.nextCursor,
      next_min_id: null,
      comment_likes_enabled: false,
    });
  });

  router.get('/api/v1/media/:id/likers/', (req, res) => {
    const post = postRef(req.params.id, req);
    const likers = posts.listLikers(db, post.id, viewerId(req));
    return igOk(res, { users: likers.map((u) => present.user(db, u, viewerId(req))), user_count: post.likeCount });
  });

  const like = (value) => (req, res) => {
    const post = postRef(req.params.id, req);
    posts.setLike(db, post.id, req.viewer.id, value);
    return igOk(res, {});
  };
  router.post('/api/v1/web/likes/:id/like/', requireViewer, like(true));
  router.post('/api/v1/web/likes/:id/unlike/', requireViewer, like(false));
  router.post('/api/v1/media/:id/like/', requireViewer, like(true));
  router.post('/api/v1/media/:id/unlike/', requireViewer, like(false));

  function addComment(req, res) {
    const post = postRef(req.params.id, req);
    const text = String(req.params_.comment_text ?? '').trim();
    if (!text) throw badRequest('Comment cannot be empty.');
    if (text.length > 2200) throw badRequest('Comment is too long.');
    const parentRef = req.params_.replied_to_comment_id;
    const parentId = parentRef ? comments.resolveId(db, parentRef) : undefined;
    if (parentRef && !parentId) throw notFound('Comment not found');
    const c = comments.create(db, post.id, req.viewer.id, { body: text, parentId });
    const shaped = present.comment(db, c, present.mediaId(post), req.viewer.id);
    return igOk(res, {
      ...shaped,
      comment: shaped,
      from: { id: shaped.user.pk, username: shaped.user.username, full_name: shaped.user.full_name, profile_picture: shaped.user.profile_pic_url },
      created_time: shaped.created_at,
    });
  }
  router.post('/api/v1/web/comments/:id/add/', requireViewer, addComment);
  router.post('/api/v1/media/:id/comment/', requireViewer, addComment);

  router.post('/api/v1/web/comments/:id/delete/:commentId/', requireViewer, (req, res) => {
    postRef(req.params.id, req);
    const id = comments.resolveId(db, req.params.commentId);
    if (!id) throw notFound('Comment not found');
    comments.remove(db, id, req.viewer.id);
    return igOk(res, {});
  });
  router.post('/api/v1/media/:id/comment/bulk_delete/', requireViewer, (req, res) => {
    postRef(req.params.id, req);
    const ids = String(req.params_.comment_ids_to_delete || '').split(',').filter(Boolean);
    if (!ids.length || ids.length > 25) throw badRequest('comment_ids_to_delete is required');
    for (const ref of ids) {
      const id = comments.resolveId(db, ref);
      if (!id) throw notFound('Comment not found');
      comments.remove(db, id, req.viewer.id);
    }
    return igOk(res, {});
  });

  const save = (value) => (req, res) => {
    const post = postRef(req.params.id, req);
    if (value) saved.save(db, req.viewer.id, post.id, null);
    else {
      try {
        saved.unsave(db, req.viewer.id, post.id);
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    return igOk(res, {});
  };
  router.post('/api/v1/web/save/:id/save/', requireViewer, save(true));
  router.post('/api/v1/web/save/:id/unsave/', requireViewer, save(false));
  router.post('/api/v1/media/:id/save/', requireViewer, save(true));
  router.post('/api/v1/media/:id/unsave/', requireViewer, save(false));

  router.get('/api/v1/feed/saved/posts/', requireViewer, (req, res) => {
    const result = saved.list(db, req.viewer.id, page(req));
    return igOk(res, {
      items: result.items.map((p) => ({ media: present.media(db, p, req.viewer.id) })),
      num_results: result.items.length,
      more_available: Boolean(result.nextCursor),
      next_max_id: result.nextCursor,
    });
  });

  function editMedia(req, res) {
    const post = postRef(req.params.id, req);
    const caption = req.params_.caption_text;
    const updated = posts.update(db, post.id, req.viewer.id, {
      caption: caption === undefined ? undefined : String(caption).slice(0, 2200),
    });
    return igOk(res, { media: present.media(db, updated, req.viewer.id) });
  }
  router.post('/api/v1/media/:id/edit_media/', requireViewer, editMedia);

  function deleteMedia(req, res) {
    const post = postRef(req.params.id, req);
    posts.remove(db, post.id, req.viewer.id);
    return igOk(res, { did_delete: true });
  }
  router.post('/api/v1/web/create/:id/delete/', requireViewer, deleteMedia);
  router.post('/api/v1/media/:id/delete/', requireViewer, deleteMedia);

  /* -------------------------------- follows ------------------------------- */

  function statusOf(req, row) {
    return present.friendshipStatus(db, req.viewer.id, row);
  }

  function followUser(req, res, { web }) {
    const row = userByPk(req.params.pk);
    try {
      follows.follow(db, req.viewer.id, row.id);
    } catch (error) {
      if (error.status !== 409) throw error;
    }
    const fs = statusOf(req, row);
    return igOk(res, web ? { result: fs.following ? 'following' : 'requested' } : { friendship_status: fs });
  }
  function unfollowUser(req, res, { web }) {
    const row = userByPk(req.params.pk);
    try {
      follows.unfollow(db, req.viewer.id, row.id);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    return igOk(res, web ? {} : { friendship_status: statusOf(req, row) });
  }
  router.post('/api/v1/friendships/create/:pk/', requireViewer, (req, res) => followUser(req, res, { web: false }));
  router.post('/api/v1/friendships/destroy/:pk/', requireViewer, (req, res) => unfollowUser(req, res, { web: false }));
  router.post('/api/v1/web/friendships/:pk/follow/', requireViewer, (req, res) => followUser(req, res, { web: true }));
  router.post('/api/v1/web/friendships/:pk/unfollow/', requireViewer, (req, res) => unfollowUser(req, res, { web: true }));

  router.get('/api/v1/friendships/show/:pk/', requireViewer, (req, res) => igOk(res, statusOf(req, userByPk(req.params.pk))));
  router.post('/api/v1/friendships/show_many/', requireViewer, (req, res) => {
    const ids = String(req.params_.user_ids || '').split(',').filter(isPk).slice(0, 200);
    const out = {};
    for (const pk of ids) {
      const row = users.getByPk(db, pk);
      if (row) out[pk] = statusOf(req, row);
    }
    return igOk(res, { friendship_statuses: out });
  });

  const relationList = (kind) => (req, res) => {
    const row = userByPk(req.params.pk);
    if (!follows.canView(db, viewerId(req), row.id)) throw notFound('User not found');
    const fn = kind === 'followers' ? follows.listFollowers : follows.listFollowing;
    const result = fn.call(follows, db, row.id, page(req, { fallback: 25, max: 100 }));
    const list = result.items.map((r) => present.user(db, users.getById(db, r.id), viewerId(req)));
    return igOk(res, { users: list, big_list: Boolean(result.nextCursor), page_size: list.length, next_max_id: result.nextCursor });
  };
  router.get('/api/v1/friendships/:pk/followers/', requireViewer, relationList('followers'));
  router.get('/api/v1/friendships/:pk/following/', requireViewer, relationList('following'));

  router.get('/api/v1/friendships/pending/', requireViewer, (req, res) => {
    const result = follows.listPending(db, req.viewer.id, page(req, { fallback: 25, max: 100 }));
    return igOk(res, {
      users: result.items.map((r) => present.user(db, users.getById(db, r.id), req.viewer.id)),
      next_max_id: result.nextCursor,
    });
  });
  const decide = (accept) => (req, res) => {
    const row = userByPk(req.params.pk);
    if (accept) follows.accept(db, req.viewer.id, row.id);
    else follows.reject(db, req.viewer.id, row.id);
    return igOk(res, { friendship_status: statusOf(req, row) });
  };
  router.post('/api/v1/friendships/approve/:pk/', requireViewer, decide(true));
  router.post('/api/v1/friendships/ignore/:pk/', requireViewer, decide(false));
  router.post('/api/v1/web/friendships/:pk/approve/', requireViewer, decide(true));
  router.post('/api/v1/web/friendships/:pk/ignore/', requireViewer, decide(false));

  router.post('/api/v1/friendships/remove_follower/:pk/', requireViewer, (req, res) => {
    const row = userByPk(req.params.pk);
    db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(row.id, req.viewer.id);
    return igOk(res, { friendship_status: statusOf(req, row) });
  });

  /* --------------------------------- search ------------------------------- */

  function topsearch(req, res) {
    const q = String(req.params_.query ?? req.params_.q ?? '').slice(0, 100);
    const found = search.users(db, q, { limit: 30 });
    return igOk(res, {
      users: found.map((u, position) => ({ position, user: present.user(db, u, viewerId(req)) })),
      places: [],
      hashtags: [],
      has_more: false,
      rank_token: '',
    });
  }
  router.get('/api/v1/web/search/topsearch/', topsearch);
  router.get('/api/v1/users/search/', (req, res) => {
    const found = search.users(db, String(req.params_.q ?? req.params_.query ?? '').slice(0, 100), { limit: 30 });
    return igOk(res, { users: found.map((u) => present.user(db, u, viewerId(req))), num_results: found.length, has_more: false });
  });

  /* -------------------------------- activity ------------------------------ */

  // The genuine activity feed POSTs {max_id, selected_filters}
  // (PolarisAPIGetInboxData); max_id is the page cursor, filters are not kept.
  function newsInbox(req, res) {
    const result = notifications.list(db, req.viewer.id, { limit: 50, cursor: req.params_.max_id || undefined });
    const stories = result.items.map((n) => present.activity(db, n));
    const unread = stories.filter((s) => !s.read);
    return igOk(res, {
      counts: { relationships: 0, likes: 0, comments: 0, activity_feed_dot_badge: unread.length },
      new_stories: unread,
      old_stories: stories.filter((s) => s.read),
      continuation_token: result.nextCursor,
    });
  }
  router.get('/api/v1/news/inbox/', requireViewer, newsInbox);
  router.post('/api/v1/news/inbox/', requireViewer, newsInbox);
  router.post('/api/v1/news/inbox_seen/', requireViewer, (req, res) => {
    notifications.markAllRead(db, req.viewer.id);
    return igOk(res, {});
  });
}

module.exports = { register, page };
