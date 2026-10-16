'use strict';

/**
 * Post creation in the genuine client: the creation dialog's operations
 * (src/clone/graphql.js) and the upload request the genuine uploader sends,
 * which carries no CSRF token, only the session cookie and the custom
 * X-Instagram-Rupload-Params header (src/clone/index.js).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer, Browser } = require('./clone-helpers');
const { sunsetPng } = require('../scripts/lib/scenario');

const gql = (b, name, variables = {}) => b.post('/graphql/query', { doc_id: '1', fb_api_req_friendly_name: name, variables });

test('creation operations and upload', async (t) => {
  const server = await startCloneServer({});
  t.after(() => server.close());
  const cat = new Browser(server.base);
  const c = await cat.signup(server, { username: 'cat_create' });
  const png = sunsetPng(64, 64);

  await t.test('the creation dialog learns that no Threads or Facebook account is linked', async () => {
    const threads = (await gql(cat, 'fetchThreadsCrosspostingMetadataQuery')).body.data;
    assert.deepStrictEqual(threads, { xcxp_fetch_linked_threads_profile: null, viewer: { user: { id: String(c.pk), cxp_crosspost_settings: null } } });
    const fb = (await gql(cat, 'fetchFBCrosspostingMetadataQuery', { caller_name: 'x', service_names: ['CROSS_POSTING_SETTING'] })).body.data;
    assert.deepStrictEqual(fb, { fx_service_cache: { services: [] } });
    const coppa = (await gql(cat, 'usePolarisCoppaEnforcementStatusViewerQuery')).body.data;
    assert.deepStrictEqual(coppa, { xdt_viewer: { user: { id: String(c.pk), is_coppa_enforced: false } } });
  });

  await t.test('an upload with the client header needs no CSRF token; without it, it does', async () => {
    const id = String(Date.now());
    const params = JSON.stringify({ media_type: 1, upload_id: id, upload_media_height: 64, upload_media_width: 64 });
    const ok = await cat.request('POST', `/rupload_igphoto/fb_uploader_${id}`, { raw: png, csrf: false, headers: { 'x-instagram-rupload-params': params, 'content-type': 'image/jpeg' } });
    assert.strictEqual(ok.status, 200);
    const bare = await cat.request('POST', `/rupload_igphoto/fb_uploader_${id}1`, { raw: png, csrf: false, headers: { 'content-type': 'image/jpeg' } });
    assert.strictEqual(bare.status, 403);
    const configured = await cat.post('/api/v1/media/configure/', { upload_id: id, caption: 'from the uploader' });
    assert.strictEqual(configured.status, 200);
    const db = server.openDb();
    try {
      const row = db.prepare('SELECT p.caption FROM posts p JOIN users u ON u.id = p.author_id WHERE u.pk = ?').get(String(c.pk));
      assert.strictEqual(row.caption, 'from the uploader');
    } finally {
      db.close();
    }
  });

  await t.test('an upload still needs a session', async () => {
    const anon = new Browser(server.base);
    await anon.visit();
    const res = await anon.request('POST', '/rupload_igphoto/fb_uploader_1', { raw: png, csrf: false, headers: { 'x-instagram-rupload-params': '{"media_type":1,"upload_id":"1"}', 'content-type': 'image/jpeg' } });
    assert.strictEqual(res.status, 401);
  });
});
