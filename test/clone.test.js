'use strict';

/**
 * End-to-end tests of the compatibility layer over real HTTP, using requests
 * shaped like the original client's. These prove the backend contract and the
 * isolation guarantees; they do not prove the genuine Instagram bundle renders
 * these responses (that needs the live client, see docs/IMPLEMENTATION-STATUS.md).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer, Browser, pngBytes } = require('./clone-helpers');

async function upload(browser, { story = false, width = 800, height = 600 } = {}) {
  const uploadId = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  const up = await browser.request('POST', `/rupload_igphoto/fb_uploader_${uploadId}`, {
    raw: pngBytes(width, height),
    headers: {
      'content-type': 'image/png',
      'x-instagram-rupload-params': JSON.stringify({ upload_id: uploadId, media_type: 1, ...(story ? { is_story: '1' } : {}) }),
      'x-entity-name': `fb_uploader_${uploadId}`,
      offset: '0',
    },
  });
  assert.strictEqual(up.status, 200, JSON.stringify(up.body));
  return uploadId;
}

async function createPost(browser, caption) {
  const uploadId = await upload(browser);
  const res = await browser.post('/api/v1/media/configure/', { upload_id: uploadId, caption, source_type: 'library' });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  return res.body.media;
}

test('the original client flows, answered by our backend', async (t) => {
  const server = await startCloneServer();
  t.after(() => server.close());

  const alice = new Browser(server.base);
  const bob = new Browser(server.base);
  const carol = new Browser(server.base);
  let alicePk;
  let bobPk;
  let carolPk;
  let alicePost;

  await t.test('a first visit issues an anonymous csrftoken and nothing from upstream', async () => {
    const res = await alice.visit('/');
    assert.strictEqual(res.status, 200);
    assert.ok(alice.cookie('csrftoken'), 'csrftoken must be issued');
    assert.notStrictEqual(alice.cookie('sessionid'), 'UPSTREAM', 'an upstream cookie must never reach the browser');
  });

  await t.test('signup through the original form endpoints creates an account and session', async () => {
    alicePk = (await alice.signup(server, { username: 'alice', fullName: 'Alice A' })).pk;
    bobPk = (await bob.signup(server, { username: 'bob' })).pk;
    carolPk = (await carol.signup(server, { username: 'carol' })).pk;
    assert.match(alicePk, /^\d+$/);
    assert.ok(alice.cookie('sessionid'));
    assert.strictEqual(alice.cookie('ds_user_id'), alicePk);
    assert.notStrictEqual(alice.cookie('sessionid'), bob.cookie('sessionid'));
    const me = await alice.get('/api/v1/accounts/current_user/');
    assert.strictEqual(me.body.user.username, 'alice');
    assert.strictEqual(me.body.user.full_name, 'Alice A');
  });

  await t.test('signup needs only a username and password; a taken username is rejected', async () => {
    const eve = new Browser(server.base);
    await eve.visit();
    const taken = await eve.post('/api/v1/web/accounts/web_create_ajax/attempt/', {
      username: 'alice',
      enc_password: await eve.encPassword('another pass 99'),
    });
    assert.strictEqual(taken.body.dryrun_passed, false);
    assert.strictEqual(taken.body.errors.username[0].code, 'username_is_taken');
    const created = await eve.post('/api/v1/web/accounts/web_create_ajax/', {
      username: 'eve',
      enc_password: await eve.encPassword('another pass 99'),
    });
    assert.strictEqual(created.status, 200);
    assert.strictEqual(created.body.account_created, true, 'no email and no code are needed');
    assert.strictEqual((await eve.get('/api/v1/accounts/current_user/')).body.user.email, '');
  });

  await t.test('login, wrong password, CSRF and logout behave like the original contract', async () => {
    const dave = new Browser(server.base);
    await dave.visit();
    const bad = await dave.post('/api/v1/web/accounts/login/ajax/', { username: 'alice', enc_password: await dave.encPassword('nope nope 1') });
    assert.deepStrictEqual([bad.body.authenticated, bad.body.user], [false, true]);
    const ghost = await dave.post('/api/v1/web/accounts/login/ajax/', { username: 'ghost', enc_password: await dave.encPassword('nope nope 1') });
    assert.deepStrictEqual(ghost.body, bad.body, 'unknown users get the same answer');
    const noCsrf = await dave.request('POST', '/api/v1/web/accounts/login/ajax/', { form: { username: 'alice' }, csrf: false });
    assert.strictEqual(noCsrf.status, 403);
    const ok = await dave.post('/api/v1/web/accounts/login/ajax/', { username: 'alice', enc_password: await dave.encPassword('correct horse 42') });
    assert.strictEqual(ok.body.authenticated, true);
    assert.strictEqual(ok.body.userId, alicePk);
    assert.strictEqual((await dave.get('/api/v1/feed/timeline/')).status, 200);
    await dave.post('/api/v1/web/accounts/logout/ajax/', { one_tap_app_login: 0 });
    assert.strictEqual((await dave.get('/api/v1/feed/timeline/')).status, 401);
  });

  await t.test("one user's CSRF token cannot authorise another user's session", async () => {
    const res = await bob.request('POST', `/api/v1/web/friendships/${alicePk}/follow/`, {
      form: {},
      headers: { 'x-csrftoken': alice.cookie('csrftoken') },
      csrf: false,
    });
    assert.strictEqual(res.status, 403);
    // Planting a matching csrftoken cookie is not enough: the token must be
    // the secret bound to the session making the request.
    const forged = await fetch(`${server.base}/api/v1/web/friendships/${alicePk}/follow/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `sessionid=${encodeURIComponent(bob.cookie('sessionid'))}; csrftoken=attacker-chosen-token-123`,
        'x-csrftoken': 'attacker-chosen-token-123',
      },
      body: '',
    });
    assert.strictEqual(forged.status, 403);
  });

  await t.test('upload and configure create a post with stored media', async () => {
    alicePost = await createPost(alice, 'hello from alice #first');
    assert.match(alicePost.pk, /^\d+$/);
    assert.strictEqual(alicePost.id, `${alicePost.pk}_${alicePk}`);
    assert.strictEqual(alicePost.original_width, 800);
    assert.strictEqual(alicePost.caption.text, 'hello from alice #first');
    const url = alicePost.image_versions2.candidates[0].url;
    const img = await bob.get(url);
    assert.strictEqual(img.status, 200);
    assert.strictEqual(img.headers.get('content-type'), 'image/png');
    assert.strictEqual(img.headers.get('x-content-type-options'), 'nosniff');
  });

  await t.test('uploads that are not images are rejected, and an upload cannot be reused', async () => {
    const res = await alice.request('POST', '/rupload_igphoto/fb_uploader_1', {
      raw: Buffer.from('<script>alert(1)</script>'),
      headers: { 'x-instagram-rupload-params': JSON.stringify({ upload_id: '123456', media_type: 1 }) },
    });
    assert.strictEqual(res.status, 400);
    const id = await upload(alice);
    assert.strictEqual((await alice.post('/api/v1/media/configure/', { upload_id: id })).status, 200);
    assert.strictEqual((await alice.post('/api/v1/media/configure/', { upload_id: id })).status, 400);
    assert.strictEqual((await bob.post('/api/v1/media/configure/', { upload_id: await upload(alice) })).status, 404, "another user's upload");
  });

  await t.test('the GraphQL feed returns followed accounts only, per viewer, with pagination', async () => {
    const follow = await bob.post(`/api/v1/web/friendships/${alicePk}/follow/`, {});
    assert.strictEqual(follow.body.result, 'following');
    const feedQuery = (b, vars) =>
      b.post('/graphql/query', {
        doc_id: '28805668309050001',
        fb_api_req_friendly_name: 'PolarisFeedTimelineRootV2Query',
        fb_api_caller_class: 'RelayModern',
        variables: vars,
        server_timestamps: 'true',
      });
    const bobFeed = await feedQuery(bob, { first: 1 });
    assert.strictEqual(bobFeed.status, 200);
    const conn = bobFeed.body.data.xdt_api__v1__feed__timeline__connection;
    assert.strictEqual(conn.edges.length, 1);
    assert.strictEqual(conn.edges[0].node.media.user.username, 'alice');
    assert.strictEqual(conn.page_info.has_next_page, true);
    const next = await feedQuery(bob, { first: 10, after: conn.page_info.end_cursor });
    const seen = new Set([conn.edges[0].node.media.pk]);
    for (const e of next.body.data.xdt_api__v1__feed__timeline__connection.edges) {
      assert.ok(!seen.has(e.node.media.pk), 'pages must not repeat items');
      seen.add(e.node.media.pk);
    }
    assert.strictEqual(seen.size, 2);
    const carolFeed = await feedQuery(carol, { first: 10 });
    assert.strictEqual(carolFeed.body.data.xdt_api__v1__feed__timeline__connection.edges.length, 0, 'carol follows nobody');
    const anon = await feedQuery(new Browser(server.base), { first: 10 });
    assert.notStrictEqual(anon.status, 200);
  });

  await t.test('likes persist, are per-viewer, and are idempotent', async () => {
    await bob.post(`/api/v1/web/likes/${alicePost.pk}/like/`, {});
    await bob.post(`/api/v1/web/likes/${alicePost.pk}/like/`, {});
    const asBob = (await bob.get(`/api/v1/media/${alicePost.id}/info/`)).body.items[0];
    const asCarol = (await carol.get(`/api/v1/media/${alicePost.id}/info/`)).body.items[0];
    assert.strictEqual(asBob.like_count, 1);
    assert.strictEqual(asBob.has_liked, true);
    assert.strictEqual(asCarol.has_liked, false);
    await bob.post(`/api/v1/web/likes/${alicePost.pk}/unlike/`, {});
    assert.strictEqual((await bob.get(`/api/v1/media/${alicePost.pk}/info/`)).body.items[0].like_count, 0);
    await bob.post(`/api/v1/web/likes/${alicePost.pk}/like/`, {});
  });

  await t.test('comments: add, list, and only the author or post owner can delete', async () => {
    const added = await carol.post(`/api/v1/web/comments/${alicePost.pk}/add/`, { comment_text: 'nice one' });
    assert.strictEqual(added.status, 200);
    assert.strictEqual(added.body.text, 'nice one');
    const list = await bob.get(`/api/v1/media/${alicePost.pk}/comments/`);
    assert.strictEqual(list.body.comments.length, 1);
    assert.strictEqual(list.body.comments[0].user.username, 'carol');
    const byBob = await bob.post(`/api/v1/web/comments/${alicePost.pk}/delete/${added.body.pk}/`, {});
    assert.strictEqual(byBob.status, 403);
    const byOwner = await alice.post(`/api/v1/web/comments/${alicePost.pk}/delete/${added.body.pk}/`, {});
    assert.strictEqual(byOwner.status, 200);
    assert.strictEqual((await bob.get(`/api/v1/media/${alicePost.pk}/comments/`)).body.comments.length, 0);
  });

  await t.test('saved posts are private to the saver', async () => {
    await bob.post(`/api/v1/web/save/${alicePost.pk}/save/`, {});
    assert.strictEqual((await bob.get('/api/v1/feed/saved/posts/')).body.items.length, 1);
    assert.strictEqual((await carol.get('/api/v1/feed/saved/posts/')).body.items.length, 0);
    assert.strictEqual((await bob.get(`/api/v1/media/${alicePost.pk}/info/`)).body.items[0].has_viewer_saved, true);
    await bob.post(`/api/v1/web/save/${alicePost.pk}/unsave/`, {});
    assert.strictEqual((await bob.get('/api/v1/feed/saved/posts/')).body.items.length, 0);
  });

  await t.test('profiles: web_profile_info and edits round-trip', async () => {
    await alice.post('/api/v1/web/accounts/edit/', { first_name: 'Alice Anders', biography: 'hi there', external_url: 'https://example.test', username: 'alice', email: 'alice@example.test' });
    const form = await alice.get('/api/v1/accounts/edit/web_form_data/');
    assert.strictEqual(form.body.form_data.biography, 'hi there');
    const profile = await bob.get('/api/v1/users/web_profile_info/?username=alice');
    const u = profile.body.data.user;
    assert.strictEqual(u.full_name, 'Alice Anders');
    assert.strictEqual(u.edge_followed_by.count, 1);
    assert.strictEqual(u.followed_by_viewer, true);
    assert.strictEqual(u.edge_owner_to_timeline_media.count, 2);
    const badUrl = await alice.post('/api/v1/web/accounts/edit/', { external_url: 'javascript:alert(1)' });
    assert.strictEqual(badUrl.status, 400);
  });

  await t.test('private accounts: follow becomes a request; content opens after approval', async () => {
    await carol.post('/api/v1/accounts/set_private/', {});
    const carolPost = await createPost(carol, 'carol only');
    const req = await bob.post(`/api/v1/web/friendships/${carolPk}/follow/`, {});
    assert.strictEqual(req.body.result, 'requested');
    assert.strictEqual((await bob.get(`/api/v1/media/${carolPost.pk}/info/`)).status, 404);
    assert.strictEqual((await bob.get(carolPost.image_versions2.candidates[0].url)).status, 404, 'private media file');
    const pending = await carol.get('/api/v1/friendships/pending/');
    assert.strictEqual(pending.body.users[0].username, 'bob');
    await carol.post(`/api/v1/web/friendships/${bobPk}/approve/`, {});
    assert.strictEqual((await bob.get(`/api/v1/media/${carolPost.pk}/info/`)).status, 200);
    assert.strictEqual((await bob.get(carolPost.image_versions2.candidates[0].url)).status, 200);
  });

  await t.test('direct messages: send, read, idempotent retry, and membership', async () => {
    const sent = await bob.post('/api/v1/direct_v2/threads/broadcast/text/', {
      recipient_users: [[alicePk]],
      text: 'hey alice',
      client_context: 'ctx-1',
      action: 'send_item',
    });
    assert.strictEqual(sent.status, 200);
    const threadId = sent.body.payload.thread_id;
    const retry = await bob.post('/api/v1/direct_v2/threads/broadcast/text/', { thread_ids: [threadId], text: 'hey alice', client_context: 'ctx-1' });
    assert.strictEqual(retry.body.payload.item_id, sent.body.payload.item_id, 'a retried send must not duplicate');
    const inbox = await alice.get('/api/v1/direct_v2/inbox/');
    assert.strictEqual(inbox.body.inbox.threads.length, 1);
    assert.strictEqual(inbox.body.inbox.threads[0].items[0].text, 'hey alice');
    assert.strictEqual(inbox.body.inbox.unseen_count, 1);
    const thread = await alice.get(`/api/v1/direct_v2/threads/${threadId}/`);
    assert.strictEqual(thread.body.thread.users[0].username, 'bob');
    assert.strictEqual((await carol.get(`/api/v1/direct_v2/threads/${threadId}/`)).status, 403);
    assert.strictEqual(
      (await carol.post('/api/v1/direct_v2/threads/broadcast/text/', { thread_ids: [threadId], text: 'intrude' })).status,
      403
    );
    await alice.post(`/api/v1/direct_v2/threads/${threadId}/items/${sent.body.payload.item_id}/seen/`, {});
    assert.strictEqual((await alice.get('/api/v1/direct_v2/inbox/')).body.inbox.unseen_count, 0);
    assert.strictEqual((await alice.post(`/api/v1/direct_v2/threads/${threadId}/items/${sent.body.payload.item_id}/delete/`, {})).status, 403);
  });

  await t.test('stories: post, tray for followers only, seen state and viewer list', async () => {
    const id = await upload(alice, { story: true, width: 1080, height: 1920 });
    const story = await alice.post('/api/v1/media/configure_to_story/', { upload_id: id });
    assert.strictEqual(story.status, 200);
    const tray = await bob.get('/api/v1/feed/reels_tray/');
    const reel = tray.body.tray.find((r) => r.user.username === 'alice');
    assert.ok(reel, 'a follower sees the story in the tray');
    assert.strictEqual(reel.seen, 0);
    assert.ok(!(await carol.get('/api/v1/feed/reels_tray/')).body.tray.some((r) => r.user.username === 'alice'));
    await bob.post('/api/v1/stories/reel/seen', { reelMediaId: story.body.media.pk, reelMediaOwnerId: alicePk, reelId: alicePk });
    const after = (await bob.get('/api/v1/feed/reels_tray/')).body.tray.find((r) => r.user.username === 'alice');
    assert.ok(after.seen > 0);
    const viewers = await alice.get(`/api/v1/media/${story.body.media.pk}/list_reel_media_viewer/`);
    assert.strictEqual(viewers.body.users[0].username, 'bob');
    assert.strictEqual((await bob.get(`/api/v1/media/${story.body.media.pk}/list_reel_media_viewer/`)).status, 403);
  });

  await t.test('search and activity reflect real records', async () => {
    const found = await carol.get('/api/v1/web/search/topsearch/?query=ali');
    assert.deepStrictEqual(found.body.users.map((u) => u.user.username), ['alice']);
    const news = await alice.get('/api/v1/news/inbox/');
    const kinds = news.body.new_stories.map((s) => s.story_type);
    assert.ok(kinds.includes(60), 'a like notification');
    assert.ok(kinds.includes(101), 'a follow notification');
  });

  await t.test('unknown operations fail loudly and are recorded, never forwarded', async () => {
    const res = await bob.post('/graphql/query', { doc_id: '1', fb_api_req_friendly_name: 'PolarisSomethingNewQuery', variables: '{}' });
    assert.strictEqual(res.status, 501);
    assert.strictEqual(res.body.data, null);
    const rest = await bob.get('/api/v1/some/new/endpoint/');
    assert.strictEqual(rest.status, 501);
    const health = await bob.get('/__clone/health');
    assert.ok(health.body.graphql.unsupported.some((u) => u.name === 'PolarisSomethingNewQuery'));
  });

  await t.test('no clone request, cookie or telemetry ever reached the upstream origin', async () => {
    await bob.post('/ajax/bz', { q: 'telemetry' });
    for (const r of server.upstream) {
      assert.ok(!/^\/(api|graphql|rupload|ajax\/bz|accounts)/.test(r.url), `forwarded upstream: ${r.method} ${r.url}`);
      assert.ok(!(r.cookie || '').includes(alice.cookie('sessionid')), 'a clone session reached upstream');
    }
  });

  await t.test('every clone API response is private and uncacheable', async () => {
    const res = await bob.get('/api/v1/feed/timeline/');
    assert.strictEqual(res.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.match(res.headers.get('vary') || '', /Cookie/);
  });
});
