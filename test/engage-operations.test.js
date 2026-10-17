'use strict';

/**
 * Likes and comments in the genuine client (src/clone/graphql.js): the feed's
 * like mutations (usePolarisLikeMedia), the post view's (PolarisAPILikePost),
 * and the comment field's usePolarisCommentCreateMutation, checked in the
 * database.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer, Browser } = require('./clone-helpers');
const { sunsetPng } = require('../scripts/lib/scenario');

const gql = (b, name, variables = {}) => b.post('/graphql/query', { doc_id: '1', fb_api_req_friendly_name: name, variables });

test('like and comment operations', async (t) => {
  const server = await startCloneServer({});
  t.after(() => server.close());
  const ann = new Browser(server.base);
  const bob = new Browser(server.base);
  const a = await ann.signup(server, { username: 'ann_engage' });
  const b = await bob.signup(server, { username: 'bob_engage' });
  const id = String(Date.now());
  await bob.request('POST', `/rupload_igphoto/fb_uploader_${id}`, { raw: sunsetPng(32, 32), headers: { 'x-instagram-rupload-params': JSON.stringify({ upload_id: id, media_type: 1 }), 'content-type': 'image/png' } });
  const media = (await bob.post('/api/v1/media/configure/', { upload_id: id, caption: 'engage' })).body.media;
  const db = server.openDb();
  t.after(() => db.close());
  const likes = () => db.prepare('SELECT count(*) AS n FROM likes l JOIN users u ON u.id = l.user_id WHERE u.pk = ?').get(String(a.pk)).n;
  const mediaId = `${media.pk}_${b.pk}`;

  await t.test('the feed and post view like mutations set and clear the like', async () => {
    const liked = (await gql(ann, 'usePolarisLikeMediaXIGLikeMutation', { input: { media_id: mediaId, container_module: 'feed_timeline', tracking_token: null } })).body.data;
    assert.deepStrictEqual(liked, { xig_media_like: { media: { id: mediaId, has_liked: true } } });
    assert.strictEqual(likes(), 1);
    const unliked = (await gql(ann, 'PolarisAPIUnlikePostMutation', { input: { media_id: String(media.pk) } })).body.data;
    assert.deepStrictEqual(unliked, { xig_media_unlike: { media: { id: mediaId, has_liked: false } } });
    assert.strictEqual(likes(), 0);
    assert.strictEqual((await gql(ann, 'PolarisAPILikePostMutation', { input: { media_id: mediaId } })).body.data.xig_media_like.media.has_liked, true);
    assert.strictEqual((await gql(ann, 'usePolarisLikeMediaXIGUnlikeMutation', { input: { media_id: mediaId } })).body.data.xig_media_unlike.media.has_liked, false);
    assert.strictEqual(likes(), 0);
    assert.strictEqual((await gql(ann, 'PolarisAPILikePostMutation', { input: { media_id: '999999999' } })).status, 404);
  });

  await t.test('the comment mutation stores the comment and answers the comment dict', async () => {
    const res = (await gql(ann, 'usePolarisCommentCreateMutation', { connections: [], data: { comment_text: '  Nice light  ', media_id: mediaId, tracking_token: null } })).body.data.xig_comment_create;
    assert.strictEqual(res.__typename, 'XIGCommentCreateMutationSuccessResponse');
    assert.strictEqual(res.comment_dict.text, 'Nice light');
    assert.deepStrictEqual([res.comment_dict.user.pk, res.comment_dict.user.username, res.comment_dict.user.fbid_v2], [String(a.pk), 'ann_engage', null]);
    const row = db.prepare('SELECT c.pk, c.body FROM comments c JOIN users u ON u.id = c.author_id WHERE u.pk = ?').get(String(a.pk));
    assert.deepStrictEqual([String(row.pk), row.body], [String(res.comment_dict.pk), 'Nice light']);
    assert.strictEqual((await gql(ann, 'usePolarisCommentCreateMutation', { data: { comment_text: '   ', media_id: mediaId } })).status, 400);
  });

  await t.test('comment likes set and clear the heart, count and notify the author', async () => {
    const created = (await gql(bob, 'usePolarisCommentCreateMutation', { data: { comment_text: 'thanks', media_id: mediaId } })).body.data.xig_comment_create.comment_dict;
    const like = (b) => gql(b, 'PolarisCommentActionsLikeMutation', { input: { comment_id: String(created.pk), actor_id: '1', client_mutation_id: '1' } });
    const listed = async (b) => (await b.get(`/api/v1/media/${media.pk}/comments/`)).body.comments.find((c) => String(c.pk) === String(created.pk));
    const res = await like(ann);
    assert.strictEqual(res.status, 200, res.text.slice(0, 200));
    assert.deepStrictEqual(res.body.data, { xig_comment_like: { __typename: 'XIGCommentLikeMutationResponse' } });
    assert.strictEqual((await like(ann)).status, 200, 'liking twice is not an error');
    assert.deepStrictEqual([(await listed(ann)).comment_like_count, (await listed(ann)).has_liked_comment], [1, true]);
    assert.deepStrictEqual([(await listed(bob)).comment_like_count, (await listed(bob)).has_liked_comment], [1, false]);
    const n = db.prepare("SELECT body FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.pk = ? AND n.kind = 'comment_like'").all(String(b.pk));
    assert.deepStrictEqual(n.map((r) => r.body), ['liked your comment: thanks']);
    const un = await gql(ann, 'PolarisCommentActionsUnlikeMutation', { input: { comment_id: String(created.pk), actor_id: '1', client_mutation_id: '2' } });
    assert.deepStrictEqual(un.body.data, { xig_comment_unlike: { __typename: 'XIGCommentUnlikeMutationResponse' } });
    assert.deepStrictEqual([(await listed(ann)).comment_like_count, (await listed(ann)).has_liked_comment], [0, false]);
    assert.strictEqual((await gql(ann, 'PolarisCommentActionsLikeMutation', { input: { comment_id: '999999' } })).status, 404);
  });

  await t.test('the mutations need a session', async () => {
    const anon = new Browser(server.base);
    await anon.visit();
    assert.strictEqual((await gql(anon, 'usePolarisLikeMediaXIGLikeMutation', { input: { media_id: mediaId } })).status, 401);
    assert.strictEqual((await gql(anon, 'usePolarisCommentCreateMutation', { data: { comment_text: 'x', media_id: mediaId } })).status, 401);
  });
});
