'use strict';

/**
 * Signup, verification, login, session lifecycle and isolation, over real HTTP
 * against the full server and a disposable database. Requests use the original
 * client's formats (form-encoded, X-CSRFToken, enc_password v10). Database
 * state is checked directly, not just inferred from responses.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer, Browser } = require('./clone-helpers');
const { encryptLikeClient } = require('../src/clone/passwordEncryption');

const PASSWORD = 'correct horse 42';

test('signup and email verification', async (t) => {
  const server = await startCloneServer({ CLONE_MAIL_TRANSPORT: 'outbox' });
  t.after(() => server.close());
  const db = server.openDb();
  t.after(() => db.close());
  const outboxCode = async (email) => {
    const res = await fetch(`${server.base}/__clone/dev/outbox`, { signal: AbortSignal.timeout(15000) });
    const body = await res.json();
    return body.messages.find((m) => m.to === email).code;
  };

  await t.test('the development outbox delivers the code, and the code is never logged', async () => {
    const b = new Browser(server.base);
    const { pk } = await b.signup(server, { username: 'outbox_user', codeFor: outboxCode });
    assert.match(pk, /^\d+$/);
    const code = (await (await fetch(`${server.base}/__clone/dev/outbox`)).json()).messages[0].code;
    assert.ok(!server.logs.some((line) => line.includes(code)), 'a signup code must not appear in the logs');
    const proxied = await fetch(`${server.base}/__clone/dev/outbox`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert.strictEqual(proxied.status, 404, 'the outbox is not reachable through a proxy');
  });

  await t.test('the account is stored with a hashed password, lowercased email and no plaintext code', async () => {
    const row = db.prepare("SELECT * FROM users WHERE username_ci = 'outbox_user'").get();
    assert.ok(row);
    assert.strictEqual(row.email_ci, 'outbox_user@example.test');
    assert.ok(row.password_hash && !row.password_hash.includes(PASSWORD));
    assert.match(row.password_params, /^\d+:\d+:\d+:\d+$/);
    for (const c of db.prepare("SELECT code_hash FROM signup_codes WHERE email_ci = 'outbox_user@example.test'").all()) {
      assert.match(c.code_hash, /^[0-9a-f]{64}$/, 'codes are stored hashed');
    }
    const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(row.id);
    assert.ok(settings, 'settings row created in the same transaction');
  });

  await t.test('invalid inputs are rejected per field', async () => {
    const b = new Browser(server.base);
    await b.visit();
    const res = await b.post('/api/v1/web/accounts/web_create_ajax/attempt/', {
      username: 'no spaces allowed',
      email: 'not-an-email',
      enc_password: await b.encPassword('short'),
    });
    assert.strictEqual(res.body.dryrun_passed, false);
    assert.deepStrictEqual(Object.keys(res.body.errors).sort(), ['email', 'password', 'username']);
  });

  await t.test('duplicate username and duplicate email are rejected, case-insensitively', async () => {
    const b = new Browser(server.base);
    await b.visit();
    const res = await b.post('/api/v1/web/accounts/web_create_ajax/attempt/', {
      username: 'OUTBOX_USER',
      email: 'Outbox_User@Example.Test',
      enc_password: await b.encPassword(PASSWORD),
    });
    assert.strictEqual(res.body.errors.username[0].code, 'username_is_taken');
    assert.strictEqual(res.body.errors.email[0].code, 'email_is_taken');
  });

  await t.test('a wrong code fails, a used code cannot be reused, and a resend invalidates the old code', async () => {
    const b = new Browser(server.base);
    await b.visit();
    const email = 'codes@example.test';
    await b.post('/api/v1/accounts/send_verify_email/', { email });
    const first = await outboxCode(email);
    await b.post('/api/v1/accounts/send_verify_email/', { email });
    const second = await outboxCode(email);
    if (first !== second) {
      const stale = await b.post('/api/v1/accounts/check_confirmation_code/', { email, code: first });
      assert.strictEqual(stale.status, 400, 'an earlier code stops working after a resend');
    }
    const wrong = await b.post('/api/v1/accounts/check_confirmation_code/', { email, code: second === '123456' ? '654321' : '123456' });
    assert.strictEqual(wrong.status, 400);
    const ok = await b.post('/api/v1/accounts/check_confirmation_code/', { email, code: second });
    assert.strictEqual(ok.status, 200);
    assert.ok(ok.body.signup_code);
    const reused = await b.post('/api/v1/accounts/check_confirmation_code/', { email, code: second });
    assert.strictEqual(reused.status, 400, 'a code works once');
  });

  await t.test('too many wrong guesses lock the code, even the right one', async () => {
    const b = new Browser(server.base);
    await b.visit();
    const email = 'guesses@example.test';
    await b.post('/api/v1/accounts/send_verify_email/', { email });
    const code = await outboxCode(email);
    const wrongCode = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) await b.post('/api/v1/accounts/check_confirmation_code/', { email, code: wrongCode });
    const right = await b.post('/api/v1/accounts/check_confirmation_code/', { email, code });
    assert.strictEqual(right.status, 400);
  });

  await t.test('an expired code is rejected', async () => {
    const b = new Browser(server.base);
    await b.visit();
    const email = 'expired@example.test';
    await b.post('/api/v1/accounts/send_verify_email/', { email });
    const code = await outboxCode(email);
    db.prepare('UPDATE signup_codes SET expires_at = ? WHERE email_ci = ?').run(new Date(Date.now() - 1000).toISOString(), email);
    const res = await b.post('/api/v1/accounts/check_confirmation_code/', { email, code });
    assert.strictEqual(res.status, 400);
  });

  await t.test('resends are rate limited per email', async () => {
    const b = new Browser(server.base);
    await b.visit();
    const statuses = [];
    for (let i = 0; i < 7; i += 1) statuses.push((await b.post('/api/v1/accounts/send_verify_email/', { email: 'spam@example.test' })).status);
    assert.ok(statuses.includes(429), `expected a 429 among ${statuses}`);
  });

  await t.test('a signup token creates exactly one account and is spent afterwards', async () => {
    const b = new Browser(server.base);
    await b.visit();
    const email = 'once@example.test';
    await b.post('/api/v1/accounts/send_verify_email/', { email });
    const checked = await b.post('/api/v1/accounts/check_confirmation_code/', { email, code: await outboxCode(email) });
    const form = async (username) => ({
      username,
      email,
      enc_password: await b.encPassword(PASSWORD),
      day: 1,
      month: 1,
      year: 1990,
      force_sign_up_code: checked.body.signup_code,
    });
    const [a, c] = await Promise.all([
      b.post('/api/v1/web/accounts/web_create_ajax/', await form('once_a')),
      b.post('/api/v1/web/accounts/web_create_ajax/', await form('once_b')),
    ]);
    const created = [a, c].filter((r) => r.body.account_created);
    assert.strictEqual(created.length, 1, 'concurrent submissions create one account');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM users WHERE email_ci = ?').get(email).n, 1);
    const again = await b.post('/api/v1/web/accounts/web_create_ajax/', await form('once_c'));
    assert.strictEqual(again.body.account_created, false);
  });

  await t.test('a code for one email does not verify another', async () => {
    const b = new Browser(server.base);
    await b.visit();
    await b.post('/api/v1/accounts/send_verify_email/', { email: 'mine@example.test' });
    const checked = await b.post('/api/v1/accounts/check_confirmation_code/', { email: 'mine@example.test', code: await outboxCode('mine@example.test') });
    const res = await b.post('/api/v1/web/accounts/web_create_ajax/', {
      username: 'theirs_user',
      email: 'theirs@example.test',
      enc_password: await b.encPassword(PASSWORD),
      force_sign_up_code: checked.body.signup_code,
    });
    assert.strictEqual(res.body.account_created, false);
  });

  await t.test('in production with no email provider, sending a code fails clearly', async () => {
    const prod = await startCloneServer({ NODE_ENV: 'production', CLONE_MAIL_TRANSPORT: '' });
    try {
      const b = new Browser(prod.base);
      await b.visit();
      const res = await b.post('/api/v1/accounts/send_verify_email/', { email: 'prod@example.test' });
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.body.status, 'fail');
      assert.strictEqual((await fetch(`${prod.base}/__clone/dev/outbox`)).status, 404);
    } finally {
      await prod.close();
    }
  });
});

test('login, sessions and isolation', async (t) => {
  const server = await startCloneServer();
  t.after(() => server.close());
  const db = server.openDb();
  t.after(() => db.close());

  const alice = new Browser(server.base);
  const bob = new Browser(server.base);
  const alicePk = (await alice.signup(server, { username: 'alice', fullName: 'Alice' })).pk;
  const bobPk = (await bob.signup(server, { username: 'bob' })).pk;

  async function login(b, username, password = PASSWORD) {
    await b.visit();
    return b.post('/api/v1/web/accounts/login/ajax/', {
      username,
      enc_password: await b.encPassword(password),
      queryParams: '{}',
      optIntoOneTap: 'false',
      trustedDeviceRecords: '{}',
    });
  }

  await t.test('login by username (any case) and by email', async () => {
    for (const name of ['alice', 'ALICE', 'alice@example.test']) {
      const res = await login(new Browser(server.base), name);
      assert.strictEqual(res.body.authenticated, true, name);
      assert.strictEqual(res.body.userId, alicePk);
    }
  });

  await t.test('the session is stored hashed, and the cookie is HttpOnly with the CSRF cookie readable', async () => {
    const b = new Browser(server.base);
    await b.visit();
    const res = await b.request('POST', '/api/v1/web/accounts/login/ajax/', {
      form: { username: 'alice', enc_password: await b.encPassword(PASSWORD) },
    });
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith('sessionid='));
    assert.match(session, /HttpOnly/);
    assert.match(session, /SameSite=Lax/);
    assert.ok(!/HttpOnly/.test(cookies.find((c) => c.startsWith('csrftoken='))));
    const token = b.cookie('sessionid');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(token).n, 0, 'the raw token is not stored');
  });

  await t.test('authenticated requests resolve to the right user', async () => {
    assert.strictEqual((await alice.get('/api/v1/accounts/current_user/')).body.user.pk, alicePk);
    assert.strictEqual((await bob.get('/api/v1/accounts/current_user/')).body.user.pk, bobPk);
    assert.strictEqual((await bob.get('/api/v1/accounts/edit/web_form_data/')).body.form_data.email, 'bob@example.test');
  });

  await t.test("one user's session cannot read another's private data", async () => {
    const sent = await bob.post('/api/v1/direct_v2/threads/broadcast/text/', { recipient_users: [[alicePk]], text: 'private note' });
    const threadId = sent.body.payload.thread_id;
    const carol = new Browser(server.base);
    await carol.signup(server, { username: 'carol' });
    assert.strictEqual((await carol.get(`/api/v1/direct_v2/threads/${threadId}/`)).status, 403);
    assert.strictEqual((await carol.get('/api/v1/direct_v2/inbox/')).body.inbox.threads.length, 0);
    assert.notStrictEqual((await carol.get('/api/v1/accounts/edit/web_form_data/')).body.form_data.email, 'bob@example.test');
  });

  await t.test('an encrypted password for a key we do not own is rejected with a clear reason', async () => {
    const b = new Browser(server.base);
    await b.visit();
    const enc = await b.encryption();
    const otherKeyId = (Number(enc.key_id) % 255) + 1;
    const res = await b.post('/api/v1/web/accounts/login/ajax/', {
      username: 'alice',
      enc_password: encryptLikeClient({ keyId: otherKeyId, publicKeyHex: enc.public_key, password: PASSWORD, time: Math.floor(Date.now() / 1000) }),
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error_details.reason, 'foreign_encryption_key');
    const health = await (await fetch(`${server.base}/__clone/health`)).json();
    assert.ok(health.passwordDecryptFailures['unknown key id'] >= 1);
  });

  await t.test('logout revokes the session in the database', async () => {
    const b = new Browser(server.base);
    await login(b, 'alice');
    const token = b.cookie('sessionid');
    await b.post('/api/v1/web/accounts/logout/ajax/', { one_tap_app_login: 0, user_id: alicePk });
    assert.strictEqual(b.cookie('sessionid'), undefined, 'the cookie is cleared');
    const replay = await fetch(`${server.base}/api/v1/feed/timeline/`, { headers: { cookie: `sessionid=${encodeURIComponent(token)}` } });
    assert.strictEqual(replay.status, 401, 'the old token no longer works');
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NOT NULL').get().n >= 1);
  });

  await t.test('an expired or revoked session is refused', async () => {
    const b = new Browser(server.base);
    await login(b, 'bob');
    assert.strictEqual((await b.get('/api/v1/feed/timeline/')).status, 200);
    const userId = db.prepare("SELECT id FROM users WHERE username_ci = 'bob'").get().id;
    db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(new Date(Date.now() - 1000).toISOString(), userId);
    assert.strictEqual((await b.get('/api/v1/feed/timeline/')).status, 401, 'expired');
    await login(b, 'bob');
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(new Date().toISOString(), userId);
    assert.strictEqual((await b.get('/api/v1/feed/timeline/')).status, 401, 'revoked');
    await login(bob, 'bob');
  });

  await t.test('changing the password revokes other sessions and the old password stops working', async () => {
    const other = new Browser(server.base);
    await login(other, 'alice');
    const res = await alice.post('/api/v1/web/accounts/password/change/', {
      enc_old_password: await alice.encPassword(PASSWORD),
      enc_new_password1: await alice.encPassword('a brand new pass 7'),
      enc_new_password2: await alice.encPassword('a brand new pass 7'),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await other.get('/api/v1/feed/timeline/')).status, 401);
    assert.strictEqual((await alice.get('/api/v1/feed/timeline/')).status, 200, 'the changing session gets a fresh one');
    assert.strictEqual((await login(new Browser(server.base), 'alice')).body.authenticated, false);
    assert.strictEqual((await login(new Browser(server.base), 'alice', 'a brand new pass 7')).body.authenticated, true);
  });

  await t.test('re-login after logout works', async () => {
    const b = new Browser(server.base);
    await login(b, 'bob');
    await b.post('/api/v1/web/accounts/logout/ajax/', {});
    const again = await login(b, 'bob');
    assert.strictEqual(again.body.authenticated, true);
    assert.strictEqual((await b.get('/api/v1/accounts/current_user/')).body.user.username, 'bob');
  });
});

test('users and sessions survive a server restart', async () => {
  const first = await startCloneServer({}, { keepDir: true });
  const b = new Browser(first.base);
  let pk;
  let keyBefore;
  try {
    pk = (await b.signup(first, { username: 'durable' })).pk;
    keyBefore = await b.encryption();
  } finally {
    await first.close();
  }
  const second = await startCloneServer({}, { dir: first.dir });
  try {
    b.base = second.base;
    const me = await b.get('/api/v1/accounts/current_user/');
    assert.strictEqual(me.status, 200, 'the existing session still works');
    assert.strictEqual(me.body.user.pk, pk);
    assert.deepStrictEqual(await b.encryption(), keyBefore, 'the password-encryption key persists');
    const fresh = new Browser(second.base);
    await fresh.visit();
    const login = await fresh.post('/api/v1/web/accounts/login/ajax/', { username: 'durable', enc_password: await fresh.encPassword(PASSWORD) });
    assert.strictEqual(login.body.authenticated, true);
  } finally {
    await second.close();
  }
});
