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

// The Direct "New message" picker through the server's own contract
// completion: the snapshot holds the real compiled operation (normalisation
// AST of IGDOmniPickerSearchResultsListQuery, client revision 1050722040),
// whose list items are spread as `... on ShareSheetItem`. Relay matches the
// item fragments only for records carrying `__isShareSheetItem`.
test('omnipicker search: the response carries the abstract-fragment discriminator', async (t) => {
  const { selections } = require('./fixtures/omnipicker-search-operation.json');
  const artifact = { kind: 'Request', fragment: { kind: 'Fragment', name: 'IGDOmniPickerSearchResultsListQuery', selections: [] }, operation: { kind: 'Operation', name: 'IGDOmniPickerSearchResultsListQuery', selections } };
  // Minified the way Meta's bundles are (unquoted keys), so the server reads it as it reads the real bundle.
  const literal = JSON.stringify(artifact).replace(/"([A-Za-z_$][\w$]*)":/g, '$1:');
  const body = `__d("IGDOmniPickerSearchResultsListQuery.graphql",[],(function(a,b,c,d,e,f){"use strict";var g=${literal};e.exports=g}),null);`;
  const server = await startCloneServer({}, { snapshot: { assets: { 'https://static.cdninstagram.com/rsrc.php/v4/omnipicker-fixture.js': { body, contentType: 'application/x-javascript; charset=utf-8' } } } });
  t.after(() => server.close());
  const ann = new Browser(server.base);
  await ann.signup(server, { username: 'ann_picker' });
  const bob = await new Browser(server.base).signup(server, { username: 'picker_bob', fullName: 'Bob Picker' });

  const res = await gql(ann, 'IGDOmniPickerSearchResultsListQuery', { search_text: 'picker' });
  assert.strictEqual(res.status, 200);
  const items = res.body.data.xfb_combinedIGSearchQuery.search_messenger_contact_v2;
  assert.deepStrictEqual(items.map((i) => [i.__typename, i.__isShareSheetItem, i.username, i.pk]), [['ShareSheetUser', 'ShareSheetUser', 'picker_bob', String(bob.pk)]]);
  // Only the operation's own fields (the item's and the ShareSheetUser
  // fragment's), its type name and the discriminator: nothing invented.
  const tree = require('../src/runtime/graphqlContract').selectionTree(selections).xfb_combinedIGSearchQuery.search_messenger_contact_v2;
  const allowed = new Set(['__typename', ...tree.__discriminators, ...Object.keys(tree).filter((k) => !k.startsWith('__') && !k.startsWith('... on ')), ...Object.keys(tree['... on ShareSheetUser'])]);
  assert.deepStrictEqual(Object.keys(items[0]).filter((k) => !allowed.has(k)), []);
  assert.strictEqual(items[0].share_sheet_item_id, String(bob.pk));
  assert.deepStrictEqual(server.upstream, []);
});

// Control: with contract completion off, the same answer has no
// discriminator, so it is the server's completion path that supplies it.
test('omnipicker search without contracts carries no discriminator', async (t) => {
  const server = await startCloneServer({ CLONE_CONTRACTS: '0' });
  t.after(() => server.close());
  const ann = new Browser(server.base);
  await ann.signup(server, { username: 'ann_picker2' });
  await new Browser(server.base).signup(server, { username: 'picker_cara' });
  const items = (await gql(ann, 'IGDOmniPickerSearchResultsListQuery', { search_text: 'picker' })).body.data.xfb_combinedIGSearchQuery.search_messenger_contact_v2;
  assert.deepStrictEqual(items.map((i) => [i.username, '__isShareSheetItem' in i]), [['picker_cara', false]]);
});
