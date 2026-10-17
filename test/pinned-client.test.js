'use strict';

/**
 * Pinned-only client serving. The server holds no path to Instagram: every
 * document, static asset and bootloader answer comes from the active snapshot
 * (src/pinnedClient.js over src/clientSnapshot.js). These tests prove it with
 * the upstream guard on (any attempt to reach a non-local host is recorded and
 * refused) and cover the snapshot lifecycle the operator commands drive
 * (scripts/client-snapshot.js): validation, verification, activation,
 * rollback, restart.
 *
 * The snapshots are test fixtures (test/snapshot-fixture.js), not Instagram's
 * client; they prove the serving and lifecycle rules.
 */

const { tempDir } = require('./paths');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startCloneServer } = require('./clone-helpers');
const { writeSnapshot, documentAt, answerAt } = require('./snapshot-fixture');
const { openSnapshotStore } = require('../src/clientSnapshot');
const snapshotCli = require('../scripts/client-snapshot');

const ROOT = path.join(__dirname, '..');
const ASSET = 'https://static.cdninstagram.com/rsrc.php/v4/pinned.js';
const ASSET_PATH = '/__ig/static.cdninstagram.com/rsrc.php/v4/pinned.js';


const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

const withAsset = (extra = {}) => ({ assets: { [ASSET]: { body: 'window.__pinned = 1;', contentType: 'application/javascript' } }, ...extra });

test('serving: zero upstream attempts, on hits, misses and errors', async (t) => {
  const s = await startCloneServer({}, { snapshot: withAsset() });
  t.after(() => s.close());

  await t.test('the server never loads the acquisition module', () => {
    assert.ok(!Object.keys(require.cache).some((k) => k.endsWith(path.join('src', 'upstream.js'))), 'src/upstream.js was loaded by the server');
  });

  await t.test('cold then warm: the same pinned bytes, from the snapshot', async () => {
    const cold = await fetch(`${s.base}/`, { headers: { accept: 'text/html' } });
    const warm = await fetch(`${s.base}/`, { headers: { accept: 'text/html' } });
    for (const r of [cold, warm]) {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers.get('x-loader-cache'), 'pinned');
      assert.strictEqual(r.headers.get('x-client-snapshot'), 'rev100-test');
    }
    const [a, b] = [await cold.text(), await warm.text()];
    assert.match(a, /"consistency":\{"rev":100\}/);
    assert.strictEqual(a.replace(/csrf[^"]*"[^"]*"/g, ''), b.replace(/csrf[^"]*"[^"]*"/g, ''));
    const asset = await fetch(`${s.base}${ASSET_PATH}`);
    assert.strictEqual(asset.status, 200);
    assert.strictEqual(await asset.text(), 'window.__pinned = 1;');
    const answer = await fetch(`${s.base}/ajax/bootloader-endpoint/?modules=PolarisFeedRoot.react&__rev=100`);
    assert.strictEqual(answer.status, 200);
    assert.match(await answer.text(), /^for \(;;\);/);
  });

  await t.test('a document miss is an explicit 404 naming the snapshot', async () => {
    const r = await fetch(`${s.base}/explore/`, { headers: { accept: 'text/html' } });
    assert.strictEqual(r.status, 404);
    assert.match(await r.text(), /Not in the pinned client snapshot rev100-test \(revision 100\): document \/explore\//);
  });

  await t.test('an asset miss is an explicit 404', async () => {
    const r = await fetch(`${s.base}/__ig/static.cdninstagram.com/rsrc.php/v4/absent.js`);
    assert.strictEqual(r.status, 404);
    assert.match(await r.text(), /Not in the pinned client snapshot/);
  });

  await t.test('a bootloader miss is an explicit 404; another revision is a 409', async () => {
    const miss = await fetch(`${s.base}/ajax/bootloader-endpoint/?modules=PolarisCreationModal.next.react&__rev=100`);
    assert.strictEqual(miss.status, 404);
    assert.match(await miss.text(), /bootloader answer PolarisCreationModal\.next\.react\|/);
    const other = await fetch(`${s.base}/ajax/bootloader-endpoint/?modules=PolarisFeedRoot.react&__rev=200`);
    assert.strictEqual(other.status, 409);
    assert.match(await other.text(), /pinned client is revision 100/);
  });

  await t.test('a request no local handler answers is refused, not relayed', async () => {
    const r = await fetch(`${s.base}/some/upstream/endpoint/`, { method: 'POST', body: 'x=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.strictEqual(r.status, 404);
  });

  await t.test('every miss is counted in diagnostics', async () => {
    const h = await (await fetch(`${s.base}/__loader/health`)).json();
    assert.strictEqual(h.client.mode, 'pinned');
    assert.strictEqual(h.client.revision, '100');
    const kinds = new Set(h.client.missingRequests.map((m) => m.kind));
    for (const k of ['document', 'asset', 'answer', 'request']) assert.ok(kinds.has(k), `no ${k} miss recorded`);
  });

  await t.test('none of it made an upstream attempt', () => {
    assert.deepStrictEqual(s.upstream, []);
  });
});

test('serving: integrity and compatibility failures are refused, never substituted', async (t) => {
  await t.test('a corrupted blob (hash mismatch) is a 500, not served', async () => {
    const s = await startCloneServer({}, { snapshot: withAsset() });
    try {
      const store = openSnapshotStore(s.clientDir);
      const entry = store.load(store.readState().active).assets[ASSET];
      const file = store.blobPath(entry.sha256);
      fs.chmodSync(file, 0o644);
      fs.writeFileSync(file, 'window.__evil = 1;  '); // same size, other bytes
      const r = await fetch(`${s.base}${ASSET_PATH}`);
      assert.strictEqual(r.status, 500);
      assert.match(await r.text(), /integrity failure/);
      const h = await (await fetch(`${s.base}/__loader/health`)).json();
      assert.strictEqual(h.client.integrityFailures[0].reason, 'hash mismatch');
      assert.deepStrictEqual(s.upstream, []);
    } finally {
      await s.close();
    }
  });

  await t.test('a snapshot carrying an answer of another revision is not served at all', async () => {
    const s = await startCloneServer({}, { snapshot: { answers: { 'PolarisFeedRoot.react|': answerAt('100'), 'Mixed.react|': answerAt('200') } } });
    try {
      const r = await fetch(`${s.base}/`, { headers: { accept: 'text/html' } });
      assert.strictEqual(r.status, 503);
      assert.match(await r.text(), /answer Mixed\.react\|: body declares revision 200, snapshot is 100/);
      assert.deepStrictEqual(s.upstream, []);
    } finally {
      await s.close();
    }
  });

  await t.test('a snapshot with a document of another revision is not served at all', async () => {
    const s = await startCloneServer({}, { snapshot: { documents: { '/': documentAt('100'), '/accounts/emailsignup/': documentAt('99') } } });
    try {
      const r = await fetch(`${s.base}/`, { headers: { accept: 'text/html' } });
      assert.strictEqual(r.status, 503);
      assert.match(await r.text(), /document \/accounts\/emailsignup\/: revision 99 != 100/);
      assert.deepStrictEqual(s.upstream, []);
    } finally {
      await s.close();
    }
  });

  await t.test('with no snapshot at all, startup succeeds and every client request is a 503', async () => {
    const s = await startCloneServer({}, { snapshot: null });
    try {
      for (const p of ['/', ASSET_PATH, '/ajax/bootloader-endpoint/?modules=X']) {
        const r = await fetch(`${s.base}${p}`, { headers: { accept: 'text/html' } });
        assert.strictEqual(r.status, 503, p);
        assert.match(await r.text(), /Pinned client unavailable: no active client snapshot/);
      }
      const h = await (await fetch(`${s.base}/__loader/health`)).json();
      assert.strictEqual(h.ok, false);
      assert.match(h.client.error, /no active client snapshot/);
      assert.deepStrictEqual(s.upstream, []);
    } finally {
      await s.close();
    }
  });
});

test('serving: restart keeps the activated snapshot', async () => {
  const dir = tempDir('restart-');
  try {
    const first = await startCloneServer({}, { dir, keepDir: true, snapshot: withAsset() });
    const a = await (await fetch(`${first.base}/__loader/health`)).json();
    await first.close();
    const second = await startCloneServer({}, { dir, keepDir: true, snapshot: withAsset({ id: 'would-replace', revision: '300' }) });
    const b = await (await fetch(`${second.base}/__loader/health`)).json();
    const doc = await fetch(`${second.base}/`, { headers: { accept: 'text/html' } });
    assert.strictEqual(doc.status, 200);
    await second.close();
    assert.strictEqual(a.client.snapshot, 'rev100-test');
    assert.strictEqual(b.client.snapshot, 'rev100-test', 'the restart served the same snapshot; nothing replaced it');
    assert.deepStrictEqual([...first.upstream, ...second.upstream], []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('serving: no timer or background task is started by the client path', async () => {
  const created = [];
  const real = { setTimeout: global.setTimeout, setInterval: global.setInterval };
  const CLIENT_FILES = /src[\\/](server|pinnedClient|clientSnapshot|upstream|rewrite)\.js|src[\\/]shell[\\/]/;
  for (const name of ['setTimeout', 'setInterval']) {
    global[name] = function (fn, ms, ...rest) {
      const stack = new Error().stack.split('\n').slice(2).join('\n');
      if (CLIENT_FILES.test(stack)) created.push({ name, ms, stack: stack.split('\n')[0] });
      return real[name].call(this, fn, ms, ...rest);
    };
  }
  let s;
  try {
    s = await startCloneServer({}, { snapshot: withAsset() });
    await fetch(`${s.base}/`, { headers: { accept: 'text/html' } });
    await fetch(`${s.base}/explore/`, { headers: { accept: 'text/html' } });
    await fetch(`${s.base}${ASSET_PATH}`);
    await fetch(`${s.base}/__ig/static.cdninstagram.com/rsrc.php/v4/absent.js`);
    await fetch(`${s.base}/ajax/bootloader-endpoint/?modules=Absent.react`);
  } finally {
    Object.assign(global, real);
  }
  await new Promise((r) => setTimeout(r, 50));
  const upstream = s.upstream;
  await s.close();
  assert.deepStrictEqual(created, [], 'a client-path timer was created');
  assert.deepStrictEqual(upstream, []);
});

test('lifecycle: validate, verify, activate, rollback', async (t) => {
  await t.test('validation rejects malformed, escaping, mixed and corrupted manifests', () => {
    const dir = tempDir('validate-');
    try {
      const store = openSnapshotStore(dir);
      const good = writeSnapshot(dir, { activate: false, status: 'candidate', ...withAsset() });
      assert.ok(store.validate(good, { deep: true, requiredRoutes: ['home'] }).ok);
      assert.throws(() => store.load('../escape'), /invalid snapshot id/);
      assert.throws(() => store.blobPath('../../etc/passwd'), /invalid sha256/);
      const bad = JSON.parse(JSON.stringify(good));
      bad.assets['https://evil.example/x.js'] = bad.assets[ASSET];
      bad.answers['Other.react|'] = { ...bad.answers['PolarisFeedRoot.react|'], revision: '99' };
      bad.documents['/x/'] = { ...bad.documents['/'], sha256: '0'.repeat(64) };
      bad.documents['/images/a.png?__d=www'] = { ...bad.assets[ASSET], contentType: 'image/png' };
      const errors = store.validate(bad).errors.join('\n');
      assert.match(errors, /evil\.example.*not a public static URL/);
      assert.match(errors, /answer Other\.react\|: revision 99 != 100/);
      assert.match(errors, /document \/x\/: blob 000000000000 missing/);
      assert.match(errors, /document key \/images\/a\.png\?__d=www has a query/);
      const noHome = JSON.parse(JSON.stringify(good));
      noHome.routes.home.supported = false;
      assert.match(store.validate(noHome, { requiredRoutes: ['home'] }).errors.join(), /required route home/);
      const file = store.blobPath(good.assets[ASSET].sha256);
      fs.writeFileSync(file, 'window.__evil = 1;  ');
      assert.ok(store.validate(good).ok, 'a shallow check sees only sizes');
      assert.match(store.validate(good, { deep: true }).errors.join(), /hash mismatch/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('a candidate that fails verification cannot replace the active snapshot', () => {
    const dir = tempDir('lifecycle-');
    try {
      const store = openSnapshotStore(dir);
      writeSnapshot(dir, { id: 'known-good' });
      const cand = writeSnapshot(dir, { id: 'cand-bad', revision: '101', activate: false, status: 'candidate' });
      const ran = [];
      const failing = (id, checks) => checks.map((c) => (ran.push(c), { check: c, ok: c !== 'feed', result: 'fixture' }));
      assert.strictEqual(quiet(() => snapshotCli.verify(cand.id, { browser: true, dir, runChecks: failing })), false);
      assert.strictEqual(store.load('cand-bad').status, 'candidate');
      assert.deepStrictEqual(ran, snapshotCli.CORE_CHECKS, 'scope checks are not run once a core check fails');
      assert.throws(() => snapshotCli.activate('cand-bad', { dir }), /only a verified snapshot can be activated/);
      assert.strictEqual(store.readState().active, 'known-good');
      // Integrity alone is not verification either.
      assert.strictEqual(quiet(() => snapshotCli.verify(cand.id, { browser: false, dir })), false);
      assert.throws(() => snapshotCli.activate('cand-bad', { dir }));
      // A corrupted candidate fails integrity before any browser check.
      const corrupt = writeSnapshot(dir, { id: 'cand-corrupt', revision: '102', activate: false, status: 'candidate', ...withAsset() });
      fs.writeFileSync(store.blobPath(corrupt.assets[ASSET].sha256), 'window.__evil = 1;  ');
      ran.length = 0;
      assert.strictEqual(quiet(() => snapshotCli.verify('cand-corrupt', { browser: true, dir, runChecks: failing })), false);
      assert.deepStrictEqual(ran, []);
      assert.strictEqual(store.readState().active, 'known-good');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('a verified candidate activates, keeps the previous for rollback, and rolls back', async () => {
    const dir = tempDir('activate-');
    try {
      const store = openSnapshotStore(dir);
      writeSnapshot(dir, { id: 'known-good' });
      writeSnapshot(dir, { id: 'cand-good', revision: '101', activate: false, status: 'candidate' });
      const passing = (id, checks) => checks.map((c) => ({ check: c, ok: c !== 'create', result: 'fixture' }));
      assert.strictEqual(quiet(() => snapshotCli.verify('cand-good', { browser: true, dir, runChecks: passing })), true);
      const verified = store.load('cand-good');
      assert.strictEqual(verified.status, 'verified');
      assert.deepStrictEqual(verified.scope.failing, ['create'], 'a failing scope check is recorded');
      assert.deepStrictEqual(verified.scope.unsupported, ['profile'], 'an unsupported route is recorded, not checked');
      assert.strictEqual(verified.scope.complete, false, 'a partial snapshot is not called complete');

      let state = snapshotCli.activate('cand-good', { dir });
      assert.strictEqual(state.active, 'cand-good');
      assert.deepStrictEqual(state.history, ['known-good']);
      assert.strictEqual(store.load('known-good').status, 'retired');

      state = snapshotCli.rollback({ dir });
      assert.strictEqual(state.active, 'known-good');
      assert.strictEqual(store.load('known-good').status, 'active');
      assert.strictEqual(store.load('cand-good').status, 'retired');
      assert.deepStrictEqual(state.history, ['cand-good']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('re-checking the active snapshot records results without changing what is active', () => {
    const dir = tempDir('recheck-');
    try {
      const store = openSnapshotStore(dir);
      writeSnapshot(dir, { id: 'live-one' });
      const checks = (ok) => (id, names) => names.map((c) => ({ check: c, ok: ok(c), result: 'fixture' }));
      assert.strictEqual(quiet(() => snapshotCli.verify('live-one', { browser: true, dir, runChecks: checks((c) => c !== 'feed') })), false);
      assert.strictEqual(store.load('live-one').status, 'active', 'a failing re-check does not silently deactivate');
      assert.strictEqual(store.load('live-one').validation.at(-1).ok, false, 'the failure is recorded');
      assert.strictEqual(quiet(() => snapshotCli.verify('live-one', { browser: true, dir, runChecks: checks(() => true) })), true);
      assert.strictEqual(store.load('live-one').status, 'active');
      assert.strictEqual(store.readState().active, 'live-one');
      writeSnapshot(dir, { id: 'next', revision: '101' });
      assert.throws(() => snapshotCli.verify('live-one', { browser: false, dir }), /retired/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('rollback refuses a previous snapshot that no longer validates', () => {
    const dir = tempDir('rollback-');
    try {
      const store = openSnapshotStore(dir);
      const old = writeSnapshot(dir, { id: 'old', ...withAsset() });
      writeSnapshot(dir, { id: 'new', revision: '101' });
      fs.writeFileSync(store.blobPath(old.assets[ASSET].sha256), 'window.__evil = 1;  ');
      assert.throws(() => snapshotCli.rollback({ dir }), /no previous verified snapshot/);
      assert.strictEqual(store.readState().active, 'new');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
