'use strict';

/**
 * Backend entry point.
 *
 * Mounts the application API under backend.prefix as a self-contained sub-app.
 * Using a sub-app rather than attaching routes to the loader's app keeps the two
 * concerns separable:
 *   - the sub-app owns its body parsing, auth resolution, CSRF check, 404 and
 *     error handler;
 *   - an error raised by a backend route can never be handled by the loader's
 *     document handler, and vice versa.
 *
 * src/server.js mounts this BEFORE the loader's catch-all, which is what stops
 * these paths from being forwarded to Instagram.
 */

const express = require('express');

const backend = require('./config');
const { openDatabase, migrate } = require('./db');
const { createRouter } = require('./api/router');
const { attachUser, csrfProtection } = require('./lib/auth');
const { AppError, notFound } = require('./lib/errors');
const { requestLogger, requestId } = require('./lib/logging');

function createBackend({ dbFile = backend.databaseFile, logger = console } = {}) {
  const db = openDatabase(dbFile);
  const applied = migrate(db);

  const sub = express();

  // The backend is a JSON API. The loader parses bodies as raw buffers (so it
  // can forward Instagram's payloads byte-for-byte); the backend must parse its
  // own JSON instead, which is why this parser is scoped to the sub-app.
  sub.use(express.json({ limit: '1mb' }));
  // The sub-app is self-contained, so it assigns its own request id rather than
  // relying on the loader's middleware being present.
  sub.use(requestId);
  sub.use(requestLogger(logger));

  // Backend responses are per-user and must never be cached or shared. Without
  // this an intermediary could serve one user's authenticated response to
  // another visitor of the public URL.
  sub.use((req, res, next) => {
    res.setHeader('cache-control', 'no-store, private');
    res.setHeader('vary', 'Cookie, Authorization');
    next();
  });

  // Resolve the session, then enforce CSRF for cookie-authenticated writes.
  sub.use(attachUser(db));
  sub.use(csrfProtection());

  sub.use('/api/v1', createRouter(db));

  // Unknown backend path: a clear JSON 404, not Instagram's HTML.
  sub.use((req, res, next) => next(notFound(`No backend route for ${req.method} ${req.originalUrl}`)));

  // Single error handler for the whole sub-app.
  // eslint-disable-next-line no-unused-vars
  sub.use((error, req, res, next) => {
    const isAppError = error instanceof AppError;
    const status = isAppError ? error.status : 500;
    const code = isAppError ? error.code : 'internal_error';
    // Only deliberate AppError messages reach the client; anything else is
    // reported generically so database text and stack traces cannot leak.
    const message = isAppError ? error.message : 'An internal error occurred';
    if (!isAppError) {
      logger.error(`[backend] unhandled error rid=${req.id}: ${error.stack || error.message}`);
    }
    const body = { error: { code, message } };
    if (isAppError && error.details) body.error.details = error.details;
    body.error.requestId = req.id;
    res.status(status).json(body);
  });

  return { sub, db, appliedMigrations: applied, prefix: backend.prefix };
}

/** Mount the backend on an existing Express app, before the loader catch-all. */
function mount(app, options = {}) {
  const instance = createBackend(options);
  app.use(instance.prefix, instance.sub);
  return instance;
}

module.exports = { createBackend, mount, prefix: backend.prefix };
