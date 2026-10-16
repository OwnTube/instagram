'use strict';

const express = require('express');
const config = require('./config');
const { ResponseCache } = require('./cache');
const { createAssetStore } = require('./assetStore');
const { fetchUpstream, UpstreamError } = require('./upstream');
const backendApp = require('./backend');
const backendConfig = require('./backend/config');
const { createClone, classify } = require('./clone');
const { personalize } = require('./shell/personalize');
const { routeKind, createTemplateStore } = require('./shell/templates');
const { createPatcher } = require('./shell/bundlePatches');

const templates = createTemplateStore({ dir: process.env.SHELL_TEMPLATE_DIR || '.cache/shell' });
const patcher = createPatcher();
// Relay prefetches are dropped from a signed-in TEMPLATE, whose prefetched data
// belongs to the account that captured it, not the clone viewer. An anonymous
// upstream page is served faithfully: its prefetch is anonymous Instagram data
// the page renders from, and removing it strands the client on a runtime query
// we cannot answer (the loading screen then never clears). Opt in to drop on
// every page only for debugging.
const forceDropPrefetches = process.env.SHELL_DROP_PREFETCHES === '1';
const {
  rewriteHtml,
  rewriteCss,
  resolveProxyTarget,
  ALLOWED_HOSTS,
} = require('./rewrite');

const app = express();

/* ------------------------------------------------------------------ */
/* Application backend                                                 */
/* ------------------------------------------------------------------ */
/*
 * Mounted FIRST, and deliberately so. The loader ends with a catch-all
 * `app.all('*')` that forwards everything to Instagram; anything registered
 * after it would be unreachable. Mounting the backend here means
 * /__backend/* is answered by our own API while every other path, including
 * Instagram's own /api/v1/* and /graphql/query, keeps flowing upstream.
 *
 * The backend is optional: if its database cannot be opened the loader still
 * starts, because serving Instagram's frontend must not depend on our database.
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

/*
 * Compatibility layer: the original client's own API paths, answered from our
 * database. Mounted before the raw-body parser and the upstream catch-all, so
 * clone-owned requests are parsed by it and never reach Instagram.
 */
let cloneInstance = null;
if (backendInstance) {
  cloneInstance = createClone({
    db: backendInstance.db,
    dataDir: process.env.CLONE_DATA_DIR || require('node:path').dirname(require('node:path').resolve(backendConfig.databaseFile)),
  });
  app.use(cloneInstance.router);
}

// Capture the raw request body so non-GET requests (the client POSTs to
// same-origin endpoints such as /ajax/bz) can be forwarded byte-for-byte.
// A raw buffer avoids any parsing/transformation of upstream payloads.
app.use(express.raw({ type: () => true, limit: config.cacheMaxBodyBytes }));

const cache = new ResponseCache();
// Public static assets only. ASSET_CACHE_DIR='' turns the disk copy off; it is
// also off under `node --test` unless a directory is given, so tests stay isolated.
const assetStore = createAssetStore(
  process.env.ASSET_CACHE_DIR !== undefined ? process.env.ASSET_CACHE_DIR : process.env.NODE_TEST_CONTEXT ? '' : '.cache/assets',
);

// Diagnostics surface: which upstream resources failed and why. This is what
// section 5 of the brief asks us to record, exposed for the operator.
const failures = [];
function recordFailure(entry) {
  failures.unshift({ at: new Date().toISOString(), ...entry });
  if (failures.length > 200) failures.pop();
  if (config.verbose) {
    console.warn(`[loader] ${entry.kind} ${entry.status} ${entry.url} :: ${entry.reason}`);
  }
}

// Collapse concurrent identical upstream requests into a single fetch.
const inflight = new Map();
function dedupe(key, producer) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = producer().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

// Headers from upstream that must not leak into our own responses.
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
  'set-cookie',
  // Origin-scoped security policy: keeping it would apply Instagram's CSP /
  // frame rules to our origin and break the very resources we are serving.
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
  'alt-svc',
  'report-to',
  'nel',
]);

function copyResponseHeaders(upstreamHeaders, res, { maxAgeSeconds }) {
  for (const [name, value] of upstreamHeaders.entries()) {
    if (STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    try {
      res.setHeader(name, value);
    } catch {
      /* ignore invalid header values from upstream */
    }
  }
  res.setHeader('cache-control', `public, max-age=${maxAgeSeconds}`);
}

function contentTypeOf(headers) {
  return (headers.get('content-type') || '').toLowerCase();
}

/**
 * Collect the Fetch Metadata request headers the browser actually sent.
 *
 * We relay them verbatim rather than synthesising new values; the only default
 * is the set a genuine top-level navigation would send, used when a client
 * (curl, a test) does not provide them.
 */
const FETCH_METADATA_HEADERS = [
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
  'upgrade-insecure-requests',
];

function fetchMetadataFor(req) {
  const headers = {};
  for (const name of FETCH_METADATA_HEADERS) {
    const value = req.get(name);
    if (value) headers[name] = value;
  }
  if (!headers['sec-fetch-site']) headers['sec-fetch-site'] = 'none';
  if (!headers['sec-fetch-mode']) headers['sec-fetch-mode'] = 'navigate';
  if (!headers['sec-fetch-dest']) headers['sec-fetch-dest'] = 'document';
  return headers;
}

/* ------------------------------------------------------------------ */
/* Asset proxy: /__ig/<host>/<path>                                    */
/* ------------------------------------------------------------------ */

app.get('/__ig/:host/*', async (req, res) => {
  const pathAndQuery = req.originalUrl.slice(`${config.assetPrefix}/${req.params.host}`.length);
  const target = resolveProxyTarget(req.params.host, pathAndQuery);

  if (!target) {
    recordFailure({ kind: 'asset', status: 403, url: req.originalUrl, reason: 'host not in allow-list' });
    return res.status(403).type('text/plain').send('Blocked: host is not in ALLOWED_ASSET_HOSTS\n');
  }

  let cached = cache.get(target);
  if (!cached && assetStore) {
    cached = await assetStore.read(target);
    if (cached) cache.map.set(target, cached);
  }
  if (cache.isFresh(cached)) {
    cache.stats.hits += 1;
    res.setHeader('x-loader-cache', 'hit');
    res.setHeader('x-loader-upstream', target);
    return sendAsset(res, cached);
  }

  cache.stats.misses += 1;

  const conditional = {};
  if (cached?.etag) conditional['if-none-match'] = cached.etag;
  if (cached?.lastModified) conditional['if-modified-since'] = cached.lastModified;

  try {
    const upstream = await dedupe(target, () => fetchUpstream(target, { headers: conditional }));

    if (upstream.status === 304 && cached) {
      cache.stats.revalidated += 1;
      cache.touch(target, { etag: upstream.headers.get('etag'), 'last-modified': upstream.headers.get('last-modified') });
      res.setHeader('x-loader-cache', 'revalidated');
      res.setHeader('x-loader-upstream', target);
      return sendAsset(res, cached);
    }

    if (!upstream.ok) {
      recordFailure({
        kind: 'asset',
        status: upstream.status,
        url: target,
        reason: `upstream returned ${upstream.status}`,
      });
      if (cached) {
        // Serve stale rather than break the page, but say so.
        res.setHeader('x-loader-cache', 'stale');
        res.setHeader('x-loader-upstream', target);
        return sendAsset(res, cached);
      }
      res.setHeader('x-loader-upstream', target);
      return res.status(upstream.status).type('text/plain').send(`Upstream error ${upstream.status} for ${target}\n`);
    }

    const type = contentTypeOf(upstream.headers);
    let body = upstream.body;
    if (type.includes('text/css')) {
      body = Buffer.from(rewriteCss(body.toString('utf8')), 'utf8');
    } else if (patcher.count && /javascript|ecmascript/.test(type)) {
      const patched = patcher.apply(body.toString('utf8'));
      if (patched.applied.length) {
        body = Buffer.from(patched.source, 'utf8');
        res.setHeader('x-clone-patches', patched.applied.join(','));
      }
    }

    const entry = {
      body,
      contentType: upstream.headers.get('content-type') || 'application/octet-stream',
      etag: upstream.headers.get('etag') || undefined,
      lastModified: upstream.headers.get('last-modified') || undefined,
    };
    cache.set(target, entry);
    if (assetStore) assetStore.write(target, entry);
    res.setHeader('x-loader-cache', 'miss');
    res.setHeader('x-loader-upstream', target);
    if (upstream.redirected) res.setHeader('x-loader-final-url', upstream.finalUrl);
    sendAsset(res, entry);
  } catch (error) {
    const status = error instanceof UpstreamError ? error.status : 502;
    recordFailure({ kind: 'asset', status, url: target, reason: error.message });
    if (cached) {
      res.setHeader('x-loader-cache', 'stale');
      res.setHeader('x-loader-upstream', target);
      return sendAsset(res, cached);
    }
    res.status(status).type('text/plain').send(`Upstream fetch failed: ${error.message}\n`);
  }
});

function sendAsset(res, entry) {
  res.setHeader('content-type', entry.contentType);
  if (entry.etag) res.setHeader('etag', entry.etag);
  if (entry.lastModified) res.setHeader('last-modified', entry.lastModified);
  if (!res.getHeader('cache-control')) {
    res.setHeader('cache-control', `public, max-age=${Math.floor(config.cacheTtlMs / 1000)}`);
  }
  res.end(entry.body);
}

/* ------------------------------------------------------------------ */
/* Diagnostics                                                         */
/* ------------------------------------------------------------------ */

app.get('/__loader/health', (req, res) => {
  res.json({
    ok: true,
    upstream: config.upstream,
    allowedAssetHosts: [...ALLOWED_HOSTS],
    cache: { size: cache.size(), ttlMs: config.cacheTtlMs, ...cache.stats },
    // No Instagram session exists anywhere in this system, configured or
    // relayed. Clone users authenticate against our own backend only.
    instagramSessions: { relayed: false, configured: false },
    inflight: inflight.size,
    backend: backendInstance
      ? { mounted: true, prefix: backendApp.prefix, health: `${backendApp.prefix}/api/v1/health` }
      : { mounted: false },
    clone: cloneInstance ? { mounted: true, health: '/__clone/health' } : { mounted: false },
    shell: { templates: templates.available(), forceDropPrefetches, bundlePatches: patcher.report() },
    recentFailures: failures.slice(0, 25),
  });
});

/* ------------------------------------------------------------------ */
/* Page proxy: everything else is a document request to the origin     */
/* ------------------------------------------------------------------ */

/**
 * Forward any method the browser used. The client issues same-origin POSTs to
 * endpoints such as /ajax/bz, so handling only GET would turn those into 404s
 * from this server instead of reaching Instagram. Request bodies are relayed
 * verbatim; nothing is parsed, re-encoded or invented.
 *
 * GET document requests are cached. A cached successful document is served
 * when the origin is throttling, which keeps the mirror usable and, more
 * importantly, avoids re-requesting the same page from the origin.
 */
app.all('*', async (req, res) => {
  // Clone-owned paths never fall through to Instagram, even when the backend
  // could not start: their requests carry clone users' data.
  if (classify(req.path) !== 'other') {
    res.setHeader('cache-control', 'no-store');
    return res.status(503).json({ message: 'The application backend is unavailable', status: 'fail' });
  }
  const isDocumentGet = req.method === 'GET' || req.method === 'HEAD';

  // A signed-in clone viewer on an app route gets the signed-in shell from a
  // captured template, personalised for them. Upstream is not contacted.
  if (isDocumentGet && cloneInstance) {
    const kind = routeKind(req.path);
    const viewer = kind ? cloneInstance.viewerFor(req) : null;
    const template = viewer ? templates.load(kind) : null;
    if (template) {
      res.setHeader('x-clone-shell', `template:${kind}`);
      return sendHtml(req, res, 200, template, { fromTemplate: true });
    }
  }

  // The upstream document is a route-independent app shell; the real route is
  // resolved client-side from our API. So for an identity-bearing route we
  // fetch a CANONICAL shell path instead of the literal one, and the clone
  // username, shortcode or thread id in the URL never reaches Instagram. The
  // query string is dropped with it, since it too can carry an identifier.
  const upstreamPath = canonicalDocPath(req);
  if (upstreamPath !== req.originalUrl) res.setHeader('x-clone-canonical', upstreamPath);
  const target = `${config.upstream}${upstreamPath}`;

  // Upstream documents are always fetched anonymously: no browser cookie is
  // ever relayed to Instagram (src/upstream.js strips them), so the upstream
  // document is identical for every viewer and safe to share in the cache.
  // Per-viewer state is added afterwards, on our side, by the shell layer.
  const docCache = cache;

  // Serve a fresh cached document without touching the origin. Only anonymous
  // documents are ever in this cache.
  let cached = null;
  const conditional = {};
  if (isDocumentGet && docCache) {
    cached = docCache.get(documentKey(req, upstreamPath));
    if (docCache.isFresh(cached)) {
      docCache.stats.hits += 1;
      res.setHeader('x-loader-cache', 'hit');
      res.setHeader('x-loader-upstream', target);
      return sendDocument(res, cached);
    }
    // Stale but present: revalidate instead of re-downloading the whole
    // document. This is the difference between one cheap 304 and a full fetch.
    if (cached?.etag) conditional['if-none-match'] = cached.etag;
    if (cached?.lastModified) conditional['if-modified-since'] = cached.lastModified;
  }

  // The upstream origin serves a DIFFERENT, reduced document to a request whose
  // Accept is `*/*` or absent (no login form, no feed modules), and the full app
  // shell only to one that asks for HTML. A real browser navigation always asks
  // for HTML, but curl and our own tests often send `*/*` and would get the
  // stripped page. So for a document navigation we send a browser-like Accept
  // unless the client already asked for HTML. Requests for a file (a path with
  // an extension, e.g. /data/manifest.json) keep their own Accept.
  const BROWSER_DOCUMENT_ACCEPT =
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
  const clientAccept = req.get('accept') || '';
  const wantsDocument =
    req.get('sec-fetch-dest') === 'document' || (isDocumentGet && !/\.[a-z0-9]{1,8}(?:$|\?)/i.test(req.path));
  const accept = clientAccept.includes('text/html') ? clientAccept : wantsDocument ? BROWSER_DOCUMENT_ACCEPT : clientAccept || '*/*';

  const forwarded = {
    accept,
    'accept-language': req.get('accept-language') || 'en-US,en;q=0.9',
    'user-agent': req.get('user-agent') || config.userAgent,
    referer: config.upstream + '/',
    // Instagram selects the client variant from the Fetch Metadata hints: a
    // navigation with sec-fetch-site: none|same-origin gets the full app shell,
    // while an absent or cross-site hint yields a reduced document. We relay the
    // browser's own hints and fall back to what a real top-level navigation
    // sends. This is a faithful relay, not a spoof of a privileged client.
    ...fetchMetadataFor(req),
  };
  // The client sends an app-id header on its own API calls; pass it through
  // when present so those calls are shaped the way the origin expects.
  // X-CSRFToken is deliberately absent: on this origin it is a clone
  // session's CSRF secret and must never reach Instagram.
  for (const name of ['x-ig-app-id', 'x-requested-with', 'x-asbd-id']) {
    const value = req.get(name);
    if (value) forwarded[name] = value;
  }
  const contentType = req.get('content-type');
  if (contentType) forwarded['content-type'] = contentType;
  const requestBody = Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined;

  try {
    const upstream = await fetchUpstream(target, {
      method: req.method,
      headers: { ...forwarded, ...conditional },
      body: requestBody,
    });

    // 304: the cached copy is still current. Serve it; do not re-download.
    if (upstream.status === 304 && cached && docCache) {
      docCache.stats.revalidated += 1;
      docCache.touch(documentKey(req, upstreamPath), {
        etag: upstream.headers.get('etag'),
        'last-modified': upstream.headers.get('last-modified'),
      });
      res.setHeader('x-loader-cache', 'revalidated');
      res.setHeader('x-loader-upstream', target);
      return sendDocument(res, cached);
    }

    if (!upstream.ok) {
      recordFailure({
        kind: 'document',
        status: upstream.status,
        url: target,
        reason: `upstream returned ${upstream.status}`,
      });

      // Throttling and origin errors carry no usable page. If we have a
      // previously successful anonymous copy, serve it rather than a dead page.
      if (isDocumentGet && docCache) {
        const stale = docCache.get(documentKey(req, upstreamPath));
        if (docCache.isServableWhenStale(stale, config.documentStaleMs)) {
          res.setHeader('x-loader-cache', 'stale');
          res.setHeader('x-loader-upstream', target);
          res.setHeader('x-loader-status', String(upstream.status));
          return sendDocument(res, stale);
        }
      }

      // Pass the origin's response through as-is. For an anti-bot response this
      // is the challenge page itself, which carries a script that POSTs a
      // verification request back to the origin. Replacing it with synthetic
      // text would strip that mechanism and guarantee the page never loads, so
      // the original body is preserved and rewritten like any other document.
      copyResponseHeaders(upstream.headers, res, { maxAgeSeconds: 0 });
      res.setHeader('x-loader-upstream', target);
      res.setHeader('x-loader-status', String(upstream.status));
      const isHtmlBody = contentTypeOf(upstream.headers).includes('text/html');
      if (isHtmlBody) return sendHtml(req, res, upstream.status, rewriteHtml(upstream.body.toString('utf8')));
      return res.status(upstream.status).end(upstream.body);
    }

    const type = contentTypeOf(upstream.headers);
    const isHtml = type.includes('text/html') || type.includes('application/xhtml+xml');

    copyResponseHeaders(upstream.headers, res, { maxAgeSeconds: 0 });
    res.setHeader('x-loader-upstream', target);
    res.setHeader('x-loader-rewritten', isHtml ? 'html' : 'none');
    if (upstream.redirected) res.setHeader('x-loader-final-url', upstream.finalUrl);

    // Only successful HTML documents are cached (they are all anonymous). The
    // origin's own redirects and errors are
    // relayed as-is, so a transient state is not frozen into the mirror.
    const cacheable = isDocumentGet && isHtml && upstream.status === 200 && docCache;
    const body = isHtml
      ? Buffer.from(rewriteHtml(upstream.body.toString('utf8')), 'utf8')
      : upstream.body;

    if (cacheable) {
      docCache.set(documentKey(req, upstreamPath), {
        body,
        contentType: 'text/html; charset=utf-8',
        status: upstream.status,
        ttlMs: config.documentCacheTtlMs,
        etag: upstream.headers.get('etag'),
        lastModified: upstream.headers.get('last-modified'),
      });
      res.setHeader('x-loader-cache', 'miss');
    }

    if (isHtml) return sendHtml(req, res, upstream.status, body.toString('utf8'));
    return res.status(upstream.status).end(body);
  } catch (error) {
    const status = error instanceof UpstreamError ? error.status : 502;
    recordFailure({ kind: 'document', status, url: target, reason: error.message });

    if (isDocumentGet && docCache) {
      const stale = docCache.get(documentKey(req, upstreamPath));
      if (docCache.isServableWhenStale(stale, config.documentStaleMs)) {
        res.setHeader('x-loader-cache', 'stale');
        res.setHeader('x-loader-upstream', target);
        res.setHeader('x-loader-error', error.message);
        return sendDocument(res, stale);
      }
    }

    res.status(status).type('text/plain').send(`Upstream fetch failed: ${error.message}\n`);
  }
});

/**
 * Mark a response as private and uncacheable by shared caches.
 *
 * Applied to every authenticated response. The loader may be reachable from a
 * public URL, so a cached signed-in page could otherwise be handed to a
 * different visitor.
 */
function markPrivate(res) {
  res.setHeader('cache-control', 'private, no-store, max-age=0');
  res.setHeader('vary', 'Cookie, Authorization');
}

/** Cache key for a document: method + path + the client variant it was fetched for. */
function documentKey(req, upstreamPath) {
  const variant = req.get('sec-fetch-site') ? 'nav' : 'plain';
  return `doc:${variant}:${upstreamPath}`;
}

/**
 * The path to fetch upstream for a document. Profiles, posts, stories and DM
 * threads carry clone identifiers in their URL; they all render from the same
 * route-independent app shell, so the root (or the inbox) is fetched instead
 * and the identifier stays on our side.
 */
function canonicalDocPath(req) {
  const kind = routeKind(req.path);
  if (kind === 'profile' || kind === 'post' || kind === 'stories') return '/';
  if (/^\/direct\/(t|thread)\//.test(req.path)) return '/direct/inbox/';
  if (/^\/(reel|reels|tv)\/[A-Za-z0-9_-]+/.test(req.path)) return '/';
  return req.originalUrl;
}

/**
 * Send an HTML document after per-request personalisation (our encryption key,
 * this browser's CSRF token, the clone viewer). The result is specific to one
 * browser, so it is never cacheable by anyone else.
 */
function sendHtml(req, res, status, html, { fromTemplate = false } = {}) {
  const ctx = cloneInstance ? cloneInstance.documentContext(req, res) : { viewer: null, csrfToken: null, encryption: null };
  const stats = {};
  const out = personalize(html, { ...ctx, identity: fromTemplate, dropPrefetches: fromTemplate || forceDropPrefetches, stats });
  if (cloneInstance) {
    const mentionsKey = /public_?key/i.test(html);
    cloneInstance.recordDocument({ path: req.path, status, fromTemplate, signedIn: Boolean(ctx.viewer), mentionsKey, ...stats });
    if (mentionsKey && !stats.encryption) {
      console.warn(`[clone] ${req.path}: the page mentions a public key but no encryption config was replaced; login and signup on this page will fail to decrypt`);
    }
  }
  markPrivate(res);
  res.removeHeader('etag');
  res.removeHeader('last-modified');
  return res.status(status).type('text/html; charset=utf-8').end(Buffer.from(out, 'utf8'));
}

function sendDocument(res, entry) {
  if (/text\/html/.test(entry.contentType)) return sendHtml(res.req, res, 200, entry.body.toString('utf8'));
  res.setHeader('content-type', entry.contentType);
  if (entry.etag) res.setHeader('etag', entry.etag);
  if (!res.getHeader('cache-control')) {
    res.setHeader('cache-control', `public, max-age=${Math.floor(config.documentCacheTtlMs / 1000)}`);
  }
  res.end(entry.body);
}

/* ------------------------------------------------------------------ */

function start() {
  const server = app.listen(config.port, config.host, () => {
    console.log(`[loader] runtime loader listening on http://${config.host}:${config.port}`);
    console.log(`[loader] upstream origin: ${config.upstream}`);
    console.log(`[loader] allowed asset hosts: ${[...ALLOWED_HOSTS].join(', ')}`);
    console.log(`[loader] health: http://localhost:${config.port}/__loader/health`);
  });
  return server;
}

if (require.main === module) {
  start();
}

module.exports = { app, start, cache };
