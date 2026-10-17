'use strict';

/**
 * The signed-in route as the server serves it (src/server.js sendHtml,
 * src/shell/signedInRoute.js), from a pinned fixture snapshot whose document
 * and bootloader answers carry one client revision:
 *
 *  - a signed-in viewer gets the signed-in route by default, with none of the
 *    anonymous page's server-rendered login markup (the login flash);
 *  - an anonymous visitor still gets the page's own server render;
 *  - a route whose answers the snapshot does not hold (here the profile) is
 *    served as the page's own route and reported in diagnostics; nothing is
 *    fetched to fill it, and no answer of another revision is used;
 *  - SHELL_SIGNED_IN_HOME=0 opts out.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer, Browser } = require('./clone-helpers');
const { answerAt, sjs } = require('./snapshot-fixture');

function documentAt(rev) {
  return `<!doctype html><html><head></head><body><div id="splash-screen"></div>${[
    { require: [['CometSSRClientInjector', 'ssrInit', null, [{ enabled: true, eid: 'mount_0_0_t', gks: { mwp_ssr_enabled: true } }]]] },
    { require: [['Bootloader', 'handlePayload', null, [{ consistency: { rev }, rsrcMap: {}, compMap: {} }]]] },
    { require: [['CometPlatformRootClient', 'initialize', [], [{ expectedPreloaders: [], additional_roots: [], initialRouteInfo: { route: { actorID: '0', routePath: '/', url: '/' } } }]]] },
  ].map(sjs).join('')}<div id="mount_0_0_t" style="content-visibility:hidden"><div><div><span>Log into Instagram</span></div><div>Create new account</div></div></div></body></html>`;
}

test('signed-in route: default, no login markup, pinned answers only', async (t) => {
  const s = await startCloneServer({}, {
    snapshot: {
      revision: '100',
      documents: { '/': documentAt(100), '/accounts/emailsignup/': documentAt(100) },
      // The profile route's answers are deliberately absent; a stale answer of
      // another revision would be rejected by validation, so none is offered.
      answers: { 'PolarisFeedRoot.react|': answerAt(100) },
    },
  });
  t.after(() => s.close());

  const viewer = new Browser(s.base);
  const me = await viewer.signup(s, { username: 'route_viewer' });
  const health = async () => (await new Browser(s.base).get('/__loader/health')).body;
  const get = async (b, p) => (await b.get(p, { headers: { accept: 'text/html', 'sec-fetch-site': 'none' } })).text;

  await t.test('a signed-in viewer gets the signed-in route by default, without the login markup', async () => {
    const html = await get(viewer, '/');
    assert.match(html, /PolarisFeedRoot/);
    assert.ok(html.includes(`"actorID":"${me.pk}"`), 'the route is under the viewer');
    assert.ok(!/Log into Instagram|Create new account/.test(html), 'no server-rendered login page');
    assert.match(html, /<div id="mount_0_0_t" style="content-visibility:hidden"><\/div>/, 'the mount element stays, empty');
    assert.match(html, /"enabled":false/, 'the anonymous server render is disabled');
    const h = await health();
    assert.strictEqual(h.routes.served.PolarisFeedRoot, '100');
    assert.strictEqual(h.client.revision, '100');
  });

  await t.test('an anonymous visitor keeps the page and its server render', async () => {
    const html = await get(new Browser(s.base), '/');
    assert.ok(html.includes('Log into Instagram') && !html.includes('PolarisFeedRoot'));
  });

  await t.test('a route the snapshot cannot answer is reported, not fetched or mixed', async () => {
    const html = await get(viewer, '/route_viewer/');
    assert.match(html, /"consistency":\{"rev":100\}/, 'the pinned revision only');
    assert.ok(!html.includes('PolarisProfileRoot'), 'no profile route without its pinned answers');
    const h = await health();
    assert.ok(h.routes.unsupported >= 1);
    assert.ok(
      h.client.missingRequests.some((m) => m.kind === 'route' && m.key === 'PolarisProfileRoot'),
      'the missing route is in diagnostics',
    );
    assert.deepStrictEqual(s.upstream, [], 'no upstream attempt');
  });

  await t.test('SHELL_SIGNED_IN_HOME=0 serves the anonymous document to everyone', async () => {
    process.env.SHELL_SIGNED_IN_HOME = '0';
    try {
      assert.ok(!(await get(viewer, '/')).includes('PolarisFeedRoot'));
    } finally {
      delete process.env.SHELL_SIGNED_IN_HOME;
    }
  });

  await t.test('no upstream attempt was made by any of it', () => {
    assert.deepStrictEqual(s.upstream, []);
  });
});

test('signed-in stories and not-found routes, from pinned answers only', async (t) => {
  const answers = {};
  for (const m of ['PolarisFeedRoot.react', 'PolarisStoriesMediaRoot.entrypoint', 'PolarisStoriesMediaRoot.react', 'PolarisErrorRoot.entrypoint', 'PolarisErrorRoot.react']) answers[`${m}|`] = answerAt(100);
  const s = await startCloneServer({}, { snapshot: { revision: '100', documents: { '/': documentAt(100), '/accounts/emailsignup/': documentAt(100) }, answers } });
  t.after(() => s.close());
  const viewer = new Browser(s.base);
  const me = await viewer.signup(s, { username: 'stories_viewer' });
  const owner = await new Browser(s.base).signup(s, { username: 'story_owner', fullName: 'Story Owner' });
  const get = (b, p) => b.get(p, { headers: { accept: 'text/html', 'sec-fetch-site': 'none' } });
  const initialize = (html) => {
    const block = [...html.matchAll(/<script type="application\/json"[^>]*data-sjs>(.*?)<\/script>/g)].map((m) => JSON.parse(m[1])).flatMap((b) => b.require || []).find((r) => r[0] === 'CometPlatformRootClient' && r[1] === 'initialize');
    return block[3][0].initialRouteInfo.route;
  };

  await t.test("an existing account's stories: the stories route with its owner", async () => {
    const res = await get(viewer, '/stories/story_owner/');
    assert.strictEqual(res.status, 200);
    const route = initialize(res.text);
    assert.strictEqual(route.actorID, String(me.pk));
    assert.strictEqual(route.tracePolicy, 'polaris.StoriesPage');
    assert.deepStrictEqual(route.params, { username: 'story_owner', initial_media_id: null });
    assert.strictEqual(route.rootView.props.user_id, String(owner.pk));
    assert.strictEqual(route.rootView.props.user.username, 'story_owner');
    assert.ok(!/Log into Instagram/.test(res.text), 'no login markup');
  });

  await t.test('a profile or stories URL naming no account: the client not-found route, HTTP 404', async () => {
    for (const p of ['/no_such_account_x/', '/stories/no_such_account_x/']) {
      const res = await get(viewer, p);
      assert.strictEqual(res.status, 404, p);
      const route = initialize(res.text);
      assert.deepStrictEqual(route.rootView.entryPoint, { __dr: 'PolarisErrorRoot.entrypoint' }, p);
      assert.deepStrictEqual(route.rootView.props, {}, 'no server props are invented');
      assert.ok(!/Log into Instagram/.test(res.text), p);
    }
  });

  await t.test('anonymous visitors keep the anonymous page', async () => {
    const res = await get(new Browser(s.base), '/no_such_account_x/');
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('Log into Instagram'));
  });

  await t.test('no upstream attempt', () => assert.deepStrictEqual(s.upstream, []));
});
