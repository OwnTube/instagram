'use strict';

/**
 * The profile's Message button (usePolarisDirectMessageClick ->
 * PolarisDirectActionCreateThread): create_group_thread with the profile's
 * user, then a chat tab opened by the answer's messaging_thread_key.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer, Browser } = require('./clone-helpers');

test('profile Message button', async (t) => {
  const server = await startCloneServer({});
  t.after(() => server.close());
  const ann = new Browser(server.base);
  await ann.signup(server, { username: 'ann_pm' });
  const bob = new Browser(server.base);
  const b = await bob.signup(server, { username: 'bob_pm' });
  const open = () => ann.post('/api/v1/direct_v2/create_group_thread/', { recipient_users: JSON.stringify([String(b.pk)]) });

  await t.test('answers with the thread and its messaging_thread_key', async () => {
    const res = await open();
    assert.strictEqual(res.status, 200, res.text.slice(0, 200));
    assert.strictEqual(res.body.messaging_thread_key, String(res.body.thread_id));
    assert.deepStrictEqual(res.body.users.map((u) => u.username), ['bob_pm']);
  });

  await t.test('one recipient: the same conversation every time', async () => {
    const first = (await open()).body.thread_id;
    assert.strictEqual((await open()).body.thread_id, first);
    const sent = await ann.post('/api/v1/direct_v2/threads/broadcast/text/', { recipient_users: JSON.stringify([[String(b.pk)]]), text: 'hi' });
    assert.strictEqual(String(sent.body.payload.thread_id), String(first));
  });

  await t.test('no upstream attempt', () => assert.deepStrictEqual(server.upstream, []));
});
