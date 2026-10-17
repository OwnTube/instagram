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
 *
 * Reels (PolarisCreationV2Actions, PolarisAPIRuploadVideo): the video goes up
 * resumably, GET /rupload_igvideo/<entity> -> { offset } then POST of the
 * bytes from that offset (headers Offset, X-Entity-Length,
 * X-Instagram-Rupload-Params); then its cover frame through rupload_igphoto
 * with the same upload_id; then POST /api/v1/media/configure_to_clips/.
 */

const posts = require('../../backend/services/posts');
const { stories } = require('../../backend/services/social');
const { badRequest } = require('../../backend/lib/errors');
const { igOk } = require('../respond');
const present = require('../present');

function register(router, ctx) {
  const { db, requireViewer, media, rawImage, rawVideo } = ctx;

  function ruploadParams(req) {
    try {
      return JSON.parse(req.get('x-instagram-rupload-params') || '{}');
    } catch {
      throw badRequest('Invalid X-Instagram-Rupload-Params');
    }
  }

  router.post(['/rupload_igphoto/:entity', '/rupload_igphoto/:entity/'], requireViewer, rawImage, (req, res) => {
    const params = ruploadParams(req);
    const uploadId = params.upload_id || String(req.params.entity).replace(/^fb_uploader_/, '').split('_')[0];
    // The cover frame of a video uploaded under the same upload_id.
    const video = media.saveCover(req.viewer.id, String(uploadId), req.body);
    if (video) return igOk(res, { upload_id: video.upload_id, xsharing_nonces: {} });
    const purpose = String(params.is_story || params.for_story || '') === '1' ? 'story' : 'post';
    const stored = media.save(req.viewer.id, req.body, { uploadId, purpose });
    return igOk(res, { upload_id: stored.upload_id, xsharing_nonces: {} });
  });

  const videoPaths = ['/rupload_igvideo/:entity', '/rupload_igvideo/:entity/'];
  router.get(videoPaths, requireViewer, (req, res) => {
    res.setHeader('cache-control', 'private, no-store');
    // Text, not JSON: ruploadVideoOffset parses the body itself
    // (JSON.parse(String(response))), and Instajax would hand it a parsed
    // object for a JSON content type.
    return res.type('text/plain').send(JSON.stringify({ offset: media.videoOffset(req.viewer.id, req.params.entity) }));
  });
  router.post(videoPaths, requireViewer, rawVideo, (req, res) => {
    const params = ruploadParams(req);
    if (params.media_type != null && String(params.media_type) !== '2') throw badRequest('Not a video upload');
    const stored = media.saveVideoChunk(req.viewer.id, req.params.entity, req.body, {
      offset: Number(req.get('offset') ?? 0),
      total: Number(req.get('x-entity-length')),
      uploadId: params.upload_id,
      width: params.upload_media_width,
      height: params.upload_media_height,
      durationMs: params.upload_media_duration_ms,
    });
    return igOk(res, stored ? { upload_id: stored.upload_id, xsharing_nonces: {} } : { offset: media.videoOffset(req.viewer.id, req.params.entity) });
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
        if (kind === 'clip') {
          if (!/^video\//.test(upload.content_type)) throw badRequest('A reel needs a video');
          const post = posts.create(db, req.viewer.id, { caption, mediaUrl: upload.url, mediaId: upload.id, mediaType: 'video' });
          out = { media: present.media(db, post, req.viewer.id) };
        } else if (/^video\//.test(upload.content_type)) {
          throw badRequest('Videos are shared as reels');
        } else if (kind === 'story') {
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
  router.post('/api/v1/media/configure_to_clips/', requireViewer, attach('clip'));
  for (const path of ['/api/v1/media/configure_to_story/', '/api/v1/web/create/configure_to_story/']) {
    router.post(path, requireViewer, attach('story'));
  }
}

module.exports = { register };
