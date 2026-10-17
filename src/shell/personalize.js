'use strict';

/**
 * Per-request edits to an original page before it reaches a browser.
 *
 *   encryption   Every { key_id, public_key, version } object becomes OUR key,
 *                so the unmodified login/signup forms encrypt to this server.
 *   csrf         `csrf_token` fields and the LSD token become this browser's
 *                clone CSRF token (what the client echoes as X-CSRFToken).
 *   viewer       Identity modules (CurrentUserInitialData) and `viewer` /
 *                `viewerId` config fields describe the clone viewer, or
 *                nobody for an anonymous visitor.
 *   placeholders Captured authenticated templates carry __CLONE_*__ markers
 *                where the capturing account's identity was scrubbed out.
 *   prefetches   Relay prefetches are upstream data for upstream accounts.
 *                With dropPrefetches they are removed, so the client issues
 *                the query itself and our GraphQL endpoint answers it.
 *   server time  Where the server render is dropped, ServerTimeData (the response's own
 *                clock reading) becomes this server's time; a pinned
 *                document's would set the client's clock back to when it
 *                was acquired.
 *   no SSR       With serverRender false the page's server render is not
 *                hydrated (ssrInit disabled, the SSR mount emptied) and the
 *                client renders the page itself; for a browser whose window
 *                the stored render does not fit (src/server.js).
 *   runtime      /__clone/runtime.js is inserted as the first script.
 *
 * The output is per-browser (it carries the CSRF token) and must be served
 * with private, no-store caching.
 */

const { editJsonBlocks, isDefineTuple, prefetchKey, REMOVE } = require('./sjs');
const { isLoginHomeInitialize, toSignedInRoute, homeRoute, isSSRInit, disableAnonymousSSR, insertFeedRoot, emptySSRMount } = require('./signedInRoute');

const RUNTIME_TAG = '<script src="/__clone/runtime.js"></script>';
const STATIC_CDN = /^https:\/\/static\.cdninstagram\.com\//;

const PLACEHOLDERS = {
  __CLONE_VIEWER_PK__: (v) => (v ? v.pk : '0'),
  __CLONE_VIEWER_USERNAME__: (v) => (v ? v.username : ''),
  __CLONE_VIEWER_FULL_NAME__: (v) => (v ? v.display_name || '' : ''),
  __CLONE_VIEWER_PROFILE_PIC__: (v) => (v && v.avatar_url ? v.avatar_url : '/__clone/static/default-avatar.svg'),
  __CLONE_CSRF__: (v, token) => token,
};

function viewerObject(viewer) {
  if (!viewer) return null;
  return {
    id: viewer.pk,
    pk: viewer.pk,
    username: viewer.username,
    full_name: viewer.display_name || '',
    profile_pic_url: viewer.avatar_url || '/__clone/static/default-avatar.svg',
    profile_pic_url_hd: viewer.avatar_url || '/__clone/static/default-avatar.svg',
    is_private: Boolean(viewer.is_private),
    is_verified: false,
    biography: viewer.bio || '',
    external_url: viewer.external_url || null,
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Inside parsed JSON strings values are inserted raw (re-serialisation escapes them); in markup they are HTML-escaped. */
function replacePlaceholders(str, viewer, csrfToken, escape = (x) => x) {
  if (!str.includes('__CLONE_')) return str;
  let out = str;
  for (const [marker, value] of Object.entries(PLACEHOLDERS)) {
    if (out.includes(marker)) out = out.split(marker).join(escape(String(value(viewer, csrfToken))));
  }
  return out;
}

/**
 * `signedInHome` + `feedRoot` (the route root's stored bootloader answer) switch
 * the anonymous page to a signed-in route: `route` (src/shell/signedInRoute.js,
 * default the home feed) at `routeUrl`.
 */
function personalize(html, { viewer = null, csrfToken, encryption, dropPrefetches = false, identity = false, signedInHome = false, feedRoot = null, route = null, routeUrl = '/', toLocal = (u) => u, stats, now = Date.now(), serverRender = true } = {}) {
  if (typeof html !== 'string' || !html) return html;
  const counts = { encryption: 0, csrf: 0, viewer: 0, prefetchesDropped: 0, placeholders: 0, signedInRoute: 0 };
  // The experimental signed-in route needs identity that agrees with it.
  // The signed-in route needs the feed root's code (a stored bootloader answer).
  const homeSwitch = Boolean(signedInHome && viewer && feedRoot);
  const spec = route || homeRoute();
  const docDefines = new Set();
  let initTuple = null;
  let ssrMount = null;
  if (homeSwitch) identity = true;

  const visit = (node) => {
    if (typeof node === 'string') {
      const replaced = replacePlaceholders(node, viewer, csrfToken);
      if (replaced !== node) {
        counts.placeholders += 1;
        return replaced;
      }
      return undefined;
    }
    if (homeSwitch && isLoginHomeInitialize(node)) {
      // Moved after the page's own payload (insertFeedRoot).
      initTuple = toSignedInRoute(node, viewer, spec, routeUrl);
      counts.signedInRoute += 1;
      return REMOVE;
    }
    if ((homeSwitch || !serverRender) && isSSRInit(node)) {
      disableAnonymousSSR(node);
      ssrMount = node[3][0].eid || null;
      counts.ssrDisabled = (counts.ssrDisabled || 0) + 1;
      return undefined;
    }
    if (dropPrefetches && prefetchKey(node)) {
      counts.prefetchesDropped += 1;
      return REMOVE;
    }
    // Identity edits (CurrentUserInitialData, viewer) apply to a signed-in
    // template or the signed-in home route. (They once seemed to trip a
    // "tamper check"; the real cause was the payload length contract, see
    // docs/REVERSE-ENGINEERING.md section 6.) The csrf token is never rewritten:
    // the client sends X-CSRFToken from the `csrftoken` cookie, which this
    // server sets to the clone session's token.
    // The page names Facebook's cross-site user-info URL; PolarisLoggedInFBUserProvider
    // fetches it (with facebook.com cookies) to offer "Continue as <Facebook
    // name>". This origin has no Facebook session (the runtime drops Meta hosts),
    // so the probe could only fail; with no URL the provider skips it
    // (`if (cross_site_request_url == null) return null`).
    if (isDefineTuple(node) && node[0] === 'PolarisSiteData' && node[2] && node[2].cross_site_request_url != null) {
      node[2].cross_site_request_url = null;
      counts.crossSiteProbe = (counts.crossSiteProbe || 0) + 1;
    }
    // ServerTime compares these with the page load's own timing and, when they
    // disagree by more than the transfer time, offsets every client clock
    // reading (message and seen timestamps, relative times) by the difference.
    // Only where the server-rendered markup is dropped (the signed-in route,
    // or serverRender false), so nothing on the page was rendered at the
    // stored time. A page that keeps its markup keeps the time it was
    // rendered at (hydration compares time-dependent output with it).
    if ((homeSwitch || !serverRender) && isDefineTuple(node) && node[0] === 'ServerTimeData' && node[2] && typeof node[2].serverTime === 'number') {
      node[2].serverTime = now;
      node[2].timeOfRequestStart = now;
      node[2].timeOfResponseStart = now;
      counts.serverTime = 1;
    }
    // The Bootloader batches the endpoint modules asked for in one tick into one
    // request (`modules=A,B`), so which sets it asks for depends on timing,
    // and a pinned snapshot cannot hold every combination (nor may one be
    // made up from the parts). With the client's own maxBatchSize of 1 it asks
    // for each module on its own, which the snapshot holds as genuine
    // single-module answers; a module it lacks is still an explicit miss.
    if (isDefineTuple(node) && node[0] === 'BootloaderEndpointConfig' && node[2] && node[2].maxBatchSize !== 1) {
      node[2].maxBatchSize = 1;
      counts.unbatchedBootloader = 1;
    }
    if (homeSwitch && isDefineTuple(node)) docDefines.add(node[0]);
    if (identity && isDefineTuple(node)) {
      const [name, , exports] = node;
      if (name === 'CurrentUserInitialData') {
        exports.USER_ID = viewer ? viewer.pk : '0';
        exports.ACCOUNT_ID = viewer ? viewer.pk : '0';
        exports.NAME = viewer ? viewer.display_name || viewer.username : '';
        exports.SHORT_NAME = viewer ? viewer.username : null;
        // The Direct read-receipt key (CurrentUser.getEIMU); Direct answers use
        // the same local id as `participant_fbid` (src/clone/homeOperations.js).
        if ('IG_USER_EIMU' in exports) exports.IG_USER_EIMU = viewer ? viewer.pk : '0';
        if ('NON_FACEBOOK_USER_ID' in exports) exports.NON_FACEBOOK_USER_ID = viewer ? viewer.pk : '0';
        counts.viewer += 1;
      }
      if (name === 'PolarisViewer' && homeSwitch) {
        exports.data = viewerObject(viewer);
        exports.id = viewer.pk;
        counts.viewer += 1;
      }
      return undefined;
    }
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      // Image-sprite data (ixData entries): the client paints these URLs as CSS
      // backgrounds through rules it inserts at runtime, which no transport hook
      // sees, so they point at the local asset proxy here. (This edit once
      // "broke boot" only because edited blocks kept a stale data-content-len.)
      for (const key of ['spi', '_spi']) {
        if (typeof node[key] === 'string' && STATIC_CDN.test(node[key])) {
          node[key] = node[key].replace(STATIC_CDN, '/__ig/static.cdninstagram.com/');
          counts.sprites = (counts.sprites || 0) + 1;
        }
      }
      if (encryption) {
        // The page's password-encryption config, in either naming style. The
        // original value's type (number or string) is kept for key ids.
        for (const [idKey, pubKey, verKey] of [
          ['key_id', 'public_key', 'version'],
          ['keyId', 'publicKey', 'version'],
          ['keyID', 'publicKey', 'version'],
        ]) {
          if (idKey in node && pubKey in node && typeof node[pubKey] === 'string') {
            node[idKey] = typeof node[idKey] === 'number' ? Number(encryption.key_id) : encryption.key_id;
            node[pubKey] = encryption.public_key;
            if (verKey in node) node[verKey] = typeof node[verKey] === 'number' ? Number(encryption.version) : encryption.version;
            counts.encryption += 1;
          }
        }
      }
      if (identity && 'viewerId' in node && 'viewer' in node) {
        node.viewerId = viewer ? viewer.pk : null;
        node.viewer = viewerObject(viewer);
        counts.viewer += 1;
      }
    }
    return undefined;
  };

  let { html: out } = editJsonBlocks(html, visit);
  if (homeSwitch && counts.signedInRoute) {
    const done = insertFeedRoot(out, feedRoot, docDefines, toLocal, initTuple, spec.root, spec.entryPoint, spec.bindings || {});
    out = done.html;
    counts.feedRootResources = done.inserted;
    counts.feedRootUnmapped = done.missing.length;
    const emptied = emptySSRMount(out, ssrMount);
    out = emptied.html;
    counts.ssrMarkupRemoved = emptied.removed;
  }
  if (!serverRender && !(homeSwitch && counts.signedInRoute)) {
    const emptied = emptySSRMount(out, ssrMount);
    out = emptied.html;
    counts.ssrMarkupRemoved = emptied.removed;
  }
  if (out.includes('__CLONE_')) out = replacePlaceholders(out, viewer, csrfToken, escapeHtml);
  out = out.replace(/<head\b[^>]*>/i, (open) => `${open}${RUNTIME_TAG}`);
  if (!out.includes(RUNTIME_TAG)) out = `${RUNTIME_TAG}${out}`;
  if (stats) Object.assign(stats, counts);
  return out;
}

module.exports = { personalize, viewerObject, escapeHtml, RUNTIME_TAG, PLACEHOLDERS };
