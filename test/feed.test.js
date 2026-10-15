'use strict';

/**
 * Home feed against the database. Every expectation is computed from a direct
 * SQL query on the server's database, then compared to what the GraphQL and
 * REST timeline endpoints return.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer, Browser, pngBytes } = require('./clone-helpers');

async function post(browser, caption) {
  const uploadId = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  await browser.request('POST', `/rupload_igphoto/fb_uploader_${uploadId}`, {
    raw: pngBytes(),
    headers: { 'x-instagram-rupload-params': JSON.stringify({ upload_id: uploadId, media_type: 1 }) },
  });
  const res = await browser.post('/api/v1/media/configure/', { upload_id: uploadId, caption });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  return res.body.media;
}

async function graphqlFeed(browser, first = 50, after) {
  const res = await browser.post('/graphql/query', {
    doc_id: '28805668309050001',
    fb_api_req_friendly_name: 'PolarisFeedTimelineRootV2Query',
    variables: JSON.stringify(after ? { first, after } : { first }),
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  return res.body.data.xdt_api__v1__feed__timeline__connection;
}

test('the home feed is exactly what the database says the viewer may see', async (t) => {
  const server = await startCloneServer();
  t.after(() => server.close());
  const db = server.openDb();
  t.after(() => db.close());

  const users = {};
  for (const name of ['alice', 'bob', 'carol', 'dave', 'erin']) {
    users[name] = new Browser(server.base);
    users[name].pk = (await users[name].signup(server, { username: name })).pk;
  }
  await users.carol.post('/api/v1/accounts/set_private/', {});
  for (const caption of ['a1', 'a2', 'a3']) await post(users.alice, caption);
  await post(users.bob, 'b1');
  await post(users.carol, 'c1');
  await post(users.dave, 'd1');
  await post(users.erin, 'e1');
  const erin = users.erin;
  for (const name of ['alice', 'bob', 'carol']) await erin.post(`/api/v1/web/friendships/${users[name].pk}/follow/`, {});

  /** The feed computed independently from the database. */
  const expected = () => {
    const erinId = db.prepare("SELECT id FROM users WHERE username_ci = 'erin'").get().id;
    return db
      .prepare(
        `SELECT p.pk FROM posts p WHERE p.deleted_at IS NULL AND (p.author_id = ? OR p.author_id IN (
           SELECT followee_id FROM follows WHERE follower_id = ? AND state = 'accepted'))
         ORDER BY p.created_at DESC, p.id DESC`
      )
      .all(erinId, erinId)
      .map((r) => r.pk);
  };
  const actual = async () => (await graphqlFeed(erin)).edges.map((e) => e.node.media.pk);

  await t.test('followed public accounts and own posts appear newest first; pending and unfollowed do not', async () => {
    const pks = await actual();
    assert.deepStrictEqual(pks, expected());
    const captions = (await graphqlFeed(erin)).edges.map((e) => e.node.media.caption.text);
    assert.deepStrictEqual(captions, ['e1', 'b1', 'a3', 'a2', 'a1'], 'creation order was a1 a2 a3 b1 c1 d1 e1');
  });

  await t.test('REST timeline and GraphQL agree', async () => {
    const rest = await erin.get('/api/v1/feed/timeline/?count=50');
    assert.deepStrictEqual(rest.body.feed_items.map((i) => i.media_or_ad.pk), await actual());
    assert.strictEqual(rest.body.more_available, false);
  });

  await t.test('approval, unfollow and deletion are reflected immediately', async () => {
    await users.carol.post(`/api/v1/web/friendships/${erin.pk}/approve/`, {});
    assert.ok((await graphqlFeed(erin)).edges.some((e) => e.node.media.caption.text === 'c1'), 'approved private account appears');
    await erin.post(`/api/v1/web/friendships/${users.bob.pk}/unfollow/`, {});
    const a2 = (await graphqlFeed(erin)).edges.find((e) => e.node.media.caption.text === 'a2').node.media;
    await users.alice.post(`/api/v1/web/create/${a2.pk}/delete/`, {});
    const captions = (await graphqlFeed(erin)).edges.map((e) => e.node.media.caption.text);
    assert.ok(!captions.includes('b1') && !captions.includes('a2'));
    assert.deepStrictEqual(await actual(), expected());
  });

  await t.test('pagination walks the feed once, in order, with no gaps or repeats', async () => {
    const walked = [];
    let after;
    for (let page = 0; page < 20; page += 1) {
      const conn = await graphqlFeed(erin, 2, after);
      walked.push(...conn.edges.map((e) => e.node.media.pk));
      if (!conn.page_info.has_next_page) break;
      after = conn.page_info.end_cursor;
    }
    assert.deepStrictEqual(walked, expected());
  });

  await t.test('like state and counts in the feed match the likes table, per viewer', async () => {
    const a3 = (await graphqlFeed(erin)).edges.find((e) => e.node.media.caption.text === 'a3').node.media;
    await erin.post(`/api/v1/web/likes/${a3.pk}/like/`, {});
    await users.bob.post(`/api/v1/web/likes/${a3.pk}/like/`, {});
    const inFeed = (await graphqlFeed(erin)).edges.find((e) => e.node.media.pk === a3.pk).node.media;
    const count = db.prepare('SELECT COUNT(*) AS n FROM likes l JOIN posts p ON p.id = l.post_id WHERE p.pk = ?').get(a3.pk).n;
    assert.strictEqual(inFeed.like_count, count);
    assert.strictEqual(inFeed.has_liked, true);
    const asAlice = (await graphqlFeed(users.alice)).edges.find((e) => e.node.media.pk === a3.pk).node.media;
    assert.strictEqual(asAlice.has_liked, false, "another viewer's like is not yours");
  });

  await t.test('a viewer with no follows sees only their own posts, and anonymous gets no feed', async () => {
    assert.deepStrictEqual((await graphqlFeed(users.dave)).edges.map((e) => e.node.media.caption.text), ['d1']);
    const anon = new Browser(server.base);
    await anon.visit();
    const res = await anon.post('/graphql/query', { fb_api_req_friendly_name: 'PolarisFeedTimelineRootV2Query', variables: '{}' });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.data, null);
  });
});
