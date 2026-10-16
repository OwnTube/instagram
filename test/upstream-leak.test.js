'use strict';

/**
 * What reaches the upstream origin while a signed-in clone user browses.
 * The stand-in origin records every request; nothing it records may contain a
 * clone username, shortcode, thread id, session, CSRF token or password.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer, Browser, pngBytes } = require('./clone-helpers');

test('no clone identity or secret reaches upstream', async (t) => {
  const server = await startCloneServer();
  t.after(() => server.close());

  const alice = new Browser(server.base);
  const alicePk = (await alice.signup(server, { username: 'zebra_alice' })).pk;
  const uploadId = `${Date.now()}1`;
  await alice.request('POST', `/rupload_igphoto/fb_uploader_${uploadId}`, {
    raw: pngBytes(),
    headers: { 'x-instagram-rupload-params': JSON.stringify({ upload_id: uploadId, media_type: 1 }) },
  });
  const post = (await alice.post('/api/v1/media/configure/', { upload_id: uploadId, caption: 'leak check' })).body.media;
  const bob = new Browser(server.base);
  await bob.signup(server, { username: 'bob_leakcheck' });
  const thread = (await bob.post('/api/v1/direct_v2/threads/broadcast/text/', { recipient_users: [[alicePk]], text: 'x' })).body.payload.thread_id;

  const secrets = () => [
    'zebra_alice',
    post.code,
    post.pk,
    thread,
    alice.cookie('sessionid'),
    alice.cookie('csrftoken'),
    'correct horse 42',
  ];
  const assertClean = () => {
    for (const r of server.upstream) {
      const seen = `${r.method} ${r.url}\n${JSON.stringify(r.headers)}\n${r.body || ''}`;
      for (const value of secrets()) {
        assert.ok(!seen.includes(value), `upstream received a clone value in: ${r.method} ${r.url}`);
      }
    }
  };

  await t.test('route definitions are answered locally and never forwarded', async () => {
    const before = server.upstream.length;
    const res = await alice.post('/ajax/bulk-route-definitions/', {
      'route_urls[0]': '/zebra_alice/',
      'route_urls[1]': `/p/${post.code}/`,
      __a: 1,
    });
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /^for \(;;\);/);
    const payload = JSON.parse(res.text.slice('for (;;);'.length));
    assert.deepStrictEqual(Object.keys(payload.payload.payloads).sort(), [`/p/${post.code}/`, '/zebra_alice/'].sort());
    assert.deepStrictEqual(payload.payload.sr_payload, {}, 'the client (fetchAnonymousCometRoute) requires payloads and sr_payload');
    assert.strictEqual(server.upstream.length, before, 'nothing was sent upstream');
  });

  await t.test('identity-bearing pages fetch a canonical shell instead of their own URL', async () => {
    const pages = ['/zebra_alice/', `/p/${post.code}/`, `/reel/${post.code}/`, '/stories/zebra_alice/', `/direct/t/${thread}/`, `/zebra_alice/?next=/p/${post.code}/`];
    for (const page of pages) {
      const before = server.upstream.length;
      const res = await alice.visit(page);
      assert.strictEqual(res.status, 200, page);
      const fetched = server.upstream.slice(before).map((r) => r.url);
      for (const url of fetched) assert.ok(url === '/' || url === '/direct/inbox/', `${page} fetched ${url} upstream`);
    }
  });

  await t.test('pages without identifiers are still fetched as themselves', async () => {
    for (const page of ['/explore/', '/accounts/edit/', '/direct/inbox/']) {
      const before = server.upstream.length;
      await new Browser(server.base).visit(page);
      const urls = server.upstream.slice(before).map((r) => r.url);
      assert.ok(urls.length === 0 || urls.includes(page), `${page} -> ${urls}`);
    }
  });

  await t.test("X-CSRFToken and cookies on forwarded requests are dropped", async () => {
    const before = server.upstream.length;
    await alice.post('/ajax/bootloader-endpoint/', { modules: 'Foo' });
    const forwarded = server.upstream.slice(before);
    assert.strictEqual(forwarded.length, 1);
    assert.strictEqual(forwarded[0].cookie, null, 'no browser cookie upstream');
    assert.strictEqual(forwarded[0].headers['x-csrftoken'], undefined, 'the clone CSRF token stays here');
  });

  await t.test('after a whole browsing session upstream saw nothing of the clone', () => {
    assertClean();
  });

  await t.test('every HTML page is private to the browser that asked for it', async () => {
    const res = await alice.visit('/');
    assert.strictEqual(res.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.match(res.headers.get('vary') || '', /Cookie/);
  });
});
