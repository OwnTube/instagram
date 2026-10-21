'use strict';

/**
 * What reaches Instagram while a signed-in clone user browses: nothing. The
 * server serves a pinned fixture snapshot; the upstream guard records any
 * attempt to reach a non-local host, and the whole session must make none
 * (and, belt and braces, nothing recorded may contain a clone username,
 * shortcode, thread id, session, CSRF token or password).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer, Browser, pngBytes } = require('./clone-helpers');
const { documentAt } = require('./snapshot-fixture');

test('no clone identity or secret reaches upstream', async (t) => {
  const server = await startCloneServer({}, {
    snapshot: { documents: { '/': documentAt(100), '/accounts/emailsignup/': documentAt(100), '/direct/inbox/': documentAt(100) } },
  });
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

  await t.test('identity-bearing pages are served from a canonical snapshot document', async () => {
    const pages = ['/zebra_alice/', `/p/${post.code}/`, `/reel/${post.code}/`, '/stories/zebra_alice/', `/direct/t/${thread}/`, `/zebra_alice/?next=/p/${post.code}/`];
    for (const page of pages) {
      const res = await alice.visit(page);
      // 501: this fixture snapshot holds no route answers, so the page is "not available" (never the login page).
      assert.ok([200, 501].includes(res.status), `${page}: ${res.status}`);
      assert.strictEqual(res.headers.get('x-client-snapshot'), 'rev100-test', page);
      const canonical = res.headers.get('x-clone-canonical');
      assert.ok(canonical === '/' || canonical === '/direct/inbox/', `${page} -> ${canonical}`);
    }
    assert.deepStrictEqual(server.upstream, []);
  });

  await t.test('a page the snapshot does not hold is an explicit 404, never fetched', async () => {
    for (const page of ['/explore/', '/reels/', '/accounts/edit/']) {
      const res = await new Browser(server.base).visit(page);
      assert.strictEqual(res.status, 404, page);
      assert.match(res.text, /Not in the pinned client snapshot rev100-test \(revision 100\)/);
    }
    assert.deepStrictEqual(server.upstream, []);
  });

  await t.test('the edit-profile page is a document request; the form post stays local', async () => {
    const page = await alice.visit('/accounts/edit/');
    assert.strictEqual(page.status, 501, 'a registered page this server does not serve yet');
    assert.match(page.text, /not available on this server/);
    const form = await alice.post('/accounts/edit/', { biography: 'from the form' });
    assert.notStrictEqual(form.status, 404, 'the profile form is answered by the backend');
    assert.deepStrictEqual(server.upstream, []);
  });

  await t.test('a request no local handler answers is refused, not relayed', async () => {
    const res = await alice.post('/ajax/unknown-endpoint/', { modules: 'Foo' });
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(server.upstream, [], 'nothing was relayed upstream');
  });

  await t.test('after a whole browsing session upstream saw nothing at all', () => {
    assertClean();
    assert.deepStrictEqual(server.upstream, []);
  });

  await t.test('every HTML page is private to the browser that asked for it', async () => {
    const res = await alice.visit('/');
    assert.strictEqual(res.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.match(res.headers.get('vary') || '', /Cookie/);
  });
});
