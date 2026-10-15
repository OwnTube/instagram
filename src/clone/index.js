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
  /^\/rupload_ig(photo|video)\//,
  /^\/accounts\/(login|logout|web_create_ajax|edit)\/ajax\/?/,
  /^\/accounts\/web_create_ajax\//,
  /^\/accounts\/edit\/?$/,
  /^\/web\/consent\//,
  /^\/data\/shared_data\/?$/,
  /^\/__media\//,
  /^\/__clone\//,
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

function createMailer({ transport, logger }) {
  if (transport === 'log') {
    return {
      enabled: true,
      transport,
      async sendSignupCode(email, code) {
        // Development transport: the operator reads the code from the server
        // console. Configure a real transport before exposing signup publicly.
        logger.log(`[clone] signup confirmation code for ${email}: ${code}`);
      },
    };
  }
  return { enabled: false, transport: 'disabled', async sendSignupCode() {} };
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

function createClone({ db, dataDir = '.data', logger = console, env = process.env } = {}) {
  const config = {
    requireEmailCode: env.SIGNUP_REQUIRE_EMAIL_CODE !== '0',
    mailTransport: env.CLONE_MAIL_TRANSPORT || (env.NODE_ENV === 'production' ? 'disabled' : 'log'),
    allowPlaintextPasswords: env.ALLOW_PLAINTEXT_ENC_PASSWORD !== '0',
  };
  const codec = createPasswordCodec({
    keyFile: path.join(dataDir, 'keys', 'password-encryption.json'),
    allowPlaintext: config.allowPlaintextPasswords,
  });
  const media = createMediaStore({ db, dir: path.join(dataDir, 'media') });
  const graphql = createGraphql({ db });
  const mailer = createMailer({ transport: config.mailTransport, logger });

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
  };

  const router = express.Router();

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
  router.use(csrfCheck);

  router.get('/__clone/health', (req, res) =>
    res.json({
      ok: true,
      graphql: { supported: graphql.supported(), unsupported: graphql.unsupported() },
      rest: { unsupported: [...unsupportedRest].map(([route, count]) => ({ route, count })).sort((a, b) => b.count - a.count) },
      passwordEncryption: { keyId: codec.keyId, version: 10 },
      signup: { requireEmailCode: config.requireEmailCode, mailTransport: mailer.transport },
    })
  );
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
  require('./routes/content').register(router, ctx);
  require('./routes/stories').register(router, ctx);
  require('./routes/direct').register(router, ctx);
  require('./routes/upload').register(router, ctx);

  router.post(['/graphql/query', '/graphql/query/', '/api/graphql', '/api/graphql/'], graphql.handler);

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

  /** The signed-in clone viewer for a document request, or null. */
  function viewerFor(req) {
    const resolved = resolveSession(db, req);
    const user = resolved ? users.getById(db, resolved.session.user_id) : null;
    return user && user.status === 'active' ? { user, session: resolved.session } : null;
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

  return { router, codec, media, graphql, config, classify, viewerFor, documentContext };
}

module.exports = { createClone, classify };
