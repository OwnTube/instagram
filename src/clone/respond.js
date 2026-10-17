'use strict';

/**
 * Instagram's response envelopes.
 *
 * REST: success is the payload plus `"status": "ok"`; failure is
 * `{ "message", "status": "fail", ... }` with a non-2xx status. A failed
 * operation is never reported as `ok`.
 *
 * Comet async requests (cometAsyncFetch: `__a=1` with `__d`, as the client's
 * getAsyncParams adds them; not Relay's GraphQL requests, which carry the
 * same params) read the same body from the Comet envelope
 * `for (;;);{"__ar":1,"payload":...}`; a failure there carries `error` and
 * `errorSummary`/`errorDescription`, which cometAsyncFetch rejects with.
 */

const { AppError } = require('../backend/lib/errors');

function isCometAsync(req) {
  // Relay's GraphQL requests carry the same async params but read plain JSON.
  if (!req || /graphql/.test(req.path)) return false;
  const params = { ...(req.body && typeof req.body === 'object' ? req.body : {}), ...req.query };
  return String(params.__a) === '1' && params.__d != null;
}

function comet(res, httpStatus, envelope) {
  return res.status(httpStatus).type('application/x-javascript').send(`for (;;);${JSON.stringify({ __ar: 1, ...envelope })}`);
}

function igOk(res, body = {}, httpStatus = 200) {
  if (isCometAsync(res.req)) return comet(res, httpStatus, { payload: { ...body, status: 'ok' } });
  return res.status(httpStatus).json({ ...body, status: 'ok' });
}

function igFail(res, httpStatus, message, extra = {}) {
  if (isCometAsync(res.req)) return comet(res, httpStatus, { error: httpStatus, errorSummary: message, errorDescription: message, payload: null });
  return res.status(httpStatus).json({ message, ...extra, status: 'fail' });
}

/** The error handler for every clone route. */
function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return function handle(error, req, res, next) {
    if (error instanceof AppError) {
      if (error.status === 401) return igFail(res, 401, 'login_required', { require_login: true });
      const extra = {};
      if (error.details) extra.error_details = error.details;
      if (error.status === 429) extra.spam = true;
      return igFail(res, error.status, error.message, extra);
    }
    if (error && error.type === 'entity.too.large') return igFail(res, 413, 'Request body too large');
    logger.error(`[clone] unhandled error ${req.method} ${req.path}: ${error.stack || error.message}`);
    return igFail(res, 500, 'An internal error occurred');
  };
}

/** Responses built from one viewer's data are never stored by shared caches. */
function privateHeaders(req, res, next) {
  res.setHeader('cache-control', 'private, no-store, max-age=0');
  res.setHeader('vary', 'Cookie');
  res.setHeader('x-content-type-options', 'nosniff');
  next();
}

module.exports = { isCometAsync, igOk, igFail, errorHandler, privateHeaders };
