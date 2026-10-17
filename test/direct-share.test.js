'use strict';

/**
 * Sharing a post in Direct from the share sheet (IGDirectMediaShareMutation)
 * and how the shared post reads back: a SlideMessageStandardXMA in the
 * thread, the client's "sent a post" snippet, the REST media_share item, and
 * a placeholder once the post is gone.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer, Browser } = require('./clone-helpers');
const { sunsetPng } = require('../scripts/lib/scenario');

const gql = (b, name, variables = {}) => b.post('/graphql/query', { doc_id: '1', fb_api_req_friendly_name: name, variables });
const share = (b, mediaId, sendData) =>
  gql(b, 'IGDirectMediaShareMutation', { send_data: { forwarded_from_thread_id: null, is_forwarded_from_own_message: null, offline_threading_id: String(Math.random()).slice(2), thread_id: null, recipient_users: null, ...sendData }, data: { media_id: mediaId } });

test('sharing a post in Direct', async (t) => {
  const server = await startCloneServer({});
  t.after(() => server.close());
  const ann = new Browser(server.base);
  const bob = new Browser(server.base);
  const a = await ann.signup(server, { username: 'ann_share' });
  const b = await bob.signup(server, { username: 'bob_share' });
  await ann.post(`/api/v1/friendships/create/${b.pk}/`, {});
  await bob.post(`/api/v1/friendships/create/${a.pk}/`, {});
  const id = String(Date.now());
  await bob.request('POST', `/rupload_igphoto/fb_uploader_${id}`, { raw: sunsetPng(32, 32), headers: { 'x-instagram-rupload-params': JSON.stringify({ upload_id: id, media_type: 1 }), 'content-type': 'image/png' } });
  const media = (await bob.post('/api/v1/media/configure/', { upload_id: id, caption: 'look at this' })).body.media;
  const mediaId = `${media.pk}_${b.pk}`;
  const db = server.openDb();
  t.after(() => db.close());
  let threadKey;

  await t.test('sending to a person stores the share in their conversation', async () => {
    const res = await share(ann, String(media.pk), { recipient_users: JSON.stringify([String(b.pk)]) });
    assert.strictEqual(res.status, 200, res.text.slice(0, 300));
    const sent = res.body.data.direct_media_share_with_slide_response;
    assert.ok(/^\d+$/.test(sent.message_id) && sent.timestamp_ms > 0);
    const row = db.prepare('SELECT m.body, m.shared_post_id, c.pk FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.pk = ?').get(sent.message_id);
    assert.strictEqual(row.body, '');
    assert.ok(row.shared_post_id);
    threadKey = String(row.pk);
    // The same thread again by thread_id.
    assert.strictEqual((await share(ann, mediaId, { thread_id: threadKey })).status, 200);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE shared_post_id IS NOT NULL').get().n, 2);
  });

  await t.test('the thread shows a standard XMA that opens the post', async () => {
    const detail = (await gql(bob, 'IGDThreadDetailQuery', { thread_fbid: threadKey, __relay_internal__pv__IGDInitialMessagePageCountrelayprovider: 20 })).body.data.get_slide_thread_nullable;
    const node = detail.as_ig_direct_thread.slide_messages.edges[0].node;
    assert.strictEqual(node.igd_snippet, 'ann_share sent a post by bob_share.');
    assert.strictEqual(node.content.__typename, 'SlideMessageXMAContent');
    const xma = node.content.xma;
    assert.strictEqual(xma.__typename, 'SlideMessageStandardXMA');
    assert.deepStrictEqual([xma.header_title_text, xma.title_text, xma.target_id, xma.target_url, xma.preview_layout_type], ['bob_share', 'look at this', mediaId, `/p/${media.code}/`, 'SINGLE']);
    assert.ok(xma.preview_image.url);
    const mine = (await gql(ann, 'IGDThreadDetailQuery', { thread_fbid: threadKey, __relay_internal__pv__IGDInitialMessagePageCountrelayprovider: 20 })).body.data.get_slide_thread_nullable;
    assert.strictEqual(mine.as_ig_direct_thread.slide_messages.edges[0].node.igd_snippet, 'You sent a post by bob_share.');
  });

  await t.test('the REST thread carries a media_share item', async () => {
    const thread = (await bob.get(`/api/v1/direct_v2/threads/${threadKey}/`)).body.thread;
    const item = thread.items[0];
    assert.strictEqual(item.item_type, 'media_share');
    assert.strictEqual(item.media_share.code, media.code);
    assert.strictEqual(item.media_share.caption.text, 'look at this');
  });

  await t.test('invalid shares are refused', async () => {
    assert.strictEqual((await share(ann, '999999999', { recipient_users: JSON.stringify([String(b.pk)]) })).status, 404);
    assert.strictEqual((await share(ann, mediaId, { recipient_users: 'not json' })).status, 400);
    assert.strictEqual((await share(ann, mediaId, { recipient_users: JSON.stringify([String(a.pk)]) })).status, 400);
    assert.strictEqual((await share(ann, mediaId, { thread_id: '123456' })).status, 400);
    const anon = new Browser(server.base);
    await anon.visit();
    assert.strictEqual((await share(anon, mediaId, { recipient_users: JSON.stringify([String(b.pk)]) })).status, 401);
  });

  await t.test('a deleted post reads as a placeholder, not an empty message', async () => {
    db.prepare("UPDATE posts SET deleted_at = '2026-01-01T00:00:00Z' WHERE pk = ?").run(String(media.pk));
    const detail = (await gql(bob, 'IGDThreadDetailQuery', { thread_fbid: threadKey, __relay_internal__pv__IGDInitialMessagePageCountrelayprovider: 20 })).body.data.get_slide_thread_nullable;
    const node = detail.as_ig_direct_thread.slide_messages.edges[0].node;
    assert.strictEqual(node.content.xma.__typename, 'SlideMessagePlaceholderXMA');
    assert.strictEqual(node.igd_snippet, 'ann_share sent an attachment.');
    assert.strictEqual((await bob.get(`/api/v1/direct_v2/threads/${threadKey}/`)).body.thread.items[0].item_type, 'placeholder');
  });

  await t.test('no upstream attempt', () => assert.deepStrictEqual(server.upstream, []));
});
