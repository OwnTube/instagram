'use strict';

/**
 * EXPERIMENTAL (SHELL_SIGNED_IN_HOME=1). A signed-in home route built from the
 * anonymous `/` document, for a viewer who has a clone session.
 *
 * The page's route is chosen by the server, not derived from the user id:
 * `CometPlatformRootClient.initialize` carries `initialRouteInfo.route` (root
 * view, entry point, actor) and `expectedPreloaders`, all for actor "0" and the
 * login homepage. Changing only CurrentUserInitialData.USER_ID leaves the
 * client waiting for preloaders under a different actor, which is why that
 * edit alone never mounted. Here the route is switched as a whole to the feed
 * entry point (PolarisFeedRoot, read from the client's own module), under the
 * viewer's actor id, with no expected preloaders: the entry point's queries
 * (PolarisFeedTimelineRootV2Query, stories tray, ...) are then issued by the
 * client and answered by src/clone. Server-rendered login markup is not
 * hydrated (ssrEnabled false).
 */

const FEED_ROOT = 'PolarisFeedRoot';

function feedView() {
  return {
    allResources: [{ __dr: `${FEED_ROOT}.entrypoint` }, { __dr: `${FEED_ROOT}.react` }],
    resource: { __dr: `${FEED_ROOT}.react` },
    props: { is_desktop: true, page_logging: { name: 'feedPage', params: { page_id: 'feedPage' } } },
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
  route.params = { variant: null };
  route.stripParams = [];
  args.expectedPreloaders = [];
  args.additional_roots = [];
  args.ssrEnabled = false;
  return node;
}

module.exports = { isLoginHomeInitialize, toSignedInHome, FEED_ROOT };
