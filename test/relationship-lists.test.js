'use strict';

/**
 * The "Following" menu of a profile (PolarisFollowingActionsModal): close
 * friends, favorites and restrict, each through the client's own mutation,
 * reflected in friendship_status wherever the profile is read, and private
 * to the viewer who made the list.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer, Browser } = require('./clone-helpers');

const gql = (b, name, variables = {}) => b.post('/graphql/query', { doc_id: '1', fb_api_req_friendly_name: name, variables });

test('relationship lists', async (t) => {
  const server = await startCloneServer({});
  t.after(() => server.close());
  const ann = new Browser(server.base);
  const bob = new Browser(server.base);
  const a = await ann.signup(server, { username: 'ann_lists' });
  const b = await bob.signup(server, { username: 'bob_lists' });
  const status = async (viewer, pk) => (await gql(viewer, 'PolarisProfilePageContentQuery', { id: String(pk), enable_integrity_filters: true })).body.data.user.friendship_status;

  await t.test('close friends: add and remove through usePolarisSetBesties', async () => {
    const added = await gql(ann, 'usePolarisSetBestiesMutation', { add: [String(b.pk)], remove: [], source: 'profile' });
    assert.strictEqual(added.status, 200);
    assert.deepStrictEqual(added.body.data.xdt_set_besties, [{ id: String(b.pk), friendship_status: { is_bestie: true } }]);
    assert.strictEqual((await status(ann, b.pk)).is_bestie, true);
    // Repeating it is harmless.
    assert.strictEqual((await gql(ann, 'usePolarisSetBestiesMutation', { add: [String(b.pk)], remove: [], source: 'profile' })).status, 200);
    const removed = await gql(ann, 'usePolarisSetBestiesMutation', { add: [], remove: [String(b.pk)], source: 'profile' });
    assert.deepStrictEqual(removed.body.data.xdt_set_besties, [{ id: String(b.pk), friendship_status: { is_bestie: false } }]);
    assert.strictEqual((await status(ann, b.pk)).is_bestie, false);
  });

  await t.test('favorites: usePolarisUpdateFeedFavorites takes {input: {add, remove, source}}', async () => {
    const res = await gql(ann, 'usePolarisUpdateFeedFavoritesMutation', { input: { add: [String(b.pk)], remove: [], source: 'profile' } });
    assert.deepStrictEqual(res.body.data.xig_update_feed_favorites.user_id_and_relationship_infos, [{ relationship_info: { is_feed_favorite: true } }]);
    assert.strictEqual((await status(ann, b.pk)).is_feed_favorite, true);
  });

  await t.test('restrict and unrestrict', async () => {
    const r = await gql(ann, 'usePolarisRestrictMutation', { target_user_ids: [String(b.pk)] });
    assert.deepStrictEqual(r.body.data.xdt_api__v1__restrict_action__restrict_many, [{ id: String(b.pk), pk: String(b.pk), friendship_status: { is_restricted: true } }]);
    assert.strictEqual((await status(ann, b.pk)).is_restricted, true);
    const u = await gql(ann, 'usePolarisUnrestrictMutation', { target_user_id: String(b.pk) });
    assert.deepStrictEqual(u.body.data.xdt_api__v1__restrict_action__unrestrict.friendship_status, { is_restricted: false });
  });

  await t.test("lists are the viewer's own: the other side sees nothing", async () => {
    await gql(ann, 'usePolarisSetBestiesMutation', { add: [String(b.pk)], remove: [], source: 'profile' });
    const fromBob = await status(bob, a.pk);
    assert.deepStrictEqual([fromBob.is_bestie, fromBob.is_feed_favorite, fromBob.is_restricted], [false, false, false]);
  });

  await t.test('unknown users, the viewer themselves and malformed input are refused without a change', async () => {
    assert.strictEqual((await gql(ann, 'usePolarisSetBestiesMutation', { add: ['999999999999'], remove: [] })).status, 404);
    assert.strictEqual((await gql(ann, 'usePolarisSetBestiesMutation', { add: [String(a.pk)], remove: [] })).status, 400);
    assert.strictEqual((await gql(ann, 'usePolarisSetBestiesMutation', { add: String(b.pk) })).status, 400);
    // A batch with one bad id changes nothing.
    await gql(ann, 'usePolarisSetBestiesMutation', { add: [], remove: [String(b.pk)] });
    assert.strictEqual((await gql(ann, 'usePolarisSetBestiesMutation', { add: [String(b.pk), '999999999999'], remove: [] })).status, 404);
    assert.strictEqual((await status(ann, b.pk)).is_bestie, false);
  });

  await t.test('a session is required', async () => {
    const anon = new Browser(server.base);
    await anon.visit();
    assert.strictEqual((await gql(anon, 'usePolarisSetBestiesMutation', { add: [String(b.pk)], remove: [] })).status, 401);
  });

  await t.test('no upstream attempt', () => assert.deepStrictEqual(server.upstream, []));
});

test('mute: posts leave the home feed, stories move to the end of the tray', async (t) => {
  const server = await startCloneServer({});
  t.after(() => server.close());
  const { pngBytes } = require('./clone-helpers');
  const ann = new Browser(server.base);
  await ann.signup(server, { username: 'ann_mute' });
  const authors = [];
  for (const name of ['bob_mute', 'cara_mute']) {
    const br = new Browser(server.base);
    const u = await br.signup(server, { username: name });
    authors.push({ br, ...u });
    await ann.post(`/api/v1/friendships/create/${u.pk}/`, {});
  }
  // Each author posts and adds a story (bob first, so cara's story is the latest).
  for (const a of authors) {
    for (const [path, story] of [['/api/v1/media/configure/', false], ['/api/v1/media/configure_to_story/', true]]) {
      const uploadId = String(Date.now()) + Math.floor(Math.random() * 1000);
      await a.br.request('POST', `/rupload_igphoto/fb_uploader_${uploadId}`, { raw: pngBytes(), headers: { 'content-type': 'image/png', 'x-instagram-rupload-params': JSON.stringify({ upload_id: uploadId, is_story: story ? '1' : '0' }) } });
      const r = await a.br.post(path, { upload_id: uploadId, caption: `${a.username} ${story ? 'story' : 'post'}` });
      assert.strictEqual(r.status, 200, `${a.username} ${path}: ${r.text.slice(0, 200)}`);
    }
  }
  const feedAuthors = async () => (await ann.get('/api/v1/feed/timeline/')).body.feed_items.map((i) => i.media_or_ad.user.username);
  const tray = async () => (await gql(ann, 'PolarisStoriesV3TrayContainerQuery', { data: {} })).body.data.xdt_api__v1__feed__reels_tray.tray.map((r) => [r.user.username, r.muted]);
  const [bob] = authors;

  assert.deepStrictEqual((await feedAuthors()).sort(), ['bob_mute', 'cara_mute']);
  assert.deepStrictEqual(await tray(), [['cara_mute', false], ['bob_mute', false]]);

  const mp = await gql(ann, 'usePolarisMutePostsMutation', { target_posts_author_id: String(bob.pk) });
  assert.deepStrictEqual(mp.body.data.xdt_user_mute_posts.muted_user, { id: String(bob.pk), friendship_status: { muting: true, is_muting_reel: false } });
  assert.deepStrictEqual(await feedAuthors(), ['cara_mute']);

  // Muting cara's story moves it after bob's; it stays in the tray.
  const ms = await gql(ann, 'usePolarisMuteStoryMutation', { target_reel_author_id: String(authors[1].pk) });
  assert.strictEqual(ms.body.data.xdt_user_mute_story.muted_user.friendship_status.is_muting_reel, true);
  assert.deepStrictEqual(await tray(), [['bob_mute', false], ['cara_mute', true]]);

  await gql(ann, 'usePolarisUnmutePostsMutation', { target_posts_author_id: String(bob.pk) });
  const us = await gql(ann, 'usePolarisUnmuteStoryMutation', { target_reel_author_id: String(authors[1].pk) });
  assert.deepStrictEqual(us.body.data.xdt_user_unmute_story.unmuted_user.friendship_status, { muting: false, is_muting_reel: false });
  assert.deepStrictEqual((await feedAuthors()).sort(), ['bob_mute', 'cara_mute']);
  assert.deepStrictEqual(await tray(), [['cara_mute', false], ['bob_mute', false]]);
  assert.deepStrictEqual(server.upstream, []);
});

test("a post's share sheet: the ranked recipients and the post bar", async (t) => {
  const server = await startCloneServer({});
  t.after(() => server.close());
  const { pngBytes } = require('./clone-helpers');
  const ann = new Browser(server.base);
  await ann.signup(server, { username: 'ann_share' });
  const bob = new Browser(server.base);
  const b = await bob.signup(server, { username: 'bob_share' });
  await ann.post(`/api/v1/friendships/create/${b.pk}/`, {});
  const uploadId = String(Date.now());
  await bob.request('POST', `/rupload_igphoto/fb_uploader_${uploadId}`, { raw: pngBytes(), headers: { 'content-type': 'image/png', 'x-instagram-rupload-params': JSON.stringify({ upload_id: uploadId }) } });
  const post = (await bob.post('/api/v1/media/configure/', { upload_id: uploadId, caption: 'share me' })).body.media;
  assert.strictEqual(post.can_viewer_reshare, true, 'a public post can be shared');

  const nul = (await gql(ann, 'PolarisShareSheetV3NullStateQuery', { input: {} })).body.data.get_paginated_share_sheet_ranked_items.ranked_items;
  assert.deepStrictEqual(nul.map((i) => [i.__typename, i.username, i.friendship_status]), [['ShareSheetUser', 'bob_share', { blocking: false, reachability_status: null }]]);
  assert.strictEqual(nul[0].__isShareSheetItem, undefined, 'no contract in the fixture snapshot: nothing added');

  const bar = (await gql(ann, 'PolarisShareSheetV3PostShareBarQuery', { media_id: post.id })).body.data.fetch__XDTMediaDict;
  assert.strictEqual(bar.code, post.code);
  assert.strictEqual(bar.share_urls.copy, `${server.base}/p/${post.code}/`);
  assert.strictEqual(bar.share_urls.whatsapp, null);
  assert.strictEqual((await gql(ann, 'PolarisShareSheetV3PostShareBarQuery', { media_id: '999999999_1' })).status, 404);
  assert.deepStrictEqual(server.upstream, []);
});
