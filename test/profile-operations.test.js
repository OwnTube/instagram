'use strict';

/**
 * Profile operations of the genuine client (src/clone/graphql.js): the
 * profile content's viewer selection, the posts grid's viewer, the
 * school-partner badge, and follow/unfollow mutations, checked in the database.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer, Browser } = require('./clone-helpers');

const gql = (b, name, variables = {}) => b.post('/graphql/query', { doc_id: '1', fb_api_req_friendly_name: name, variables });

test('profile operations', async (t) => {
  const server = await startCloneServer({});
  t.after(() => server.close());
  const ann = new Browser(server.base);
  const bob = new Browser(server.base);
  const a = await ann.signup(server, { username: 'ann_prof' });
  const b = await bob.signup(server, { username: 'bob_prof' });
  const db = server.openDb();
  t.after(() => db.close());
  const edge = () => db.prepare('SELECT f.state FROM follows f JOIN users x ON x.id = f.follower_id JOIN users y ON y.id = f.followee_id WHERE x.pk = ? AND y.pk = ?').get(String(a.pk), String(b.pk));

  await t.test("the own-profile options menu and the More menu: no Accounts Center, Ads Manager or Meta account", async () => {
    const own = (await gql(ann, 'PolarisProfileOwnOptionsContextMenuQuery', {})).body.data;
    assert.deepStrictEqual(own.fxcal_settings.should_show_nodes_in_accounts_center, []);
    assert.deepStrictEqual([own.viewer.user.pk, own.viewer.user.username, own.viewer.user.is_professional_account], [String(a.pk), 'ann_prof', false]);
    assert.strictEqual((await gql(ann, 'PolarisAdsManagerMenuItemQuery', {})).body.data.xig_ig_web_ads_manager_entrypoint_root_query.ads_manager_entrypoint_url, null);
    assert.strictEqual((await gql(ann, 'PolarisMoreContextMenuIsFetaQuery', {})).body.data.xfb_is_feta_account_eligible_for_flow, false);
  });

  await t.test('profile content and posts carry the signed-in viewer', async () => {
    const content = (await gql(ann, 'PolarisProfilePageContentQuery', { id: String(b.pk), enable_integrity_filters: true })).body.data;
    assert.strictEqual(content.user.username, 'bob_prof');
    assert.deepStrictEqual([content.viewer.user.id, content.viewer.user.can_see_organic_insights], [String(a.pk), false]);
    const grid = (await gql(ann, 'PolarisProfilePostsQuery', { data: { count: 12 }, username: 'bob_prof' })).body.data;
    assert.deepStrictEqual(grid.xdt_viewer, { user: { id: String(a.pk) } });
    const badge = (await gql(ann, 'PolarisSchoolPartnerProfileBadgeQuery', { igid: String(b.pk) })).body.data;
    assert.deepStrictEqual([badge.xig_user_by_igid_v2.id, badge.xig_user_by_igid_v2.school_partner], [String(b.pk), null]);
  });

  await t.test('follow and unfollow mutations change the follow row', async () => {
    const followed = (await gql(ann, 'usePolarisFollowMutation', { target_user_id: String(b.pk), container_module: 'profile', nav_chain: '' })).body.data;
    assert.strictEqual(followed.xdt_create_friendship.friendship_status.following, true);
    assert.strictEqual(edge().state, 'accepted');
    assert.strictEqual((await gql(ann, 'usePolarisFollowMutation', { target_user_id: String(b.pk) })).status, 200, 'following twice is not an error');
    const unfollowed = (await gql(ann, 'usePolarisUnfollowMutation', { target_user_id: String(b.pk), container_module: 'profile', nav_chain: '' })).body.data;
    assert.strictEqual(unfollowed.xdt_destroy_friendship.friendship_status.following, false);
    assert.strictEqual(edge(), undefined);
    assert.strictEqual((await gql(ann, 'usePolarisUnfollowMutation', { target_user_id: String(b.pk) })).status, 200, 'unfollowing again is not an error');
    assert.strictEqual((await gql(ann, 'usePolarisUnfollowMutation', { target_user_id: '999999999999' })).status, 404);
  });

  await t.test('the mutations need a session', async () => {
    const anon = new Browser(server.base);
    await anon.visit();
    assert.strictEqual((await gql(anon, 'usePolarisFollowMutation', { target_user_id: String(b.pk) })).status, 401);
  });
});
