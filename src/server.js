'use strict';

const express = require('express');
const config = require('./config');
const { ResponseCache } = require('./cache');
const { fetchUpstream, UpstreamError } = require('./upstream');
const backendApp = require('./backend');
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

// Capture the raw request body so non-GET requests (the client POSTs to
// same-origin endpoints such as /ajax/bz) can be forwarded byte-for-byte.
// A raw buffer avoids any parsing/transformation of upstream payloads.
app.use(express.raw({ type: () => true, limit: config.cacheMaxBodyBytes }));

const cache = new ResponseCache();

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

  const cached = cache.get(target);
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
    }

    const entry = {
      body,
      contentType: upstream.headers.get('content-type') || 'application/octet-stream',
      etag: upstream.headers.get('etag') || undefined,
      lastModified: upstream.headers.get('last-modified') || undefined,
    };
    cache.set(target, entry);
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
    // Personalisation is per-viewer and always opt-in. There is no configured
    // account, so there is no credential to report or leak here: the flag says
    // only whether the loader will honour a viewer's own session.
    viewerSessions: { enabled: config.allowViewerSessions },
    inflight: inflight.size,
    backend: backendInstance
      ? { mounted: true, prefix: backendApp.prefix, health: `${backendApp.prefix}/api/v1/health` }
      : { mounted: false },
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
  const target = `${config.upstream}${req.originalUrl}`;
  const isDocumentGet = req.method === 'GET' || req.method === 'HEAD';

  /*
   * Per-viewer personalisation.
   *
   * There is no server-side account. When (and only when) viewer sessions are
   * enabled, a viewer's OWN Instagram session cookies are relayed to the
   * upstream origin for that viewer's own requests, so each viewer sees their
   * own feed. Every other viewer is anonymous.
   *
   * Only the Instagram session cookies from the viewer's request are relayed,
   * never the whole cookie header, and they are used for the upstream origin
   * only: the asset proxy never sends them (see the /__ig route). Nothing is
   * stored.
   */
  const viewerCookie = viewerSessionCookie(req);
  const personalized = Boolean(viewerCookie);
  // Personalised documents are never cached. A per-viewer cache would still be
  // one bug away from serving one viewer's page to another; not caching makes
  // that impossible rather than merely unlikely.
  const docCache = personalized ? null : cache;

  // Serve a fresh cached document without touching the origin. Only anonymous
  // documents are ever in this cache.
  let cached = null;
  const conditional = {};
  if (isDocumentGet && docCache) {
    cached = docCache.get(documentKey(req));
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

  const forwarded = {
    accept: req.get('accept') || 'text/html,application/xhtml+xml',
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
  for (const name of ['x-ig-app-id', 'x-csrftoken', 'x-requested-with', 'x-asbd-id', 'x-ig-www-claim']) {
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
      cookie: viewerCookie || undefined,
    });

    // 304: the cached copy is still current. Serve it; do not re-download.
    if (upstream.status === 304 && cached && docCache) {
      docCache.stats.revalidated += 1;
      docCache.touch(documentKey(req), {
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
        const stale = docCache.get(documentKey(req));
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
      if (personalized) markPrivate(res);
      const isHtmlBody = contentTypeOf(upstream.headers).includes('text/html');
      if (isHtmlBody) {
        const rewrittenError = rewriteHtml(upstream.body.toString('utf8'));
        return res.status(upstream.status).type('text/html; charset=utf-8').end(Buffer.from(rewrittenError, 'utf8'));
      }
      return res.status(upstream.status).end(upstream.body);
    }

    const type = contentTypeOf(upstream.headers);
    const isHtml = type.includes('text/html') || type.includes('application/xhtml+xml');

    copyResponseHeaders(upstream.headers, res, { maxAgeSeconds: 0 });
    res.setHeader('x-loader-upstream', target);
    res.setHeader('x-loader-rewritten', isHtml ? 'html' : 'none');
    if (personalized) {
      // A personalised page is one viewer's view. Never let a shared cache or
      // an intermediary reuse it, and mark it so the distinction is visible.
      markPrivate(res);
      res.setHeader('x-loader-personalized', 'true');
    }
    if (upstream.redirected) res.setHeader('x-loader-final-url', upstream.finalUrl);

    // Only successful anonymous HTML documents are cached. Personalised
    // documents are never cached, and the origin's own redirects and errors are
    // relayed as-is, so a transient state is not frozen into the mirror.
    const cacheable = isDocumentGet && isHtml && upstream.status === 200 && docCache;
    const body = isHtml
      ? Buffer.from(rewriteHtml(upstream.body.toString('utf8')), 'utf8')
      : upstream.body;

    if (cacheable) {
      docCache.set(documentKey(req), {
        body,
        contentType: 'text/html; charset=utf-8',
        status: upstream.status,
        ttlMs: config.documentCacheTtlMs,
        etag: upstream.headers.get('etag'),
        lastModified: upstream.headers.get('last-modified'),
      });
      res.setHeader('x-loader-cache', 'miss');
    }

    return res.status(upstream.status).end(body);
  } catch (error) {
    const status = error instanceof UpstreamError ? error.status : 502;
    recordFailure({ kind: 'document', status, url: target, reason: error.message });

    if (isDocumentGet && docCache) {
      const stale = docCache.get(documentKey(req));
      if (docCache.isServableWhenStale(stale, config.documentStaleMs)) {
        res.setHeader('x-loader-cache', 'stale');
        res.setHeader('x-loader-upstream', target);
        res.setHeader('x-loader-error', error.message);
        return sendDocument(res, stale);
      }
    }

    if (personalized) markPrivate(res);
    res.status(status).type('text/plain').send(`Upstream fetch failed: ${error.message}\n`);
  }
});

/*
 * Extract the viewer's own Instagram session cookies from their request.
 *
 * This is the whole of the personalisation mechanism, and it is deliberately
 * narrow:
 *   - only these cookie names are ever relayed upstream, never the full header,
 *     so unrelated cookies (including our own backend session) cannot leak to
 *     Instagram;
 *   - nothing is stored, so there is no jar to leak from;
 *   - returns null when disabled or absent, which is the normal anonymous case.
 *
 * The loader never authenticates anyone: a viewer is personalised only if they
 * already hold a valid Instagram session of their own.
 */
const VIEWER_SESSION_COOKIES = ['sessionid', 'ds_user_id', 'csrftoken'];

function viewerSessionCookie(req) {
  if (!config.allowViewerSessions) return null;
  const raw = req.get('cookie');
  if (!raw) return null;
  const wanted = [];
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (VIEWER_SESSION_COOKIES.includes(name)) {
      wanted.push(`${name}=${part.slice(eq + 1).trim()}`);
    }
  }
  // A sessionid is required: csrftoken alone is an anonymous cookie that
  // Instagram issues to logged-out visitors, and forwarding it as though it
  // were a session would be meaningless.
  return wanted.some((c) => c.startsWith('sessionid=')) ? wanted.join('; ') : null;
}

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
function documentKey(req) {
  const variant = req.get('sec-fetch-site') ? 'nav' : 'plain';
  return `doc:${variant}:${req.originalUrl}`;
}

function sendDocument(res, entry) {
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
