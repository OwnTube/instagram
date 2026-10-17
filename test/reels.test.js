'use strict';

/**
 * Reels (video posts), through the client's own requests
 * (PolarisCreationV2Actions, PolarisAPIRuploadVideo, PolarisCreationAPI):
 * the resumable rupload_igvideo upload, the cover frame through
 * rupload_igphoto with the same upload_id, configure_to_clips, and the Reels
 * tab's PolarisClipsHomeRootQuery.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer, Browser, pngBytes } = require('./clone-helpers');

const gql = (b, name, variables = {}) => b.post('/graphql/query', { doc_id: '1', fb_api_req_friendly_name: name, variables });

// A minimal MP4 header: a 'ftyp' box (isom) followed by filler bytes.
function mp4Bytes(size = 4096) {
  const buf = Buffer.alloc(size, 7);
  buf.writeUInt32BE(24, 0);
  buf.write('ftypisom', 4, 'latin1');
  return buf;
}

function putChunk(br, entity, chunk, { offset, total, uploadId }) {
  return br.request('POST', `/rupload_igvideo/${entity}`, {
    raw: chunk,
    headers: {
      'content-type': 'application/octet-stream',
      offset: String(offset),
      'x-entity-length': String(total),
      'x-entity-name': entity,
      'x-instagram-rupload-params': JSON.stringify({ upload_id: uploadId, media_type: 2, upload_media_width: 540, upload_media_height: 960, upload_media_duration_ms: 4000 }),
    },
  });
}

test('reels', async (t) => {
  const server = await startCloneServer({});
  t.after(() => server.close());
  const ann = new Browser(server.base);
  await ann.signup(server, { username: 'ann_reel' });
  const bob = new Browser(server.base);
  const b = await bob.signup(server, { username: 'bob_reel' });
  const video = mp4Bytes();
  const uploadId = String(Date.now());
  const entity = `fb_uploader_${uploadId}`;

  await t.test('the offset is text, and the upload resumes from it', async () => {
    const before = await ann.get(`/rupload_igvideo/${entity}`);
    assert.match(before.headers.get('content-type'), /^text\/plain/);
    assert.deepStrictEqual(JSON.parse(before.text), { offset: 0 });
    assert.strictEqual((await putChunk(ann, entity, video.subarray(0, 1000), { offset: 0, total: video.length, uploadId })).status, 200);
    assert.deepStrictEqual(JSON.parse((await ann.get(`/rupload_igvideo/${entity}`)).text), { offset: 1000 });
    // A chunk at the wrong offset is refused and changes nothing.
    assert.strictEqual((await putChunk(ann, entity, video.subarray(500), { offset: 500, total: video.length, uploadId })).status, 400);
    const done = await putChunk(ann, entity, video.subarray(1000), { offset: 1000, total: video.length, uploadId });
    assert.strictEqual(done.status, 200, done.text.slice(0, 200));
    assert.strictEqual(done.body.upload_id, uploadId);
    assert.deepStrictEqual(JSON.parse((await ann.get(`/rupload_igvideo/${entity}`)).text), { offset: video.length });
  });

  await t.test('only videos are accepted', async () => {
    const id = String(Date.now() + 1);
    const res = await putChunk(ann, `fb_uploader_${id}`, pngBytes(), { offset: 0, total: pngBytes().length, uploadId: id });
    assert.strictEqual(res.status, 400);
  });

  let reel;
  await t.test('the cover frame goes up under the same upload_id; configure_to_clips makes the reel', async () => {
    const cover = await ann.request('POST', `/rupload_igphoto/${entity}`, { raw: pngBytes(), headers: { 'content-type': 'image/png', 'x-instagram-rupload-params': JSON.stringify({ upload_id: uploadId, media_type: 1 }) } });
    assert.strictEqual(cover.status, 200, cover.text.slice(0, 200));
    assert.strictEqual(cover.body.upload_id, uploadId);
    // A video can't be configured as a photo post.
    assert.strictEqual((await ann.post('/api/v1/media/configure/', { upload_id: uploadId, caption: 'x' })).status, 400);
    const res = await ann.post('/api/v1/media/configure_to_clips/', { upload_id: uploadId, caption: 'first reel', clips_share_preview_to_feed: '1' });
    assert.strictEqual(res.status, 200, res.text.slice(0, 300));
    reel = res.body.media;
    assert.strictEqual(reel.media_type, 2);
    assert.strictEqual(reel.product_type, 'clips');
    assert.strictEqual(reel.caption.text, 'first reel');
    assert.match(reel.video_versions[0].url, /\/__media\/.+\.mp4$/);
    assert.match(reel.image_versions2.candidates[0].url, /\/__media\/.+\.png$/);
    assert.strictEqual(reel.video_duration, 4);
    assert.deepStrictEqual([reel.original_width, reel.original_height], [540, 960]);
  });

  await t.test('the video and its cover are served to those who may see the reel, with ranges', async () => {
    const path = new URL(reel.video_versions[0].url, server.base).pathname;
    const part = await bob.request('GET', path, { headers: { range: 'bytes=0-99' } });
    assert.strictEqual(part.status, 206);
    assert.strictEqual(part.headers.get('content-type'), 'video/mp4');
    assert.strictEqual((await bob.get(new URL(reel.image_versions2.candidates[0].url, server.base).pathname)).status, 200);
    assert.strictEqual((await ann.post('/api/v1/accounts/set_private/', {})).status, 200);
    const cara = new Browser(server.base);
    await cara.signup(server, { username: 'cara_reel' });
    assert.strictEqual((await cara.get(path)).status, 404);
    assert.strictEqual((await ann.post('/api/v1/accounts/set_public/', {})).status, 200);
  });

  await t.test('the Reels tab lists the reels the viewer may see', async () => {
    const res = await gql(bob, 'PolarisClipsHomeRootQuery', { first: 5 });
    const conn = res.body.data.xdt_api__v1__clips__home__connection_v2;
    assert.deepStrictEqual(conn.edges.map((e) => e.node.media.code), [reel.code]);
    assert.strictEqual(conn.page_info.has_next_page, false);
    assert.deepStrictEqual((await gql(bob, 'PolarisClipsAdsPoolQuery', { is_ads_enabled: true })).body.data.xdt_injected_reels_units, { ad_media_items: [] });
    void b;
  });

  await t.test('no upstream attempt', () => assert.deepStrictEqual(server.upstream, []));
});
