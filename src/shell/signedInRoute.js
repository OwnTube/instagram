'use strict';

/**
 * Signed-in home route: on by default for a signed-in viewer (opt out with
 * SHELL_SIGNED_IN_HOME=0, which serves every visitor the anonymous document).
 *
 * Built from the anonymous `/` document plus Instagram's own bootloader-endpoint
 * answer for `PolarisFeedRoot.react` (stored in .cache/bootloader). Contracts
 * (docs/REVERSE-ENGINEERING.md):
 *
 *  - the route is server-chosen: `CometPlatformRootClient.initialize` carries
 *    `initialRouteInfo.route` (root view, entry point, actor) and the
 *    `expectedPreloaders`; the whole route is switched, under the viewer's actor,
 *    to `PolarisFeedRoot.entrypoint` (its props/params are the ones
 *    PolarisFeedRoot.react and XPolarisFeedControllerRouteBuilder read);
 *  - the feed root's code is applied the way `HasteResponse.handle` applies an
 *    endpoint answer: support data (`HasteSupportData.handle`), resource and
 *    component maps (`Bootloader.handlePayload`), the answer's `allResources`
 *    as script/style tags carrying `data-bootloader-hash` (so the Bootloader
 *    records them as loaded), then its `jsmods`. The tags are blocking and come
 *    before the block that calls `initialize`, so the root module is defined by
 *    then and `loadModules` takes `fastPathForAlreadyRequired`;
 *  - the page's own config modules win over the answer's (anonymous) copies.
 *
 * No hash, resource mapping or module is invented: everything inserted comes
 * from the stored answer, unchanged.
 */

const FEED_ROOT = 'PolarisFeedRoot';

/**
 * Component replacements the stored (anonymous) answer binds to the logged-out
 * desktop top navigation. The server picks `cr:` bindings per viewer; for a
 * signed-in viewer these slots are unbound. Evidence, from the stored bundles
 * (docs/REVERSE-ENGINEERING.md section 9):
 *  - `cr:2696` -> PolarisDesktopNav: rendered by PolarisShellHeader whenever
 *    bound (PolarisFeedRoot never passes `hideHeader`); outside that slot only
 *    the logged-out channel preview uses it. Unbound, the header falls back to
 *    PolarisFeedMobileTopNavigation, which has its own logged-in branch and
 *    renders nothing on wide screens;
 *  - `cr:4477` -> PolarisDesktopNavLoggedOutContainer (the "Log In" / "Sign Up"
 *    buttons; only consumer: PolarisDesktopNav);
 *  - `cr:7459` -> PolarisProfileStoryHighlightsTrayLegacy: PolarisProfileStoryHighlightsTray
 *    renders the Relay tray (`cr:7462 ?? cr:9493`, PolarisProfileStoryHighlightsTray.next)
 *    for a signed-in viewer given `highlightsQuery`, and the legacy tray
 *    whenever cr:7459 is bound, except where the Relay tray renders while
 *    logged out (crawlers), so the two never show together. The legacy tray
 *    reads redux, which that Relay query fills
 *    (subscribeToPolarisRelayUserHighlights), so signed in it is the Relay tray.
 * Each is replaced with the answer's own unbound form `{"__rc":[null,null]}`.
 * Other logged-out bindings are gated by the client itself (cr:7457 by
 * useHasLoggedOutMobileTopNav, cr:4197 by useShouldShowLoggedOutCallToAction)
 * and are left as delivered.
 */
const LOGGED_OUT_ONLY = new Set(['cr:2696', 'cr:4477', 'cr:7459']);

/**
 * Bindings for services this server does not have, left unbound so the client
 * takes its own fallback:
 *  - `cr:5380` -> usePolarisSetupProfileGatingREST (signed-in profile gating):
 *    it fetches the gating info named by the server's
 *    `polaris_preload.gated` preloader spec (age/region restrictions). No
 *    content is gated here and that endpoint is not known, so the slot is
 *    unbound: usePolarisSetupProfileGating falls back to useEmptyFunction
 *    (`n("cr:5380") ?? useEmptyFunction`), i.e. "not gated".
 */
const NO_LOCAL_SERVICE = new Set(['cr:5380']);

function forSignedInViewer(define, bindings = {}) {
  const bound = bindings[define[0]];
  if (bound) return [define[0], [bound], { __rc: [bound, null] }, define[3]];
  return LOGGED_OUT_ONLY.has(define[0]) || NO_LOCAL_SERVICE.has(define[0]) ? [define[0], [], { __rc: [null, null] }, define[3]] : define;
}
const FEED_PARAMS = { create_live: false, create_long_video: false, create_post: false, from_share: false, yr: false, scs: false, flo: false, variant: null };
// XPolarisProfileControllerRouteBuilder: "/{username}/{?tab}/{?view_type}/{?igshid}/" and its defaults.
const PROFILE_PARAMS = {
  show_shared_access_dialog: false,
  show_meta_verified_dialog: false,
  show_pro_dash_dialog: false,
  pro_dash_tool: '',
  show_ad_partnerships_dialog: false,
  enable_persistent_cta: false,
  tab: null,
  view_type: null,
  igshid: null,
};

/**
 * Signed-in routes the shell can build. Each names its entry point and the
 * entry point's root component, the stored bootloader answers that provide
 * their code (`answers`, module names as requested), the route
 * props its entry point and root read, the pattern and params of its route builder, its
 * trace policy and page id (both read by the client: `polaris.feedPage`,
 * `polaris.profilePage`, page ids `feedPage`, `profilePage`).
 * `canonicalRouteName` is only used for logging (null-checked everywhere); it
 * is not in any stored material, so it is null rather than invented.
 */
function homeRoute() {
  return {
    entryPoint: FEED_ROOT,
    root: FEED_ROOT,
    answers: [`${FEED_ROOT}.react`],
    props: { is_desktop: true, enable_desktop_nux_flow: false, enable_mobile_suggested_user_cta: false, page_logging: { name: 'feedPage', params: { page_id: 'feedPage' } } },
    params: { ...FEED_PARAMS },
    routePath: '/',
    tracePolicy: 'polaris.feedPage',
    pageID: 'feedPage',
  };
}

/**
 * A local user's profile (posts tab). Props read by buildPolarisProfileRoute
 * (`id`, the optional query switches), PolarisProfilePostsTabRoot.entrypoint
 * (`id`, `number_of_preloaded_posts`, default 12) and
 * PolarisProfilePostsTabRoot.react (`userID`, `userFullName`),
 * PolarisProfileRoot.react (`polaris_preload`, below); the switches
 * for queries we have no content for (suggested users, SEO pool)
 * are off.
 */
function profileRoute(user) {
  const pk = String(user.pk);
  return {
    // buildPolarisProfileRoute: the posts tab's entry point has the profile
    // root as its component and nests the tab (`contentEntryPoint`).
    entryPoint: 'PolarisProfilePostsTabRoot',
    root: 'PolarisProfileRoot',
    answers: ['PolarisProfilePostsTabRoot.entrypoint', 'PolarisProfileRoot.react'],
    props: {
      id: pk,
      userID: pk,
      userFullName: user.display_name || null,
      enable_highlights_query: true,
      enable_suggested_users_query: false,
      enable_seo_crawling_pool: false,
      // PolarisPreloadConstants.POLARIS_PRELOAD_PROP: the server's preloader
      // specs by name (bootstrapPolarisPreloader issues those enabled on
      // navigation), including `gated` for the gating hook (unbound here, see
      // NO_LOCAL_SERVICE). No server preloads: the entry point's own queries
      // load the profile.
      polaris_preload: {},
    },
    params: { ...PROFILE_PARAMS, username: user.username },
    routePath: '/{username}/{?tab}/{?view_type}/{?igshid}/',
    tracePolicy: 'polaris.profilePage',
    pageID: 'profilePage',
  };
}

/**
 * A local account's stories (`/stories/{username}/{?initial_media_id}/`,
 * XPolarisStoriesMediaControllerRouteBuilder). PolarisStoriesMediaRoot.entrypoint
 * preloads nothing (`queries: {}`); PolarisStoriesMediaRoot.react reads
 * routeParams `username`, `initial_media_id` and routeProps `user` (the
 * owner: initStoryPage stores it and loads the reel by its `id`),
 * `is_media_inactive`, `show_qr_modal`; the stories data sync reads
 * `rootView.props.user_id` under trace policy `polaris.StoriesPage`. The page
 * id is the stories page's own name (`StoriesPage`, as its external-link
 * logging names it). `owner` is the user object in the shape the page
 * carries for the viewer (src/shell/personalize.js viewerObject).
 */
function storiesRoute(user, owner) {
  const pk = String(user.pk);
  return {
    entryPoint: 'PolarisStoriesMediaRoot',
    root: 'PolarisStoriesMediaRoot',
    answers: ['PolarisStoriesMediaRoot.entrypoint', 'PolarisStoriesMediaRoot.react'],
    props: { user_id: pk, user: owner, is_media_inactive: false, show_qr_modal: false },
    params: { username: user.username, initial_media_id: null },
    routePath: '/stories/{username}/{?initial_media_id}/',
    tracePolicy: 'polaris.StoriesPage',
    pageID: 'StoriesPage',
  };
}

/**
 * The activity feed ("Notifications"): PolarisActivityFeedRoot, whose entry
 * point preloads nothing; its root renders `cr:34873` (PolarisActivityFeed,
 * bound in the acquired answer), which loads the feed itself through
 * /api/v1/news/inbox/ and /api/v1/friendships/pending/. Route builder
 * XPolarisActivityFeedControllerRouteBuilder: `/notifications/`, default
 * params {followRequests: false}. Page id: PolarisActivityFeedConstants
 * PAGE_ID (`ActivityFeedPage`). Trace policy `polaris.notificationsPage`: one
 * of the `polaris.<page>` policies the client maps to its surfaces
 * (usePolarisVenusFlytrapPreSelectedProducts).
 * /accounts/activity/ gets the same route: the client redirects it to
 * /notifications/ itself (usePolarisAccountActivityRedirect).
 */
function activityRoute() {
  return {
    entryPoint: 'PolarisActivityFeedRoot',
    root: 'PolarisActivityFeedRoot',
    answers: ['PolarisActivityFeedRoot.entrypoint', 'PolarisActivityFeedRoot.react'],
    props: {},
    params: { followRequests: false },
    routePath: '/notifications/',
    tracePolicy: 'polaris.notificationsPage',
    pageID: 'ActivityFeedPage',
  };
}

/**
 * The Direct inbox, or one thread of it: PolarisDirectInboxRoot. Its entry
 * point preloads the mailbox, badge counts, presence, viewer settings and
 * account queries (each answered locally, src/clone/homeOperations.js) and the
 * inbox tray entry point; with `routeParams.thread_key` (IGDThreadUrl:
 * `/direct/t/{?thread_key}/`, an extra URL of the inbox route) it also
 * preloads that thread's header and messages. The client builds
 * `/direct/inbox/` as a literal (no route builder, so no default params).
 * Page id `DirectInboxPage` for both: the thread URL is an extra URL of the
 * same route, so it carries the same route config, and that id is the one
 * useShouldHideChatTabs lists (it has no thread page id), so the client does
 * not open its chat tabs over the page. Components on the thread pass their
 * own `DirectThreadPage` to usePolarisPageID. Trace policy
 * `polaris.directInboxPage` (see activityRoute).
 */
function directInboxRoute(threadKey = null) {
  return {
    entryPoint: 'PolarisDirectInboxRoot',
    root: 'PolarisDirectInboxRoot',
    answers: ['PolarisDirectInboxRoot.entrypoint', 'PolarisDirectInboxRoot.react'],
    props: {},
    params: threadKey ? { thread_key: threadKey } : {},
    routePath: threadKey ? '/direct/t/{?thread_key}/' : '/direct/inbox/',
    tracePolicy: 'polaris.directInboxPage',
    pageID: 'DirectInboxPage',
    // usePolarisIsOnDirectPage: entity_type `direct` (or `direct_old`).
    entityKeyConfig: { entity_type: { source: 'constant', value: 'direct' } },
  };
}

/**
 * The Reels tab: PolarisClipsTabRoot, whose entry point nests the clips
 * viewer's entry point (PolarisClipsViewerDefaultContent, or the following
 * tab's for `routeParams.tab === 'following'` when its gate is on). Route
 * builder `/reels/{?shortcode}/` (no default params); page id `reelsTab`, the
 * id the client's page checks use; trace policy `polaris.reelsTab`.
 */
function reelsRoute() {
  return {
    entryPoint: 'PolarisClipsTabRoot',
    root: 'PolarisClipsTabRoot',
    answers: ['PolarisClipsTabRoot.entrypoint', 'PolarisClipsTabRoot.react'],
    props: {},
    params: { shortcode: null },
    routePath: '/reels/{?shortcode}/',
    tracePolicy: 'polaris.reelsTab',
    pageID: 'reelsTab',
    // usePolarisIsOnReelsPage: entity_type `clip`.
    entityKeyConfig: { entity_type: { source: 'constant', value: 'clip' } },
  };
}

/**
 * A post page (`/p/{shortcode}/`, `/reel/{shortcode}/`):
 * XPolarisPostControllerRouteBuilder `/{permalink_key}/{shortcode}/{?slug}/`
 * with its default params. PolarisPostRoot.entrypoint preloads the "more
 * posts" grid (routeProps.media_owner_id); PolarisPostRoot.react reads
 * routeParams.shortcode and routeProps media_id (the media pk: the client
 * keys posts by `id.split("_")[0]`), media_owner_id and
 * polaris_preload.media, and renders the page through `cr:2882`, which the
 * anonymous answer leaves unbound (its fallback is the 404 page).
 *
 * `polaris_preload.media` is a preloader spec in the shape
 * bootstrapPolarisPreloader reads ({request: {method, url, params}, ...}),
 * not enabled, so usePolarisPreloadedGetQuery issues the request itself: the
 * client's own media info request (PolarisPostActionLoadPost:
 * `/api/v1/media/{media_id}/info/` with {path: {media_id}, query: {}}).
 *
 * `cr:2882` is bound to PolarisDesktopPostRoot.react. It is the desktop post
 * page root: it reads routeProps.media_id, renders PolarisShell under the page
 * ID, and lazily loads PolarisDesktopPostPage.react. Nothing else in the
 * bundles references it. This binding is an inference from that evidence,
 * not a recorded server answer. The route is served only when the snapshot
 * holds all three answers below; otherwise the page falls back as before
 * (routeWithAnswers).
 */
const POST_PARAMS = { chaining: false, preserve_img_index: false, viewer: false, show_insights: false, slug: null };
function postRoute(post, permalinkKey = 'p') {
  const mediaId = String(post.pk);
  return {
    entryPoint: 'PolarisPostRoot',
    root: 'PolarisPostRoot',
    answers: ['PolarisPostRoot.entrypoint', 'PolarisPostRoot.react', 'PolarisDesktopPostRoot.react'],
    bindings: { 'cr:2882': 'PolarisDesktopPostRoot.react' },
    props: {
      media_id: mediaId,
      media_owner_id: String(post.authorPk),
      polaris_preload: {
        media: {
          request: { method: 'GET', url: '/api/v1/media/{media_id}/info/', params: { path: { media_id: mediaId }, query: {} } },
          preloadEnabledOnInit: false,
          preloadEnabledOnNav: false,
          preloaderID: null,
        },
      },
    },
    params: { ...POST_PARAMS, permalink_key: permalinkKey, shortcode: post.code },
    routePath: '/{permalink_key}/{shortcode}/{?slug}/',
    tracePolicy: 'polaris.postPage',
    pageID: 'postPage',
    // usePolarisIsOnPostPage: entity_type `post`.
    entityKeyConfig: { entity_type: { source: 'constant', value: 'post' } },
  };
}

/**
 * The client's own "page not available" route (PolarisErrorRoot: entry point
 * with no preloads, root rendering PolarisHttp404Page), for a URL that names
 * nothing here, e.g. a profile of no local account. Its route props
 * (`failure_reason`, `page_type`, `restricted_age`,
 * `show_lox_redesigned_404_page`) are server-chosen and all optional in the
 * client; Instagram's own not-found document has not been acquired, so none is
 * set. Page id: the error page's own identifier (`httpErrorPage`); no trace
 * policy for it exists in the client, so none is named. Served with HTTP 404.
 */
function errorRoute(url) {
  return {
    entryPoint: 'PolarisErrorRoot',
    root: 'PolarisErrorRoot',
    answers: ['PolarisErrorRoot.entrypoint', 'PolarisErrorRoot.react'],
    props: {},
    params: {},
    routePath: url,
    tracePolicy: null,
    pageID: 'httpErrorPage',
    status: 404,
  };
}

/**
 * A route view in the shape the page server sends (the anonymous documents'
 * own routes): its entry point, the entry point's root component, the props.
 */
function view(spec) {
  return {
    allResources: [{ __dr: `${spec.entryPoint}.entrypoint` }, { __dr: `${spec.root}.react` }],
    resource: { __dr: `${spec.root}.react` },
    props: spec.props,
    entryPoint: { __dr: `${spec.entryPoint}.entrypoint` },
  };
}

/** True for the root-client initialize call of the anonymous login homepage. */
function isLoginHomeInitialize(node) {
  if (!Array.isArray(node) || node[0] !== 'CometPlatformRootClient' || node[1] !== 'initialize') return false;
  const args = Array.isArray(node[3]) ? node[3][0] : null;
  const route = args && args.initialRouteInfo && args.initialRouteInfo.route;
  return Boolean(route && route.routePath === '/' && route.actorID === '0');
}

/** Rewrite the initialize arguments in place: route `spec` for `viewer`, at `url`. */
function toSignedInRoute(node, viewer, spec = homeRoute(), url = '/') {
  const args = node[3][0];
  const route = args.initialRouteInfo.route;
  route.actorID = String(viewer.pk);
  route.rootView = view(spec);
  route.hostableView = view(spec);
  route.tracePolicy = spec.tracePolicy;
  route.canonicalRouteName = null;
  route.polarisRouteConfig = { pageID: spec.pageID };
  route.params = spec.params;
  route.stripParams = [];
  route.routePath = spec.routePath;
  route.url = url;
  // The route's entity, read by getCometEntityKey ({key: {source, value}}),
  // e.g. what usePolarisIsOnDirectPage tests; absent unless the spec names one.
  route.entityKeyConfig = spec.entityKeyConfig || null;
  args.expectedPreloaders = [];
  args.additional_roots = [];
  args.ssrEnabled = false;
  return node;
}

const toSignedInHome = (node, viewer) => toSignedInRoute(node, viewer, homeRoute());

/**
 * The anonymous document's Comet SSR init (`CometSSRClientInjector.ssrInit`).
 * Its server render (the hidden `eid` mount and the onPayloadReceived passes)
 * is the logged-out login homepage; with SSR enabled, CometSSRStateManager
 * hydrates that markup with whatever root the page initializes, so the feed
 * root would be hydrated against logged-out HTML (React #418, then a client
 * render fallback). A signed-in route has no server render of its own here, so
 * its document says so the way the server does: `enabled: false`, which
 * ssrInit turns into the "SSR is disabled from server" path (state SSRDisabled,
 * then ClientRender via createRoot; later payloads are ignored in that state).
 * Evidence: docs/REVERSE-ENGINEERING.md section 11.
 */
function isSSRInit(node) {
  return Array.isArray(node) && node[0] === 'CometSSRClientInjector' && node[1] === 'ssrInit' && Array.isArray(node[3]) && node[3][0] && typeof node[3][0] === 'object';
}

function disableAnonymousSSR(node) {
  node[3][0].enabled = false;
  return node;
}

/**
 * The anonymous document's server render: the login homepage markup inside the
 * SSR mount (`<div id="<eid>" style="content-visibility:hidden">`). With SSR
 * disabled the client never hydrates it, but `comet_ssr_unhide_early` reveals
 * the mount before the client's own first commit replaces it, so a signed-in
 * viewer saw the logged-out login page for seconds. A signed-in route keeps the
 * mount element and drops only its children (a document with no server render,
 * like Instagram's own signed-in pages); the splash screen covers the page
 * until the client renders. Returns { html, removed } (removed: characters).
 */
function emptySSRMount(html, eid) {
  if (!eid) return { html, removed: 0 };
  const open = new RegExp(`<div id="${eid.replace(/[^\w-]/g, '')}"[^>]*>`).exec(html);
  if (!open) return { html, removed: 0 };
  const start = open.index + open[0].length;
  const tags = /<div\b|<\/div>/g;
  tags.lastIndex = start;
  let depth = 1;
  let m;
  while ((m = tags.exec(html))) {
    depth += m[0] === '<div' ? 1 : -1;
    if (depth === 0) return { html: html.slice(0, start) + html.slice(m.index), removed: m.index - start };
  }
  return { html, removed: 0 };
}

/** The stored endpoint answer's payload ({allResources, hsrp, jsmods}), or null. */
function parseAnswer(text) {
  try {
    const j = JSON.parse(String(text).replace(/^for \(;;\);/, ''));
    return j && j.hrp && Array.isArray(j.hrp.allResources) && j.hrp.hsrp ? j.hrp : null;
  } catch {
    return null;
  }
}

function escapeJsonForScript(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function attr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Append the feed root's resources, its payload and the (switched) initialize
 * call after the page's own payload blocks, followed by a copy of the page's
 * own `ServerJSPayloadListener.process()` trigger. The initialize call must come
 * last: the feed entry point evaluates support data at initialisation (e.g.
 * gkx 8953 in getPolarisFeedInitialPageSize), and the anonymous page delivers
 * some of it in blocks after its own initialize call.
 * `docDefines` are the module names the page itself defines.
 * Returns { html, inserted, missing }; `missing` lists resource hashes the
 * answer names but does not map (they cannot be served and are reported).
 */
function insertFeedRoot(html, answers, docDefines, toLocal, initTuple, root = FEED_ROOT, entryPoint = root, bindings = {}) {
  // One answer, or several (a route whose entry point and root component are
  // answered separately); each is applied the way HasteResponse.handle does.
  const list = Array.isArray(answers) ? answers : [answers];
  const tags = [];
  const missing = [];
  const seenHashes = new Set();
  const seenDefines = new Set(docDefines);
  const define = [];
  const require = [];
  for (const answer of list) {
    const hblp = answer.hsrp.hblp || {};
    const rsrcMap = hblp.rsrcMap || {};
    for (const hash of answer.allResources) {
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);
      const e = rsrcMap[hash];
      if (!e || !e.src) {
        missing.push(hash);
        continue;
      }
      const src = attr(toLocal(e.src));
      if (e.type === 'css') tags.push(`<link rel="stylesheet" href="${src}" data-bootloader-hash="${attr(hash)}" crossorigin="anonymous" />`);
      else if (e.type === 'js') tags.push(`<script src="${src}" data-bootloader-hash="${attr(hash)}" crossorigin="anonymous"></script>`);
    }
    const jsmods = answer.jsmods || {};
    for (const d of jsmods.define || []) {
      if (!Array.isArray(d) || seenDefines.has(d[0])) continue;
      seenDefines.add(d[0]);
      define.push(forSignedInViewer(d, bindings));
    }
    if (answer.hsrp.hsdp) require.push(['HasteSupportData', 'handle', null, [answer.hsrp.hsdp]]);
    require.push(['Bootloader', 'handlePayload', null, [hblp]]);
    require.push(...(jsmods.require || []));
  }
  // The page server's "delivered" signals for its route root, as the anonymous
  // document sends them for CAAIGLoginHomepageRoot: support data ("sd") and
  // styles ("css") for the root are in this document (above), so references to
  // the root may resolve (RequireDeferredReference.unblock defines rd:<module>).
  const roots = [`${root}.react`, `${entryPoint}.entrypoint`];
  require.push(['RequireDeferredReference', 'unblock', [], [roots, 'sd']]);
  require.push(['RequireDeferredReference', 'unblock', [], [roots, 'css']]);

  // Same attributes as the page's own payload blocks: the listener checks the
  // content length (see sjs.withContentLength) and compares the nonce.
  const nonce = (/<script type="application\/json" nonce="([^"]*)"/.exec(html) || [])[1];
  const block = (payload) => {
    const text = escapeJsonForScript(payload);
    return `<script type="application/json"${nonce ? ` nonce="${attr(nonce)}"` : ''} data-content-len="${text.length}" data-sjs>${text}</script>`;
  };
  const trigger = (/<script src="data:text\/javascript;base64,[^"]*"[^>]*><\/script>/.exec(
    html.slice(html.lastIndexOf('data-sjs>')),
  ) || [''])[0];
  const parts = [...tags, block({ define, require })];
  if (initTuple) parts.push(block({ require: [initTuple] }));
  parts.push(trigger);
  const marker = html.lastIndexOf("<div id='has-finished-comet-page'");
  const at = marker >= 0 ? marker : html.lastIndexOf('</body>');
  if (at < 0) return { html, inserted: 0, missing };
  return { html: html.slice(0, at) + parts.join('') + html.slice(at), inserted: tags.length, missing };
}

module.exports = { emptySSRMount, isLoginHomeInitialize, toSignedInHome, toSignedInRoute, homeRoute, profileRoute, storiesRoute, activityRoute, directInboxRoute, reelsRoute, postRoute, errorRoute, isSSRInit, disableAnonymousSSR, insertFeedRoot, parseAnswer, FEED_ROOT, LOGGED_OUT_ONLY, NO_LOCAL_SERVICE };
