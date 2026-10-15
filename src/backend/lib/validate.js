'use strict';

/**
 * Request validation.
 *
 * Hand-written rather than schema-library based, to keep the backend free of
 * extra dependencies. Every field is validated by type and bound before it
 * reaches a service, so no unvalidated value is ever interpolated into SQL
 * (the data layer uses bound parameters regardless).
 */

const backend = require('../config');
const { badRequest } = require('./errors');

const USERNAME_RE = /^[a-zA-Z0-9._]{3,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(message, details) {
  throw badRequest(message, details);
}

function asObject(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    fail('Request body must be a JSON object');
  }
  return body;
}

function str(value, field, { min = 1, max = 5000, required = true, pattern } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(`"${field}" is required`, { field });
    return undefined;
  }
  if (typeof value !== 'string') fail(`"${field}" must be a string`, { field });
  const trimmed = value.trim();
  if (trimmed.length < min) fail(`"${field}" must be at least ${min} characters`, { field });
  if (trimmed.length > max) fail(`"${field}" must be at most ${max} characters`, { field });
  if (pattern && !pattern.test(trimmed)) fail(`"${field}" has an invalid format`, { field });
  return trimmed;
}

function optionalStr(value, field, opts = {}) {
  if (value === undefined || value === null || value === '') return undefined;
  return str(value, field, { ...opts, required: false });
}

function bool(value, field, { required = true, fallback } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(`"${field}" is required`, { field });
    return fallback;
  }
  if (typeof value !== 'boolean') fail(`"${field}" must be a boolean`, { field });
  return value;
}

function int(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, required = true, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(`"${field}" is required`, { field });
    return fallback;
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n)) fail(`"${field}" must be an integer`, { field });
  if (n < min || n > max) fail(`"${field}" must be between ${min} and ${max}`, { field });
  return n;
}

function oneOf(value, field, allowed, { required = true, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(`"${field}" is required`, { field });
    return fallback;
  }
  if (!allowed.includes(value)) {
    fail(`"${field}" must be one of: ${allowed.join(', ')}`, { field, allowed });
  }
  return value;
}

function username(value, field = 'username') {
  return str(value, field, { min: 3, max: 30, pattern: USERNAME_RE });
}

function email(value, field = 'email') {
  const v = str(value, field, { min: 3, max: 254 });
  if (!EMAIL_RE.test(v)) fail(`"${field}" must be a valid email address`, { field });
  return v.toLowerCase();
}

function password(value, field = 'password') {
  const v = str(value, field, { min: 10, max: 200 });
  if (!/[a-zA-Z]/.test(v) || !/[0-9]/.test(v)) {
    fail(`"${field}" must contain at least one letter and one digit`, { field });
  }
  return v;
}

/**
 * Cursor pagination parsed from a query string.
 *
 * Cursors are opaque to the client: the service layer decides what a cursor
 * encodes. Only the page size is validated here.
 */
function pagination(query = {}) {
  const limit = int(query.limit, 'limit', {
    min: 1,
    max: backend.maxPageSize,
    required: false,
    fallback: backend.defaultPageSize,
  });
  const cursor = optionalStr(query.cursor, 'cursor', { max: 512 });
  return { limit, cursor };
}

module.exports = {
  asObject,
  str,
  optionalStr,
  bool,
  int,
  oneOf,
  username,
  email,
  password,
  pagination,
  USERNAME_RE,
  EMAIL_RE,
};
