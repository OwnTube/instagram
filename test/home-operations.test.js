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

  await t.test('the Direct inbox page: its thread list, folder counts and one thread', async () => {
    const box = (await gql(ann, 'PolarisDirectInboxQuery', { device_id_for_iris_subscription: 'x', __relay_internal__pv__IGDMaxUnreadMessagesCountrelayprovider: 5 })).body.data.get_slide_mailbox_for_iris_subscription;
    const thread = box.threads_by_folder.edges[0].node.as_ig_direct_thread;
    assert.strictEqual(thread.folder, 'INBOX');
    // The thread list items require each member's friendship status.
    assert.deepStrictEqual([thread.users[0].username, thread.users[0].friendship_status.blocking], ['bob_home', false]);
    assert.strictEqual(box.threads_by_system_folder_and_ig_inbox_folder.edges.length, 1);
    const count = async (folder) => (await gql(ann, 'useIGDSystemFolderUnreadThreadCountQuery', { folder, newer_than_timestamp_ms: 0 })).body.data.get_slide_mailbox_for_iris_subscription.threads_by_folder.edges.length;
    assert.strictEqual(await count('INBOX'), 1);
    assert.strictEqual(await count('PENDING'), 0, 'there are no message requests locally');

    const key = thread.thread_key;
    const detail = (await gql(ann, 'IGDThreadDetailQuery', { thread_fbid: key, __relay_internal__pv__IGDInitialMessagePageCountrelayprovider: 20 })).body.data.get_slide_thread_nullable;
    assert.strictEqual(detail.as_ig_direct_thread.thread_fbid, key);
    const message = detail.as_ig_direct_thread.slide_messages.edges[0].node;
    assert.deepStrictEqual([message.content_type, message.text_body, message.thread_fbid], ['TEXT', 'hi ann', key]);
    assert.deepStrictEqual([message.sender.__typename, message.sender.user_dict.username, typeof message.sender.user_dict.profile_pic_url], ['SlideUser', 'bob_home', 'string'], 'the sender carries name and avatar');
    const header = (await gql(ann, 'IGDInboxHeaderOffMsysQuery', { thread_fbid: key })).body.data.get_slide_thread_nullable;
    assert.strictEqual(header.as_ig_direct_thread.users[0].username, 'bob_home');
    const outsider = (await gql(cat, 'IGDThreadDetailQuery', { thread_fbid: key })).body.data;
    assert.strictEqual(outsider.get_slide_thread_nullable, null, "another account's thread is not readable");
    // Opening the thread marks it read; another account cannot mark it.
    const msgId = message.message_id;
    const valid = await gql(ann, 'useIGDMarkThreadAsReadValidationMutation', { data: { message_id: msgId, message_timestamp_ms: message.timestamp_ms }, metadata: { ig_thread_igid: key } });
    assert.strictEqual(valid.body.data.xig_direct_mark_read_id_validation, true);
    const read = await gql(ann, 'useIGDMarkThreadAsReadMutation', { data: { item_id: '', message_id: msgId }, metadata: { ig_thread_igid: key } });
    assert.strictEqual(read.body.data.xig_direct_item_seen_mutation_with_slide_messaging_response.participant_eimu_id, String(a.pk));
    const after = (await gql(ann, 'IGDChatTabsJewelOffMsysQuery', {})).body.data.get_slide_mailbox_for_iris_subscription.threads_by_folder.edges[0].node.as_ig_direct_thread;
    const mine = after.slide_read_receipts.find((r) => r.participant_fbid === String(a.pk));
    assert.ok(Number(mine.watermark_timestamp_ms) >= Number(after.last_activity_timestamp_ms), 'the thread is read for ann');
    assert.strictEqual((await gql(cat, 'useIGDMarkThreadAsReadMutation', { data: { item_id: '', message_id: msgId }, metadata: { ig_thread_igid: key } })).status, 400);
    // The composer's send stores the message; a retry with the same
    // offline_threading_id does not store it twice; a non-member cannot send.
    const send = { ig_thread_igid: key, text: { sensitive_string_value: 'from the composer' }, offline_threading_id: '7234567890123456789' };
    const sent = (await gql(ann, 'IGDirectTextSendMutation', send)).body.data.xig_direct_text_send_with_slide_messaging_response;
    assert.match(sent.message_id, /^\d+$/);
    assert.strictEqual((await gql(ann, 'IGDirectTextSendMutation', send)).body.data.xig_direct_text_send_with_slide_messaging_response.message_id, sent.message_id);
    const listed = (await gql(ann, 'IGDThreadDetailQuery', { thread_fbid: key, __relay_internal__pv__IGDInitialMessagePageCountrelayprovider: 20 })).body.data;
    assert.ok(JSON.stringify(listed).includes('from the composer'), 'the thread lists the sent message');
    assert.strictEqual((await gql(cat, 'IGDirectTextSendMutation', { ...send, offline_threading_id: '1' })).status, 400);
    assert.strictEqual((await gql(ann, 'IGDirectTextSendMutation', { ...send, text: { sensitive_string_value: '  ' }, offline_threading_id: '2' })).status, 400);
    const me = (await gql(ann, 'IGDThreadListHeaderAccountSwitcherOffMsysQuery', {})).body.data.viewer.xdt_user;
    assert.strictEqual(me.username, 'ann_home');
  });

  await t.test('the Reels tab has no clips (local accounts publish photos only)', async () => {
    const res = await gql(ann, 'PolarisClipsHomeRootQuery', { data: {}, first: 10 });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.data.xdt_api__v1__clips__home__connection_v2.edges, []);
    assert.strictEqual(res.body.data.xdt_api__v1__clips__home__connection_v2.page_info.has_next_page, false);
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

  await t.test("the picker's Chat reads the recipient by messaging id; unknown ids are null", async () => {
    const res = await gql(ann, 'useIGDCreateOptimisticThreadUserQuery', { messaging_user_fbid: String(b.pk) });
    assert.strictEqual(res.status, 200);
    const u = res.body.data.xig_user_from_messaging_user_fbid;
    assert.deepStrictEqual([u.username, u.interop_messaging_user_fbid, u.friendship_status.blocking, u.friendship_status.is_restricted], ['bob_home', String(b.pk), false, false]);
    for (const id of ['999999999999', 'x']) {
      assert.strictEqual((await gql(ann, 'useIGDCreateOptimisticThreadUserQuery', { messaging_user_fbid: id })).body.data.xig_user_from_messaging_user_fbid, null, id);
    }
  });

  await t.test('the telemetry sink accepts dropped beacons without a CSRF token', async () => {
    const res = await ann.request('POST', '/__clone/dropped', { raw: 'x', csrf: false });
    assert.strictEqual(res.status, 204);
  });

  await t.test('these operations need a session', async () => {
    const anon = new Browser(server.base);
    await anon.visit();
    assert.strictEqual((await gql(anon, 'PolarisSuggestedUserListQuery', {})).status, 401);
    assert.strictEqual((await gql(anon, 'PolarisDirectInboxQuery', {})).status, 401);
    assert.strictEqual((await gql(anon, 'IGDThreadDetailQuery', { thread_fbid: '1' })).status, 401);
  });
});
