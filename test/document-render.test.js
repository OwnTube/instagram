'use strict';

/**
 * The served HTML document must let the original client boot. The regression
 * this guards: the shell used to strip the anonymous page's own Relay prefetch,
 * which is the data the page renders from, leaving the client waiting on a
 * runtime query we cannot answer (the loading screen then never clears).
 *
 * A stand-in origin serves a page shaped like Instagram's: a define tuple, an
 * encryption config, a csrf field, and a RelayPrefetchedStreamCache prefetch.
 * These tests assert what the shell does to it, over real HTTP.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const ROOT = path.join(__dirname, '..');
fs.mkdirSync(path.join(ROOT, '.scratch'), { recursive: true });

const PREFETCH_KEY = 'adp_LoggedOutHomeQueryRelayPreloader_abc';
const PREFETCH_MARK = 'ANON-PREFETCH-PAYLOAD';

function block(obj) {
  return `<script type="application/json" data-sjs>${JSON.stringify(obj)}</script>`;
}

// A big integer and integer-like object keys sit in the SAME block as the csrf
// the shell edits. A whole-block round trip would lose the integer's precision
// and reorder the keys; this fixture lets the served bytes be checked.
const BIG_INT = '12345678901234567890';
// The encryption config (which the shell DOES rewrite) sits in the same block
// as a big integer and integer-like keys. A whole-block round trip would lose
// the integer's precision and reorder the keys; this fixture checks the served
// bytes. The csrf token is here too, to confirm it is NOT rewritten (the client
// tamper-checks it).
const SUPPORT_BLOCK = `{"config":{"csrf_token":"upstream-anon-csrf"},"encryption":{"key_id":"1","public_key":"${'a'.repeat(64)}","version":"10"},"clp":{"1744178":{"r":1},"636":{"r":2}},"hsi":${BIG_INT}}`;

function upstreamPage() {
  return (
    '<!DOCTYPE html><html><head><title>Instagram</title>' +
    '<script src="https://static.cdninstagram.com/rsrc.php/boot.js"></script></head><body><div id="spinner">loading</div>' +
    block({ define: [['CurrentUserInitialData', [], { USER_ID: '0', NAME: '', SHORT_NAME: null }, 1]] }) +
    `<script type="application/json" data-sjs>${SUPPORT_BLOCK}</script>` +
    block({ require: [['RelayPrefetchedStreamCache', 'next', [], [PREFETCH_KEY, { __bbox: { result: { data: { note: PREFETCH_MARK } } } }]]] }) +
    '</body></html>'
  );
}

async function withServer(env, fn) {
  const seenAccept = [];
  const upstream = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      seenAccept.push(req.headers.accept || '');
      // Mimic Instagram: a request that does not ask for HTML gets a reduced
      // page with no login form.
      const full = (req.headers.accept || '').includes('text/html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(full ? upstreamPage() : '<!DOCTYPE html><html><head></head><body>reduced</body></html>');
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  upstream.seenAccept = seenAccept;
  const dir = fs.mkdtempSync(path.join(ROOT, '.scratch', 'doc-'));
  const saved = { ...process.env };
  Object.assign(process.env, {
    UPSTREAM_ORIGIN: `http://127.0.0.1:${upstream.address().port}`,
    BACKEND_DB: path.join(dir, 'db.sqlite'),
    CLONE_DATA_DIR: dir,
    VERBOSE: '0',
    BACKEND_VERBOSE: '0',
    ...env,
  });
  for (const key of Object.keys(require.cache)) if (key.startsWith(SRC)) delete require.cache[key];
  const { app } = require('../src/server');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, upstream);
  } finally {
    for (const k of Object.keys(env)) if (saved[k] === undefined) delete process.env[k];
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the served document lets the client boot', async (t) => {
  await t.test('an anonymous page keeps its own prefetch and is valid HTML', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
      assert.strictEqual(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /text\/html/);
      const html = await res.text();
      assert.ok(html.includes(PREFETCH_MARK), 'the anonymous prefetch payload must survive');
      assert.ok(html.includes('RelayPrefetchedStreamCache'));
      // Every JSON block still parses after personalisation.
      for (const m of html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
        assert.doesNotThrow(() => JSON.parse(m[1]), 'a bootstrap JSON block was left invalid');
      }
    });
  });

  await t.test('our encryption key is substituted in; the csrf token and a readable csrftoken cookie are left for the client', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
      const html = await res.text();
      const ours = (await (await fetch(`${base}/data/shared_data/`)).json()).encryption;
      assert.ok(html.includes(ours.public_key) && !html.includes('a'.repeat(64)), 'our key replaces the upstream key');
      assert.ok(html.includes('upstream-anon-csrf'), 'the bootstrap csrf token is preserved (the client tamper-checks it)');
      const csrfCookie = res.headers.getSetCookie().find((c) => c.startsWith('csrftoken='));
      assert.ok(csrfCookie && !/HttpOnly/i.test(csrfCookie), 'a readable csrftoken cookie is issued for the client to echo as X-CSRFToken');
      // The encryption edit must not corrupt the big integer or key order in its block.
      assert.ok(html.includes(`"hsi":${BIG_INT}`), 'the big integer survives the edit to its block');
      assert.ok(html.includes('"clp":{"1744178":{"r":1},"636":{"r":2}}'), 'integer-like key order is preserved');
      const csrf = res.headers.getSetCookie().find((c) => c.startsWith('csrftoken='));
      assert.ok(csrf && !/HttpOnly/i.test(csrf), 'a readable csrftoken is issued for the client to echo');
      assert.ok(html.includes('/__clone/runtime.js'), 'the runtime is injected');
    });
  });

  await t.test('the health endpoint confirms prefetch dropping is off by default', async () => {
    await withServer({}, async (base) => {
      const health = await (await fetch(`${base}/__loader/health`)).json();
      assert.strictEqual(health.shell.forceDropPrefetches, false);
    });
  });

  await t.test('forcing drops on removes the prefetch (debug only), confirming the mechanism', async () => {
    await withServer({ SHELL_DROP_PREFETCHES: '1' }, async (base) => {
      const html = await (await fetch(`${base}/`, { headers: { accept: 'text/html' } })).text();
      assert.ok(!html.includes(PREFETCH_MARK), 'with the debug flag the prefetch is stripped');
    });
  });

  await t.test('a document navigation gets the full HTML variant even when the client sends */*', async () => {
    await withServer({}, async (base, upstream) => {
      const route = await fetch(`${base}/`, { headers: { accept: '*/*' } });
      const html = await route.text();
      assert.ok(html.includes(PREFETCH_MARK), 'the full page was fetched, not the reduced one');
      assert.ok(upstream.seenAccept.some((a) => a.includes('text/html')), 'upstream was asked for HTML');
    });
  });

  await t.test('a request for a file keeps its own Accept and is not forced to HTML', async () => {
    await withServer({}, async (base, upstream) => {
      upstream.seenAccept.length = 0;
      await fetch(`${base}/data/manifest.json`, { headers: { accept: 'application/json' } });
      assert.ok(upstream.seenAccept.every((a) => !a.includes('text/html')), 'a .json path must not be upgraded to HTML');
    });
  });

  await t.test('an unsupported GraphQL op the client might issue fails fast with 501, not a hang', async () => {
    await withServer({}, async (base) => {
      const first = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
      const token = first.headers.getSetCookie().find((c) => c.startsWith('csrftoken=')).split(';')[0].split('=')[1];
      const res = await fetch(`${base}/graphql/query`, {
        method: 'POST',
        headers: { cookie: `csrftoken=${token}`, 'x-csrftoken': decodeURIComponent(token), 'content-type': 'application/x-www-form-urlencoded' },
        body: 'fb_api_req_friendly_name=PolarisUnknownBootQuery&variables=%7B%7D',
      });
      assert.strictEqual(res.status, 501);
      assert.strictEqual((await res.json()).data, null);
    });
  });
});
