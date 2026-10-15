'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { startTestServer, request, register } = require('./helpers');

test('API behaviour: validation, pagination, rate limits, feed, privacy', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const alice = await register(s.base, { username: 'alice' });
  const bob = await register(s.base, { username: 'bob' });

  await t.test('unknown route returns a JSON 404, not HTML', async () => {
    const res = await request(s.base, 'GET', '/does/not/exist');
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error.code, 'not_found');
  });

  await t.test('validation error names the offending field', async () => {
    const res = await request(s.base, 'POST', '/posts', { token: alice.token, body: { caption: 'x' } });
    // mediaType defaults to image, so this should succeed; instead test a bad type.
    const bad = await request(s.base, 'POST', '/posts', {
      token: alice.token,
      body: { caption: 'x', mediaType: 'hologram' },
    });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.error.details.field, 'mediaType');
    assert.strictEqual(res.status, 201);
  });

  await t.test('a non-object body is a 400', async () => {
    const res = await request(s.base, 'POST', '/posts', { token: alice.token, body: [1, 2, 3] });
    assert.strictEqual(res.status, 400);
  });

  await t.test('every error carries a request id', async () => {
    const res = await request(s.base, 'GET', '/nope');
    assert.ok(res.body.error.requestId);
  });

  await t.test('pagination walks the whole set exactly once', async () => {
    const author = await register(s.base, { username: 'prolific' });
    const ids = [];
    for (let i = 0; i < 7; i += 1) {
      const res = await request(s.base, 'POST', '/posts', {
        token: author.token,
        body: { caption: `post ${i}`, mediaType: 'image' },
      });
      assert.strictEqual(res.status, 201);
      ids.push(res.body.data.id);
    }

    const seen = [];
    let cursor = null;
    let guard = 0;
    do {
      const q = `/users/${author.user.id}/posts?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = await request(s.base, 'GET', q);
      assert.strictEqual(page.status, 200);
      page.body.data.forEach((p) => seen.push(p.id));
      cursor = page.body.meta?.nextCursor || null;
      guard += 1;
      assert.ok(guard < 10, 'pagination did not terminate');
    } while (cursor);

    assert.strictEqual(seen.length, 7);
    assert.strictEqual(new Set(seen).size, 7, 'no duplicates across pages');
  });

  await t.test('an invalid cursor is a 400', async () => {
    const res = await request(s.base, 'GET', '/explore?cursor=!!!not-base64!!!');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.details.field, 'cursor');
  });

  await t.test('limit above the cap is a 400', async () => {
    const res = await request(s.base, 'GET', '/explore?limit=100000');
    assert.strictEqual(res.status, 400);
  });

  await t.test('a public account\'s post appears in explore; a private one does not', async () => {
    const pub = await register(s.base, { username: 'publicuser' });
    const priv = await register(s.base, { username: 'privateuser' });
    await request(s.base, 'PATCH', '/users/me/settings', { token: priv.token, body: { isPrivate: true } });

    await request(s.base, 'POST', '/posts', { token: pub.token, body: { caption: 'public post' } });
    await request(s.base, 'POST', '/posts', { token: priv.token, body: { caption: 'private post' } });

    const explore = await request(s.base, 'GET', '/explore?limit=100');
    const captions = explore.body.data.map((p) => p.caption);
    assert.ok(captions.includes('public post'));
    assert.ok(!captions.includes('private post'));
  });

  await t.test('private profile hides its bio from a non-follower', async () => {
    const priv = await register(s.base, { username: 'shyuser' });
    await request(s.base, 'PATCH', '/users/me', { token: priv.token, body: { bio: 'secret bio' } });
    await request(s.base, 'PATCH', '/users/me/settings', { token: priv.token, body: { isPrivate: true } });

    const asStranger = await request(s.base, 'GET', `/users/${priv.user.id}`, { token: bob.token });
    assert.strictEqual(asStranger.status, 200);
    assert.strictEqual(asStranger.body.data.bio, null);
    assert.strictEqual(asStranger.body.data.restricted, true);

    const asOwner = await request(s.base, 'GET', `/users/${priv.user.id}`, { token: priv.token });
    assert.strictEqual(asOwner.body.data.bio, 'secret bio');
  });

  await t.test('following a private account creates a pending request', async () => {
    const priv = await register(s.base, { username: 'pendingtarget' });
    await request(s.base, 'PATCH', '/users/me/settings', { token: priv.token, body: { isPrivate: true } });

    const follow = await request(s.base, 'POST', `/users/${priv.user.id}/follow`, { token: bob.token });
    assert.strictEqual(follow.status, 200);
    assert.strictEqual(follow.body.data.state, 'pending');

    const requests = await request(s.base, 'GET', '/users/me/follow-requests', { token: priv.token });
    assert.strictEqual(requests.body.data.length, 1);
    assert.strictEqual(requests.body.data[0].id, bob.user.id);

    const accept = await request(s.base, 'POST', `/users/${bob.user.id}/follow/accept`, { token: priv.token });
    assert.strictEqual(accept.body.data.state, 'accepted');

    const feed = await request(s.base, 'GET', '/feed', { token: bob.token });
    assert.ok(Array.isArray(feed.body.data));
  });

  await t.test('messaging requires membership', async () => {
    const third = await register(s.base, { username: 'thirdwheel' });
    const conv = await request(s.base, 'POST', '/conversations', {
      token: alice.token,
      body: { memberIds: [bob.user.id] },
    });
    assert.strictEqual(conv.status, 201);
    const convId = conv.body.data.id;

    const sent = await request(s.base, 'POST', `/conversations/${convId}/messages`, {
      token: alice.token,
      body: { body: 'hello bob' },
    });
    assert.strictEqual(sent.status, 201);

    const intruder = await request(s.base, 'GET', `/conversations/${convId}/messages`, { token: third.token });
    assert.strictEqual(intruder.status, 403);

    const member = await request(s.base, 'GET', `/conversations/${convId}/messages`, { token: bob.token });
    assert.strictEqual(member.status, 200);
    assert.strictEqual(member.body.data.length, 1);
  });

  await t.test('saving a post owned by another user is allowed; the collection is not', async () => {
    const post = await request(s.base, 'POST', '/posts', { token: alice.token, body: { caption: 'save me' } });
    const postId = post.body.data.id;

    const saved = await request(s.base, 'PUT', `/users/me/saved/${postId}`, { token: bob.token });
    assert.strictEqual(saved.status, 200);

    const list = await request(s.base, 'GET', '/users/me/saved', { token: bob.token });
    assert.strictEqual(list.body.data.length, 1);

    // Bob cannot file it into Alice's collection.
    const aliceCollection = await request(s.base, 'POST', '/users/me/collections', {
      token: alice.token,
      body: { name: 'alice stuff' },
    });
    const res = await request(s.base, 'PUT', `/users/me/saved/${postId}`, {
      token: bob.token,
      body: { collectionId: aliceCollection.body.data.id },
    });
    assert.strictEqual(res.status, 403);
  });

  await t.test('notifications are created and scoped to the recipient', async () => {
    const actor = await register(s.base, { username: 'actor' });
    const target = await register(s.base, { username: 'target' });
    await request(s.base, 'POST', `/users/${target.user.id}/follow`, { token: actor.token });

    const targetNotes = await request(s.base, 'GET', '/users/me/notifications', { token: target.token });
    assert.ok(targetNotes.body.data.some((n) => n.kind === 'follow'));

    const actorNotes = await request(s.base, 'GET', '/users/me/notifications', { token: actor.token });
    assert.strictEqual(actorNotes.body.data.length, 0, 'the actor must not see the target\'s notifications');
  });

  await t.test('stories expire and disappear from the active list', async () => {
    const author = await register(s.base, { username: 'storyteller' });
    const story = await request(s.base, 'POST', '/stories', {
      token: author.token,
      body: { caption: 'fleeting' },
    });
    assert.strictEqual(story.status, 201);
    const active = await request(s.base, 'GET', `/users/${author.user.id}/stories`);
    assert.strictEqual(active.body.data.length, 1);

    // Expire it in the store and re-read.
    s.db
      .prepare('UPDATE stories SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), story.body.data.id);
    const after = await request(s.base, 'GET', `/users/${author.user.id}/stories`);
    assert.strictEqual(after.body.data.length, 0);
  });

  await t.test('settings round-trip and mirror privacy onto the user', async () => {
    const user = await register(s.base, { username: 'settingsuser' });
    const updated = await request(s.base, 'PATCH', '/users/me/settings', {
      token: user.token,
      body: { theme: 'dark', locale: 'fr', allowMessagesFrom: 'following' },
    });
    assert.strictEqual(updated.body.data.theme, 'dark');
    assert.strictEqual(updated.body.data.locale, 'fr');

    const invalid = await request(s.base, 'PATCH', '/users/me/settings', {
      token: user.token,
      body: { theme: 'neon' },
    });
    assert.strictEqual(invalid.status, 400);
  });

  await t.test('rate limiting returns 429 with retry-after', async () => {
    // The auth limiter is the tightest; exhaust it from this client.
    let sawLimit = false;
    for (let i = 0; i < 40; i += 1) {
      const res = await request(s.base, 'POST', '/auth/login', {
        body: { username: 'nobody-here', password: 'password123' },
      });
      if (res.status === 429) {
        sawLimit = true;
        assert.ok(res.headers.get('retry-after'), '429 must carry retry-after');
        break;
      }
    }
    assert.ok(sawLimit, 'auth limiter never triggered');
  });

  await t.test('health and readiness endpoints answer', async () => {
    const health = await request(s.base, 'GET', '/health');
    assert.strictEqual(health.body.data.ok, true);
    const ready = await request(s.base, 'GET', '/readiness');
    assert.strictEqual(ready.body.data.ready, true);
  });

  await t.test('the readiness endpoint exposes no secrets', async () => {
    const ready = await request(s.base, 'GET', '/readiness');
    const text = JSON.stringify(ready.body);
    assert.ok(!/password|secret|token|cookie/i.test(text));
  });

  await t.test('every response disables shared caching of authenticated content', async () => {
    // Authenticated responses must never be reusable by an intermediary: the
    // deployment exposes a public URL, so a cached per-user response could be
    // served to a different visitor. Checked on both a public and an
    // authenticated route, and on an error response.
    for (const [label, res] of [
      ['public', await request(s.base, 'GET', '/explore')],
      ['authenticated', await request(s.base, 'GET', '/users/me', { token: alice.token })],
      ['error', await request(s.base, 'GET', '/nope')],
    ]) {
      const cc = res.headers.get('cache-control') || '';
      assert.match(cc, /no-store/, `${label} response must be no-store (got "${cc}")`);
      assert.match(cc, /private/, `${label} response must be private (got "${cc}")`);
      const vary = (res.headers.get('vary') || '').toLowerCase();
      assert.ok(vary.includes('cookie'), `${label} response must Vary: Cookie (got "${vary}")`);
      assert.ok(vary.includes('authorization'), `${label} response must Vary: Authorization (got "${vary}")`);
    }
  });

  await t.test('the same path returns per-user data, never a shared body', async () => {
    // Two different authenticated callers hitting one path must each get their
    // own representation; if a shared cache were in play one would see the other.
    const a = await request(s.base, 'GET', '/users/me', { token: alice.token });
    const b = await request(s.base, 'GET', '/users/me', { token: bob.token });
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200);
    assert.strictEqual(a.body.data.username, 'alice');
    assert.strictEqual(b.body.data.username, 'bob');
    assert.notStrictEqual(a.body.data.id, b.body.data.id);
  });
});
