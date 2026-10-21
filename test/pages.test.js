'use strict';

/**
 * The page registry (src/pages/registry.js): its entries are well formed,
 * it accounts for every page route builder of the active pinned client, and
 * the server dispatches every page as the registry says: a served page as its
 * route (200), a page whose root the snapshot lacks or that is not served yet
 * as the client's error route (501, with the reason), a page naming nothing as
 * the not-found route (404), and never the anonymous login page for a
 * signed-in viewer.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const registry = require('../src/pages/registry');
const { routeBuilders } = require('../src/pages/inventory');
const { startCloneServer, Browser, pngBytes } = require('./clone-helpers');
const { answerAt, sjs } = require('./snapshot-fixture');

const { PAGES, matchPage } = registry;

test('registry entries are well formed', () => {
  const ids = new Set();
  for (const page of PAGES) {
    assert.ok(!ids.has(page.id), `duplicate id ${page.id}`);
    ids.add(page.id);
    assert.ok(['page', 'redirect'].includes(page.kind), page.id);
    assert.ok(['signed-in', 'anonymous'].includes(page.access), page.id);
    assert.ok(page.patterns.length > 0 && page.patterns.every((p) => p.startsWith('/') && p.endsWith('/')), page.id);
    assert.strictEqual(typeof page.data, 'string', `${page.id}: what it shows is recorded`);
    if (page.access === 'signed-in' && !page.served) assert.ok(page.next, `${page.id}: an unserved page records its next step`);
    if (page.served) assert.ok(registry.servedAnswers(page).length > 0, page.id);
    // A recorded root names a real module pair; no root is guessed for an unrecorded page.
    if (page.har && page.har.root) assert.match(page.har.root, /^Polaris\w+(\.next)?$/, page.id);
  }
});

test("each page's patterns and sample URL dispatch to that page", () => {
  const f = { username: 'someone', postCode: 'AbCdEf12', storyOwner: 'someone', threadId: '340282366841710300', highlightId: '17890000000000001' };
  for (const page of PAGES) {
    const url = page.sample && page.sample(f);
    if (!url) continue;
    const m = matchPage(new URL(url, 'http://x').pathname);
    assert.ok(m, `${page.id}: ${url} matches no page`);
    // The tag page is a redirect whose sample lands on its own pattern.
    assert.strictEqual(m.page.id, page.id, url);
  }
  // Route parameters come from the URL.
  assert.deepStrictEqual(matchPage('/reels/AbC123/').params, { shortcode: 'AbC123' });
  assert.deepStrictEqual(matchPage('/direct/t/42/').params, { thread_key: '42' });
  assert.strictEqual(matchPage('/p/AbC/').params.permalink_key, 'p');
  assert.strictEqual(matchPage('/tv/AbC/').page.id, 'post');
  assert.strictEqual(matchPage('/xyz/AbC/'), null, 'not a permalink key, not a profile tab');
  assert.strictEqual(matchPage('/explore/x/y/z/w/'), null);
  // Reserved names are never profiles; names that are not usernames neither.
  for (const p of ['/accounts/', '/direct/', '/stories/', '/__clone/', '/bad%2Fname/', '/a b/']) assert.notStrictEqual(matchPage(p)?.page.id, 'profile', p);
});

test('the registry accounts for every page route builder of the active pinned client', (t) => {
  const dir = path.join(__dirname, '..', '.cache', 'client');
  if (!fs.existsSync(path.join(dir, 'state.json'))) return t.skip('no pinned client installed (npm run client:setup)');
  const inv = routeBuilders(dir);
  if (!inv) return t.skip('no active snapshot');
  const classified = registry.classifiedBuilders();
  const unclassified = Object.keys(inv.builders).filter((b) => !classified.has(b));
  assert.deepStrictEqual(unclassified, [], `route builders of ${inv.snapshot} missing from src/pages/registry.js`);
  for (const page of PAGES) {
    if (!page.builder) continue;
    assert.ok(inv.builders[page.builder], `${page.id}: ${page.builder} is not in ${inv.snapshot}`);
    // A page's patterns are its builder's own (profile tabs are values of the builder's {?tab}).
    if (page.builder === 'XPolarisProfileControllerRouteBuilder') continue;
    for (const p of page.patterns) assert.ok(inv.builders[page.builder].includes(p), `${page.id}: ${p} is not a pattern of ${page.builder} (${inv.builders[page.builder]})`);
  }
});

// An anonymous document as the snapshot holds them: its server render (the login page) in the SSR mount.
function documentAt(rev) {
  return `<!doctype html><html><head></head><body>${[
    { require: [['CometSSRClientInjector', 'ssrInit', null, [{ enabled: true, eid: 'mount_0_0_t', gks: { mwp_ssr_enabled: true } }]]] },
    { require: [['Bootloader', 'handlePayload', null, [{ consistency: { rev }, rsrcMap: {}, compMap: {} }]]] },
    { require: [['CometPlatformRootClient', 'initialize', [], [{ expectedPreloaders: [], additional_roots: [], initialRouteInfo: { route: { actorID: '0', routePath: '/', url: '/' } } }]]] },
  ].map(sjs).join('')}<div id="mount_0_0_t" style="content-visibility:hidden"><div>Log into Instagram</div></div></body></html>`;
}

test('the server dispatches every page as the registry says', async (t) => {
  // A snapshot holding every served route's answers except the post page's
  // desktop root, and the error route.
  const answers = {};
  for (const page of PAGES) for (const a of registry.servedAnswers(page)) answers[`${a}|`] = answerAt(100);
  for (const a of registry.errorAnswers()) answers[`${a}|`] = answerAt(100);
  delete answers['PolarisDesktopPostRoot.react|'];
  const documents = { '/': documentAt(100) };
  for (const page of PAGES.filter((p) => p.access === 'anonymous')) documents[page.sample()] = documentAt(100);
  const s = await startCloneServer({}, { snapshot: { revision: '100', documents, answers } });
  t.after(() => s.close());

  const viewer = new Browser(s.base);
  const me = await viewer.signup(s, { username: 'pages_viewer' });
  const other = new Browser(s.base);
  const o = await other.signup(s, { username: 'pages_other' });
  const id = String(Date.now());
  await other.request('POST', `/rupload_igphoto/fb_uploader_${id}`, { raw: pngBytes(), headers: { 'content-type': 'image/png', 'x-instagram-rupload-params': JSON.stringify({ upload_id: id }) } });
  const media = (await other.post('/api/v1/media/configure/', { upload_id: id, caption: 'pages' })).body.media;
  const thread = await viewer.post('/api/v1/direct_v2/threads/broadcast/text/', { recipient_users: JSON.stringify([[String(o.pk)]]), text: 'hi', client_context: 'pages-1' });
  const f = { username: o.username, postCode: media.code, storyOwner: o.username, threadId: String(thread.body.payload.thread_id) };

  const nav = { accept: 'text/html', 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  const routeOf = (html) => {
    const blocks = [...html.matchAll(/<script type="application\/json"[^>]*data-sjs>(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const init = blocks.flatMap((b) => b.require || []).filter((r) => r[0] === 'CometPlatformRootClient' && r[1] === 'initialize').pop();
    return init[3][0].initialRouteInfo.route;
  };
  const rows = [];
  for (const page of PAGES) {
    const url = page.sample && page.sample(f);
    if (!url) continue;
    const res = await viewer.get(url, { headers: nav });
    rows.push(`${page.id} ${res.status}`);
    assert.strictEqual(res.headers.get('x-clone-page'), page.id, url);
    if (page.access === 'anonymous') {
      assert.strictEqual(res.status, 200, url);
      continue;
    }
    assert.ok(!res.text.includes('Log into Instagram'), `${url}: a signed-in viewer never gets the login page`);
    const route = routeOf(res.text);
    assert.strictEqual(route.actorID, String(me.pk), `${url}: under the viewer`);
    const servedHere = page.served && registry.servedAnswers(page).every((a) => answers[`${a}|`]);
    if (servedHere) {
      assert.strictEqual(res.status, 200, url);
      if (page.expect.pageID) assert.strictEqual(route.polarisRouteConfig.pageID, page.expect.pageID, url);
    } else {
      assert.strictEqual(res.status, 501, `${url}: not served is not a success`);
      assert.deepStrictEqual(route.rootView.entryPoint, { __dr: 'PolarisErrorRoot.entrypoint' }, url);
      assert.ok(res.headers.get('x-clone-page-unavailable'), url);
    }
  }
  // A page naming nothing is the not-found route, a page that is no page keeps its own (absent) document.
  assert.strictEqual((await viewer.get('/no_such_account_x/reels/', { headers: nav })).status, 404);
  assert.strictEqual((await viewer.get('/no_such_account_x/', { headers: nav })).status, 404);
  assert.strictEqual((await viewer.get('/someone/nonsense/', { headers: nav })).status, 404);
  const health = (await viewer.get('/__loader/health')).body;
  assert.ok(health.routes.unavailable.accounts_edit, JSON.stringify(health.routes.unavailable));
  assert.ok(health.routes.unavailable.post, 'the post page is reported unavailable without its desktop root');
  assert.ok(rows.length >= 20, rows.join(', '));
  assert.deepStrictEqual(s.upstream, []);
});
