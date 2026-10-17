'use strict';

/**
 * The signed-in route as the server serves it (src/server.js sendHtml,
 * src/shell/signedInRoute.js), against a stand-in origin whose document and
 * bootloader answers carry a client revision:
 *
 *  - a signed-in viewer gets the signed-in route by default, with none of the
 *    anonymous page's server-rendered login markup (the login flash);
 *  - an anonymous visitor still gets the page's own server render;
 *  - a new upstream revision whose answers are not stored is healed: its answers
 *    are fetched once, else the last consistent document is served; answers of
 *    another revision are never mixed in;
 *  - SHELL_SIGNED_IN_HOME=0 opts out.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startCloneServer, Browser } = require('./clone-helpers');

const TEST_ROOT = path.join(__dirname, '..', '.scratch', 'test');
const sjs = (obj) => `<script type="application/json" data-sjs>${JSON.stringify(obj)}</script>`;

function documentAt(rev) {
  return `<!doctype html><html><head></head><body><div id="splash-screen"></div>${[
    { require: [['CometSSRClientInjector', 'ssrInit', null, [{ enabled: true, eid: 'mount_0_0_t', gks: { mwp_ssr_enabled: true } }]]] },
    { require: [['Bootloader', 'handlePayload', null, [{ consistency: { rev }, rsrcMap: {}, compMap: {} }]]] },
    { require: [['CometPlatformRootClient', 'initialize', [], [{ expectedPreloaders: [], additional_roots: [], initialRouteInfo: { route: { actorID: '0', routePath: '/', url: '/' } } }]]] },
  ].map(sjs).join('')}<div id="mount_0_0_t" style="content-visibility:hidden"><div><div><span>Log into Instagram</span></div><div>Create new account</div></div></div></body></html>`;
}

function answerAt(rev) {
  return `for (;;);${JSON.stringify({ hrp: { allResources: [], hsrp: { hblp: { consistency: { rev }, rsrcMap: {}, compMap: {} } }, jsmods: { define: [], require: [] } } })}`;
}

test('signed-in route: default, no login markup, revision self-healing', async (t) => {
  const origin = { rev: 100, answers: new Set([100]), bootloaderRequests: [] };
  const handler = (req) => {
    const url = new URL(req.url, 'http://origin');
    if (url.pathname === '/ajax/bootloader-endpoint/') {
      origin.bootloaderRequests.push(`${url.searchParams.get('modules')}@${url.searchParams.get('__rev')}`);
      const rev = Number(url.searchParams.get('__rev'));
      return origin.answers.has(rev) ? { type: 'application/x-javascript', body: answerAt(rev) } : { status: 500, type: 'text/plain', body: 'no' };
    }
    if (url.pathname === '/') return { body: documentAt(origin.rev) };
    return null;
  };
  // A data directory of its own, so the document and bootloader stores (off in
  // tests by default) can be on for this server.
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'route-'));
  const env = { DOCUMENT_CACHE_DIR: path.join(dir, 'documents'), BOOTLOADER_CACHE_DIR: path.join(dir, 'bootloader'), DOCUMENT_CACHE_TTL_MS: '0' };
  const s = await startCloneServer(env, { dir, origin: handler });
  t.after(() => s.close());

  const viewer = new Browser(s.base);
  const me = await viewer.signup(s, { username: 'route_viewer' });
  const health = async () => (await new Browser(s.base).get('/__loader/health')).body.revisions;
  const home = async (b) => (await b.get('/', { headers: { accept: 'text/html', 'sec-fetch-site': 'none' } })).text;

  await t.test('a signed-in viewer gets the signed-in route by default, without the login markup', async () => {
    const html = await home(viewer);
    assert.match(html, /PolarisFeedRoot/);
    assert.ok(html.includes(`"actorID":"${me.pk}"`), 'the route is under the viewer');
    assert.ok(!/Log into Instagram|Create new account/.test(html), 'no server-rendered login page');
    assert.match(html, /<div id="mount_0_0_t" style="content-visibility:hidden"><\/div>/, 'the mount element stays, empty');
    assert.match(html, /"enabled":false/, 'the anonymous server render is disabled');
    const r = await health();
    assert.strictEqual(r.served.PolarisFeedRoot, '100');
    assert.strictEqual(r.healedByFetch, 1, 'the missing answer was fetched once for the page revision');
  });

  await t.test('an anonymous visitor keeps the page and its server render', async () => {
    const html = await home(new Browser(s.base));
    assert.ok(html.includes('Log into Instagram') && !html.includes('PolarisFeedRoot'));
  });

  await t.test('a new revision without answers serves the last consistent document, never mixed answers', async () => {
    origin.rev = 200;
    const html = await home(viewer);
    assert.match(html, /"consistency":\{"rev":100\}/, 'the revision-100 document, whose answers are stored');
    assert.ok(!html.includes('"rev":200'));
    assert.match(html, /PolarisFeedRoot/);
    const r = await health();
    assert.strictEqual(r.servedPinned, 1);
    assert.ok(origin.bootloaderRequests.includes('PolarisFeedRoot.react@200'), 'the answer for the new revision was asked for');
  });

  await t.test('once the new revision is answered, it is fetched and served', async () => {
    origin.answers.add(200);
    const html = await home(viewer);
    assert.match(html, /"consistency":\{"rev":200\}/);
    assert.match(html, /PolarisFeedRoot/);
    const r = await health();
    assert.strictEqual(r.served.PolarisFeedRoot, '200');
    assert.strictEqual(r.healedByFetch, 2);
  });

  await t.test('SHELL_SIGNED_IN_HOME=0 serves the anonymous document to everyone', async () => {
    process.env.SHELL_SIGNED_IN_HOME = '0';
    try {
      assert.ok(!(await home(viewer)).includes('PolarisFeedRoot'));
    } finally {
      delete process.env.SHELL_SIGNED_IN_HOME;
    }
  });
});
