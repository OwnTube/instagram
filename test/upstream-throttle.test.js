'use strict';

/**
 * A throttling origin (HTTP 429) is not retried and starts a per-host
 * cooldown during which nothing is sent to it; LOADER_OFFLINE=1 never contacts
 * the origin. Other transient errors are still retried.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

test('upstream throttling', async (t) => {
  let hits = 0;
  let status = 429;
  const origin = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      hits += 1;
      res.writeHead(status, { 'content-type': 'text/plain', ...(status === 429 ? { 'retry-after': '60' } : {}) });
      res.end('x');
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => {
    origin.closeAllConnections?.();
    origin.close();
  });
  const url = `http://127.0.0.1:${origin.address().port}/`;
  process.env.RETRY_BASE_MS = '1';
  for (const key of Object.keys(require.cache)) if (key.includes('/src/')) delete require.cache[key];
  const { fetchUpstream, UpstreamError, throttle } = require('../src/upstream');

  await t.test('a 429 is returned once, not retried', async () => {
    const res = await fetchUpstream(url);
    assert.strictEqual(res.status, 429);
    assert.strictEqual(hits, 1);
  });

  await t.test('during the cooldown nothing is sent and callers get a 429 error', async () => {
    await assert.rejects(fetchUpstream(url), (e) => e instanceof UpstreamError && e.status === 429);
    assert.strictEqual(hits, 1);
    const [entry] = throttle.status();
    assert.ok(entry.coolingDownForMs > 50 * 1000 && entry.coolingDownForMs <= 60 * 1000, 'Retry-After sets the cooldown');
  });

  await t.test('after the cooldown, requests flow again; 5xx is still retried', async () => {
    throttle.until.clear();
    status = 503;
    hits = 0;
    const res = await fetchUpstream(url);
    assert.strictEqual(res.status, 503);
    assert.ok(hits > 1, 'a 503 is retried');
  });

  await t.test('LOADER_OFFLINE=1 never contacts the origin', async () => {
    hits = 0;
    process.env.LOADER_OFFLINE = '1';
    try {
      await assert.rejects(fetchUpstream(url), (e) => e.status === 504);
      assert.strictEqual(hits, 0);
    } finally {
      delete process.env.LOADER_OFFLINE;
    }
  });
});
