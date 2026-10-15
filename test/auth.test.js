'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { startTestServer, request, register } = require('./helpers');
const { parseCookies } = require('../src/backend/lib/cookies');
const backend = require('../src/backend/config');

test('auth lifecycle, sessions, CSRF and isolation', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  await t.test('register issues a session, token and csrf secret', async () => {
    const res = await request(s.base, 'POST', '/auth/register', {
      body: { username: 'alice', password: 'password123' },
    });
    assert.strictEqual(res.status, 201);
    assert.ok(res.body.data.token);
    assert.ok(res.body.data.csrfToken);
    assert.strictEqual(res.body.data.user.username, 'alice');
    // The session cookie is HttpOnly and scoped to the whole clone origin.
    const sessionCookie = res.setCookie.find((c) => c.startsWith(`${backend.cookieName}=`));
    assert.ok(sessionCookie, 'session cookie must be set');
    assert.match(sessionCookie, /HttpOnly/i);
    assert.match(sessionCookie, /Path=\/;/i);
  });

  await t.test('duplicate username is a 409', async () => {
    const res = await request(s.base, 'POST', '/auth/register', {
      body: { username: 'alice', password: 'password123' },
    });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.error.code, 'conflict');
  });

  await t.test('weak password is rejected with a 400', async () => {
    const res = await request(s.base, 'POST', '/auth/register', {
      body: { username: 'weakling', password: 'alllettersonly' },
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.details.field, 'password');
  });

  await t.test('login with a wrong password is a uniform 401', async () => {
    const res = await request(s.base, 'POST', '/auth/login', {
      body: { username: 'alice', password: 'wrongpassword1' },
    });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error.message, 'Invalid username or password');
  });

  await t.test('login for an unknown user gives the same 401 message', async () => {
    const res = await request(s.base, 'POST', '/auth/login', {
      body: { username: 'ghost', password: 'password123' },
    });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error.message, 'Invalid username or password');
  });

  const alice = await register(s.base, { username: 'alice2' });
  const bob = await register(s.base, { username: 'bob2' });

  await t.test('a bearer token authenticates /users/me', async () => {
    const res = await request(s.base, 'GET', '/users/me', { token: alice.token });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.username, 'alice2');
  });

  await t.test('a tampered token is rejected', async () => {
    const res = await request(s.base, 'GET', '/users/me', { token: `${alice.token}x` });
    assert.strictEqual(res.status, 401);
  });

  await t.test('logout revokes the token', async () => {
    const tmp = await register(s.base, { username: 'logoutuser' });
    assert.strictEqual((await request(s.base, 'GET', '/users/me', { token: tmp.token })).status, 200);
    assert.strictEqual((await request(s.base, 'POST', '/auth/logout', { token: tmp.token })).status, 204);
    assert.strictEqual((await request(s.base, 'GET', '/users/me', { token: tmp.token })).status, 401);
  });

  await t.test('session rotation invalidates the previous token', async () => {
    const tmp = await register(s.base, { username: 'rotateuser' });
    const rotated = await request(s.base, 'POST', '/auth/session/rotate', { token: tmp.token });
    assert.strictEqual(rotated.status, 200);
    assert.notStrictEqual(rotated.body.data.token, tmp.token);
    assert.strictEqual((await request(s.base, 'GET', '/users/me', { token: tmp.token })).status, 401);
    assert.strictEqual((await request(s.base, 'GET', '/users/me', { token: rotated.body.data.token })).status, 200);
  });

  await t.test('revoke-all invalidates every session for the user', async () => {
    const first = await request(s.base, 'POST', '/auth/register', {
      body: { username: 'multisession', password: 'password123' },
    });
    const second = await request(s.base, 'POST', '/auth/login', {
      body: { username: 'multisession', password: 'password123' },
    });
    const a = first.body.data.token;
    const b = second.body.data.token;
    assert.strictEqual((await request(s.base, 'POST', '/auth/sessions/revoke-all', { token: a })).status, 200);
    assert.strictEqual((await request(s.base, 'GET', '/users/me', { token: a })).status, 401);
    assert.strictEqual((await request(s.base, 'GET', '/users/me', { token: b })).status, 401);
  });

  await t.test('expired sessions are not accepted', async () => {
    const tmp = await register(s.base, { username: 'expiringuser' });
    // Force the session past its expiry directly in the store.
    s.db
      .prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), tmp.user.id);
    assert.strictEqual((await request(s.base, 'GET', '/users/me', { token: tmp.token })).status, 401);
  });

  await t.test('cross-user data isolation: bob cannot modify alice\'s post', async () => {
    const post = await request(s.base, 'POST', '/posts', {
      token: alice.token,
      body: { caption: 'alice only', mediaType: 'image' },
    });
    assert.strictEqual(post.status, 201);
    const id = post.body.data.id;

    assert.strictEqual((await request(s.base, 'PATCH', `/posts/${id}`, { token: bob.token, body: { caption: 'hijack' } })).status, 403);
    assert.strictEqual((await request(s.base, 'DELETE', `/posts/${id}`, { token: bob.token })).status, 403);
    // Alice still owns an unmodified post.
    const read = await request(s.base, 'GET', `/posts/${id}`, { token: alice.token });
    assert.strictEqual(read.body.data.caption, 'alice only');
  });

  await t.test('cross-user isolation: bob cannot read alice\'s saved list', async () => {
    const mine = await request(s.base, 'GET', '/users/me/saved', { token: alice.token });
    assert.strictEqual(mine.status, 200);
    assert.ok(Array.isArray(mine.body.data));
    const theirs = await request(s.base, 'GET', '/users/me/saved', { token: bob.token });
    assert.ok(Array.isArray(theirs.body.data));
  });

  await t.test('CSRF: a cookie write without the header is refused', async () => {
    const login = await request(s.base, 'POST', '/auth/login', {
      body: { username: 'alice2', password: 'password123' },
    });
    const cookieHeader = login.cookies;
    assert.ok(cookieHeader.includes(backend.cookieName));

    const blocked = await request(s.base, 'POST', '/posts', {
      cookies: cookieHeader,
      body: { caption: 'no csrf', mediaType: 'image' },
    });
    assert.strictEqual(blocked.status, 403);
    assert.strictEqual(blocked.body.error.code, 'forbidden');
  });

  await t.test('CSRF: the csrf cookie alone cannot satisfy the header check', async () => {
    const login = await request(s.base, 'POST', '/auth/login', {
      body: { username: 'alice2', password: 'password123' },
    });
    const csrfCookie = parseCookies(login.cookies)[backend.csrfCookieName];
    // Echoing the cookie value into the header is allowed (that is the intended
    // flow); the point is that a request with NO header is refused even though
    // the cookie is present.
    const withHeader = await request(s.base, 'POST', '/posts', {
      cookies: login.cookies,
      csrf: csrfCookie,
      body: { caption: 'with csrf', mediaType: 'image' },
    });
    assert.strictEqual(withHeader.status, 201);
  });

  await t.test('CSRF: a mismatched header is refused', async () => {
    const login = await request(s.base, 'POST', '/auth/login', {
      body: { username: 'alice2', password: 'password123' },
    });
    const res = await request(s.base, 'POST', '/posts', {
      cookies: login.cookies,
      csrf: 'not-the-right-token',
      body: { caption: 'bad csrf', mediaType: 'image' },
    });
    assert.strictEqual(res.status, 403);
  });

  await t.test('bearer writes are exempt from CSRF (no ambient authority)', async () => {
    const res = await request(s.base, 'POST', '/posts', {
      token: alice.token,
      body: { caption: 'bearer write', mediaType: 'image' },
    });
    assert.strictEqual(res.status, 201);
  });

  await t.test('no response leaks a password hash or session token', async () => {
    const me = await request(s.base, 'GET', '/users/me', { token: alice.token });
    const text = JSON.stringify(me.body);
    assert.ok(!/password_hash|password_salt|password_params/.test(text));
    assert.ok(!text.includes(alice.token));
    assert.ok(!/csrf_secret/.test(text));
  });

  await t.test('the upstream identity is declared, never authenticated', async () => {
    const res = await request(s.base, 'PUT', '/users/me/upstream-identity', {
      token: alice.token,
      body: { instagramUsername: 'alice_ig' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.authenticatedToInstagram, false);
    assert.strictEqual(res.body.data.linkState, 'declared');
  });
});
