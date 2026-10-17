'use strict';

/**
 * Notes in the Direct inbox tray: usePolarisCreateInboxTrayItemSubmitMutation,
 * IGDInboxTrayQuery and usePolarisDeleteInboxTrayItemSubmitMutation, with
 * the audience rules (mutual follows, close friends).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer, Browser } = require('./clone-helpers');

const gql = (b, name, variables = {}) => b.post('/graphql/query', { doc_id: '1', fb_api_req_friendly_name: name, variables });
const share = (b, text, audience = 0, extra = {}) =>
  gql(b, 'usePolarisCreateInboxTrayItemSubmitMutation', { input: { inbox_tray_item_type: 'note', audience, additional_params: { note_create_params: { note_create_info: null, note_style: 0, text } }, ...extra } });
const tray = async (b) => {
  const res = await gql(b, 'IGDInboxTrayQuery');
  assert.strictEqual(res.status, 200, res.text.slice(0, 200));
  return res.body.data.response.inbox_tray_items;
};

test('notes', async (t) => {
  const server = await startCloneServer({});
  t.after(() => server.close());
  const ann = new Browser(server.base);
  const a = await ann.signup(server, { username: 'ann_note' });
  const bob = new Browser(server.base);
  const b = await bob.signup(server, { username: 'bob_note' });
  const cat = new Browser(server.base);
  const c = await cat.signup(server, { username: 'cat_note' });
  // ann and bob follow each other; cat follows ann only.
  await ann.post(`/api/v1/friendships/create/${b.pk}/`, {});
  await bob.post(`/api/v1/friendships/create/${a.pk}/`, {});
  await cat.post(`/api/v1/friendships/create/${a.pk}/`, {});

  let pk;
  await t.test('sharing answers the tray item in the shape the tray reads', async () => {
    const res = await share(ann, 'hello there');
    assert.strictEqual(res.status, 200, res.text.slice(0, 200));
    const item = res.body.data.xdt_create_inbox_tray_item.inbox_tray_item;
    assert.strictEqual(item.inbox_tray_item_type, 'note');
    assert.strictEqual(item.pog_info.pog_style, 'user');
    assert.strictEqual(item.pog_info.pog_users[0].id, String(a.pk));
    assert.strictEqual(item.note_dict.text, 'hello there');
    assert.strictEqual(item.note_dict.audience, 0);
    pk = item.inbox_tray_item_id;
  });

  await t.test('mutual followers see it after a reload; others do not', async () => {
    assert.deepStrictEqual((await tray(ann)).map((i) => i.note_dict.text), ['hello there']);
    assert.deepStrictEqual((await tray(bob)).map((i) => i.note_dict.text), ['hello there']);
    assert.deepStrictEqual(await tray(cat), []);
  });

  await t.test('close friends audience: only the author and their close friends', async () => {
    assert.strictEqual((await gql(ann, 'usePolarisSetBestiesMutation', { add: [String(c.pk)], remove: [] })).status, 200);
    const res = await share(ann, 'besties only', 1);
    assert.strictEqual(res.status, 200, res.text.slice(0, 200));
    assert.deepStrictEqual((await tray(cat)).map((i) => i.note_dict.text), ['besties only']);
    assert.deepStrictEqual(await tray(bob), [], 'a new note replaces the old one; bob is not a close friend');
    pk = res.body.data.xdt_create_inbox_tray_item.inbox_tray_item.inbox_tray_item_id;
  });

  await t.test('invalid notes are refused', async () => {
    assert.notStrictEqual((await share(ann, '   ')).status, 200);
    assert.notStrictEqual((await share(ann, 'x'.repeat(81))).status, 200);
    assert.notStrictEqual((await share(ann, 'odd', 7)).status, 200);
    assert.notStrictEqual((await gql(ann, 'usePolarisCreateInboxTrayItemSubmitMutation', { input: { inbox_tray_item_type: 'note', audience: 0, additional_params: { note_create_params: { note_style: 1, text: 'music' } } } })).status, 200);
  });

  await t.test('only the author can delete; then nobody sees it', async () => {
    assert.notStrictEqual((await gql(cat, 'usePolarisDeleteInboxTrayItemSubmitMutation', { inbox_tray_item_id: pk })).status, 200);
    const res = await gql(ann, 'usePolarisDeleteInboxTrayItemSubmitMutation', { inbox_tray_item_id: pk });
    assert.strictEqual(res.status, 200, res.text.slice(0, 200));
    assert.deepStrictEqual(res.body.data.xdt_delete_inbox_tray_item, { success: true });
    assert.deepStrictEqual(await tray(ann), []);
    assert.deepStrictEqual(await tray(cat), []);
  });

  await t.test('no upstream attempt', () => assert.deepStrictEqual(server.upstream, []));
});
