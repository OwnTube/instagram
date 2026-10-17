'use strict';

/**
 * The genuine search panel's operations (src/clone/searchOperations.js):
 * local accounts by username or full name, in the topsearch shape; nothing
 * invented (no hashtags, places or recent searches exist locally).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer, Browser } = require('./clone-helpers');

const gql = (b, name, variables = {}) => b.post('/graphql/query', { doc_id: '1', fb_api_req_friendly_name: name, variables });

test('search operations', async (t) => {
  const server = await startCloneServer({});
  t.after(() => server.close());
  const ann = new Browser(server.base);
  await ann.signup(server, { username: 'ann_search' });
  const bob = await new Browser(server.base).signup(server, { username: 'harbour_bob', fullName: 'Robert Quay' });

  const typed = (query) => gql(ann, 'PolarisSearchBoxRefetchableQuery', {
    data: { context: 'blended', include_reel: 'true', query, rank_token: 'r1', search_session_id: 's1', search_surface: 'web_top_search' },
    hasQuery: true,
  });

  await t.test('the panel opens without a query: nothing is searched', async () => {
    const res = await gql(ann, 'PolarisSearchBoxContainerQuery', { data: { context: 'blended' }, hasQuery: false });
    assert.strictEqual(res.status, 200);
    assert.ok(!res.body.data.xdt_api__v1__fbsearch__topsearch_connection);
  });

  await t.test('a typed query finds local accounts by username and by full name', async () => {
    for (const q of ['harbour', 'robert qu', '@harbour_bob']) {
      const res = await typed(q);
      assert.strictEqual(res.status, 200, q);
      const conn = res.body.data.xdt_api__v1__fbsearch__topsearch_connection;
      assert.deepStrictEqual(conn.users.map((u) => [u.position, u.user.username, u.user.pk, u.user.full_name]), [[0, 'harbour_bob', String(bob.pk), 'Robert Quay']], q);
      assert.deepStrictEqual([conn.hashtags, conn.places], [[], []]);
      assert.strictEqual(conn.rank_token, 'r1');
    }
  });

  await t.test('no match is an empty list', async () => {
    const conn = (await typed('nobody_here_xyz')).body.data.xdt_api__v1__fbsearch__topsearch_connection;
    assert.deepStrictEqual(conn.users, []);
  });

  await t.test('the non-personalised variant and the null state', async () => {
    const np = await gql(ann, 'PolarisSearchBoxNonProfiledRefetchableQuery', { query: 'harbour', hasQuery: true });
    assert.deepStrictEqual(np.body.data.xdt_api__v1__fbsearch__non_profiled_serp.users.map((u) => u.username), ['harbour_bob']);
    const nul = await gql(ann, 'PolarisSearchNullStateQuery', {});
    assert.deepStrictEqual(nul.body.data.xig_recent_searches.recent_searches, []);
  });

  await t.test("the empty feed's search box lists other local accounts with their friendship status", async () => {
    for (const op of ['PolarisFeedEmptySULSearchUsersQuery', 'PolarisFeedEmptySULSearchRefetchQuery']) {
      const res = await gql(ann, op, { query: 'harbour' });
      const users = res.body.data.searchQuery.users;
      assert.deepStrictEqual(users.map((u) => [u.user.username, u.user.friendship_status.following]), [['harbour_bob', false]], op);
    }
    await ann.post(`/api/v1/friendships/create/${bob.pk}/`, {});
    const after = (await gql(ann, 'PolarisFeedEmptySULSearchUsersQuery', { query: 'harbour' })).body.data.searchQuery.users;
    assert.strictEqual(after[0].user.friendship_status.following, true);
    const self = (await gql(ann, 'PolarisFeedEmptySULSearchUsersQuery', { query: 'ann_search' })).body.data.searchQuery.users;
    assert.deepStrictEqual(self, [], 'the viewer is not suggested to themselves');
  });

  await t.test('search needs a signed-in viewer', async () => {
    const anon = new Browser(server.base);
    await anon.visit();
    assert.strictEqual((await gql(anon, 'PolarisSearchBoxRefetchableQuery', { data: { query: 'harbour' }, hasQuery: true })).status, 401);
  });

  await t.test('no upstream attempt', () => assert.deepStrictEqual(server.upstream, []));
});
