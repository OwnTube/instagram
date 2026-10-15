'use strict';

/**
 * Error types and the single response envelope every endpoint uses.
 *
 * The envelope is uniform so a client never has to guess the shape:
 *   success: { data: <payload>, meta?: {...} }
 *   failure: { error: { code, message, details? } }
 *
 * Only AppError messages reach the client. Anything else is an internal fault
 * and is reported as a generic 500 so stack traces and database text cannot
 * leak through an error response.
 */

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new AppError(400, 'bad_request', message, details);
const unauthorized = (message = 'Authentication required') => new AppError(401, 'unauthorized', message);
const forbidden = (message = 'Not permitted') => new AppError(403, 'forbidden', message);
const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
const conflict = (message, details) => new AppError(409, 'conflict', message, details);
const tooMany = (message = 'Too many requests', details) => new AppError(429, 'rate_limited', message, details);
const unavailable = (message, details) => new AppError(503, 'upstream_unavailable', message, details);

function ok(res, data, meta) {
  const body = { data };
  if (meta) body.meta = meta;
  return res.status(200).json(body);
}

function created(res, data, meta) {
  const body = { data };
  if (meta) body.meta = meta;
  return res.status(201).json(body);
}

function noContent(res) {
  return res.status(204).end();
}

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  tooMany,
  unavailable,
  ok,
  created,
  noContent,
};
