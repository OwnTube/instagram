'use strict';

/**
 * Anonymous documents persist to disk, so after a restart a throttling origin
 * (HTTP 429) does not take the page down, and LOADER_PREFER_CACHE serves the
 * copy without contacting the origin at all. Nothing per-viewer is stored.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const PAGE = '<!DOCTYPE html><html><head><title>Instagram</title></head><body><p>ANON-PAGE-MARK</p></body></html>';

async function boot(env) {
  for (const key of Object.keys(require.cache)) if (key.startsWith(SRC)) delete require.cache[key];
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const { app } = require('../src/server');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    },
  };
}

test('anonymous documents survive a restart and an origin that throttles', async () => {
  fs.mkdirSync(path.join(ROOT, '.scratch'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, '.scratch', 'docstore-'));
  let mode = 'ok';
  let hits = 0;
  const upstream = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      hits += 1;
      if (mode === 'throttle') {
        res.writeHead(429, { 'content-type': 'text/plain' });
        return res.end('slow down');
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const env = {
    UPSTREAM_ORIGIN: `http://127.0.0.1:${upstream.address().port}`,
    BACKEND_DB: path.join(dir, 'db.sqlite'),
    CLONE_DATA_DIR: dir,
    DOCUMENT_CACHE_DIR: path.join(dir, 'documents'),
    ASSET_CACHE_DIR: '',
    DOCUMENT_STALE_MS: String(24 * 3600 * 1000),
    VERBOSE: '0',
    BACKEND_VERBOSE: '0',
  };
  try {
    let srv = await boot(env);
    const first = await (await fetch(`${srv.base}/`, { headers: { accept: 'text/html' } })).text();
    assert.ok(first.includes('ANON-PAGE-MARK'));
    await new Promise((r) => setTimeout(r, 100)); // the disk write is fire-and-forget
    await srv.close();

    mode = 'throttle';
    srv = await boot({ ...env, DOCUMENT_CACHE_TTL_MS: '0' });
    const res = await fetch(`${srv.base}/`, { headers: { accept: 'text/html' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-loader-cache'), 'stale');
    assert.ok((await res.text()).includes('ANON-PAGE-MARK'), 'the disk copy is served while the origin answers 429');
    await srv.close();

    const before = hits;
    srv = await boot({ ...env, DOCUMENT_CACHE_TTL_MS: '0', LOADER_PREFER_CACHE: '1' });
    const cachedOnly = await fetch(`${srv.base}/`, { headers: { accept: 'text/html' } });
    assert.strictEqual(cachedOnly.headers.get('x-loader-cache'), 'hit');
    assert.ok((await cachedOnly.text()).includes('ANON-PAGE-MARK'));
    assert.strictEqual(hits, before, 'LOADER_PREFER_CACHE does not contact the origin');
    await srv.close();

    // A different upstream must never be answered from this upstream's copy.
    const other = await new Promise((resolve) => {
      const o = http.createServer((req, res) => {
        res.writeHead(429, { 'content-type': 'text/plain' });
        res.end('no');
      });
      o.listen(0, '127.0.0.1', () => resolve(o));
    });
    srv = await boot({ ...env, UPSTREAM_ORIGIN: `http://127.0.0.1:${other.address().port}`, LOADER_PREFER_CACHE: '1' });
    const foreign = await (await fetch(`${srv.base}/`, { headers: { accept: 'text/html' } })).text();
    assert.ok(!foreign.includes('ANON-PAGE-MARK'), 'a copy from another upstream must not be served');
    await srv.close();
    other.closeAllConnections?.();
    await new Promise((r) => other.close(r));

    for (const f of fs.readdirSync(path.join(dir, 'documents'))) {
      const text = fs.readFileSync(path.join(dir, 'documents', f), 'utf8');
      assert.ok(!/sessionid|ds_user_id/.test(text), 'no viewer state on disk');
    }
  } finally {
    upstream.closeAllConnections?.();
    await new Promise((r) => upstream.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
