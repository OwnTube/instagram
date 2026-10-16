'use strict';

/**
 * The compatibility layer: the original client's API surface, answered by us.
 *
 *   original client --(its own relative API paths)--> this router --> services --> SQLite + media store
 *
 * Every request is classified first (classify()):
 *
 *   clone      API paths the client uses for its data and mutations
 *              (/api/v1/*, /graphql/*, /api/graphql, uploads, account forms).
 *              Answered here or rejected with 501; NEVER forwarded upstream,
 *              because they carry clone users' data and sessions.
 *   telemetry  Logging beacons. Acknowledged locally and dropped, so clone
 *              users' activity is not reported to a third party.
 *   other      Documents, static assets and client infrastructure
 *              (bootloader, route definitions, manifests). Left to the loader,
 *              which fetches them anonymously.
 */

const path = require('node:path');
const express = require('express');
const busboy = require('busboy');

const { createPasswordCodec } = require('./passwordEncryption');
const { createMediaStore, MAX_BYTES } = require('./media');
const { createGraphql } = require('./graphql');
const { createContractCache } = require('../runtime/graphqlContract');
const { buildModuleIndex } = require('../runtime/moduleIndex');
const fs = require('node:fs');
const { attachViewer, csrfCheck, ensureCsrfCookie } = require('./session');
const { resolveSession } = require('../backend/lib/auth');
const users = require('../backend/services/users');

const RUNTIME_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'shell', 'runtime.js'), 'utf8');
const { igOk, igFail, errorHandler, privateHeaders } = require('./respond');
const { auth: authLimiter, general: generalLimiter, middleware: limit } = require('../backend/lib/ratelimit');
const { unauthorized, badRequest } = require('../backend/lib/errors');

const CLONE_PATHS = [
  /^\/api\/v1\//,
  /^\/api\/graphql\/?$/,
  /^\/graphql\//,
  /^\/graphql\/?$/,
  // The ads GraphQL endpoint (story ads pool): its variables carry the viewer's
  // context, so it is answered here, never forwarded.
  /^\/ads\/igwww_ads_graphql\/?$/,
  /^\/rupload_ig(photo|video)\//,
  /^\/accounts\/(login|logout|web_create_ajax|edit)\/ajax\/?/,
  /^\/accounts\/web_create_ajax\//,
  /^\/accounts\/edit\/?$/,
  /^\/web\/consent\//,
  /^\/data\/shared_data\/?$/,
  /^\/__media\//,
  /^\/__clone\//,
  // Route definitions: the request body lists route URLs, which contain clone
  // usernames and shortcodes, so it must never reach Instagram.
  /^\/ajax\/bulk-route-definitions\/?$/,
  /^\/ajax\/route-definition\/?$/,
];

const TELEMETRY_PATHS = [
  /^\/ajax\/bz\/?$/,
  /^\/ajax\/qm\/?$/,
  /^\/ajax\/relay-ef\/?$/,
  /^\/ajax\/weblite_app_logging\/?$/,
  /^\/ajax\/webstorage\/process_keys\/?$/,
  /^\/ajax\/logging\//,
  /^\/logging_client_events\/?$/,
  /^\/logging\//,
  /^\/sync\/instagram\/?$/,
  /^\/api\/v1\/web\/fxcal\//,
];

function classify(pathname) {
  if (TELEMETRY_PATHS.some((re) => re.test(pathname))) return 'telemetry';
  if (CLONE_PATHS.some((re) => re.test(pathname))) return 'clone';
  return 'other';
}

const DEFAULT_AVATAR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 150"><rect width="150" height="150" fill="#dbdbdb"/>' +
  '<circle cx="75" cy="58" r="28" fill="#fff"/><path d="M25 140c4-30 26-46 50-46s46 16 50 46z" fill="#fff"/></svg>';

/**
 * Signup-code delivery.
 *
 * Accounts need only a username and a password; no code is ever required to
 * create one. These codes exist only so the original signup form can finish
 * its own confirmation step if it shows one after an email was typed.
 *
 *   outbox    development default: codes are held in memory (never logged,
 *             never stored in plaintext) and shown at /__clone/dev/outbox to
 *             requests from this machine only.
 *   log       explicit opt-in: codes are printed to the server console.
 *   disabled  production default: no email provider exists, so sending a code
 *             fails with a clear error instead of pretending an email was sent.
 */
function createMailer({ transport, logger }) {
  const outbox = [];
  const OUTBOX_TTL_MS = 10 * 60 * 1000;
  if (transport === 'outbox') {
    return {
      enabled: true,
      transport,
      outbox: {
        enabled: true,
        list() {
          const cutoff = Date.now() - OUTBOX_TTL_MS;
          while (outbox.length && Date.parse(outbox[outbox.length - 1].sentAt) < cutoff) outbox.pop();
          return outbox.slice(0, 20);
        },
      },
      async sendSignupCode(email, code) {
        outbox.unshift({ to: email, code, purpose: 'signup', sentAt: new Date().toISOString() });
        if (outbox.length > 50) outbox.pop();
      },
    };
  }
  if (transport === 'log') {
    return {
      enabled: true,
      transport,
      outbox: { enabled: false, list: () => [] },
      async sendSignupCode(email, code) {
        logger.log(`[clone] signup confirmation code for ${email}: ${code}`);
      },
    };
  }
  return { enabled: false, transport: 'disabled', outbox: { enabled: false, list: () => [] }, async sendSignupCode() {} };
}

/**
 * A request from this machine itself. A request relayed by a reverse proxy on
 * the same host also arrives from loopback, so any forwarding header means the
 * real client is elsewhere and the request is not trusted as local.
 */
function isLoopback(req) {
  if (req.get('x-forwarded-for') || req.get('forwarded') || req.get('x-real-ip')) return false;
  const addr = req.socket?.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function multipart(req, res, next) {
  if (!/^multipart\/form-data/i.test(req.get('content-type') || '')) return next();
  let parser;
  try {
    parser = busboy({ headers: req.headers, limits: { fileSize: MAX_BYTES, files: 1, fields: 50 } });
  } catch {
    return next(badRequest('Malformed multipart body'));
  }
  req.files = {};
  req.body = req.body && typeof req.body === 'object' ? req.body : {};
  let failed = null;
  parser.on('field', (name, value) => {
    req.body[name] = value;
  });
  parser.on('file', (name, stream) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('limit', () => {
      failed = badRequest('Upload is too large');
    });
    stream.on('end', () => {
      req.files[name] = Buffer.concat(chunks);
    });
  });
  parser.on('error', () => {
    failed = badRequest('Malformed multipart body');
  });
  parser.on('close', () => {
    req.params_ = { ...req.query, ...req.body };
    next(failed || undefined);
  });
  req.pipe(parser);
}

/**
 * Express 4 does not route a rejected promise to the error handler: an async
 * handler that throws leaves the request open forever. Wrap every handler the
 * router registers so a rejection becomes next(error).
 */
function catchAsync(router) {
  const wrap = (fn) => {
    if (typeof fn !== 'function' || fn.length === 4) return fn;
    return function wrapped(req, res, next) {
      try {
        const out = fn(req, res, next);
        if (out && typeof out.then === 'function') out.catch(next);
        return out;
      } catch (error) {
        return next(error);
      }
    };
  };
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'all', 'use']) {
    const original = router[method].bind(router);
    router[method] = (...args) => original(...args.map((a) => (Array.isArray(a) ? a.map(wrap) : wrap(a))));
  }
  return router;
}

function createClone({ db, dataDir = '.data', logger = console, env = process.env } = {}) {
  const config = {
    mailTransport: env.CLONE_MAIL_TRANSPORT || (env.NODE_ENV === 'production' ? 'disabled' : 'outbox'),
    allowPlaintextPasswords: env.ALLOW_PLAINTEXT_ENC_PASSWORD !== '0',
  };
  const codec = createPasswordCodec({
    keyFile: path.join(dataDir, 'keys', 'password-encryption.json'),
    allowPlaintext: config.allowPlaintextPasswords,
  });
  const media = createMediaStore({ db, dir: path.join(dataDir, 'media') });
  // Operation contracts come from the client's own compiled artifacts in the
  // local asset store (when present); built lazily, once per process.
  let moduleIndex;
  const contracts = createContractCache(() => {
    if (moduleIndex === undefined) moduleIndex = env.CLONE_CONTRACTS === '0' ? null : buildModuleIndex({ assetDir: env.ASSET_CACHE_DIR || '.cache/assets', documentDir: env.DOCUMENT_CACHE_DIR || '.cache/documents', bootloaderDir: env.BOOTLOADER_CACHE_DIR || '.cache/bootloader' });
    return moduleIndex;
  });
  const graphql = createGraphql({ db, contracts });
  if (config.mailTransport === 'outbox' && env.NODE_ENV === 'production') config.mailTransport = 'disabled';
  const mailer = createMailer({ transport: config.mailTransport, logger });
  const outbox = mailer.outbox;
  const decryptFailures = {};

  const requireViewer = (req, res, next) => (req.viewer ? next() : next(unauthorized()));
  const rawImage = express.raw({ type: () => true, limit: MAX_BYTES });
  const ctx = {
    db,
    codec,
    media,
    mailer,
    config,
    requireViewer,
    rawImage,
    multipart,
    limits: { auth: limit(authLimiter) },
    decryptFailures,
  };

  const router = catchAsync(express.Router());

  router.use((req, res, next) => {
    req.cloneKind = classify(req.path);
    if (req.cloneKind === 'other') return next('router');
    next();
  });

  router.use((req, res, next) => {
    if (req.cloneKind !== 'telemetry') return next();
    // Acknowledge in the shapes the client's transports expect, and drop the data.
    res.setHeader('cache-control', 'no-store');
    if (req.path.startsWith('/ajax/')) {
      return res.type('application/x-javascript').send('for (;;);{"__ar":1,"payload":null}');
    }
    return res.json({ status: 'ok' });
  });

  router.use(privateHeaders);
  router.use(attachViewer(db));
  router.get('/__media/:key', media.handler);
  router.use(limit(generalLimiter));
  router.use((req, res, next) => (req.path.startsWith('/rupload_') ? next() : express.urlencoded({ extended: false, limit: '1mb' })(req, res, next)));
  router.use((req, res, next) => (req.path.startsWith('/rupload_') ? next() : express.json({ limit: '1mb' })(req, res, next)));
  router.use((req, res, next) => {
    req.params_ = { ...req.query, ...(req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {}) };
    next();
  });
  const ROUTE_DEFINITIONS = /^\/ajax\/(bulk-route-definitions|route-definition)\/?$/;
  // The telemetry sink writes nothing, so it needs no CSRF token (dropped beacons carry none).
  // The ads GraphQL endpoint is called by a network layer that sends no CSRF
  // token; only the read-only ads queries are answered there (see below).
  const ADS_GRAPHQL = /^\/ads\/igwww_ads_graphql\/?$/;
  const ADS_OPERATIONS = new Set(['PolarisStoriesV3AdsPoolWWWQuery']);
  // The genuine uploader (rupload) sends no CSRF token, only the session cookie
  // and the custom X-Instagram-Rupload-Params header. A custom header cannot be
  // sent cross-site without a CORS preflight (this origin answers none), so its
  // presence stands in for the token there; without it the token is required.
  const RUPLOAD = /^\/rupload_ig(photo|video)\//;
  const ruploadByClient = (req) => RUPLOAD.test(req.path) && Boolean(req.get('x-instagram-rupload-params'));
  router.use((req, res, next) => (ROUTE_DEFINITIONS.test(req.path) || req.path === '/__clone/dropped' || ADS_GRAPHQL.test(req.path) || ruploadByClient(req) ? next() : csrfCheck(req, res, next)));
  router.post(ADS_GRAPHQL, (req, res, next) => {
    if (ADS_OPERATIONS.has(String(req.params_.fb_api_req_friendly_name || ''))) return next();
    return res.status(404).json({ data: null, errors: [{ message: 'Only ads queries are answered on this endpoint', code: 404 }], status: 'fail' });
  });

  router.get('/__clone/health', (req, res) =>
    res.json({
      ok: true,
      graphql: { supported: graphql.supported(), unsupported: graphql.unsupported() },
      rest: { unsupported: [...unsupportedRest].map(([route, count]) => ({ route, count })).sort((a, b) => b.count - a.count) },
      passwordEncryption: { keyId: codec.keyId, version: 10 },
      signup: { emailRequired: false, verificationRequired: false, mailTransport: mailer.transport, devOutbox: outbox.enabled },
      passwordDecryptFailures: { ...decryptFailures },
      // Visited paths can name users, so the per-document list is local-only.
      documents: isLoopback(req) ? recentDocuments : undefined,
    })
  );
  router.get('/__clone/dev/outbox', (req, res) => {
    if (!outbox.enabled || !isLoopback(req)) return igFail(res, 404, 'Not found');
    return res.json({
      notice: 'Development outbox. Signup does not require an email or a code; codes appear here only if the signup form asks for one.',
      messages: outbox.list(),
    });
  });

  router.get('/__clone/runtime.js', (req, res) => {
    res.setHeader('cache-control', 'no-cache');
    res.type('application/javascript').send(RUNTIME_SOURCE);
  });
  router.all('/__clone/dropped', (req, res) => res.status(204).end());
  router.get('/__clone/static/default-avatar.svg', (req, res) => {
    res.setHeader('cache-control', 'public, max-age=86400');
    res.type('image/svg+xml').send(DEFAULT_AVATAR_SVG);
  });

  router.get('/data/shared_data/', (req, res) => {
    const csrf = req.cloneSession ? req.cloneSession.csrf_secret : ensureCsrfCookie(req, res);
    const present = require('./present');
    return res.json({
      config: {
        csrf_token: csrf,
        viewer: req.viewer ? present.user(db, req.viewer, null) : null,
        viewerId: req.viewer ? req.viewer.pk : null,
      },
      encryption: codec.clientConfig(),
      country_code: 'US',
      language_code: 'en',
    });
  });

  require('./routes/accounts').register(router, ctx);
  graphql.setLoginCore(ctx.loginCore);
  graphql.setSignupCore(ctx.signupCore);
  require('./routes/content').register(router, ctx);
  require('./routes/stories').register(router, ctx);
  require('./routes/direct').register(router, ctx);
  require('./routes/upload').register(router, ctx);

  // /ads/igwww_ads_graphql/ carries the ads operations (e.g. PolarisStoriesV3AdsPoolWWWQuery) in the same form.
  router.post(['/graphql/query', '/graphql/query/', '/api/graphql', '/api/graphql/', '/ads/igwww_ads_graphql', '/ads/igwww_ads_graphql/'], (req, res, next) => (graphql.isAuthOperation(req.params_) ? ctx.limits.auth(req, res, next) : next()), graphql.handler);

  /*
   * Route definitions are answered here with an empty map for every requested
   * URL. Instagram's real definitions name the bundles a route needs; without
   * them the client falls back to loading a route's code on navigation. This
   * is a deliberate trade: forwarding would send clone usernames to Instagram.
   */
  router.post(['/ajax/bulk-route-definitions/', '/ajax/bulk-route-definitions', '/ajax/route-definition/', '/ajax/route-definition'], (req, res) => {
    const urls = [];
    for (const [key, value] of Object.entries(req.params_ || {})) {
      if (/^route_urls(\[\d+\])?$/.test(key)) urls.push(...(Array.isArray(value) ? value : [value]));
    }
    if (typeof req.params_?.route_url === 'string') urls.push(req.params_.route_url);
    const payloads = {};
    for (const url of urls.slice(0, 100)) payloads[String(url)] = { error: 1357004, errorSummary: 'Route definition unavailable', payload: null };
    res.setHeader('cache-control', 'private, no-store, max-age=0');
    // fetchAnonymousCometRoute requires both `payloads` and `sr_payload` (server
    // render data, none here); an entry with `error` makes parseCometRouteFetchPayload
    // report the route as unavailable, and the router then loads the URL as a page.
    return res.type('application/x-javascript').send(`for (;;);${JSON.stringify({ __ar: 1, payload: { payloads, sr_payload: {} }, lid: '0' })}`);
  });

  router.get('/api/v1/web/get_profile_pic_props/:username/', (req, res) =>
    igOk(res, { show_profile_pic_sync_reminders: false, show_change_profile_pic_confirm_dialog: false })
  );

  // A clone-owned path with no handler: say so explicitly. Forwarding it to
  // Instagram would leak the request, and a fake success would lie.
  const unsupportedRest = new Map();
  router.use((req, res) => {
    const key = `${req.method} ${req.path.replace(/\/\d+(?=\/|$)/g, '/:id')}`;
    unsupportedRest.set(key, (unsupportedRest.get(key) || 0) + 1);
    return igFail(res, 501, `${req.method} ${req.path} is not implemented by this server`, { error_type: 'not_implemented' });
  });
  router.use(errorHandler(logger));

  const recentDocuments = [];
  function recordDocument(entry) {
    recentDocuments.unshift({ at: new Date().toISOString(), ...entry });
    if (recentDocuments.length > 20) recentDocuments.pop();
  }

  /** The signed-in clone viewer for a document request, or null. */
  function viewerFor(req) {
    const resolved = resolveSession(db, req);
    const user = resolved ? users.getById(db, resolved.session.user_id) : null;
    return user && user.status === 'active' ? { user, session: resolved.session } : null;
  }

  /** An active local account by username (a profile page's subject), or null. */
  function userByUsername(username) {
    const user = users.getByUsername(db, String(username));
    return user && user.status === 'active' ? user : null;
  }

  /** What a page needs to be personalised for this browser. */
  function documentContext(req, res) {
    const found = viewerFor(req);
    return {
      viewer: found ? found.user : null,
      csrfToken: found ? found.session.csrf_secret : ensureCsrfCookie(req, res),
      encryption: codec.clientConfig(),
    };
  }

  return { router, codec, media, graphql, config, classify, viewerFor, userByUsername, documentContext, recordDocument };
}

module.exports = { createClone, classify };
