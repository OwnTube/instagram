'use strict';

/**
 * Story highlights, through the requests the client makes:
 * the archive picker (cometAsyncFetch of day_shells, then reels_media for
 * `archiveDay:` reels), PolarisStoryAPIActions' create_reel / edit_reel, the
 * profile tray query and the `highlight:` reels it opens.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer, Browser, pngBytes } = require('./clone-helpers');

const gql = (b, name, variables = {}) => b.post('/graphql/query', { doc_id: '1', fb_api_req_friendly_name: name, variables });

async function story(br, caption) {
  const uploadId = String(Date.now()) + Math.floor(Math.random() * 1000);
  await br.request('POST', `/rupload_igphoto/fb_uploader_${uploadId}`, { raw: pngBytes(), headers: { 'content-type': 'image/png', 'x-instagram-rupload-params': JSON.stringify({ upload_id: uploadId, is_story: '1' }) } });
  const res = await br.post('/api/v1/media/configure_to_story/', { upload_id: uploadId, caption });
  assert.strictEqual(res.status, 200, res.text.slice(0, 200));
  return res.body.media;
}

/** Parse a Comet async answer: `for (;;);{"__ar":1,"payload":...}`. */
function comet(res) {
  assert.match(res.text, /^for \(;;\);/);
  return JSON.parse(res.text.slice('for (;;);'.length));
}

test('story highlights', async (t) => {
  const server = await startCloneServer({});
  t.after(() => server.close());
  const ann = new Browser(server.base);
  const a = await ann.signup(server, { username: 'ann_hl' });
  const bob = new Browser(server.base);
  await bob.signup(server, { username: 'bob_hl' });
  const s1 = await story(ann, 'one');
  const s2 = await story(ann, 'two');
  const bobStory = await story(bob, 'bob');

  await t.test('day_shells answers cometAsyncFetch with the Comet envelope, and Instapi with plain JSON', async () => {
    const env = comet(await ann.get('/api/v1/archive/reel/day_shells/?timezone_offset=0&__d=www&__a=1&__req=9'));
    assert.strictEqual(env.__ar, 1);
    assert.strictEqual(env.payload.status, 'ok');
    assert.strictEqual(env.payload.items.length, 1);
    assert.match(env.payload.items[0].id, /^archiveDay:\d+$/);
    const plain = await ann.get('/api/v1/archive/reel/day_shells/?timezone_offset=0');
    assert.strictEqual(plain.body.status, 'ok');
    assert.deepStrictEqual(plain.body.items.map((r) => r.id), env.payload.items.map((r) => r.id));
    // A failure in the envelope carries `error` (cometAsyncFetch rejects on it).
    const anon = new Browser(server.base);
    const denied = comet(await anon.get('/api/v1/archive/reel/day_shells/?__d=www&__a=1'));
    assert.ok(denied.error);
    assert.strictEqual(denied.payload, null);
  });

  await t.test("the picker's archiveDay reel holds the viewer's stories of that day, oldest first", async () => {
    const day = (await ann.get('/api/v1/archive/reel/day_shells/?timezone_offset=0')).body.items[0].id;
    const res = await ann.post('/api/v1/feed/reels_media/', { reel_ids: JSON.stringify([day]) });
    assert.deepStrictEqual(res.body.reels[day].items.map((i) => i.pk), [s1.pk, s2.pk]);
    assert.strictEqual(res.body.reels[day].reel_type, 'archive_day_reel');
    // The same day id reads the asker's own archive only.
    assert.deepStrictEqual((await bob.post('/api/v1/feed/reels_media/', { reel_ids: JSON.stringify([day]) })).body.reels[day].items.map((i) => i.pk), [bobStory.pk]);
  });

  let pk;
  await t.test('create_reel: title, stories, cover; the answer is the highlight reel', async () => {
    const res = await ann.post('/api/v1/highlights/create_reel/', {
      cover: JSON.stringify({ media_id: s2.pk }),
      media_ids: JSON.stringify([`${s1.pk}_${a.pk}`, `${s2.pk}_${a.pk}`]),
      source: 'self_profile',
      title: 'Trips',
    });
    assert.strictEqual(res.status, 200, res.text.slice(0, 300));
    const reel = res.body.reel;
    assert.match(reel.id, /^highlight:\d+$/);
    pk = reel.id.slice('highlight:'.length);
    assert.strictEqual(reel.title, 'Trips');
    assert.strictEqual(reel.reel_type, 'highlight_reel');
    assert.deepStrictEqual(reel.items.map((i) => i.pk), [s1.pk, s2.pk]);
    assert.strictEqual(reel.cover_media.media_id, s2.id);
    assert.strictEqual(reel.cover_media.cropped_image_version.url, s2.image_versions2.candidates[0].url);
  });

  await t.test('only your own stories, a name and at least one story', async () => {
    const own = (extra) => ann.post('/api/v1/highlights/create_reel/', { media_ids: JSON.stringify([`${s1.pk}_${a.pk}`]), source: 'self_profile', title: 'x', ...extra });
    assert.strictEqual((await own({ media_ids: JSON.stringify([`${bobStory.pk}_1`]) })).status, 403);
    assert.strictEqual((await own({ title: '  ' })).status, 400);
    assert.strictEqual((await own({ media_ids: '[]' })).status, 400);
    assert.strictEqual((await own({ media_ids: 'nope' })).status, 400);
    assert.strictEqual((await own({ media_ids: JSON.stringify(['999999999_1']) })).status, 404);
    const anon = new Browser(server.base);
    await anon.visit();
    assert.strictEqual((await anon.post('/api/v1/highlights/create_reel/', { media_ids: '[]', title: 'x' })).status, 401);
  });

  await t.test('the profile tray query lists highlights; the profile counts them', async () => {
    for (const viewer of [ann, bob]) {
      const res = await gql(viewer, 'PolarisProfileStoryHighlightsTrayContentQuery', { user_id: String(a.pk), first: 10 });
      const conn = res.body.data.highlights;
      assert.deepStrictEqual(conn.edges.map((e) => [e.node.id, e.node.title, e.node.user.username]), [[`highlight:${pk}`, 'Trips', 'ann_hl']]);
      assert.strictEqual(conn.page_info.has_next_page, false);
    }
    const profile = await gql(bob, 'PolarisProfilePageContentQuery', { id: String(a.pk), enable_integrity_filters: true });
    assert.strictEqual(profile.body.data.user.highlight_reel_count, 1);
  });

  await t.test('a highlight reel opens through reels_media, after its stories expire too', async () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(server.dbFile);
    db.prepare('UPDATE stories SET expires_at = ? WHERE pk IN (?, ?)').run(new Date(Date.now() - 1000).toISOString(), s1.pk, s2.pk);
    db.close();
    const id = `highlight:${pk}`;
    const res = await bob.post('/api/v1/feed/reels_media/', { reel_ids: JSON.stringify([id]) });
    assert.deepStrictEqual(res.body.reels[id].items.map((i) => i.pk), [s1.pk, s2.pk]);
    // Expired stories leave the tray and the author's reel, not the highlight.
    assert.deepStrictEqual((await bob.post('/api/v1/feed/reels_media/', { reel_ids: JSON.stringify([String(a.pk)]) })).body.reels, {});
  });

  await t.test('edit_reel renames, removes and re-covers; only the owner may edit', async () => {
    const path = `/api/v1/highlights/highlight:${pk}/edit_reel/`;
    const denied = await bob.post(path, { added_media_ids: '[]', removed_media_ids: '[]', source: 'story_viewer_profile', title: 'mine' });
    assert.strictEqual(denied.status, 403);
    const res = await ann.post(path, {
      added_media_ids: '[]',
      cover: JSON.stringify({ media_id: s1.pk }),
      removed_media_ids: JSON.stringify([`${s2.pk}_${a.pk}`]),
      source: 'story_viewer_profile',
      title: 'Summer',
    });
    assert.strictEqual(res.status, 200, res.text.slice(0, 300));
    assert.strictEqual(res.body.reel.title, 'Summer');
    assert.deepStrictEqual(res.body.reel.items.map((i) => i.pk), [s1.pk]);
    assert.strictEqual(res.body.reel.cover_media.media_id, s1.id);
  });

  await t.test('removing the last story deletes the highlight', async () => {
    const res = await ann.post(`/api/v1/highlights/highlight:${pk}/edit_reel/`, { added_media_ids: '[]', removed_media_ids: JSON.stringify([`${s1.pk}_${a.pk}`]), title: 'Summer' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(Object.keys(res.body), ['status']);
    const conn = (await gql(ann, 'PolarisProfileStoryHighlightsTrayContentQuery', { user_id: String(a.pk) })).body.data.highlights;
    assert.deepStrictEqual(conn.edges, []);
  });

  await t.test("a private account's highlights are for its approved followers", async () => {
    const cara = new Browser(server.base);
    const c = await cara.signup(server, { username: 'cara_hl' });
    const cs = await story(cara, 'private');
    assert.strictEqual((await cara.post('/api/v1/accounts/set_private/', {})).status, 200);
    const made = await cara.post('/api/v1/highlights/create_reel/', { media_ids: JSON.stringify([`${cs.pk}_${c.pk}`]), title: 'Home' });
    const id = made.body.reel.id;
    const conn = (await gql(bob, 'PolarisProfileStoryHighlightsTrayContentQuery', { user_id: String(c.pk) })).body.data.highlights;
    assert.deepStrictEqual(conn.edges, []);
    assert.deepStrictEqual((await bob.post('/api/v1/feed/reels_media/', { reel_ids: JSON.stringify([id]) })).body.reels, {});
  });

  await t.test('no upstream attempt', () => assert.deepStrictEqual(server.upstream, []));
});
