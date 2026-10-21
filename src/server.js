'use strict';

/**
 * The server: Instagram's genuine web client, served from ONE pinned, verified
 * local snapshot (src/pinnedClient.js, src/clientSnapshot.js), with every API
 * call the client makes answered by our own backend (src/backend, src/clone).
 *
 * Pinned only. This process never contacts Instagram: it does not import the
 * upstream client (src/upstream.js, used only by the operator's acquisition
 * command), and a document, asset or bootloader answer the snapshot does not
 * hold is answered with an explicit error naming it and the snapshot revision,
 * and counted in /__loader/health -> client. Changing the served client is an
 * operator action (scripts/client-snapshot.js: acquire, build, verify,
 * activate, rollback), never a side effect of a request.
 */

// First: an unsupported Node fails here with a readable message, not deep in
// the require graph (node:sqlite).
require('./nodeVersion').assertSupportedNode();

const express = require('express');
const config = require('./config');
const backendApp = require('./backend');
const backendConfig = require('./backend/config');
const { createClone, classify } = require('./clone');
const { personalize, viewerObject } = require('./shell/personalize');
const { parseAnswer, homeRoute, profileRoute, storiesRoute, activityRoute, directInboxRoute, reelsRoute, postRoute, errorRoute, unavailableRoute } = require('./shell/signedInRoute');
const { matchPage } = require('./pages/registry');
const { createPatcher } = require('./shell/bundlePatches');
const { openPinnedClient } = require('./pinnedClient');
const { rewriteHtml, rewriteCss, resolveProxyTarget, ALLOWED_HOSTS, mapUrl } = require('./rewrite');

const patcher = createPatcher();
// Debug only: drop the page's Relay prefetches. The anonymous page is served
// faithfully by default: removing its prefetch strands the client on a runtime
// query we cannot answer.
const forceDropPrefetches = process.env.SHELL_DROP_PREFETCHES === '1';

const app = express();

/* ------------------------------------------------------------------ */
/* Application backend                                                 */
/* ------------------------------------------------------------------ */
/*
 * Mounted first: /__backend/* is our own API. The backend is optional: if its
 * database cannot be opened the server still serves the client.
 */
let backendInstance = null;
if (process.env.BACKEND_ENABLED !== '0') {
  try {
    backendInstance = backendApp.mount(app);
    console.log(`[loader] application backend mounted at ${backendApp.prefix}`);
    if (backendInstance.appliedMigrations.length) {
      console.log(`[loader] applied migrations: ${backendInstance.appliedMigrations.join(', ')}`);
    }
  } catch (error) {
    console.error(`[loader] backend disabled: ${error.message}`);
  }
}


/* ------------------------------------------------------------------ */
/* The pinned client                                                   */
/* ------------------------------------------------------------------ */

// The store's active snapshot; CLIENT_SNAPSHOT_ID serves a given (candidate)
// snapshot instead, which is how `client-snapshot verify --browser` checks a
// candidate before it may be activated. Either way it is a local snapshot.
const pinned = openPinnedClient({ dir: process.env.CLIENT_DIR || '.cache/client', snapshotId: process.env.CLIENT_SNAPSHOT_ID || null });
if (pinned.ready) console.log(`[loader] pinned client: snapshot ${pinned.id}, revision ${pinned.revision}`);
else console.warn(`[loader] pinned client unavailable: ${pinned.error}`);

/*
 * Compatibility layer: the original client's own API paths, answered from our
 * database. Clone-owned requests never leave this server. Operation contracts
 * come from the pinned snapshot.
 */
let cloneInstance = null;
if (backendInstance) {
  cloneInstance = createClone({
    db: backendInstance.db,
    dataDir: process.env.CLONE_DATA_DIR || require('node:path').dirname(require('node:path').resolve(backendConfig.databaseFile)),
    contractSource: () => pinned.contractSource(),
  });
  app.use(cloneInstance.router);
}

/**
 * The client's realtime socket (redirected here by the runtime) arrives as an
 * HTTP upgrade, which Express never sees; every server this app creates
 * answers it (start() and the tests both go through app.listen).
 */
const realtime = cloneInstance
  ? require('./realtime').createRealtime({ db: backendInstance.db, viewerFor: cloneInstance.viewerFor, debug: process.env.REALTIME_DEBUG === '1' })
  : null;
app.listen = function listen(...args) {
  const server = require('node:http').createServer(this);
  // Upgraded sockets leave the server's own connection tracking, so close()
  // would otherwise wait on every open realtime socket.
  const upgraded = new Set();
  const close = server.close.bind(server);
  server.close = (callback) => {
    for (const socket of upgraded) socket.destroy();
    return close(callback);
  };
  server.on('upgrade', (req, socket, head) => {
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    socket.on('error', () => {});
    if (!realtime || !realtime.handleUpgrade(req, socket, head)) socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  return server.listen(...args);
};

const pinnedUnavailable = (res) => res.status(503).type('text/plain').send(`Pinned client unavailable: ${pinned.error}\n`);
const notPinned = (res, what) =>
  res.status(404).type('text/plain').send(`Not in the pinned client snapshot ${pinned.id} (revision ${pinned.revision}): ${what}\n`);

// Every page carries a self-only policy: the browser itself refuses requests to
// any other host, which catches what the runtime cannot see (e.g. url()s in CSS
// rules the client inserts). Nothing reaches Instagram or any other host.
const SELF_ONLY_CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' data: 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self'",
].join('; ');

/* ------------------------------------------------------------------ */
/* Static client assets: /__ig/<host>/<path>                           */
/* ------------------------------------------------------------------ */

app.get('/__ig/:host/*', (req, res) => {
  const pathAndQuery = req.originalUrl.slice(`${config.assetPrefix}/${req.params.host}`.length);
  const target = resolveProxyTarget(req.params.host, pathAndQuery);
  if (!target) return res.status(403).type('text/plain').send('Blocked: host is not in ALLOWED_ASSET_HOSTS\n');
  return sendPinnedAsset(res, target);
});

// One object per snapshot blob, so the patched-body memo below is per blob.
const pinnedEntries = new Map();
function sendPinnedAsset(res, target) {
  if (!pinned.ready) return pinnedUnavailable(res);
  const entry = pinned.asset(target);
  if (!entry) {
    pinned.noteMissing('asset', target, 'not in the snapshot');
    return notPinned(res, target);
  }
  let obj = pinnedEntries.get(entry.sha256);
  if (!obj) {
    const body = pinned.body(entry);
    if (!body) return res.status(500).type('text/plain').send(`Pinned client integrity failure for ${target}\n`);
    obj = { body, contentType: entry.contentType, etag: entry.etag, lastModified: entry.lastModified };
    pinnedEntries.set(entry.sha256, obj);
    if (pinnedEntries.size > 300) pinnedEntries.delete(pinnedEntries.keys().next().value);
  }
  res.setHeader('x-loader-cache', 'pinned');
  res.setHeader('x-client-snapshot', pinned.id);
  return sendAsset(res, obj, target);
}

// CSS rewriting and bundle patches are applied when an asset is SENT, so the
// snapshot holds the upstream bytes unchanged. Memoised per entry.
const patchedBodies = new WeakMap();
function assetBody(res, entry, target) {
  const isCss = /text\/css/.test(entry.contentType || '');
  const isJs = patcher.count && /javascript|ecmascript/.test(entry.contentType || '');
  if (!isCss && !isJs) return entry.body;
  let done = patchedBodies.get(entry);
  if (!done) {
    if (isCss) {
      done = { body: Buffer.from(rewriteCss(entry.body.toString('utf8'), target), 'utf8'), applied: [] };
    } else {
      const patched = patcher.apply(entry.body.toString('utf8'));
      done = patched.applied.length ? { body: Buffer.from(patched.source, 'utf8'), applied: patched.applied } : { body: entry.body, applied: [] };
    }
    patchedBodies.set(entry, done);
  }
  if (done.applied.length) res.setHeader('x-clone-patches', done.applied.join(','));
  return done.body;
}

function sendAsset(res, entry, target) {
  res.setHeader('content-type', entry.contentType);
  if (entry.etag) res.setHeader('etag', entry.etag);
  if (entry.lastModified) res.setHeader('last-modified', entry.lastModified);
  if (!res.getHeader('cache-control')) {
    res.setHeader('cache-control', `public, max-age=${Math.floor(config.cacheTtlMs / 1000)}`);
  }
  res.end(assetBody(res, entry, target));
}

/* ------------------------------------------------------------------ */
/* Bootloader answers                                                  */
/* ------------------------------------------------------------------ */

const revisionOf = (html) => (/"consistency":\{"rev":(\d+)\}/.exec(html) || [])[1] || '';

/**
 * The snapshot's answers for a signed-in route (by requested module name), or
 * null when any is missing or the page is not of the snapshot's revision.
 * Answers are revision-bound: the snapshot holds only answers whose body
 * declares its revision (checked when it was built and on validation).
 */
function routeAnswers(html, modules) {
  if (!pinned.ready || revisionOf(html) !== pinned.revision) return null;
  const answers = [];
  for (const name of modules) {
    const entry = pinned.answer(`${name}|`);
    const body = entry && pinned.body(entry);
    const answer = body ? parseAnswer(body.toString('utf8')) : null;
    if (!answer) return null;
    answers.push(answer);
  }
  return answers;
}

// Which revision each signed-in route root was last served at, and how often a
// route could not be served signed in (its answers are not in the snapshot).
const routeState = { served: {}, unsupported: 0, unavailable: {} };

function routeWithAnswers(route, html) {
  const answers = routeAnswers(html, route.answers);
  if (answers) {
    routeState.served[route.root] = revisionOf(html);
    return { html, answers };
  }
  routeState.unsupported += 1;
  pinned.noteMissing('route', route.root, `answers ${route.answers.join(', ')} not in snapshot revision ${pinned.revision}`);
  return null;
}

// The client's Bootloader asks /ajax/bootloader-endpoint/?modules=... for the
// resource map of lazily loaded modules. Answered from the snapshot only, and
// only for the snapshot's revision.
app.get(['/ajax/bootloader-endpoint/', '/ajax/bootloader-endpoint'], (req, res) => {
  if (!pinned.ready) return pinnedUnavailable(res);
  const q = req.query || {};
  const key = `${String(q.modules || '')}|${String(q.nb_modules || '')}`;
  const rev = String(q.__rev || '');
  res.setHeader('cache-control', 'no-store');
  if (rev && rev !== pinned.revision) {
    pinned.noteMissing('answer', `${key}@${rev}`, `asked for revision ${rev}`);
    return res.status(409).type('text/plain').send(`Revision ${rev} asked; the pinned client is revision ${pinned.revision}\n`);
  }
  const entry = pinned.answer(key);
  if (!entry) {
    pinned.noteMissing('answer', key, 'not in the snapshot');
    return notPinned(res, `bootloader answer ${key}`);
  }
  const body = pinned.body(entry);
  if (!body) return res.status(500).type('text/plain').send(`Pinned client integrity failure for ${key}\n`);
  res.setHeader('x-loader-cache', 'pinned');
  res.setHeader('x-client-snapshot', pinned.id);
  return res.type(entry.contentType).end(body);
});

/* ------------------------------------------------------------------ */
/* Local endpoints                                                     */
/* ------------------------------------------------------------------ */

// The page links a web app manifest. This one is ours; it names this site.
app.get('/data/manifest.json', (req, res) => {
  res.setHeader('cache-control', 'public, max-age=3600');
  res.json({ name: 'Instagram', short_name: 'Instagram', start_url: '/', scope: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#ffffff', icons: [] });
});

// Instagram's service worker (registered for web push) is not served: at this
// origin it would intercept every request and subscribe to Meta's push service.
// The client treats a failed registration as "push unavailable" and carries on.
app.get('/www-service-worker.js', (req, res) => {
  res.setHeader('cache-control', 'no-store');
  res.status(404).type('text/plain').send('No service worker on this origin\n');
});

app.get('/__loader/health', (req, res) => {
  res.json({
    ok: pinned.ready,
    // Pinned only: this process has no upstream client.
    client: pinned.diagnostics(),
    allowedAssetHosts: [...ALLOWED_HOSTS],
    // No Instagram session exists anywhere in this system, configured or
    // relayed. Clone users authenticate against our own backend only.
    instagramSessions: { relayed: false, configured: false },
    backend: backendInstance
      ? { mounted: true, prefix: backendApp.prefix, health: `${backendApp.prefix}/api/v1/health` }
      : { mounted: false },
    clone: cloneInstance ? { mounted: true, health: '/__clone/health' } : { mounted: false },
    shell: { forceDropPrefetches, bundlePatches: patcher.report() },
    routes: routeState,
  });
});

/* ------------------------------------------------------------------ */
/* Documents: everything else                                          */
/* ------------------------------------------------------------------ */

/**
 * GET/HEAD: the snapshot's document for the canonical path (the anonymous
 * upstream bytes; viewer state is added per request by sendHtml), or an
 * explicit 404. Any other method on a path our backend does not own is
 * answered 404: nothing is relayed anywhere.
 */
app.all('*', (req, res) => {
  // Clone-owned paths are answered by the clone router; reaching here means the
  // backend could not start.
  if (classify(req.path, req.method) !== 'other') {
    res.setHeader('cache-control', 'no-store');
    return res.status(503).json({ message: 'The application backend is unavailable', status: 'fail' });
  }
  if (!pinned.ready) return pinnedUnavailable(res);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    pinned.noteMissing('request', `${req.method} ${req.path}`, 'no local handler');
    return res.status(404).type('text/plain').send(`${req.method} ${req.path} is not answered by this server\n`);
  }
  const p = new URL(canonicalDocPath(req), 'http://local').pathname;
  if (p !== req.path) res.setHeader('x-clone-canonical', p);
  const entry = pinned.document(p);
  if (!entry) {
    pinned.noteMissing('document', p, 'not in the snapshot');
    return notPinned(res, `document ${p}`);
  }
  const body = pinned.body(entry);
  if (!body) return res.status(500).type('text/plain').send(`Pinned client integrity failure for ${p}\n`);
  res.setHeader('x-loader-cache', 'pinned');
  res.setHeader('x-client-snapshot', pinned.id);
  if (/text\/html/.test(entry.contentType)) return sendHtml(req, res, 200, rewriteHtml(body.toString('utf8')));
  res.setHeader('cache-control', `public, max-age=${Math.floor(config.cacheTtlMs / 1000)}`);
  return res.type(entry.contentType).end(body);
});

/**
 * Mark a response as private and uncacheable by shared caches.
 *
 * Applied to every authenticated response. The server may be reachable from a
 * public URL, so a cached signed-in page could otherwise be handed to a
 * different visitor.
 */
function markPrivate(res) {
  res.setHeader('cache-control', 'private, no-store, max-age=0');
  res.setHeader('vary', 'Cookie, Authorization');
}

/**
 * The snapshot document for a request (src/pages/registry.js decides which
 * page a path is). A signed-in viewer's app pages all render from the
 * route-independent app shell, the root document. Signed out, profiles,
 * posts, stories and reels links get the anonymous root page (the client's
 * logged-out view of them), a thread link the inbox document, and any other
 * path its own document, if the snapshot has one.
 */
function canonicalDocPath(req) {
  const match = matchPage(req.path);
  if (!match || match.page.access !== 'signed-in') return req.originalUrl;
  if (cloneInstance && cloneInstance.viewerFor(req)) return '/';
  const id = match.page.id;
  if (id === 'post' || id === 'stories' || id.startsWith('profile') || (id === 'reels' && match.params.shortcode)) return '/';
  if (id === 'direct_thread') return '/direct/inbox/';
  return req.originalUrl;
}

/**
 * The signed-in route for a document request (src/shell/signedInRoute.js),
 * from the page registry: the page's route when this server serves it; the
 * client's not-found route (HTTP 404) for a profile, stories or post URL
 * naming nothing the viewer may see; the client's "page not available"
 * route (HTTP 501, with the reason) for a registered page this server does
 * not serve yet. Never the anonymous page: null only for a path that is no
 * signed-in page (an anonymous document such as /accounts/login/, or no page).
 */
function signedInRouteFor(req, viewer = null) {
  const match = matchPage(req.path);
  if (!match || match.page.access !== 'signed-in') return null;
  const { page, params } = match;
  const unavailable = () => unavailableRoute(req.path, page.id, page.next || 'not served by this server');
  if (page.id === 'home') return homeRoute();
  if (page.id === 'notifications') return activityRoute();
  if (page.id === 'direct_inbox') return directInboxRoute();
  if (page.id === 'direct_thread') return /^\d{1,30}$/.test(params.thread_key) ? directInboxRoute(params.thread_key) : errorRoute(req.path);
  if (page.id === 'reels' && !params.shortcode) return reelsRoute();
  if (!cloneInstance) return unavailable();
  if (page.id === 'post') {
    const post = cloneInstance.postByCode(params.shortcode, viewer);
    return post ? postRoute(post, params.permalink_key) : errorRoute(req.path);
  }
  if (page.id === 'stories' || page.id.startsWith('profile')) {
    const user = cloneInstance.userByUsername(params.username);
    if (!user) return errorRoute(req.path);
    if (page.id === 'stories') return storiesRoute(user, viewerObject(user));
    if (page.id === 'profile') return profileRoute(user);
  }
  return unavailable();
}

/**
 * Whether the stored server render fits this browser's window. The stored
 * documents were rendered for a wide window (the login homepage's wide
 * layout); the client lays the page out from the window itself
 * (useMatchViewport, e.g. CAAFetaLoginHomepageLayout's `max-width: 1024px`),
 * so in a narrower window it renders other markup than the stored one and
 * hydration fails (React #418). The client reports its window in the `wd`
 * cookie (`<width>x<height>`, written on load and resize), which Instagram's
 * server uses for its own render; a reported width at or below the
 * breakpoint gets the page without its server render. With no report (a
 * first visit) the stored render is kept, as the server's own guess would be.
 */
const NARROW_LAYOUT_MAX_WIDTH = 1024;
function serverRenderFits(req) {
  const wd = /(?:^|;\s*)wd=(\d{1,5})x\d{1,5}(?:;|$)/.exec(req.headers.cookie || '');
  return !wd || Number(wd[1]) > NARROW_LAYOUT_MAX_WIDTH;
}

/**
 * Send an HTML document after per-request personalisation (our encryption key,
 * this browser's CSRF token, the clone viewer). The result is specific to one
 * browser, so it is never cacheable by anyone else.
 */
function sendHtml(req, res, status, html) {
  const ctx = cloneInstance ? cloneInstance.documentContext(req, res) : { viewer: null, csrfToken: null, encryption: null };
  const stats = {};
  // Signed-in viewers get the signed-in route (opt out: SHELL_SIGNED_IN_HOME=0).
  const page = matchPage(req.path);
  if (page) res.setHeader('x-clone-page', page.page.id);
  let route = process.env.SHELL_SIGNED_IN_HOME !== '0' && ctx.viewer ? signedInRouteFor(req, ctx.viewer) : null;
  let withAnswers = route ? routeWithAnswers(route, html) : null;
  // A signed-in page whose root the snapshot lacks is not served as the
  // anonymous page: it is the client's "not available" route instead.
  if (route && !withAnswers && !route.unavailable) {
    route = unavailableRoute(req.path, page ? page.page.id : null, `answers ${route.answers.join(', ')} not in snapshot revision ${pinned.revision}`);
    withAnswers = routeWithAnswers(route, html);
  }
  if (route && route.unavailable) {
    routeState.unavailable[route.unavailable.page || req.path] = route.unavailable.reason;
    res.setHeader('x-clone-page-unavailable', route.unavailable.reason.replace(/[^\x20-\x7e]/g, '?').slice(0, 300));
  }
  if (route && !withAnswers) {
    markPrivate(res);
    return res.status(501).type('text/plain').send(`This page is not available on this server: ${route.unavailable ? route.unavailable.reason : 'its route is not in the pinned client'}\n`);
  }
  const signedInHome = Boolean(withAnswers);
  const feedRoot = withAnswers ? withAnswers.answers : null;
  const out = personalize(html, { ...ctx, identity: false, signedInHome, feedRoot, route, routeUrl: req.path, toLocal: mapUrl, dropPrefetches: forceDropPrefetches, serverRender: serverRenderFits(req), stats });
  if (withAnswers && route.status) status = route.status;
  if (cloneInstance) {
    const mentionsKey = /public_?key/i.test(html);
    cloneInstance.recordDocument({ path: req.path, status, fromTemplate: false, signedIn: Boolean(ctx.viewer), mentionsKey, ...stats });
    if (mentionsKey && !stats.encryption) {
      console.warn(`[clone] ${req.path}: the page mentions a public key but no encryption config was replaced; login and signup on this page will fail to decrypt`);
    }
  }
  markPrivate(res);
  res.setHeader('content-security-policy', SELF_ONLY_CSP);
  return res.status(status).type('text/html; charset=utf-8').end(Buffer.from(out, 'utf8'));
}

/* ------------------------------------------------------------------ */

/**
 * A startup error the operator can act on: the port is taken or not
 * permitted. Any other error is not ours to explain and is rethrown.
 */
function listenErrorMessage(error, { host, port }) {
  if (error && error.code === 'EADDRINUSE') {
    return `port ${port} on ${host} is already in use (another server, perhaps another instance of this one). Stop it, or start this one on another port: PORT=${port + 1} npm start`;
  }
  if (error && error.code === 'EACCES') {
    return `not permitted to listen on port ${port} on ${host}. Use a port above 1023: PORT=12000 npm start`;
  }
  return null;
}

function start({ onListenError = (message) => { console.error(`[loader] cannot start: ${message}`); process.exit(1); } } = {}) {
  const server = app.listen(config.port, config.host, () => {
    console.log(`[loader] listening on http://${config.host}:${config.port}`);
    console.log(`[loader] health: http://localhost:${config.port}/__loader/health`);
  });
  server.on('error', (error) => {
    const message = listenErrorMessage(error, config);
    if (!message) throw error;
    onListenError(message, error);
  });
  return server;
}

if (require.main === module) {
  start();
}

module.exports = { app, start, listenErrorMessage };
