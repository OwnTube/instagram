'use strict';

/**
 * The packaged pinned client (scripts/client-bundle.js): export one snapshot
 * to a bundle, install it offline, idempotently, keeping a valid local
 * snapshot, and refusing a missing or altered bundle with a clear message.
 */

const { tempDir } = require('./paths');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { writeSnapshot } = require('./snapshot-fixture');
const { openSnapshotStore, sha256 } = require('../src/clientSnapshot');
const { setup, exportBundle, readBundle, BundleError } = require('../scripts/client-bundle');

const quiet = () => {};

function workdir() {
  const dir = tempDir('bundle-');
  return { dir, source: path.join(dir, 'source'), bundle: path.join(dir, 'bundle'), client: path.join(dir, 'client'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A source store with two snapshots (revision 100 retired, 200 active) and an unrelated blob. */
function sourceStore(dir) {
  writeSnapshot(dir, { id: 'rev100-a', revision: '100', assets: { 'https://static.cdninstagram.com/a.js': { body: 'old', contentType: 'application/x-javascript' } } });
  writeSnapshot(dir, { id: 'rev200-b', revision: '200', assets: { 'https://static.cdninstagram.com/b.js': { body: 'new', contentType: 'application/x-javascript' } } });
  openSnapshotStore(dir).putBlob({ body: Buffer.from('unrelated') });
}

const throwsBundle = (fn, pattern) => assert.throws(fn, (e) => e instanceof BundleError && pattern.test(e.message));

test('export writes exactly the active snapshot: its manifest byte for byte and its blobs', (t) => {
  const w = workdir();
  t.after(w.cleanup);
  sourceStore(w.source);
  const d = exportBundle({ clientDir: w.source, outDir: w.bundle, log: quiet });
  assert.strictEqual(d.snapshot, 'rev200-b');
  assert.deepStrictEqual(fs.readdirSync(path.join(w.bundle, 'snapshots')), ['rev200-b']);
  const src = openSnapshotStore(w.source);
  assert.strictEqual(sha256(fs.readFileSync(path.join(w.bundle, 'snapshots', 'rev200-b', 'manifest.json'))), sha256(fs.readFileSync(src.manifestPath('rev200-b'))));
  const blobs = fs.readdirSync(path.join(w.bundle, 'blobs')).flatMap((p) => fs.readdirSync(path.join(w.bundle, 'blobs', p)));
  assert.strictEqual(blobs.length, d.blobs);
  assert.ok(!blobs.includes(sha256(Buffer.from('unrelated'))) && !blobs.includes(sha256(Buffer.from('old'))));
  assert.ok(!fs.existsSync(path.join(w.bundle, 'state.json')));
  // Re-exporting another snapshot replaces the bundle.
  exportBundle({ id: 'rev100-a', clientDir: w.source, outDir: w.bundle, log: quiet });
  assert.deepStrictEqual(fs.readdirSync(path.join(w.bundle, 'snapshots')), ['rev100-a']);
  assert.strictEqual(readBundle(w.bundle).descriptor.snapshot, 'rev100-a');
});

test('setup installs into an empty store and activates; repeating it changes nothing', (t) => {
  const w = workdir();
  t.after(w.cleanup);
  sourceStore(w.source);
  exportBundle({ clientDir: w.source, outDir: w.bundle, log: quiet });
  const first = setup({ bundleDir: w.bundle, clientDir: w.client, log: quiet });
  assert.deepStrictEqual([first.active, first.outcome], ['rev200-b', 'activated']);
  const store = openSnapshotStore(w.client);
  assert.strictEqual(store.load('rev200-b').status, 'active');
  assert.ok(store.validate(store.load('rev200-b'), { deep: true }).ok);
  const before = fs.readFileSync(store.manifestPath('rev200-b'), 'utf8');
  const again = setup({ bundleDir: w.bundle, clientDir: w.client, log: quiet });
  assert.deepStrictEqual([again.active, again.written, again.outcome], ['rev200-b', 0, 'already active']);
  assert.strictEqual(fs.readFileSync(store.manifestPath('rev200-b'), 'utf8'), before);
});

test('a valid local snapshot stays active unless --activate; then the old one is kept for rollback', (t) => {
  const w = workdir();
  t.after(w.cleanup);
  sourceStore(w.source);
  writeSnapshot(w.client, { id: 'rev150-local', revision: '150' });
  exportBundle({ clientDir: w.source, outDir: w.bundle, log: quiet });
  const kept = setup({ bundleDir: w.bundle, clientDir: w.client, log: quiet });
  assert.strictEqual(kept.active, 'rev150-local');
  assert.match(kept.outcome, /^kept/);
  const store = openSnapshotStore(w.client);
  assert.strictEqual(store.load('rev200-b').status, 'verified');
  const switched = setup({ bundleDir: w.bundle, clientDir: w.client, activate: true, log: quiet });
  assert.strictEqual(switched.active, 'rev200-b');
  assert.deepStrictEqual(store.readState().history, ['rev150-local']);
  require('../scripts/client-snapshot').rollback({ dir: w.client });
  assert.strictEqual(store.readState().active, 'rev150-local');
});

test('an invalid local active snapshot is replaced by the bundled one', (t) => {
  const w = workdir();
  t.after(w.cleanup);
  sourceStore(w.source);
  const local = writeSnapshot(w.client, { id: 'rev150-local', revision: '150' });
  fs.rmSync(openSnapshotStore(w.client).blobPath(local.documents['/'].sha256));
  exportBundle({ clientDir: w.source, outDir: w.bundle, log: quiet });
  const r = setup({ bundleDir: w.bundle, clientDir: w.client, log: quiet });
  assert.strictEqual(r.active, 'rev200-b');
  assert.match(r.outcome, /failed integrity/);
});

test('a missing or altered bundle fails with an actionable message and installs nothing', (t) => {
  const w = workdir();
  t.after(w.cleanup);
  sourceStore(w.source);
  throwsBundle(() => setup({ bundleDir: w.bundle, clientDir: w.client, log: quiet }), /no client bundle: .*bundle\.json does not exist/);

  const d = exportBundle({ clientDir: w.source, outDir: w.bundle, log: quiet });
  fs.renameSync(path.join(w.bundle, 'blobs'), path.join(w.dir, 'blobs-aside'));
  throwsBundle(() => setup({ bundleDir: w.bundle, clientDir: w.client, log: quiet }), /blobs\/ is absent: .*manifest but not its bodies.*pinned client artifact/);
  fs.renameSync(path.join(w.dir, 'blobs-aside'), path.join(w.bundle, 'blobs'));
  const store = openSnapshotStore(w.bundle);
  const m = store.load(d.snapshot);
  const blob = store.blobPath(m.assets['https://static.cdninstagram.com/b.js'].sha256);

  fs.writeFileSync(blob, 'NEW'); // same size, different bytes
  throwsBundle(() => setup({ bundleDir: w.bundle, clientDir: w.client, log: quiet }), /failed integrity: asset .*hash mismatch.*client:fetch -- --replace/);
  fs.rmSync(blob);
  throwsBundle(() => setup({ bundleDir: w.bundle, clientDir: w.client, log: quiet }), /failed integrity: asset .*missing/);
  fs.writeFileSync(blob, 'new');

  const manifestFile = store.manifestPath(d.snapshot);
  const raw = fs.readFileSync(manifestFile, 'utf8');
  fs.writeFileSync(manifestFile, raw.replace('"revision": "200"', '"revision": "201"'));
  throwsBundle(() => setup({ bundleDir: w.bundle, clientDir: w.client, log: quiet }), /manifest of rev200-b does not match bundle\.json/);
  fs.writeFileSync(manifestFile, raw);

  fs.writeFileSync(path.join(w.bundle, 'bundle.json'), '{');
  throwsBundle(() => setup({ bundleDir: w.bundle, clientDir: w.client, log: quiet }), /bundle\.json is not valid JSON/);
  assert.ok(!fs.existsSync(path.join(w.client, 'state.json')), 'nothing was activated');
});

test('a local snapshot of the same id with other contents is not overwritten', (t) => {
  const w = workdir();
  t.after(w.cleanup);
  sourceStore(w.source);
  writeSnapshot(w.client, { id: 'rev200-b', revision: '200', assets: { 'https://static.cdninstagram.com/b.js': { body: 'different', contentType: 'application/x-javascript' } } });
  exportBundle({ clientDir: w.source, outDir: w.bundle, log: quiet });
  throwsBundle(() => setup({ bundleDir: w.bundle, clientDir: w.client, log: quiet }), /already holds a snapshot named rev200-b with different contents/);
});
