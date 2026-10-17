'use strict';

/**
 * The signed-in route as the server serves it (src/server.js sendHtml,
 * src/shell/signedInRoute.js), from a pinned fixture snapshot whose document
 * and bootloader answers carry one client revision:
 *
 *  - a signed-in viewer gets the signed-in route by default, with none of the
 *    anonymous page's server-rendered login markup (the login flash);
 *  - an anonymous visitor still gets the page's own server render, unless
 *    their window (the `wd` cookie) is narrower than the render's layout;
 *  - a route whose answers the snapshot does not hold (here the profile) is
 *    served as the page's own route and reported in diagnostics; nothing is
 *    fetched to fill it, and no answer of another revision is used;
 *  - SHELL_SIGNED_IN_HOME=0 opts out.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer, Browser, pngBytes } = require('./clone-helpers');
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

  await t.test("a window narrower than the stored render's layout gets the page without its server render", async () => {
    // The client reports its window in the `wd` cookie; at or below the login
    // homepage's 1024px breakpoint it lays the page out differently from the
    // stored (wide) render, so that render is not hydrated.
    const narrow = new Browser(s.base);
    narrow.jar.set('wd', '800x600');
    const html = await get(narrow, '/');
    assert.match(html, /"enabled":false/, 'server render disabled');
    assert.match(html, /<div id="mount_0_0_t" style="content-visibility:hidden"><\/div>/, 'the mount stays, empty');
    assert.ok(!html.includes('Log into Instagram'), 'no stored markup to hydrate');
    const wide = new Browser(s.base);
    wide.jar.set('wd', '1280x900');
    const kept = await get(wide, '/');
    assert.ok(kept.includes('Log into Instagram') && /"enabled":true/.test(kept), 'a wide window keeps the server render');
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
  for (const m of ['PolarisFeedRoot.react', 'PolarisStoriesMediaRoot.entrypoint', 'PolarisStoriesMediaRoot.react', 'PolarisErrorRoot.entrypoint', 'PolarisErrorRoot.react', 'PolarisActivityFeedRoot.entrypoint', 'PolarisActivityFeedRoot.react', 'PolarisDirectInboxRoot.entrypoint', 'PolarisDirectInboxRoot.react', 'PolarisClipsTabRoot.entrypoint', 'PolarisClipsTabRoot.react']) answers[`${m}|`] = answerAt(100);
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

  await t.test('/notifications/ and /accounts/activity/: the activity feed route, not a profile', async () => {
    for (const p of ['/notifications/', '/accounts/activity/']) {
      const res = await get(viewer, p);
      assert.strictEqual(res.status, 200, p);
      const route = initialize(res.text);
      assert.deepStrictEqual(route.rootView.entryPoint, { __dr: 'PolarisActivityFeedRoot.entrypoint' }, p);
      assert.deepStrictEqual(route.params, { followRequests: false }, p);
      assert.deepStrictEqual(route.polarisRouteConfig, { pageID: 'ActivityFeedPage' }, p);
      assert.ok(!/Log into Instagram/.test(res.text), p);
    }
    // Signed out, it is not the anonymous home page: the path has no document.
    const anon = await get(new Browser(s.base), '/notifications/');
    assert.strictEqual(anon.status, 404);
    assert.ok(!anon.text.includes('Log into Instagram'));
  });

  await t.test('/direct/inbox/, a /direct/t/ thread and /reels/: their client roots, signed in only', async () => {
    const expected = [
      ['/direct/inbox/', 'PolarisDirectInboxRoot', {}, 'DirectInboxPage'],
      ['/direct/t/340282366841710300/', 'PolarisDirectInboxRoot', { thread_key: '340282366841710300' }, 'DirectInboxPage'],
      ['/reels/', 'PolarisClipsTabRoot', { shortcode: null }, 'reelsTab'],
    ];
    for (const [p, root, params, pageID] of expected) {
      const res = await get(viewer, p);
      assert.strictEqual(res.status, 200, p);
      const route = initialize(res.text);
      assert.deepStrictEqual(route.rootView.entryPoint, { __dr: `${root}.entrypoint` }, p);
      assert.deepStrictEqual(route.params, params, p);
      assert.deepStrictEqual(route.polarisRouteConfig, { pageID }, p);
      const anon = await get(new Browser(s.base), p);
      assert.strictEqual(anon.status, 404, `${p} signed out: no document`);
    }
  });

  await t.test('a client route name cannot be taken as a username', async () => {
    const created = await new Browser(s.base).signup(s, { username: 'notifications' }).then(() => true, () => false);
    assert.strictEqual(created, false, 'signup with a reserved name must fail');
  });

  await t.test('anonymous visitors keep the anonymous page', async () => {
    const res = await get(new Browser(s.base), '/no_such_account_x/');
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('Log into Instagram'));
  });

  await t.test('no upstream attempt', () => assert.deepStrictEqual(s.upstream, []));
});

test('signed-in post page: PolarisPostRoot with cr:2882 bound, only when the snapshot holds the desktop post root', async (t) => {
  // PolarisPostRoot.react's answer leaves cr:2882 unbound, as the anonymous answer does.
  const unbound = { define: [['cr:2882', [], { __rc: [null, null] }, -1]], require: [] };
  const answers = { 'PolarisFeedRoot.react|': answerAt(100), 'PolarisErrorRoot.entrypoint|': answerAt(100), 'PolarisErrorRoot.react|': answerAt(100), 'PolarisPostRoot.entrypoint|': answerAt(100), 'PolarisPostRoot.react|': answerAt(100, { jsmods: unbound }) };
  const withRoot = { ...answers, 'PolarisDesktopPostRoot.react|': answerAt(100) };
  const get = (b, p) => b.get(p, { headers: { accept: 'text/html', 'sec-fetch-site': 'none' } });
  const blocks = (html) => [...html.matchAll(/<script type="application\/json"[^>]*data-sjs>(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  const initialize = (html) => blocks(html).flatMap((b) => b.require || []).find((r) => r[0] === 'CometPlatformRootClient' && r[1] === 'initialize')[3][0].initialRouteInfo.route;
  const defines = (html) => blocks(html).flatMap((b) => (b.define || []).concat(...(b.require || []).filter((r) => r[0] === 'ServerJSDefine').map((r) => r[3] || [])));
  const post = async (s, b) => {
    const id = String(Date.now());
    await b.request('POST', `/rupload_igphoto/fb_uploader_${id}`, { raw: pngBytes(), headers: { 'content-type': 'image/png', 'x-instagram-rupload-params': JSON.stringify({ upload_id: id }) } });
    return (await b.post('/api/v1/media/configure/', { upload_id: id, caption: 'permalink' })).body.media;
  };

  await t.test('with the desktop post root: the post route, its props from the post, cr:2882 bound', async () => {
    const s = await startCloneServer({}, { snapshot: { revision: '100', documents: { '/': documentAt(100) }, answers: withRoot } });
    t.after(() => s.close());
    const author = new Browser(s.base);
    const a = await author.signup(s, { username: 'post_author' });
    const media = await post(s, author);
    const viewer = new Browser(s.base);
    const v = await viewer.signup(s, { username: 'post_viewer' });
    for (const prefix of ['p', 'reel']) {
      const res = await get(viewer, `/${prefix}/${media.code}/`);
      assert.strictEqual(res.status, 200, prefix);
      const route = initialize(res.text);
      assert.strictEqual(route.actorID, String(v.pk));
      assert.deepStrictEqual(route.rootView.entryPoint, { __dr: 'PolarisPostRoot.entrypoint' });
      assert.strictEqual(route.tracePolicy, 'polaris.postPage');
      assert.deepStrictEqual(route.polarisRouteConfig, { pageID: 'postPage' });
      assert.strictEqual(route.params.shortcode, media.code);
      assert.strictEqual(route.params.permalink_key, prefix);
      assert.strictEqual(route.rootView.props.media_id, String(media.pk));
      assert.strictEqual(route.rootView.props.media_owner_id, String(a.pk));
      assert.deepStrictEqual(route.rootView.props.polaris_preload.media.request, { method: 'GET', url: '/api/v1/media/{media_id}/info/', params: { path: { media_id: String(media.pk) }, query: {} } });
      assert.ok(!/Log into Instagram/.test(res.text), 'no login markup');
      assert.ok(res.text.includes('["cr:2882",["PolarisDesktopPostRoot.react"],{"__rc":["PolarisDesktopPostRoot.react",null]},-1]'), 'cr:2882 bound to the desktop post root');
    }
    // The media request the preloader spec names answers the post.
    const info = await viewer.get(`/api/v1/media/${media.pk}/info/`);
    assert.strictEqual(info.body.items[0].code, media.code);
    // An unknown shortcode: the client's not-found route.
    const missing = await get(viewer, '/p/NoSuchCode1/');
    assert.strictEqual(missing.status, 404);
    assert.deepStrictEqual(initialize(missing.text).rootView.entryPoint, { __dr: 'PolarisErrorRoot.entrypoint' });
    assert.deepStrictEqual(s.upstream, []);
  });

  await t.test('without it (the current snapshot): the page keeps its own route and the gap is reported', async () => {
    const s = await startCloneServer({}, { snapshot: { revision: '100', documents: { '/': documentAt(100) }, answers } });
    t.after(() => s.close());
    const author = new Browser(s.base);
    await author.signup(s, { username: 'post_author2' });
    const media = await post(s, author);
    const res = await get(author, `/p/${media.code}/`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(initialize(res.text).actorID, '0', 'not switched');
    const health = await author.get('/__loader/health');
    assert.ok(health.body.client.missingRequests.some((m) => m.kind === 'route' && m.key === 'PolarisPostRoot'), JSON.stringify(health.body.client.missingRequests));
  });
});
