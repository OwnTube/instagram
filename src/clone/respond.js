'use strict';

/**
 * Instagram's response envelopes.
 *
 * REST: success is the payload plus `"status": "ok"`; failure is
 * `{ "message", "status": "fail", ... }` with a non-2xx status. A failed
 * operation is never reported as `ok`.
 */

const { AppError } = require('../backend/lib/errors');

function igOk(res, body = {}, httpStatus = 200) {
  return res.status(httpStatus).json({ ...body, status: 'ok' });
}

function igFail(res, httpStatus, message, extra = {}) {
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

module.exports = { igOk, igFail, errorHandler, privateHeaders };
