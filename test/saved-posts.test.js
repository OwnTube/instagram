'use strict';

/**
 * The post's save button (PolarisAPISavePostMutation,
 * PolarisAPIUnsavePostMutation) and the collection picker that opens after a
 * save (PolarisSavedCollectionPickerQuery), checked in the database and in the
 * media info the post view reloads.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer, Browser } = require('./clone-helpers');
const { sunsetPng } = require('../scripts/lib/scenario');

const gql = (b, name, variables = {}) => b.post('/graphql/query', { doc_id: '1', fb_api_req_friendly_name: name, variables });

test('saved posts', async (t) => {
  const server = await startCloneServer({});
  t.after(() => server.close());
  const ann = new Browser(server.base);
  const bob = new Browser(server.base);
  const a = await ann.signup(server, { username: 'ann_saves' });
  const b = await bob.signup(server, { username: 'bob_saves' });
  const id = String(Date.now());
  await bob.request('POST', `/rupload_igphoto/fb_uploader_${id}`, { raw: sunsetPng(32, 32), headers: { 'x-instagram-rupload-params': JSON.stringify({ upload_id: id, media_type: 1 }), 'content-type': 'image/png' } });
  const media = (await bob.post('/api/v1/media/configure/', { upload_id: id, caption: 'save me' })).body.media;
  const mediaId = `${media.pk}_${b.pk}`;
  const db = server.openDb();
  t.after(() => db.close());
  const annId = db.prepare('SELECT id FROM users WHERE pk = ?').get(String(a.pk)).id;
  const savedRow = () => db.prepare('SELECT collection_id FROM saved_posts WHERE user_id = ?').get(annId);
  const savedFlag = async () => (await ann.get(`/api/v1/media/${media.pk}/info/`)).body.items[0].has_viewer_saved;

  await t.test('save and unsave set and clear the saved post', async () => {
    const res = await gql(ann, 'PolarisAPISavePostMutation', { input: { media_id: String(media.pk) } });
    assert.strictEqual(res.status, 200, res.text.slice(0, 200));
    assert.deepStrictEqual(res.body.data, { xig_media_save: { media: { id: mediaId } } });
    assert.ok(savedRow());
    assert.strictEqual(await savedFlag(), true);
    // Saving again is not an error and keeps the collection the post is in.
    db.prepare("INSERT INTO collections (id, owner_id, name, created_at) VALUES ('c1', ?, 'Trips', '2026-01-01T00:00:00Z')").run(annId);
    db.prepare("UPDATE saved_posts SET collection_id = 'c1' WHERE user_id = ?").run(annId);
    assert.strictEqual((await gql(ann, 'PolarisAPISavePostMutation', { input: { media_id: mediaId } })).status, 200);
    assert.strictEqual(savedRow().collection_id, 'c1');
    const un = await gql(ann, 'PolarisAPIUnsavePostMutation', { input: { media_id: mediaId } });
    assert.deepStrictEqual(un.body.data, { xig_media_unsave: { media: { id: mediaId } } });
    assert.strictEqual(savedRow(), undefined);
    assert.strictEqual(await savedFlag(), false);
    assert.strictEqual((await gql(ann, 'PolarisAPIUnsavePostMutation', { input: { media_id: mediaId } })).status, 200, 'unsaving twice is not an error');
  });

  await t.test('the picker lists only the viewer’s collections, in the client’s shape', async () => {
    db.prepare("INSERT INTO collections (id, owner_id, name, created_at) VALUES ('c2', ?, 'Food', '2026-01-02T00:00:00Z')").run(annId);
    const bobId = db.prepare('SELECT id FROM users WHERE pk = ?').get(String(b.pk)).id;
    db.prepare("INSERT INTO collections (id, owner_id, name, created_at) VALUES ('c3', ?, 'Bob only', '2026-01-03T00:00:00Z')").run(bobId);
    const res = await gql(ann, 'PolarisSavedCollectionPickerQuery', { first: 1 });
    assert.strictEqual(res.status, 200, res.text.slice(0, 200));
    const conn = res.body.data.viewer.media_collections;
    assert.deepStrictEqual(conn.edges.map((e) => [e.node.__typename, e.node.collection_id, e.node.collection_name]), [['MediaCollection', 'c1', 'Trips']]);
    assert.deepStrictEqual(conn.page_info, { end_cursor: 'c1', has_next_page: true });
    const next = (await gql(ann, 'PolarisSavedCollectionPickerQuery', { first: 5, after: 'c1' })).body.data.viewer.media_collections;
    assert.deepStrictEqual(next.edges.map((e) => e.node.collection_name), ['Food']);
    assert.strictEqual(next.page_info.has_next_page, false);
  });

  await t.test('invalid input and authorisation', async () => {
    assert.strictEqual((await gql(ann, 'PolarisAPISavePostMutation', { input: { media_id: '999999999' } })).status, 404);
    assert.strictEqual((await gql(ann, 'PolarisAPISavePostMutation', { input: {} })).status, 404);
    const anon = new Browser(server.base);
    await anon.visit();
    assert.strictEqual((await gql(anon, 'PolarisAPISavePostMutation', { input: { media_id: mediaId } })).status, 401);
    assert.strictEqual((await gql(anon, 'PolarisSavedCollectionPickerQuery', { first: 5 })).status, 401);
  });

  await t.test('no upstream attempt', () => assert.deepStrictEqual(server.upstream, []));
});
