'use strict';

/**
 * Profile photo, through the client's requests (PolarisUserActionSetProfilePic
 * / RemoveProfilePic): rupload_igphoto, then the Relay mutation naming the
 * upload_id; the change-photo menu's labels from get_profile_pic_props.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer, Browser, pngBytes } = require('./clone-helpers');

const gql = (b, name, variables = {}) => b.post('/graphql/query', { doc_id: '1', fb_api_req_friendly_name: name, variables });

async function rupload(br) {
  const uploadId = String(Date.now()) + Math.floor(Math.random() * 1000);
  const res = await br.request('POST', `/rupload_igphoto/fb_uploader_${uploadId}`, { raw: pngBytes(), headers: { 'content-type': 'image/png', 'x-instagram-rupload-params': JSON.stringify({ upload_id: uploadId, media_type: 1 }) } });
  assert.strictEqual(res.status, 200, res.text.slice(0, 200));
  return uploadId;
}

test('profile photo', async (t) => {
  const server = await startCloneServer({});
  t.after(() => server.close());
  const ann = new Browser(server.base);
  const a = await ann.signup(server, { username: 'ann_pp' });
  const bob = new Browser(server.base);
  await bob.signup(server, { username: 'bob_pp' });

  let url;
  await t.test('set: the upload becomes the profile photo, visible to others', async () => {
    const res = await gql(ann, 'PolarisUserActionSetProfilePicMutation', { upload_id: await rupload(ann) });
    assert.strictEqual(res.status, 200, res.text.slice(0, 300));
    const user = res.body.data.xig_web_set_profile_picture.user;
    assert.strictEqual(user.id, String(a.pk));
    assert.strictEqual(user.has_profile_pic, true);
    url = user.profile_pic_url;
    assert.match(url, /\/__media\//);
    const seen = await gql(bob, 'PolarisProfilePageContentQuery', { id: String(a.pk) });
    assert.strictEqual(seen.body.data.user.profile_pic_url, url);
    assert.strictEqual((await bob.get(new URL(url, server.base).pathname)).status, 200);
  });

  await t.test("an upload can't be used twice, nor someone else's", async () => {
    const id = await rupload(ann);
    assert.strictEqual((await gql(ann, 'PolarisUserActionSetProfilePicMutation', { upload_id: id })).status, 200);
    assert.notStrictEqual((await gql(ann, 'PolarisUserActionSetProfilePicMutation', { upload_id: id })).status, 200);
    assert.notStrictEqual((await gql(bob, 'PolarisUserActionSetProfilePicMutation', { upload_id: await rupload(ann) })).status, 200);
  });

  await t.test('the change-photo menu has its title and buttons', async () => {
    const res = await ann.get('/api/v1/web/get_profile_pic_props/ann_pp/');
    assert.strictEqual(res.body.status, 'ok');
    for (const k of ['change_profile_pic_actions_screen_header', 'change_profile_pic_actions_screen_upload_cta', 'change_profile_pic_actions_screen_remove_cta', 'change_profile_pic_actions_screen_cancel_cta']) assert.ok(res.body[k], k);
    assert.strictEqual(res.body.show_profile_pic_sync_reminders, false);
  });

  await t.test('remove: back to the default photo', async () => {
    const res = await gql(ann, 'PolarisUserActionRemoveProfilePicMutation');
    const user = res.body.data.xig_remove_profile_picture.user;
    assert.strictEqual(user.has_profile_pic, false);
    assert.ok(user.profile_pic_url);
    const seen = await gql(bob, 'PolarisProfilePageContentQuery', { id: String(a.pk) });
    assert.notStrictEqual(seen.body.data.user.profile_pic_url, url);
  });

  await t.test('signed out: refused', async () => {
    const anon = new Browser(server.base);
    await anon.visit();
    const res = await gql(anon, 'PolarisUserActionRemoveProfilePicMutation');
    assert.ok(res.status === 401 || (res.body.errors && res.body.errors.length), res.text.slice(0, 200));
  });

  await t.test('no upstream attempt', () => assert.deepStrictEqual(server.upstream, []));
});
