'use strict';

/** Story tray, reels, seen state and viewer lists, from our stories table. */

const users = require('../../backend/services/users');
const { stories } = require('../../backend/services/social');
const { highlights } = require('../../backend/services/highlights');
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

  /*
   * The viewer's story archive by day (XPolarisIGXAPIStoriesDayShellControllerRouteBuilder;
   * read by PolarisStoryAPIActions as {items, max_id, more_available}). One reel
   * per local calendar day (`timezone_offset`, seconds east of UTC), id
   * `archiveDay:<day start, unix seconds>`, reel_type `archive_day_reel` (both
   * as the client's own ReelType / PolarisStoryActions use them).
   */
  router.get('/api/v1/archive/reel/day_shells/', requireViewer, (req, res) => {
    const offset = Number.isFinite(Number(req.query.timezone_offset)) ? Number(req.query.timezone_offset) : 0;
    const days = new Map();
    for (const story of stories.listArchive(db, req.viewer.id)) {
      const local = Math.floor(Date.parse(story.createdAt) / 1000) + offset;
      const day = local - (((local % 86400) + 86400) % 86400) - offset;
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(story);
    }
    const author = users.getById(db, req.viewer.id);
    const items = [...days].map(([day, list]) => ({
      ...present.reel(db, author, list.slice().reverse(), req.viewer.id),
      id: `archiveDay:${day}`,
      reel_type: 'archive_day_reel',
    }));
    return igOk(res, { items, max_id: '', more_available: false });
  });

  router.get('/api/v1/feed/reels_tray/', requireViewer, (req, res) => {
    const tray = stories
      .tray(db, req.viewer.id)
      .map((t) => present.reel(db, users.getById(db, t.authorId), t.items, req.viewer.id))
      .filter((r) => r.items.length);
    return igOk(res, { tray, story_ranking_token: '', has_new_nux_story: false });
  });

  /** The viewer's own archived stories of one day (`archiveDay:<day start>`, as day_shells lists them). */
  function archiveDayReel(day, viewerId) {
    if (!viewerId || !/^-?\d+$/.test(day)) return null;
    const start = Number(day) * 1000;
    const list = stories
      .listArchive(db, viewerId)
      .filter((s) => Date.parse(s.createdAt) >= start && Date.parse(s.createdAt) < start + 86400 * 1000)
      .reverse();
    if (!list.length) return null;
    return { ...present.reel(db, users.getById(db, viewerId), list, viewerId), id: `archiveDay:${day}`, reel_type: 'archive_day_reel' };
  }

  function highlightReel(pk, viewerId) {
    if (!isPk(pk)) return null;
    try {
      return present.highlightReel(db, highlights.get(db, pk, viewerId), viewerId);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  // Reel ids are user pks, `highlight:<pk>` or `archiveDay:<day>`
  // (polarisGetReelIdFromReelType); unknown or invisible ones are left out.
  function reelsMedia(req, res) {
    let ids = req.params_.reel_ids ?? req.params_.user_ids ?? [];
    if (typeof ids === 'string') ids = ids.startsWith('[') ? JSON.parse(ids) : ids.split(',');
    if (!Array.isArray(ids)) throw badRequest('reel_ids must be a list');
    const viewerId = req.viewer?.id ?? null;
    const reels = {};
    const list = [];
    for (const id of ids.map(String).slice(0, 50)) {
      let reel = null;
      if (id.startsWith('highlight:')) reel = highlightReel(id.slice('highlight:'.length), viewerId);
      else if (id.startsWith('archiveDay:')) reel = archiveDayReel(id.slice('archiveDay:'.length), viewerId);
      else if (isPk(id)) {
        const row = users.getByPk(db, id);
        reel = row ? reelFor(row, viewerId) : null;
      }
      if (reel) {
        reels[id] = reel;
        list.push(reel);
      }
    }
    return igOk(res, { reels, reels_media: list });
  }

  /*
   * Highlights, as PolarisStoryAPIActions posts them: media_ids are
   * "<story pk>_<user pk>", cover is JSON {media_id}. The answer is the
   * highlight reel under `reel` (normalizeReels reads it).
   */
  const parseList = (v, name) => {
    if (v == null || v === '') return [];
    let list = v;
    if (typeof v === 'string') {
      try {
        list = JSON.parse(v);
      } catch {
        throw badRequest(`${name} must be a JSON list`);
      }
    }
    if (!Array.isArray(list)) throw badRequest(`${name} must be a list`);
    return list.map((x) => storyRef(x));
  };
  const parseCover = (v) => {
    if (v == null || v === '') return null;
    let c = v;
    if (typeof v === 'string') {
      try {
        c = JSON.parse(v);
      } catch {
        throw badRequest('cover must be JSON');
      }
    }
    return c && c.media_id != null ? storyRef(c.media_id) : null;
  };
  router.post('/api/v1/highlights/create_reel/', requireViewer, (req, res) => {
    const p = req.params_;
    const h = highlights.create(db, req.viewer.id, { title: p.title, storyPks: parseList(p.media_ids, 'media_ids'), coverPk: parseCover(p.cover) });
    return igOk(res, { reel: present.highlightReel(db, h, req.viewer.id) });
  });
  router.post('/api/v1/highlights/:pk/edit_reel/', requireViewer, (req, res) => {
    const p = req.params_;
    const pk = String(req.params.pk).replace(/^highlight:/, '');
    if (!isPk(pk)) throw badRequest('Invalid highlight id');
    const h = highlights.edit(db, pk, req.viewer.id, {
      title: p.title,
      coverPk: parseCover(p.cover),
      addPks: parseList(p.added_media_ids, 'added_media_ids'),
      removePks: parseList(p.removed_media_ids, 'removed_media_ids'),
    });
    // Removing every story deletes the highlight: no reel to return then.
    return igOk(res, h ? { reel: present.highlightReel(db, h, req.viewer.id) } : {});
  });
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
