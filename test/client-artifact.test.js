'use strict';

/**
 * The pinned client artifact (scripts/lib/client-artifact.js and the fetch /
 * pack commands of scripts/client-bundle.js): a fresh checkout without
 * client/blobs/ gets exactly the pinned bodies from one file whose sha256 is
 * committed, verified record by record, installed by a rename only after
 * everything checks, and never at the expense of a valid installation.
 */

const { tempDir } = require('./paths');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const { writeSnapshot } = require('./snapshot-fixture');
const { openSnapshotStore, sha256 } = require('../src/clientSnapshot');
const { setup, exportBundle, readBundle, pack, fetchBlobs, BundleError } = require('../scripts/client-bundle');
const { checkUrl, ArtifactError } = require('../scripts/lib/client-artifact');

const quiet = () => {};

function workdir(t) {
  const dir = tempDir('artifact-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = { dir, source: path.join(dir, 'source'), bundle: path.join(dir, 'bundle'), client: path.join(dir, 'client') };
  writeSnapshot(w.source, {
    id: 'rev300-c',
    revision: '300',
    assets: {
      'https://static.cdninstagram.com/c.js': { body: 'console.log("c")', contentType: 'application/x-javascript' },
      'https://static.cdninstagram.com/d.css': { body: 'body{}', contentType: 'text/css' },
    },
  });
  exportBundle({ clientDir: w.source, outDir: w.bundle, log: quiet });
  return w;
}

const descriptorOf = (w) => JSON.parse(fs.readFileSync(path.join(w.bundle, 'bundle.json'), 'utf8'));
const blobsDir = (w) => path.join(w.bundle, 'blobs');
const listBlobs = (dir) => fs.readdirSync(dir).flatMap((p) => fs.readdirSync(path.join(dir, p))).sort();

/** Pack, then move the blobs out of the bundle as a fresh checkout has none. Returns the artifact file. */
async function packed(w) {
  const r = await pack({ bundleDir: w.bundle, log: quiet });
  fs.renameSync(blobsDir(w), path.join(w.dir, 'original-blobs'));
  return r.file;
}

/** A local HTTP server for one file (the checks' stand-in for a release host). */
async function serve(t, file, { mutate = (b) => b } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url !== `/${path.basename(file)}`) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/gzip' }).end(mutate(fs.readFileSync(file)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/${path.basename(file)}`, hits };
}

const rejectsBundle = (p, pattern) => assert.rejects(p, (e) => e instanceof BundleError && pattern.test(e.message));

test('packing is deterministic and pins the artifact in bundle.json', async (t) => {
  const w = workdir(t);
  const a = await pack({ bundleDir: w.bundle, log: quiet });
  const b = await pack({ bundleDir: w.bundle, outFile: path.join(w.dir, 'again.igrl.gz'), log: quiet });
  assert.strictEqual(a.sha256, b.sha256);
  assert.ok(fs.readFileSync(a.file).equals(fs.readFileSync(b.file)));
  const d = descriptorOf(w);
  assert.deepStrictEqual(d.artifact, { name: 'client-rev300-c.igrl.gz', bytes: a.bytes, sha256: a.sha256, urls: [] });
  // The pin does not disturb the bundle's own validation.
  assert.strictEqual(readBundle(w.bundle).descriptor.snapshot, 'rev300-c');
});

test('a checkout without blobs downloads the pinned artifact, verifies it and installs it', async (t) => {
  const w = workdir(t);
  const file = await packed(w);
  const host = await serve(t, file);
  const r = await fetchBlobs({ bundleDir: w.bundle, source: host.url, log: quiet });
  assert.strictEqual(r.installed, true);
  assert.deepStrictEqual(r.hosts, ['127.0.0.1']);
  assert.deepStrictEqual(listBlobs(blobsDir(w)), listBlobs(path.join(w.dir, 'original-blobs')));
  assert.deepStrictEqual(fs.readdirSync(w.bundle).filter((n) => n.startsWith('.staging-')), [], 'staging is removed');
  // Setup then installs into the snapshot store as before.
  const s = setup({ bundleDir: w.bundle, clientDir: w.client, log: quiet });
  assert.strictEqual(s.active, 'rev300-c');
  const store = openSnapshotStore(w.client);
  assert.ok(store.validate(store.load('rev300-c'), { deep: true }).ok);
});

test('the URLs pinned in bundle.json are the default source', async (t) => {
  const w = workdir(t);
  const file = await packed(w);
  const host = await serve(t, file);
  const d = descriptorOf(w);
  d.artifact.urls = [host.url.replace(/[^/]+$/, 'missing.igrl.gz'), host.url];
  fs.writeFileSync(path.join(w.bundle, 'bundle.json'), JSON.stringify(d));
  const r = await fetchBlobs({ bundleDir: w.bundle, log: quiet });
  assert.strictEqual(r.installed, true);
  assert.strictEqual(host.hits.length, 2, 'the first (404) URL, then the second');
});

test('a corrupt or truncated artifact is rejected and installs nothing', async (t) => {
  const w = workdir(t);
  const file = await packed(w);
  const flipped = await serve(t, file, {
    mutate: (b) => {
      const c = Buffer.from(b);
      c[c.length >> 1] ^= 0xff;
      return c;
    },
  });
  await rejectsBundle(fetchBlobs({ bundleDir: w.bundle, source: flipped.url, log: quiet }), /does not match the pinned/);
  const truncated = await serve(t, file, { mutate: (b) => b.subarray(0, b.length - 10) });
  await rejectsBundle(fetchBlobs({ bundleDir: w.bundle, source: truncated.url, log: quiet }), /truncated/);
  const longer = await serve(t, file, { mutate: (b) => Buffer.concat([b, Buffer.from('x')]) });
  await rejectsBundle(fetchBlobs({ bundleDir: w.bundle, source: longer.url, log: quiet }), /larger than the pinned/);
  assert.ok(!fs.existsSync(blobsDir(w)), 'no blobs/ was created');
  assert.deepStrictEqual(fs.readdirSync(w.bundle).filter((n) => n.startsWith('.staging-')), []);
});

/** gzip of an artifact built by hand, for contents the packer would never write. */
function forge(w, records, headerPatch = {}) {
  const d = descriptorOf(w);
  const header = { format: 'igrl-client-artifact', version: 1, snapshot: d.snapshot, revision: d.revision, manifestSha256: d.manifestSha256, blobs: d.blobs, bytes: d.bytes, contentsSha256: d.contentsSha256, ...headerPatch };
  const parts = [Buffer.from(`${JSON.stringify(header)}\n`)];
  for (const [kind, hash, body] of records) parts.push(Buffer.from(`${kind} ${hash} ${body.length}\n`), body);
  const gz = zlib.gzipSync(Buffer.concat(parts));
  const file = path.join(w.dir, `forged-${sha256(gz).slice(0, 8)}.igrl.gz`);
  fs.writeFileSync(file, gz);
  d.artifact = { name: path.basename(file), bytes: gz.length, sha256: sha256(gz), urls: [] };
  fs.writeFileSync(path.join(w.bundle, 'bundle.json'), JSON.stringify(d));
  return file;
}

test('an artifact matching its pin is still checked record by record against the committed manifest', async (t) => {
  const w = workdir(t);
  await packed(w);
  const original = path.join(w.dir, 'original-blobs');
  const d = descriptorOf(w);
  const manifest = fs.readFileSync(openSnapshotStore(w.bundle).manifestPath(d.snapshot));
  const blobs = listBlobs(original).map((h) => [h, fs.readFileSync(path.join(original, h.slice(0, 2), h))]);
  const good = blobs.map(([h, b]) => ['blob', h, b]);
  const cases = [
    [[['manifest', d.manifestSha256, manifest], ...good.slice(1)], /lacks 1 of the manifest's blobs/],
    [[['manifest', d.manifestSha256, manifest], ...good, ['blob', sha256(Buffer.from('extra')), Buffer.from('extra')]], /does not reference/],
    [[['manifest', d.manifestSha256, manifest], good[0], ...good], /repeats blob/],
    [[['manifest', d.manifestSha256, manifest], ['blob', good[0][1], Buffer.from('tampered')], ...good.slice(1)], /does not hash to its name/],
    [[['manifest', sha256(Buffer.from('{}')), Buffer.from('{}')], ...good], /not the committed manifest/],
    [good, /no manifest record/],
  ];
  for (const [records, pattern] of cases) {
    const file = forge(w, records);
    await rejectsBundle(fetchBlobs({ bundleDir: w.bundle, source: file, log: quiet }), pattern);
    assert.ok(!fs.existsSync(blobsDir(w)));
  }
  const other = forge(w, [['manifest', d.manifestSha256, manifest], ...good], { revision: '301' });
  await rejectsBundle(fetchBlobs({ bundleDir: w.bundle, source: other, log: quiet }), /artifact is for revision 301/);
  const garbage = path.join(w.dir, 'garbage.igrl.gz');
  fs.writeFileSync(garbage, 'not gzip at all');
  const dd = descriptorOf(w);
  dd.artifact = { name: 'garbage.igrl.gz', bytes: 15, sha256: sha256(Buffer.from('not gzip at all')), urls: [] };
  fs.writeFileSync(path.join(w.bundle, 'bundle.json'), JSON.stringify(dd));
  await rejectsBundle(fetchBlobs({ bundleDir: w.bundle, source: garbage, log: quiet }), /not a readable client artifact/);
});

test('a valid installation is kept: a valid blobs/ is not re-fetched, an invalid one is replaced only on request', async (t) => {
  const w = workdir(t);
  const file = await packed(w);
  fs.cpSync(path.join(w.dir, 'original-blobs'), blobsDir(w), { recursive: true });
  const before = listBlobs(blobsDir(w));
  let calls = 0;
  const spy = async () => {
    calls += 1;
    throw new Error('must not be called');
  };
  const r = await fetchBlobs({ bundleDir: w.bundle, source: 'https://example.invalid/x.igrl.gz', fetchImpl: spy, log: quiet });
  assert.deepStrictEqual([r.installed, calls], [false, 0]);
  assert.deepStrictEqual(listBlobs(blobsDir(w)), before);

  // Damage one blob: without --replace nothing happens.
  const victim = path.join(blobsDir(w), before[0].slice(0, 2), before[0]);
  fs.writeFileSync(victim, 'damaged');
  await rejectsBundle(fetchBlobs({ bundleDir: w.bundle, source: file, log: quiet }), /fails integrity.*--replace/);
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'damaged');
  // --replace with a corrupt artifact: the existing directory is untouched.
  const bad = await serve(t, file, { mutate: (b) => b.subarray(1) });
  await rejectsBundle(fetchBlobs({ bundleDir: w.bundle, source: bad.url, replace: true, log: quiet }), /truncated/);
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'damaged');
  // --replace with the pinned artifact: the invalid directory is moved aside, not deleted.
  const ok = await fetchBlobs({ bundleDir: w.bundle, source: file, replace: true, log: quiet });
  assert.strictEqual(ok.installed, true);
  assert.ok(readBundle(w.bundle));
  const aside = fs.readdirSync(w.bundle).filter((n) => n.startsWith('blobs.invalid-'));
  assert.strictEqual(aside.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(w.bundle, aside[0], before[0].slice(0, 2), before[0]), 'utf8'), 'damaged');
});

test('setup never fetches from Instagram or Meta, and needs a pin and a source', async (t) => {
  for (const url of ['https://www.instagram.com/x', 'https://static.cdninstagram.com/x', 'https://scontent.xx.fbcdn.net/x', 'https://facebook.com/x', 'http://meta.com/x']) {
    assert.throws(() => checkUrl(url), (e) => e instanceof ArtifactError && /never contacts Instagram/.test(e.message), url);
  }
  assert.throws(() => checkUrl('file:///etc/passwd'), /unsupported artifact URL scheme/);
  const w = workdir(t);
  await packed(w);
  let calls = 0;
  const spy = async () => {
    calls += 1;
    throw new Error('must not be called');
  };
  await rejectsBundle(fetchBlobs({ bundleDir: w.bundle, source: 'https://www.instagram.com/client.igrl.gz', fetchImpl: spy, log: quiet }), /never contacts Instagram/);
  assert.strictEqual(calls, 0);
  // A redirect onto a Meta host is refused too.
  const redirected = async () => ({ ok: true, url: 'https://scontent.cdninstagram.com/x', status: 200, body: null });
  await rejectsBundle(fetchBlobs({ bundleDir: w.bundle, source: 'https://example.test/x.igrl.gz', fetchImpl: redirected, log: quiet }), /never contacts Instagram/);
  // No sources configured.
  await rejectsBundle(fetchBlobs({ bundleDir: w.bundle, log: quiet }), /artifact\.urls is empty/);
  // No pin at all.
  const d = descriptorOf(w);
  delete d.artifact;
  fs.writeFileSync(path.join(w.bundle, 'bundle.json'), JSON.stringify(d));
  await rejectsBundle(fetchBlobs({ bundleDir: w.bundle, source: 'https://example.test/x', log: quiet }), /pins no client artifact/);
});
