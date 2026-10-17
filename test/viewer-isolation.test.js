'use strict';

/**
 * Viewer isolation regression tests.
 *
 * The loader once injected a single configured `IG_SESSIONID` upstream, and a
 * later revision could relay a visitor's own Instagram cookies. Both are gone,
 * and so is any upstream at serving time: documents and assets come from the
 * pinned client snapshot, so a browser cookie has nowhere to go. These tests
 * pin that down, including when the legacy ALLOW_VIEWER_SESSIONS variable is
 * still set in an old deployment's environment.
 *
 * The snapshot is a test fixture; every upstream attempt is recorded by the
 * upstream guard and refused. Sessions here are synthetic.
 */

const { tempDir } = require('./paths');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { installUpstreamGuard } = require('../scripts/lib/upstream-guard');
const { writeSnapshot, documentAt } = require('./snapshot-fixture');

const SRC = path.join(__dirname, '..', 'src');
const guard = installUpstreamGuard();

const ALICE = 'alice-session-value';
const BOB = 'bob-session-value';
const ASSET_URL = 'https://static.cdninstagram.com/rsrc.php/v4/app.js';

/** Load a fresh copy of a module with the given environment applied. */
function loadWithEnv(modulePath, env) {
  const saved = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(require.cache)) if (key.startsWith(SRC)) delete require.cache[key];
  try {
    return require(modulePath);
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/** Start the loader (no backend) on a fixture snapshot. */
async function startLoader(env) {
  const dir = tempDir('isolation-');
  writeSnapshot(dir, {
    documents: { '/': documentAt('100', { body: '<div id="who">anonymous</div>' }) },
    assets: { [ASSET_URL]: { body: 'console.log("pinned asset");', contentType: 'application/javascript' } },
  });
  const before = guard.attempts.length;
  const { app } = loadWithEnv(path.join(SRC, 'server.js'), { BACKEND_ENABLED: '0', CLIENT_DIR: dir, ...env });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    get upstream() {
      return guard.attempts.slice(before);
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
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

  await t.test('a browser sessionid has nowhere to go: no upstream request is made, even with the legacy flag', async () => {
    const loader = await startLoader(LEGACY);
    try {
      const res = await get(loader.base, '/', `sessionid=${ALICE}; csrftoken=abc; tracking=1`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('x-client-snapshot'), 'rev100-test');
      assert.deepStrictEqual(loader.upstream, []);
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
  await t.test('an asset is served from the snapshot with a browser cookie present, and nothing is fetched', async () => {
    const loader = await startLoader(LEGACY);
    try {
      const res = await fetch(`${loader.base}/__ig/static.cdninstagram.com/rsrc.php/v4/app.js`, { headers: { cookie: `sessionid=${ALICE}` } });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('x-loader-cache'), 'pinned');
      assert.match(await res.text(), /pinned asset/);
      assert.deepStrictEqual(loader.upstream, []);
    } finally {
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

  await t.test('a served document never sets an Instagram session cookie', async () => {
    const loader = await startLoader(LEGACY);
    try {
      const res = await get(loader.base, '/', `sessionid=${BOB}`);
      assert.ok(!res.headers.getSetCookie().some((c) => /sessionid|ds_user_id/.test(c)));
      assert.ok(!res.body.includes(BOB));
    } finally {
      await loader.close();
    }
  });
});
