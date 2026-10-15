'use strict';

/**
 * Express 4 does not forward a rejected promise to the error handler, so every
 * async route is wrapped. Without this a thrown AppError would become an
 * unhandled rejection and the request would hang.
 */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
