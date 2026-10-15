'use strict';

/**
 * Viewer isolation regression tests.
 *
 * The loader once injected a single configured `IG_SESSIONID` upstream, which
 * made every visitor receive one account's personalised document. These tests
 * exist so that cannot come back, and so that the replacement mechanism —
 * per-viewer pass-through of the viewer's OWN session — cannot degrade into the
 * same bug.
 *
 * The properties under test are about what one viewer can observe of another:
 *
 *   - with no viewer session, everyone gets the same account-free document;
 *   - with viewer sessions enabled, a viewer's session is used for that
 *     viewer's request only, and never appears in another viewer's response;
 *   - personalised responses are never stored in a shared cache;
 *   - a viewer's session is never sent to asset hosts, and never echoed back.
 *
 * A stand-in origin is used so the tests never contact Instagram and never need
 * a real credential. Sessions here are synthetic.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const MODULES = ['config.js', 'session.js', 'upstream.js', 'cookies.js', 'server.js', 'rewrite.js', 'cache.js'].map(
  (f) => path.join(SRC, f),
);

const ALICE = 'alice-session-value';
const BOB = 'bob-session-value';

/** Load a fresh copy of a module with the given environment applied. */
function loadWithEnv(modulePath, env) {
  const saved = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const p of MODULES) delete require.cache[p];
  try {
    return require(modulePath);
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/**
 * Stand-in origin. Echoes which session it saw into the document, and records
 * every request, so a test can assert exactly what was forwarded.
 */
async function startFakeOrigin() {
  const received = [];
  const server = http.createServer((req, res) => {
    received.push({ url: req.url, cookie: req.headers.cookie || null, method: req.method });
    const m = (req.headers.cookie || '').match(/sessionid=([^;]+)/);
    const who = m ? m[1] : 'anonymous';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"v1"' });
    res.end(`<!doctype html><html><body><div id="who">${who}</div></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    received,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Start the loader against a stand-in origin. */
async function startLoader(env) {
  const fake = await startFakeOrigin();
  const { app } = loadWithEnv(path.join(SRC, 'server.js'), {
    BACKEND_ENABLED: '0',
    UPSTREAM_ORIGIN: fake.origin,
    ...env,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    received: fake.received,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await fake.close();
    },
  };
}

/** GET a path, optionally with a Cookie header. Returns { status, body, headers }. */
async function get(base, p = '/', cookie) {
  const res = await fetch(`${base}${p}`, { headers: cookie ? { cookie } : {} });
  return { status: res.status, body: await res.text(), headers: res.headers };
}

const identity = (body) => (body.match(/id="who">([^<]*)/) || [, null])[1];

test('viewer isolation: anonymous by default', async (t) => {
  await t.test('viewer sessions are off unless explicitly enabled', () => {
    const config = loadWithEnv(path.join(SRC, 'config.js'), { ALLOW_VIEWER_SESSIONS: undefined });
    assert.strictEqual(config.allowViewerSessions, false);
    // The global-session mechanism is gone entirely.
    assert.strictEqual(config.authMode, undefined);
    assert.strictEqual(config.sessionCookie, undefined);
  });

  await t.test('two independent viewers receive byte-identical documents', async () => {
    const loader = await startLoader({ ALLOW_VIEWER_SESSIONS: undefined });
    try {
      const a = await get(loader.base, '/');
      const b = await get(loader.base, '/', 'theme=dark; unrelated=1');
      assert.strictEqual(a.body, b.body, 'an anonymous document must not vary by viewer');
      assert.strictEqual(identity(a.body), 'anonymous');
    } finally {
      await loader.close();
    }
  });

  await t.test('a session cookie is ignored while viewer sessions are disabled', async () => {
    const loader = await startLoader({ ALLOW_VIEWER_SESSIONS: undefined });
    try {
      const res = await get(loader.base, '/', `sessionid=${ALICE}`);
      assert.strictEqual(identity(res.body), 'anonymous');
      const upstream = loader.received.at(-1);
      assert.ok(!(upstream.cookie || '').includes(ALICE), 'the session must not be forwarded when disabled');
    } finally {
      await loader.close();
    }
  });
});

test('viewer isolation: one viewer never sees another', async (t) => {
  await t.test('each viewer is served with their own session', async () => {
    const loader = await startLoader({ ALLOW_VIEWER_SESSIONS: '1' });
    try {
      const alice = await get(loader.base, '/', `sessionid=${ALICE}; ds_user_id=111`);
      const bob = await get(loader.base, '/', `sessionid=${BOB}; ds_user_id=222`);
      assert.strictEqual(identity(alice.body), ALICE);
      assert.strictEqual(identity(bob.body), BOB);
    } finally {
      await loader.close();
    }
  });

  await t.test("viewer A's session never appears in viewer B's response", async () => {
    const loader = await startLoader({ ALLOW_VIEWER_SESSIONS: '1' });
    try {
      await get(loader.base, '/', `sessionid=${ALICE}`);
      const bob = await get(loader.base, '/', `sessionid=${BOB}`);
      assert.ok(!bob.body.includes(ALICE), "one viewer's session must never appear in another's response");
    } finally {
      await loader.close();
    }
  });

  await t.test('an anonymous viewer is not served a personalised document', async () => {
    const loader = await startLoader({ ALLOW_VIEWER_SESSIONS: '1' });
    try {
      // Prime with a personalised request first, so a cache leak would show up.
      await get(loader.base, '/', `sessionid=${ALICE}`);
      const anon = await get(loader.base, '/');
      assert.strictEqual(identity(anon.body), 'anonymous', 'a personalised document must never be served anonymously');
      assert.ok(!anon.body.includes(ALICE));
    } finally {
      await loader.close();
    }
  });

  await t.test('a personalised document is never cached or shared', async () => {
    const loader = await startLoader({ ALLOW_VIEWER_SESSIONS: '1' });
    try {
      const first = await get(loader.base, '/', `sessionid=${ALICE}`);
      const second = await get(loader.base, '/', `sessionid=${ALICE}`);
      assert.strictEqual(first.headers.get('x-loader-cache'), null, 'personalised responses must not be cached');
      assert.strictEqual(second.headers.get('x-loader-cache'), null);
      assert.strictEqual(first.headers.get('cache-control'), 'private, no-store, max-age=0');
      assert.strictEqual(first.headers.get('x-loader-personalized'), 'true');
    } finally {
      await loader.close();
    }
  });

  await t.test('only Instagram session cookies are relayed, not the whole header', async () => {
    const loader = await startLoader({ ALLOW_VIEWER_SESSIONS: '1' });
    try {
      await get(loader.base, '/', `sessionid=${ALICE}; igloader_session=our-own-backend-cookie; tracking=abc`);
      const upstream = loader.received.at(-1);
      assert.match(upstream.cookie, /sessionid=/);
      assert.ok(!upstream.cookie.includes('our-own-backend-cookie'), 'our own cookie must not leak upstream');
      assert.ok(!upstream.cookie.includes('tracking=abc'), 'unrelated cookies must not leak upstream');
    } finally {
      await loader.close();
    }
  });

  await t.test('a csrftoken alone does not make a viewer personalised', async () => {
    // Instagram hands csrftoken to logged-out visitors; treating it as a
    // session would mark anonymous traffic as personalised.
    const loader = await startLoader({ ALLOW_VIEWER_SESSIONS: '1' });
    try {
      const res = await get(loader.base, '/', 'csrftoken=anon-token');
      assert.strictEqual(identity(res.body), 'anonymous');
      assert.strictEqual(res.headers.get('x-loader-personalized'), null);
    } finally {
      await loader.close();
    }
  });
});

test('viewer isolation: a session never reaches asset hosts', async (t) => {
  await t.test('the asset proxy does not forward a viewer session', async () => {
    const loader = await startLoader({ ALLOW_VIEWER_SESSIONS: '1', ALLOWED_ASSET_HOSTS: 'cdn.example' });
    const seen = [];
    // Capture the real fetch first: the loader and the test client must not
    // share the mock, or the client request would be intercepted too.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      seen.push({ url: String(url), cookie: new Headers(options.headers).get('cookie') });
      return new Response('body{}', { status: 200, headers: { 'content-type': 'application/javascript' } });
    };
    try {
      const res = await realFetch(`${loader.base}/__ig/cdn.example/static/app.js`, {
        headers: { cookie: `sessionid=${ALICE}` },
      });
      assert.strictEqual(res.status, 200);
      assert.ok(
        !seen.some((s) => (s.cookie || '').includes(ALICE)),
        "a viewer's Instagram session must never be sent to an asset host",
      );
    } finally {
      globalThis.fetch = realFetch;
      await loader.close();
    }
  });
});

test('viewer isolation: nothing is echoed back to the browser', async (t) => {
  await t.test('the health endpoint reports no session material', async () => {
    const loader = await startLoader({ ALLOW_VIEWER_SESSIONS: '1' });
    try {
      const res = await get(loader.base, '/__loader/health');
      const parsed = JSON.parse(res.body);
      assert.deepStrictEqual(parsed.viewerSessions, { enabled: true });
      assert.strictEqual(parsed.auth, undefined, 'no global session state should be reported');
      assert.ok(!/sessionid/i.test(res.body), 'the health payload must carry no cookie material');
    } finally {
      await loader.close();
    }
  });

  await t.test('an upstream Set-Cookie is stripped before reaching the browser', async () => {
    const fake = await startFakeOrigin();
    const { app } = loadWithEnv(path.join(SRC, 'server.js'), {
      BACKEND_ENABLED: '0',
      UPSTREAM_ORIGIN: fake.origin,
      ALLOW_VIEWER_SESSIONS: '1',
    });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    // The loader's upstream call is mocked; the test client must use the real
    // fetch, otherwise it would be answered by the mock rather than the loader.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('<html><body>ok</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html', 'set-cookie': `sessionid=${ALICE}; Path=/` },
      });
    try {
      const res = await realFetch(`http://127.0.0.1:${server.address().port}/`, {
        headers: { cookie: `sessionid=${ALICE}` },
      });
      assert.strictEqual(res.headers.get('set-cookie'), null, 'no session cookie may reach the browser');
      assert.ok(!(await res.text()).includes(`sessionid=${ALICE}`));
    } finally {
      globalThis.fetch = realFetch;
      await new Promise((resolve) => server.close(resolve));
      await fake.close();
    }
  });
});
