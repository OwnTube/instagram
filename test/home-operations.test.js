'use strict';

/**
 * The signed-in home page's operations besides the feed
 * (src/clone/homeOperations.js): answers come from the database, in the
 * shapes of the client's compiled operations, and are empty when there is no
 * local content.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer, Browser } = require('./clone-helpers');

const gql = (b, name, variables = {}) => b.post('/graphql/query', { doc_id: '1', fb_api_req_friendly_name: name, variables });

test('signed-in home operations', async (t) => {
  const server = await startCloneServer({});
  t.after(() => server.close());
  const ann = new Browser(server.base);
  const bob = new Browser(server.base);
  const cat = new Browser(server.base);
  const a = await ann.signup(server, { username: 'ann_home' });
  const b = await bob.signup(server, { username: 'bob_home' });
  const c = await cat.signup(server, { username: 'cat_home' });

  await t.test('a new account gets truthful empty states', async () => {
    const tray = await gql(ann, 'PolarisStoriesV3TrayContainerQuery', { data: {} });
    assert.strictEqual(tray.status, 200);
    assert.deepStrictEqual(tray.body.data.xdt_api__v1__feed__reels_tray.tray, []);
    assert.deepStrictEqual(tray.body.data.xdt_api__v1__feed__reels_tray.broadcasts, []);
    assert.strictEqual(tray.body.data.xdt_viewer.user.username, 'ann_home');
    const badge = await gql(ann, 'usePolarisNotificationsNavItemQuery', { device_id: 'x' });
    assert.strictEqual(badge.body.data.xdt_notification_badge.badge_count.total_count, 0);
    const mail = await gql(ann, 'IGDBadgeCountOffMsysQuery', { device_id_for_iris_subscription: 'x' });
    assert.deepStrictEqual(mail.body.data.get_slide_mailbox_for_iris_subscription.threads_by_folder.edges, []);
    const qp = await gql(ann, 'QuickPromotionSupportIGSchemaBatchFetchQuery', { surface_nux_ids: ['1', '2'], scale: 1, trigger_context: null });
    assert.deepStrictEqual(qp.body.data.ig_quick_promotion_batch_fetch_root.map((s) => [s.surface_nux_id, s.eligible_promotions.edges.length]), [['1', 0], ['2', 0]]);
  });

  await t.test('suggestions are local accounts the viewer does not follow, ranked by mutual follows', async () => {
    assert.strictEqual((await ann.post(`/api/v1/friendships/create/${b.pk}/`, {})).status, 200);
    assert.strictEqual((await bob.post(`/api/v1/friendships/create/${c.pk}/`, {})).status, 200);
    const res = await gql(ann, 'PolarisSuggestedUserListQuery', { data: {}, showMutualFollowersContext: true });
    const items = res.body.data.ayml.groups[0].items;
    assert.deepStrictEqual(items.map((i) => i.user.username), ['cat_home'], 'self and followed accounts are never suggested');
    assert.strictEqual(items[0].social_context, 'Followed by bob_home');
    assert.strictEqual(items[0].user.friendship_status.following, false);
    const refetch = await gql(ann, 'PolarisSuggestedUserListRefetchQuery', { data: {}, showMutualFollowersContext: true });
    assert.deepStrictEqual(refetch.body.data.ayml.groups[0].items.map((i) => i.user.username), ['cat_home'], 'the empty feed refetch answers the same list');
    const activity = await gql(ann, 'PolarisUserActionLoadSULV2Query', { data: {} });
    assert.strictEqual(activity.status, 200);
    assert.strictEqual(activity.body.data.ayml.more_available, false);
    assert.deepStrictEqual(activity.body.data.ayml.groups[0].items.map((i) => i.user.username), ['cat_home'], 'the activity feed suggests the same list');
  });

  await t.test('the notifications badge counts unread notifications by kind', async () => {
    assert.strictEqual((await bob.post(`/api/v1/friendships/create/${a.pk}/`, {})).status, 200);
    const counts = (await gql(ann, 'usePolarisNotificationsNavItemQuery', {})).body.data.xdt_notification_badge.badge_count;
    assert.strictEqual(counts.total_count, 1);
    assert.strictEqual(counts.activity_badge_counts.relationships, 1);
    assert.strictEqual(counts.activity_badge_counts.likes, 0);
  });

  await t.test('a message makes the thread unread for the recipient, not the sender', async () => {
    const sent = await bob.post('/api/v1/direct_v2/threads/broadcast/text/', { recipient_users: [[a.pk]], text: 'hi ann', client_context: 'c1', action: 'send_item' });
    assert.strictEqual(sent.status, 200);
    const unread = (body, pk) => {
      const t0 = body.data.get_slide_mailbox_for_iris_subscription.threads_by_folder.edges[0].node.as_ig_direct_thread;
      const mark = t0.slide_read_receipts.find((r) => r.participant_fbid === String(pk));
      return t0.marked_as_unread || Number(mark ? mark.watermark_timestamp_ms : 0) < Number(t0.last_activity_timestamp_ms);
    };
    const forAnn = (await gql(ann, 'IGDChatTabsJewelOffMsysQuery', {})).body;
    const t0 = forAnn.data.get_slide_mailbox_for_iris_subscription.threads_by_folder.edges[0].node.as_ig_direct_thread;
    assert.deepStrictEqual(t0.users.map((u) => u.username), ['bob_home']);
    assert.strictEqual(unread(forAnn, a.pk), true);
    assert.strictEqual(unread((await gql(bob, 'IGDBadgeCountOffMsysQuery', {})).body, b.pk), false);
    const tab = (await gql(ann, 'IGDChatTabsContentOffMsysQuery', { __relay_internal__pv__IGDMaxUnreadMessagesCountrelayprovider: 5 })).body;
    const messages = tab.data.get_slide_mailbox_for_iris_subscription.threads_by_folder.edges[0].node.as_ig_direct_thread.slide_messages;
    assert.deepStrictEqual(messages.edges.map((e) => [e.node.sender_fbid, e.node.content.text_body]), [[String(b.pk), 'hi ann']]);
    assert.strictEqual(messages.page_info.has_next_page, false);
  });

  await t.test('presence and viewer settings report the local defaults', async () => {
    assert.strictEqual((await gql(ann, 'IGPresenceUnifiedSetupQuery')).body.data.xdt_api__v1__get__presence__disabled.disabled, false);
    const settings = (await gql(ann, 'PolarisViewerSettingsQuery')).body.data.viewer.user;
    assert.deepStrictEqual([settings.id, settings.is_reduce_motion_setting_enabled], [String(a.pk), false]);
  });

  await t.test('the stories ads pool is empty (no ads exist locally)', async () => {
    const res = await gql(ann, 'PolarisStoriesV3AdsPoolQuery', { data: {}, is_highlight: false });
    assert.deepStrictEqual(res.body.data.xdt_injected_story_units.ad_media_items, []);
  });

  await t.test('the ads endpoint answers its operations with no ads', async () => {
    // Its network layer sends no CSRF token; only the read-only ads queries are answered there.
    const res = await ann.post('/ads/igwww_ads_graphql/', { doc_id: '1', fb_api_req_friendly_name: 'PolarisStoriesV3AdsPoolWWWQuery', variables: { data: {}, is_highlight: false } }, { csrf: false });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.data.xdt_injected_story_units.ad_media_items, []);
    const mutation = await ann.post('/ads/igwww_ads_graphql/', { doc_id: '1', fb_api_req_friendly_name: 'useCDSWebLoginMutation', variables: { input: {} } }, { csrf: false });
    assert.strictEqual(mutation.status, 404, 'no other operation runs on the token-less endpoint');
  });

  await t.test('the Direct picker lists followed accounts, most recent conversation first', async () => {
    const res = await gql(ann, 'IGDOmniPickerNullStateListQuery', { input: {} });
    const items = res.body.data.get_paginated_share_sheet_ranked_items.ranked_items;
    assert.deepStrictEqual(items.map((i) => [i.__typename, i.username]), [['ShareSheetUser', 'bob_home']], 'only accounts ann follows');
    assert.strictEqual(items[0].pk, String(b.pk));
  });

  await t.test('the telemetry sink accepts dropped beacons without a CSRF token', async () => {
    const res = await ann.request('POST', '/__clone/dropped', { raw: 'x', csrf: false });
    assert.strictEqual(res.status, 204);
  });

  await t.test('these operations need a session', async () => {
    const anon = new Browser(server.base);
    await anon.visit();
    assert.strictEqual((await gql(anon, 'PolarisSuggestedUserListQuery', {})).status, 401);
  });
});
