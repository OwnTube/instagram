'use strict';

/**
 * Photo upload in the client's two-step protocol:
 *
 *   1. POST /rupload_igphoto/<entity>  raw image bytes, with
 *      X-Instagram-Rupload-Params: {"upload_id": "...", "media_type": 1}
 *      -> { upload_id, status: "ok" }
 *   2. POST /api/v1/media/configure/ (or configure_to_story) with upload_id and
 *      caption -> { media, status: "ok" }
 *
 * The upload is stored and sniffed in step 1 but invisible to everyone except
 * its owner until step 2 attaches it to a post or story, inside a transaction
 * so a failed configure never leaves a half-made post.
 */

const posts = require('../../backend/services/posts');
const { stories } = require('../../backend/services/social');
const { badRequest } = require('../../backend/lib/errors');
const { igOk } = require('../respond');
const present = require('../present');

function register(router, ctx) {
  const { db, requireViewer, media, rawImage } = ctx;

  router.post(['/rupload_igphoto/:entity', '/rupload_igphoto/:entity/'], requireViewer, rawImage, (req, res) => {
    let params = {};
    try {
      params = JSON.parse(req.get('x-instagram-rupload-params') || '{}');
    } catch {
      throw badRequest('Invalid X-Instagram-Rupload-Params');
    }
    const uploadId = params.upload_id || String(req.params.entity).replace(/^fb_uploader_/, '').split('_')[0];
    const purpose = String(params.is_story || params.for_story || '') === '1' ? 'story' : 'post';
    const stored = media.save(req.viewer.id, req.body, { uploadId, purpose });
    return igOk(res, { upload_id: stored.upload_id, xsharing_nonces: {} });
  });

  function attach(kind) {
    return (req, res) => {
      const p = req.params_;
      if (!p.upload_id) throw badRequest('upload_id is required');
      const upload = media.claimUpload(req.viewer.id, String(p.upload_id));
      const caption = p.caption === undefined ? undefined : String(p.caption).slice(0, 2200);
      db.exec('BEGIN');
      try {
        let out;
        if (kind === 'story') {
          const story = stories.create(db, req.viewer.id, { mediaUrl: upload.url, mediaId: upload.id, caption });
          const author = present.user(db, present.userRow(db, req.viewer.id), req.viewer.id);
          out = { media: present.storyItem(db, story, author) };
        } else {
          const post = posts.create(db, req.viewer.id, { caption, mediaUrl: upload.url, mediaId: upload.id, mediaType: 'image' });
          out = { media: present.media(db, post, req.viewer.id) };
        }
        media.markAttached(upload.id);
        db.exec('COMMIT');
        return igOk(res, out);
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    };
  }
  for (const path of ['/api/v1/media/configure/', '/api/v1/web/create/configure/']) router.post(path, requireViewer, attach('post'));
  for (const path of ['/api/v1/media/configure_to_story/', '/api/v1/web/create/configure_to_story/']) {
    router.post(path, requireViewer, attach('story'));
  }
}

module.exports = { register };
