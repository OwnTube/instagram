'use strict';

/**
 * Signed-in home route (SHELL_SIGNED_IN_HOME=1, off by default until verified).
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
 *    buttons; only consumer: PolarisDesktopNav).
 * Each is replaced with the answer's own unbound form `{"__rc":[null,null]}`.
 * Other logged-out bindings are gated by the client itself (cr:7457 by
 * useHasLoggedOutMobileTopNav, cr:4197 by useShouldShowLoggedOutCallToAction)
 * and are left as delivered.
 */
const LOGGED_OUT_ONLY = new Set(['cr:2696', 'cr:4477']);

function forSignedInViewer(define) {
  return LOGGED_OUT_ONLY.has(define[0]) ? [define[0], [], { __rc: [null, null] }, define[3]] : define;
}
const FEED_PARAMS = { create_live: false, create_long_video: false, create_post: false, from_share: false, yr: false, scs: false, flo: false, variant: null };

function feedView() {
  return {
    allResources: [{ __dr: `${FEED_ROOT}.entrypoint` }, { __dr: `${FEED_ROOT}.react` }],
    resource: { __dr: `${FEED_ROOT}.react` },
    props: { is_desktop: true, enable_desktop_nux_flow: false, enable_mobile_suggested_user_cta: false, page_logging: { name: 'feedPage', params: { page_id: 'feedPage' } } },
    entryPoint: { __dr: `${FEED_ROOT}.entrypoint` },
  };
}

/** True for the root-client initialize call of the anonymous login homepage. */
function isLoginHomeInitialize(node) {
  if (!Array.isArray(node) || node[0] !== 'CometPlatformRootClient' || node[1] !== 'initialize') return false;
  const args = Array.isArray(node[3]) ? node[3][0] : null;
  const route = args && args.initialRouteInfo && args.initialRouteInfo.route;
  return Boolean(route && route.routePath === '/' && route.actorID === '0');
}

/** Rewrite the initialize arguments in place for `viewer`. */
function toSignedInHome(node, viewer) {
  const args = node[3][0];
  const route = args.initialRouteInfo.route;
  route.actorID = String(viewer.pk);
  route.rootView = feedView();
  route.hostableView = feedView();
  route.tracePolicy = 'polaris.feedPage';
  route.canonicalRouteName = 'comet.igweb.PolarisFeedRoute';
  route.polarisRouteConfig = { pageID: 'feedPage' };
  route.params = { ...FEED_PARAMS };
  route.stripParams = [];
  args.expectedPreloaders = [];
  args.additional_roots = [];
  args.ssrEnabled = false;
  return node;
}

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
function insertFeedRoot(html, answer, docDefines, toLocal, initTuple) {
  const hblp = answer.hsrp.hblp || {};
  const rsrcMap = hblp.rsrcMap || {};
  const tags = [];
  const missing = [];
  for (const hash of answer.allResources) {
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
  const define = (jsmods.define || []).filter((d) => Array.isArray(d) && !docDefines.has(d[0])).map(forSignedInViewer);
  const require = [];
  if (answer.hsrp.hsdp) require.push(['HasteSupportData', 'handle', null, [answer.hsrp.hsdp]]);
  require.push(['Bootloader', 'handlePayload', null, [hblp]]);
  require.push(...(jsmods.require || []));
  // The page server's "delivered" signals for its route root, as the anonymous
  // document sends them for CAAIGLoginHomepageRoot: support data ("sd") and
  // styles ("css") for the root are in this document (above), so references to
  // the root may resolve (RequireDeferredReference.unblock defines rd:<module>).
  const roots = [`${FEED_ROOT}.react`, `${FEED_ROOT}.entrypoint`];
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

module.exports = { isLoginHomeInitialize, toSignedInHome, isSSRInit, disableAnonymousSSR, insertFeedRoot, parseAnswer, FEED_ROOT, LOGGED_OUT_ONLY };
