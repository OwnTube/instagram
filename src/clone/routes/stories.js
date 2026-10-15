'use strict';

/** Story tray, reels, seen state and viewer lists, from our stories table. */

const users = require('../../backend/services/users');
const { stories } = require('../../backend/services/social');
const { notFound, badRequest } = require('../../backend/lib/errors');
const { isPk } = require('../../backend/lib/ids');
const { igOk } = require('../respond');
const present = require('../present');

function register(router, ctx) {
  const { db, requireViewer } = ctx;

  function reelFor(authorRow, viewerId) {
    const items = stories.listActiveByAuthor(db, authorRow.id, viewerId);
    return items.length ? present.reel(db, authorRow, items, viewerId) : null;
  }

  router.get('/api/v1/feed/reels_tray/', requireViewer, (req, res) => {
    const tray = stories
      .tray(db, req.viewer.id)
      .map((t) => present.reel(db, users.getById(db, t.authorId), t.items, req.viewer.id))
      .filter((r) => r.items.length);
    return igOk(res, { tray, story_ranking_token: '', has_new_nux_story: false });
  });

  function reelsMedia(req, res) {
    let ids = req.params_.reel_ids ?? req.params_.user_ids ?? [];
    if (typeof ids === 'string') ids = ids.startsWith('[') ? JSON.parse(ids) : ids.split(',');
    if (!Array.isArray(ids)) throw badRequest('reel_ids must be a list');
    const reels = {};
    const list = [];
    for (const pk of ids.map(String).filter(isPk).slice(0, 50)) {
      const row = users.getByPk(db, pk);
      const reel = row ? reelFor(row, req.viewer?.id ?? null) : null;
      if (reel) {
        reels[pk] = reel;
        list.push(reel);
      }
    }
    return igOk(res, { reels, reels_media: list });
  }
  router.get('/api/v1/feed/reels_media/', reelsMedia);
  router.post('/api/v1/feed/reels_media/', reelsMedia);

  const userReel = (req, res) => {
    const row = isPk(req.params.pk) ? users.getByPk(db, req.params.pk) : null;
    if (!row) throw notFound('User not found');
    return igOk(res, { reel: reelFor(row, req.viewer?.id ?? null) });
  };
  router.get('/api/v1/feed/user/:pk/story/', userReel);
  router.get('/api/v1/feed/user/:pk/reel_media/', userReel);

  function storyRef(ref) {
    const pk = String(ref || '').split('_')[0];
    if (!isPk(pk)) throw badRequest('Invalid story id');
    return pk;
  }

  router.post('/api/v1/stories/reel/seen', requireViewer, (req, res) => {
    stories.markSeen(db, storyRef(req.params_.reelMediaId), req.viewer.id);
    return igOk(res, {});
  });
  router.post('/api/v1/media/seen/', requireViewer, (req, res) => {
    let reels = req.params_.reels;
    if (typeof reels === 'string') reels = JSON.parse(reels);
    for (const key of Object.keys(reels || {}).slice(0, 100)) stories.markSeen(db, storyRef(key), req.viewer.id);
    return igOk(res, {});
  });

  router.get('/api/v1/media/:id/list_reel_media_viewer/', requireViewer, (req, res) => {
    const viewers = stories.viewers(db, storyRef(req.params.id), req.viewer.id);
    return igOk(res, { users: viewers.map((u) => present.user(db, u, req.viewer.id)), user_count: viewers.length, total_viewer_count: viewers.length });
  });

  router.post('/api/v1/stories/:id/delete/', requireViewer, (req, res) => {
    stories.remove(db, storyRef(req.params.id), req.viewer.id);
    return igOk(res, { did_delete: true });
  });
}

module.exports = { register };
