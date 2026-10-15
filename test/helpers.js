'use strict';

/**
 * Minimal test harness.
 *
 * Node's built-in `node:test` plus `node:assert` is used so the backend needs no
 * test framework dependency. This file provides a helper to start the real HTTP
 * app against a throwaway on-disk database and a tiny fetch-based client, so the
 * tests exercise the real Express stack (routing, auth, CSRF, error handling)
 * rather than calling services directly.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const backendApp = require('../src/backend');

// Test databases live under the project-local .scratch/ tree (gitignored), never
// in the system temp directory, so no test artifact leaves the workspace.
const TEST_ROOT = path.join(__dirname, '..', '.scratch', 'test');

/** Fresh temporary database file, removed on cleanup. */
function tempDbFile() {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'run-'));
  return { file: path.join(dir, 'test.db'), dir };
}

/**
 * Start the backend on an ephemeral port. Returns { base, db, close }.
 * The backend is mounted on a bare Express app exactly as src/server.js mounts
 * it, so the routing order under test matches production.
 */
async function startTestServer() {
  const { file, dir } = tempDbFile();
  const app = express();
  const instance = backendApp.mount(app, { dbFile: file, logger: { log() {}, error() {} } });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();

  return {
    base: `http://127.0.0.1:${port}${backendApp.prefix}/api/v1`,
    db: instance.db,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

/** Request helper. Returns { status, body, headers, cookies }. */
async function request(base, method, path, { body, token, csrf, cookies, headers } = {}) {
  const h = { ...(headers || {}) };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`;
  if (csrf) h['x-csrf-token'] = csrf;
  if (cookies) h.cookie = cookies;

  const res = await fetch(`${base}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const cookieHeader = setCookie.map((c) => c.split(';')[0]).join('; ');

  return { status: res.status, body: parsed, headers: res.headers, setCookie, cookies: cookieHeader };
}

/** Register a user and return { user, token, csrfToken }. */
async function register(base, overrides = {}) {
  const username = overrides.username || `u${Math.random().toString(36).slice(2, 10)}`;
  const res = await request(base, 'POST', '/auth/register', {
    body: { username, password: 'password123', ...overrides },
  });
  assert.strictEqual(res.status, 201, `register failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

module.exports = { startTestServer, request, register, tempDbFile };
