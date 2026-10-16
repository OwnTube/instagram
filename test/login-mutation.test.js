'use strict';

/**
 * The login form's GraphQL mutation (useCDSWebLoginMutation) authenticates
 * against our database like the REST login route. Variables and response
 * follow the client's own useCDSWebLoginMutation module (read from the cached
 * bundle); that this exact response logs the genuine form in is still to be
 * confirmed in the real browser.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer, Browser } = require('./clone-helpers');

const PASSWORD = 'correct horse 42';

test('useCDSWebLoginMutation', async (t) => {
  const server = await startCloneServer({});
  t.after(() => server.close());
  const owner = new Browser(server.base);
  const { pk } = await owner.signup(server, { username: 'mut_user' });

  const sens = (v) => ({ sensitive_string_value: v });
  // The input the client builds (read from its useCDSWebLoginMutation module).
  const input = async (b, identifier, password, extra = {}) => ({
    identifier,
    enc_password: sens(await b.encPassword(password)),
    password: sens(await b.encPassword(password)),
    credential_type: 'password',
    persistent: true,
    ...extra,
  });
  const mutate = (b, inp) =>
    b.post('/graphql/query', { doc_id: '28077768681846394', fb_api_req_friendly_name: 'useCDSWebLoginMutation', variables: { input: inp, scale: 1 } });

  await t.test('correct credentials sign in, set session cookies and redirect', async () => {
    const b = new Browser(server.base);
    await b.visit();
    const res = await mutate(b, await input(b, 'mut_user', PASSWORD, { next: '/' }));
    assert.strictEqual(res.status, 200);
    const out = res.body.data.caa_login_web;
    assert.strictEqual(out.ig_authenticated, true);
    assert.strictEqual(out.redirect_uri, '/');
    assert.strictEqual(out.crypted_uid, pk);
    assert.strictEqual(out.error_message, null);
    assert.strictEqual(b.cookie('ds_user_id'), pk);
    assert.strictEqual((await b.get('/api/v1/accounts/current_user/')).body.user.username, 'mut_user');
  });

  await t.test('the redirect cannot leave the site', async () => {
    const b = new Browser(server.base);
    await b.visit();
    for (const next of ['https://evil.example/', '//evil.example', '/\\evil.example']) {
      const res = await mutate(b, await input(b, 'mut_user', PASSWORD, { next }));
      assert.strictEqual(res.body.data.caa_login_web.redirect_uri, '/', next);
    }
    const ok = await mutate(b, await input(b, 'mut_user', PASSWORD, { next: '/explore/' }));
    assert.strictEqual(ok.body.data.caa_login_web.redirect_uri, '/explore/');
  });

  await t.test('a login replaces the browser\'s earlier session', async () => {
    const b = new Browser(server.base);
    await b.visit();
    await mutate(b, await input(b, 'mut_user', PASSWORD));
    const first = b.header();
    await mutate(b, await input(b, 'mut_user', PASSWORD));
    const stale = await fetch(`${server.base}/api/v1/accounts/current_user/`, { headers: { cookie: first } });
    assert.strictEqual(stale.status, 401);
  });

  await t.test('a wrong password or unknown user gets the same in-band error and no session', async () => {
    const b = new Browser(server.base);
    await b.visit();
    const bad = await mutate(b, await input(b, 'mut_user', 'wrong password 1'));
    const none = await mutate(b, await input(b, 'nobody_here', 'wrong password 1'));
    const e = bad.body.data.caa_login_web;
    assert.strictEqual(e.ig_authenticated, false);
    assert.strictEqual(e.redirect_uri, null);
    assert.ok(e.error_message.text);
    assert.deepStrictEqual(bad.body.data, none.body.data);
    assert.strictEqual(b.cookie('ds_user_id'), undefined);
    assert.strictEqual((await b.get('/api/v1/accounts/current_user/')).status, 401);
  });

  await t.test('an unreadable password is reported in-band; missing fields too', async () => {
    const b = new Browser(server.base);
    await b.visit();
    const garbled = await mutate(b, { identifier: 'mut_user', enc_password: sens('#PWD_INSTAGRAM_BROWSER:10:1:bm9wZQ=='), password: sens('x') });
    assert.strictEqual(garbled.body.data.caa_login_web.ig_authenticated, false);
    assert.ok(garbled.body.data.caa_login_web.error_message.text);
    const empty = await mutate(b, {});
    assert.strictEqual(empty.body.data.caa_login_web.error_code, 'missing_credentials');
  });

  await t.test('CSRF is enforced', async () => {
    const b = new Browser(server.base);
    await b.visit();
    const res = await b.post('/graphql/query', { fb_api_req_friendly_name: 'useCDSWebLoginMutation', variables: { input: await input(b, 'mut_user', PASSWORD) } }, { csrf: false });
    assert.ok(res.status === 403 || res.status === 400, `status ${res.status}`);
    assert.strictEqual(b.cookie('ds_user_id'), undefined);
  });

  await t.test('it is supported and not recorded as unsupported', async () => {
    const health = await owner.get('/__clone/health');
    assert.ok(health.body.graphql.supported.includes('useCDSWebLoginMutation'));
    assert.ok(!health.body.graphql.unsupported.some((u) => u.name === 'useCDSWebLoginMutation'));
  });
});
