'use strict';

/**
 * The login form's GraphQL mutation (useCDSWebLoginMutation) authenticates
 * against our database like the REST login route. The variable names the live
 * client uses are matched tolerantly (see graphql.js); the exact response
 * contract still has to be confirmed against the live page.
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

  const mutate = (b, variables) =>
    b.post('/graphql/query', { doc_id: '1', fb_api_req_friendly_name: 'useCDSWebLoginMutation', variables });

  await t.test('correct credentials sign in and set session cookies', async () => {
    const b = new Browser(server.base);
    await b.visit();
    const res = await mutate(b, { username: 'mut_user', enc_password: await b.encPassword(PASSWORD) });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.xdt_login.authenticated, true);
    assert.strictEqual(b.cookie('ds_user_id'), pk);
    assert.strictEqual((await b.get('/api/v1/accounts/current_user/')).body.user.username, 'mut_user');
  });

  await t.test('nested variables are found', async () => {
    const b = new Browser(server.base);
    await b.visit();
    const res = await mutate(b, { input: { username: 'mut_user', enc_password: await b.encPassword(PASSWORD) } });
    assert.strictEqual(res.body.data.xdt_login.authenticated, true);
  });

  await t.test('a wrong password or unknown user is refused identically and sets no session', async () => {
    const b = new Browser(server.base);
    await b.visit();
    const bad = await mutate(b, { username: 'mut_user', enc_password: await b.encPassword('wrong password 1') });
    const none = await mutate(b, { username: 'nobody_here', enc_password: await b.encPassword('wrong password 1') });
    assert.strictEqual(bad.body.data.xdt_login.authenticated, false);
    assert.deepStrictEqual(bad.body.data, none.body.data);
    assert.strictEqual(b.cookie('ds_user_id'), undefined);
    assert.strictEqual((await b.get('/api/v1/accounts/current_user/')).status, 401);
  });

  await t.test('missing CSRF is rejected and missing fields are a 400', async () => {
    const b = new Browser(server.base);
    await b.visit();
    const noCsrf = await b.post('/graphql/query', { fb_api_req_friendly_name: 'useCDSWebLoginMutation', variables: { username: 'mut_user' } }, { csrf: false });
    assert.ok(noCsrf.status === 403 || noCsrf.status === 400);
    const empty = await mutate(b, {});
    assert.strictEqual(empty.status, 400);
  });

  await t.test('it is no longer recorded as unsupported', async () => {
    const health = await owner.get('/__clone/health');
    assert.ok(health.body.graphql.supported.includes('useCDSWebLoginMutation'));
    assert.ok(!health.body.graphql.unsupported.some((u) => u.name === 'useCDSWebLoginMutation'));
  });
});
