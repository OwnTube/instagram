'use strict';

/**
 * Viewer isolation regression tests.
 *
 * The loader once injected a single configured `IG_SESSIONID` upstream, and a
 * later revision could relay a visitor's own Instagram cookies. Both are gone:
 * cookies on this origin are clone sessions and must never reach Instagram.
 * These tests pin that down, including when the legacy ALLOW_VIEWER_SESSIONS
 * variable is still set in an old deployment's environment.
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

const LEGACY = { ALLOW_VIEWER_SESSIONS: '1' };

test('viewer isolation: no Instagram session exists or is relayed', async (t) => {
  await t.test('the global-session and relay mechanisms are gone from config', () => {
    const config = loadWithEnv(path.join(SRC, 'config.js'), LEGACY);
    assert.strictEqual(config.allowViewerSessions, undefined);
    assert.strictEqual(config.authMode, undefined);
    assert.strictEqual(config.sessionCookie, undefined);
  });

  await t.test('two independent viewers receive byte-identical documents', async () => {
    const loader = await startLoader(LEGACY);
    try {
      const a = await get(loader.base, '/', `sessionid=${ALICE}; ds_user_id=111`);
      const b = await get(loader.base, '/', `sessionid=${BOB}; ds_user_id=222`);
      assert.strictEqual(a.body, b.body, 'the upstream document must not vary by viewer');
      assert.strictEqual(identity(a.body), 'anonymous');
    } finally {
      await loader.close();
    }
  });

  await t.test('a browser sessionid is never forwarded upstream, even with the legacy flag', async () => {
    const loader = await startLoader(LEGACY);
    try {
      await get(loader.base, '/', `sessionid=${ALICE}; csrftoken=abc; tracking=1`);
      for (const r of loader.received) {
        assert.ok(!(r.cookie || '').includes(ALICE), 'a browser session must never reach the origin');
        assert.ok(!(r.cookie || '').includes('tracking=1'), 'no browser cookie may reach the origin');
      }
    } finally {
      await loader.close();
    }
  });

  await t.test("viewer A's cookie never appears in viewer B's response", async () => {
    const loader = await startLoader(LEGACY);
    try {
      await get(loader.base, '/', `sessionid=${ALICE}`);
      const bob = await get(loader.base, '/', `sessionid=${BOB}`);
      assert.ok(!bob.body.includes(ALICE));
    } finally {
      await loader.close();
    }
  });
});

test('viewer isolation: a session never reaches asset hosts', async (t) => {
  await t.test('the asset proxy does not forward a browser cookie', async () => {
    const loader = await startLoader({ ...LEGACY, ALLOWED_ASSET_HOSTS: 'cdn.example' });
    const seen = [];
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
      assert.ok(!seen.some((s) => (s.cookie || '').includes(ALICE)));
    } finally {
      globalThis.fetch = realFetch;
      await loader.close();
    }
  });
});

test('viewer isolation: nothing is echoed back to the browser', async (t) => {
  await t.test('the health endpoint reports no session material', async () => {
    const loader = await startLoader(LEGACY);
    try {
      const res = await get(loader.base, '/__loader/health', `sessionid=${ALICE}`);
      const parsed = JSON.parse(res.body);
      assert.deepStrictEqual(parsed.instagramSessions, { relayed: false, configured: false });
      assert.ok(!res.body.includes(ALICE));
    } finally {
      await loader.close();
    }
  });

  await t.test('an upstream Set-Cookie can never overwrite clone cookies', async () => {
    const fake = await startFakeOrigin();
    const { app } = loadWithEnv(path.join(SRC, 'server.js'), {
      BACKEND_ENABLED: '0',
      UPSTREAM_ORIGIN: fake.origin,
      ...LEGACY,
    });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('<html><body>ok</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html', 'set-cookie': `sessionid=${ALICE}; Path=/` },
      });
    try {
      const res = await realFetch(`http://127.0.0.1:${server.address().port}/`, {
        headers: { cookie: `sessionid=${BOB}` },
      });
      const setCookies = res.headers.getSetCookie();
      assert.ok(!setCookies.some((c) => c.includes(ALICE)), 'an upstream cookie must never reach the browser');
      assert.ok(!(await res.text()).includes(`sessionid=${ALICE}`));
    } finally {
      globalThis.fetch = realFetch;
      await new Promise((resolve) => server.close(resolve));
      await fake.close();
    }
  });
});
