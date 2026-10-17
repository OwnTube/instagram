'use strict';

/**
 * Authorization regression tests for content owned by private accounts, and for
 * the data-model invariants the original client relies on (numeric pks,
 * shortcodes). Each case was a real gap before migration 0002.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startTestServer, request, register } = require('./helpers');
const { shortcodeFromPk, pkFromShortcode, newPk } = require('../src/backend/lib/ids');
const { openDatabase, migrate } = require('../src/backend/db');

test('private content is invisible to non-followers', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  const owner = await register(s.base, { username: 'priv_owner' });
  const stranger = await register(s.base, { username: 'stranger1' });
  const follower = await register(s.base, { username: 'follower1' });
  const as = (u) => ({ token: u.token });

  await request(s.base, 'PATCH', '/users/me', { ...as(owner), body: { isPrivate: true } });
  const post = (await request(s.base, 'POST', '/posts', { ...as(owner), body: { caption: 'secret' } })).body.data;
  assert.match(post.pk, /^\d+$/);
  assert.strictEqual(post.code, shortcodeFromPk(post.pk));

  await request(s.base, 'POST', `/users/${owner.user.id}/follow`, as(follower));
  await request(s.base, 'POST', `/users/${follower.user.id}/follow/accept`, as(owner));

  await t.test('anonymous and stranger reads are 404, follower read succeeds', async () => {
    assert.strictEqual((await request(s.base, 'GET', `/posts/${post.id}`)).status, 404);
    assert.strictEqual((await request(s.base, 'GET', `/posts/${post.id}`, as(stranger))).status, 404);
    const ok = await request(s.base, 'GET', `/posts/${post.id}`, as(follower));
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.data.caption, 'secret');
  });

  await t.test('a stranger cannot like, comment on, save, or list comments of it', async () => {
    assert.strictEqual((await request(s.base, 'POST', `/posts/${post.id}/likes`, as(stranger))).status, 404);
    assert.strictEqual(
      (await request(s.base, 'POST', `/posts/${post.id}/comments`, { ...as(stranger), body: { body: 'hi' } })).status,
      404
    );
    assert.strictEqual((await request(s.base, 'PUT', `/users/me/saved/${post.id}`, { ...as(stranger), body: {} })).status, 404);
    assert.strictEqual((await request(s.base, 'GET', `/posts/${post.id}/comments`, as(stranger))).status, 404);
    assert.strictEqual(s.db.prepare('SELECT COUNT(*) AS n FROM likes').get().n, 0, 'no like row may be written');
  });

  await t.test('stories of a private account are hidden from strangers', async () => {
    const story = (await request(s.base, 'POST', '/stories', { ...as(owner), body: { caption: 'x' } })).body.data;
    assert.strictEqual((await request(s.base, 'GET', `/stories/${story.id}`, as(stranger))).status, 404);
    assert.strictEqual((await request(s.base, 'GET', `/stories/${story.id}`, as(follower))).status, 200);
    const list = await request(s.base, 'GET', `/users/${owner.user.id}/stories`, as(follower));
    assert.strictEqual(list.body.data.length, 1);
  });

  await t.test('a saved post disappears from the saver once they lose access', async () => {
    const pub = await register(s.base, { username: 'went_private' });
    const p2 = (await request(s.base, 'POST', '/posts', { ...as(pub), body: { caption: 'was public' } })).body.data;
    await request(s.base, 'PUT', `/users/me/saved/${p2.id}`, { ...as(stranger), body: {} });
    assert.strictEqual((await request(s.base, 'GET', '/users/me/saved', as(stranger))).body.data.length, 1);
    await request(s.base, 'PATCH', '/users/me', { ...as(pub), body: { isPrivate: true } });
    assert.strictEqual((await request(s.base, 'GET', '/users/me/saved', as(stranger))).body.data.length, 0);
  });
});

test('interaction side effects and ownership', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const a = await register(s.base, { username: 'author_a' });
  const b = await register(s.base, { username: 'liker_b' });
  const c = await register(s.base, { username: 'third_c' });
  const post = (await request(s.base, 'POST', '/posts', { token: a.token, body: { caption: 'p' } })).body.data;

  await t.test('a like notifies the author exactly once; self-likes notify nobody', async () => {
    await request(s.base, 'POST', `/posts/${post.id}/likes`, { token: b.token });
    await request(s.base, 'POST', `/posts/${post.id}/likes`, { token: b.token });
    await request(s.base, 'POST', `/posts/${post.id}/likes`, { token: a.token });
    const n = s.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'like'").get().n;
    assert.strictEqual(n, 1);
    assert.strictEqual(s.db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?').get(post.id).n, 2);
  });

  await t.test('the post author may delete a comment on their post; a third user may not', async () => {
    const cm = (await request(s.base, 'POST', `/posts/${post.id}/comments`, { token: b.token, body: { body: 'nice' } })).body.data;
    assert.strictEqual((await request(s.base, 'DELETE', `/comments/${cm.id}`, { token: c.token })).status, 403);
    assert.strictEqual((await request(s.base, 'DELETE', `/comments/${cm.id}`, { token: a.token })).status, 204);
  });

  await t.test('allow_messages_from is enforced when starting a conversation', async () => {
    await request(s.base, 'PATCH', '/users/me/settings', { token: a.token, body: { allowMessagesFrom: 'none' } });
    const denied = await request(s.base, 'POST', '/conversations', { token: b.token, body: { memberIds: [a.user.id] } });
    assert.strictEqual(denied.status, 403);
    await request(s.base, 'PATCH', '/users/me/settings', { token: a.token, body: { allowMessagesFrom: 'following' } });
    assert.strictEqual(
      (await request(s.base, 'POST', '/conversations', { token: b.token, body: { memberIds: [a.user.id] } })).status,
      403
    );
    await request(s.base, 'POST', `/users/${b.user.id}/follow`, { token: a.token });
    assert.strictEqual(
      (await request(s.base, 'POST', '/conversations', { token: b.token, body: { memberIds: [a.user.id] } })).status,
      201
    );
  });
});

test('pk and shortcode invariants', async (t) => {
  await t.test('shortcodes round-trip to their pk', () => {
    for (let i = 0; i < 200; i += 1) {
      const pk = newPk();
      assert.strictEqual(pkFromShortcode(shortcodeFromPk(pk)), pk);
    }
    assert.strictEqual(pkFromShortcode('bad code!'), null);
  });

  await t.test('migration 0002 backfills pks onto rows created before it', () => {
    const db = openDatabase(':memory:');
    const { migrations } = require('../src/backend/db/migrations');
    const first = migrations[0];
    db.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    first.up(db);
    db.prepare("INSERT INTO schema_migrations VALUES ('0001_core', 'x')").run();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO users (id, username, username_ci, created_at, updated_at) VALUES ('u1', 'Old', 'old', ?, ?)"
    ).run(now, now);
    db.prepare("INSERT INTO posts (id, author_id, created_at, updated_at) VALUES ('p1', 'u1', ?, ?)").run(now, now);
    assert.deepStrictEqual(migrate(db), ['0002_client_compat', '0003_relationship_lists', '0004_story_likes', '0005_highlights']);
    const user = db.prepare('SELECT pk FROM users').get();
    const p = db.prepare('SELECT pk, code FROM posts').get();
    assert.match(user.pk, /^\d+$/);
    assert.strictEqual(p.code, shortcodeFromPk(p.pk));
    assert.throws(
      () => db.prepare("INSERT INTO posts (id, pk, author_id, created_at, updated_at) VALUES ('p2', ?, 'u1', ?, ?)").run(p.pk, now, now),
      /UNIQUE/,
      'post pks must be unique'
    );
  });
});
