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

const express = require('express');
const config = require('./config');
const backendApp = require('./backend');
const backendConfig = require('./backend/config');
const { createClone, classify } = require('./clone');
const { personalize, viewerObject } = require('./shell/personalize');
const { parseAnswer, homeRoute, profileRoute, storiesRoute, errorRoute } = require('./shell/signedInRoute');
const { routeKind } = require('./shell/templates');
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
const routeState = { served: {}, unsupported: 0 };

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
 * The snapshot document for a request. Profiles, posts, stories and DM threads
 * carry clone identifiers in their URL; they all render from the same
 * route-independent app shell, so the root (or the inbox) document is used.
 */
function canonicalDocPath(req) {
  const kind = routeKind(req.path);
  if (kind === 'profile' || kind === 'post' || kind === 'stories') return '/';
  if (/^\/direct\/(t|thread)\//.test(req.path)) return '/direct/inbox/';
  if (/^\/(reel|reels|tv)\/[A-Za-z0-9_-]+/.test(req.path)) return '/';
  return req.originalUrl;
}

/**
 * The signed-in route for a document request (src/shell/signedInRoute.js):
 * the home feed; an existing local account's profile (posts tab) or stories;
 * the client's own not-found route (HTTP 404) for a profile or stories URL
 * naming no local account. Anything else keeps the page's own route.
 * (Posts: PolarisPostRoot renders its content only through `cr:2882`, which
 * the anonymously acquired answer leaves unbound, so a post page would show
 * the 404 page for an existing post; it is not switched. See
 * docs/CLIENT-PINNING.md.)
 */
function signedInRouteFor(req) {
  const kind = routeKind(req.path);
  if (kind === 'home') return homeRoute();
  if ((kind === 'profile' || kind === 'stories') && cloneInstance) {
    const segments = req.path.split('/').filter(Boolean);
    const user = cloneInstance.userByUsername(kind === 'stories' ? segments[1] : segments[0]);
    if (!user) return errorRoute(req.path);
    return kind === 'stories' ? storiesRoute(user, viewerObject(user)) : profileRoute(user);
  }
  return null;
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
  const route = process.env.SHELL_SIGNED_IN_HOME !== '0' && ctx.viewer ? signedInRouteFor(req) : null;
  const withAnswers = route ? routeWithAnswers(route, html) : null;
  const signedInHome = Boolean(withAnswers);
  const feedRoot = withAnswers ? withAnswers.answers : null;
  const out = personalize(html, { ...ctx, identity: false, signedInHome, feedRoot, route, routeUrl: req.path, toLocal: mapUrl, dropPrefetches: forceDropPrefetches, stats });
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

function start() {
  const server = app.listen(config.port, config.host, () => {
    console.log(`[loader] listening on http://${config.host}:${config.port}`);
    console.log(`[loader] health: http://localhost:${config.port}/__loader/health`);
  });
  return server;
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
