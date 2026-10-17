'use strict';

/**
 * The packaged pinned client (client/): one verified snapshot, its manifest and
 * every blob it references, in the snapshot store's own layout, so a fresh
 * checkout serves the same client without contacting Instagram.
 *
 *   node scripts/client-bundle.js setup [--activate] [--bundle DIR]
 *       Install the bundle into CLIENT_DIR (default .cache/client). Offline:
 *       nothing is fetched, and any network attempt fails the command. Every
 *       blob is re-hashed against the manifest and the manifest against
 *       client/bundle.json. With no valid active snapshot locally the bundled
 *       one is activated; an existing valid active snapshot is kept unless
 *       --activate is given (it then goes to history, for rollback).
 *       Repeating it changes nothing.
 *
 *   node scripts/client-bundle.js export [<snapshot id>] [--out DIR]
 *       Write CLIENT_DIR's active (or the named, verified) snapshot to client/,
 *       replacing the previous bundle. Only that manifest and its blobs go in:
 *       no other snapshot, no legacy store, no database or account data.
 *
 *   node scripts/client-bundle.js check [--bundle DIR]
 *       Validate the bundle without installing it.
 *
 *   node scripts/client-bundle.js fetch [--artifact URL|FILE] [--replace]
 *       (setup runs this itself when client/blobs/ is absent.) Get the pinned
 *       client artifact (bundle.json `artifact`: name, bytes, sha256, urls),
 *       check its sha256, unpack it into a staging directory, check every blob
 *       against the committed manifest, then rename the staging blobs into
 *       client/blobs/. Source: --artifact, else CLIENT_ARTIFACT, else
 *       bundle.json artifact.urls in order. Only that host is contacted;
 *       Instagram/Meta hosts are refused. A valid client/blobs/ is never
 *       replaced; an invalid one only with --replace (it is moved aside, not
 *       deleted).
 *
 *   node scripts/client-bundle.js pack [--out FILE]
 *       Write the bundle as one artifact (default client/dist/<name>) and pin
 *       its name, bytes and sha256 in bundle.json, for publishing (see
 *       client/README.md). Packing is deterministic.
 *
 * client/ layout:
 *   bundle.json                    { format, snapshot, revision, manifestSha256,
 *                                    blobs, bytes, contentsSha256, exportedAt }
 *   snapshots/<id>/manifest.json   the snapshot's manifest, byte for byte
 *   blobs/<aa>/<sha256>            its bodies
 *
 * contentsSha256 is the sha256 of the sorted "<sha256> <bytes>\n" lines of
 * every referenced blob, so a missing or extra blob is detected as well as a
 * changed one.
 */

const fs = require('node:fs');
const path = require('node:path');
const { openSnapshotStore, sha256, SNAPSHOT_ID } = require('../src/clientSnapshot');
const artifact = require('./lib/client-artifact');

const ROOT = path.join(__dirname, '..');
const BUNDLE_FORMAT = 1;
const DEFAULT_BUNDLE = path.join(ROOT, 'client');

class BundleError extends Error {}
class BlobsAbsent extends BundleError {}

/** Every blob a manifest references: sha256 -> bytes. */
function referencedBlobs(manifest) {
  const out = new Map();
  for (const table of [manifest.documents, manifest.answers, manifest.assets]) {
    for (const e of Object.values(table || {})) out.set(e.sha256, e.bytes);
  }
  return out;
}

function contentsDigest(blobs) {
  return sha256(Buffer.from([...blobs].map(([h, n]) => `${h} ${n}\n`).sort().join('')));
}

/** The content tables only (status and timestamps are lifecycle fields). */
function sameContents(a, b) {
  const pick = (m) => JSON.stringify(['documents', 'answers', 'assets'].map((t) => Object.entries(m[t] || {}).map(([k, e]) => [k, e.sha256, e.bytes]).sort()));
  return a.revision === b.revision && pick(a) === pick(b);
}

/** Read and fully validate a bundle directory; returns { descriptor, manifest, store }. */
function readBundle(dir = DEFAULT_BUNDLE) {
  const where = path.relative(ROOT, dir) || dir;
  const descriptorFile = path.join(dir, 'bundle.json');
  if (!fs.existsSync(descriptorFile)) {
    throw new BundleError(`no client bundle: ${path.join(where, 'bundle.json')} does not exist. The pinned client is described by client/ (see client/README.md).`);
  }
  let d;
  try {
    d = JSON.parse(fs.readFileSync(descriptorFile, 'utf8'));
  } catch (error) {
    throw new BundleError(`${where}/bundle.json is not valid JSON (${error.message})`);
  }
  if (d.format !== BUNDLE_FORMAT) throw new BundleError(`${where}/bundle.json: format ${d.format}, expected ${BUNDLE_FORMAT}`);
  if (!SNAPSHOT_ID.test(String(d.snapshot))) throw new BundleError(`${where}/bundle.json: invalid snapshot id`);
  const store = openSnapshotStore(dir);
  if (!fs.existsSync(path.join(dir, 'blobs'))) {
    throw new BlobsAbsent(`${where}/blobs/ is absent: this checkout has the bundle's manifest but not its bodies (${d.blobs} blobs, ${d.bytes} bytes). npm run client:setup gets them from the pinned client artifact (see client/README.md).`);
  }
  const manifestFile = store.manifestPath(d.snapshot);
  if (!fs.existsSync(manifestFile)) throw new BundleError(`${where}: manifest of ${d.snapshot} missing (${path.relative(ROOT, manifestFile)})`);
  const raw = fs.readFileSync(manifestFile);
  if (sha256(raw) !== d.manifestSha256) throw new BundleError(`${where}: manifest of ${d.snapshot} does not match bundle.json (sha256 ${sha256(raw).slice(0, 12)} != ${String(d.manifestSha256).slice(0, 12)}); the bundle is altered or incomplete`);
  const manifest = JSON.parse(raw.toString('utf8'));
  if (manifest.id !== d.snapshot || String(manifest.revision) !== String(d.revision)) throw new BundleError(`${where}: manifest is ${manifest.id} rev ${manifest.revision}, bundle.json names ${d.snapshot} rev ${d.revision}`);
  if (!['active', 'verified', 'retired'].includes(manifest.status)) throw new BundleError(`${where}: snapshot ${d.snapshot} is ${manifest.status}; only a verified snapshot is bundled`);
  const blobs = referencedBlobs(manifest);
  if (blobs.size !== d.blobs || contentsDigest(blobs) !== d.contentsSha256) throw new BundleError(`${where}: the manifest's blob list does not match bundle.json`);
  const check = store.validate(manifest, { deep: true, requiredRoutes: ['home'] });
  if (!check.ok) {
    const more = check.errors.length > 5 ? ` (+${check.errors.length - 5} more)` : '';
    throw new BundleError(`${where}: snapshot ${d.snapshot} failed integrity: ${check.errors.slice(0, 5).join('; ')}${more}. Reinstall the pinned blobs with npm run client:fetch -- --replace, or re-export the bundle.`);
  }
  return { descriptor: d, manifest, store, stats: check.stats };
}

/** bundle.json and the committed manifest, checked against each other (no blobs needed). */
function readDescriptor(dir = DEFAULT_BUNDLE) {
  const where = path.relative(ROOT, dir) || dir;
  const file = path.join(dir, 'bundle.json');
  if (!fs.existsSync(file)) throw new BundleError(`no client bundle: ${path.join(where, 'bundle.json')} does not exist`);
  const descriptor = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (descriptor.format !== BUNDLE_FORMAT || !SNAPSHOT_ID.test(String(descriptor.snapshot))) throw new BundleError(`${where}/bundle.json is not a format ${BUNDLE_FORMAT} bundle descriptor`);
  const manifestFile = openSnapshotStore(dir).manifestPath(descriptor.snapshot);
  if (!fs.existsSync(manifestFile)) throw new BundleError(`${where}: manifest of ${descriptor.snapshot} missing`);
  const manifestRaw = fs.readFileSync(manifestFile);
  if (sha256(manifestRaw) !== descriptor.manifestSha256) throw new BundleError(`${where}: manifest of ${descriptor.snapshot} does not match bundle.json`);
  const referenced = referencedBlobs(JSON.parse(manifestRaw.toString('utf8')));
  if (referenced.size !== descriptor.blobs || contentsDigest(referenced) !== descriptor.contentsSha256) throw new BundleError(`${where}: the manifest's blob list does not match bundle.json`);
  return { descriptor, manifestRaw, referenced };
}

async function pack({ bundleDir = DEFAULT_BUNDLE, outFile = null, log = console.log } = {}) {
  const { descriptor } = readBundle(bundleDir);
  const { manifestRaw, referenced } = readDescriptor(bundleDir);
  const name = artifact.artifactName(descriptor);
  const out = outFile || path.join(bundleDir, 'dist', name);
  const result = await artifact.packArtifact({ bundleDir, descriptor, manifestRaw, blobs: referenced, outFile: out });
  const previous = descriptor.artifact || {};
  const urls = previous.name === name && Array.isArray(previous.urls) ? previous.urls : [];
  descriptor.artifact = { name, bytes: result.bytes, sha256: result.sha256, urls };
  fs.writeFileSync(path.join(bundleDir, 'bundle.json'), `${JSON.stringify(descriptor, null, 1)}\n`);
  log(`packed ${descriptor.snapshot} (revision ${descriptor.revision}) into ${path.relative(ROOT, result.file) || result.file}: ${result.bytes} bytes, sha256 ${result.sha256}`);
  log(urls.length ? `bundle.json artifact.urls: ${urls.join(', ')}` : 'bundle.json has no artifact.urls yet: publish the file and add its URL there (see client/README.md)');
  return { ...result, descriptor };
}

/**
 * Put the pinned client's blobs into bundleDir/blobs from the artifact, all or
 * nothing. Returns { installed, source, hosts }.
 */
async function fetchBlobs({ bundleDir = DEFAULT_BUNDLE, source = null, replace = false, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const { descriptor, manifestRaw, referenced } = readDescriptor(bundleDir);
  const blobsDir = path.join(bundleDir, 'blobs');
  let aside = null;
  if (fs.existsSync(blobsDir)) {
    let valid = true;
    try {
      readBundle(bundleDir);
    } catch (error) {
      if (!(error instanceof BundleError)) throw error;
      valid = false;
    }
    if (valid) {
      log(`${path.relative(ROOT, blobsDir)} already holds the pinned client: nothing fetched`);
      return { installed: false, source: null, hosts: [] };
    }
    if (!replace) throw new BundleError(`${path.relative(ROOT, blobsDir)} exists but fails integrity; it is not replaced automatically. Run again with --replace to move it aside and install the pinned artifact.`);
    aside = `${blobsDir}.invalid-${new Date().toISOString().replace(/[:.]/g, '')}`;
  }
  let pin;
  try {
    pin = artifact.artifactPin(descriptor);
  } catch (error) {
    throw new BundleError(error.message);
  }
  if (!pin) throw new BundleError('client/bundle.json pins no client artifact (no `artifact` entry): this bundle can only be installed from a local client/blobs/');
  const sources = source ? [source] : process.env.CLIENT_ARTIFACT ? [process.env.CLIENT_ARTIFACT] : pin.urls;
  if (!sources.length) throw new BundleError(`no source for the pinned client artifact ${pin.name}: bundle.json artifact.urls is empty. Pass --artifact <url|file> or set CLIENT_ARTIFACT (see client/README.md).`);

  const work = fs.mkdtempSync(path.join(bundleDir, '.staging-'));
  try {
    const download = path.join(work, pin.name);
    let got = null;
    const failures = [];
    for (const src of sources) {
      try {
        got = await artifact.fetchArtifact(src, pin, download, { fetchImpl, log });
        break;
      } catch (error) {
        if (!(error instanceof artifact.ArtifactError)) throw error;
        failures.push(`${src}: ${error.message}`);
        log(`  ${error.message}`);
      }
    }
    if (!got) throw new BundleError(`could not get the pinned client artifact ${pin.name} (sha256 ${pin.sha256.slice(0, 16)}…):\n  ${failures.join('\n  ')}`);
    log(`artifact ${pin.name}: ${pin.bytes} bytes, sha256 ok; unpacking`);
    const staged = path.join(work, 'unpacked');
    try {
      const { blobs } = await artifact.unpackArtifact(download, staged, descriptor, { manifestRaw, referenced });
      log(`unpacked ${blobs} blobs; every blob hashes to its name and the set equals the manifest's`);
    } catch (error) {
      throw new BundleError(error.message);
    }
    // Rename into place only now that everything is verified.
    if (aside) {
      fs.renameSync(blobsDir, aside);
      log(`moved the invalid ${path.relative(ROOT, blobsDir)} aside to ${path.relative(ROOT, aside)}`);
    }
    fs.renameSync(path.join(staged, 'blobs'), blobsDir);
    readBundle(bundleDir);
    log(`installed ${path.relative(ROOT, blobsDir)} (snapshot ${descriptor.snapshot}, revision ${descriptor.revision})`);
    return { installed: true, source: got.source, hosts: got.hosts };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Copy one blob unless the destination already holds exactly those bytes. Returns true if written. */
function copyBlob(from, to, hash) {
  const src = from.blobPath(hash);
  const dest = to.blobPath(hash);
  if (fs.existsSync(dest) && sha256(fs.readFileSync(dest)) === hash) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.copyFileSync(src, tmp);
  if (sha256(fs.readFileSync(tmp)) !== hash) {
    fs.rmSync(tmp, { force: true });
    throw new BundleError(`blob ${hash.slice(0, 12)} changed while copying`);
  }
  fs.renameSync(tmp, dest);
  return true;
}

function setup({ bundleDir = DEFAULT_BUNDLE, clientDir = process.env.CLIENT_DIR || path.join(ROOT, '.cache', 'client'), activate: forceActivate = false, log = console.log } = {}) {
  const { descriptor, manifest, store: bundle, stats } = readBundle(bundleDir);
  const id = descriptor.snapshot;
  log(`bundle: ${id} (revision ${descriptor.revision}), ${descriptor.blobs} blobs, ${descriptor.bytes} bytes: integrity ok`);
  const target = openSnapshotStore(clientDir);

  let existing = null;
  try {
    existing = target.load(id);
  } catch {
    existing = null;
  }
  if (existing && !sameContents(existing, manifest)) {
    throw new BundleError(`${target.manifestPath(id)} already holds a snapshot named ${id} with different contents; it is not overwritten. Move it aside or remove it deliberately, then run setup again.`);
  }

  let written = 0;
  for (const hash of referencedBlobs(manifest).keys()) if (copyBlob(bundle, target, hash)) written += 1;
  if (!existing) target.save({ ...manifest, status: 'verified' });
  log(`installed into ${path.relative(ROOT, target.root) || target.root}: ${written} blobs written, ${descriptor.blobs - written} already present${existing ? '; manifest already present' : ''}`);

  const { activate } = require('./client-snapshot');
  const state = target.readState();
  let activeValid = false;
  if (state.active && state.active !== id) {
    try {
      activeValid = target.validate(target.load(state.active), { requiredRoutes: ['home'] }).ok;
    } catch {
      activeValid = false;
    }
  }
  let outcome;
  if (state.active === id) outcome = 'already active';
  else if (activeValid && !forceActivate) outcome = `kept: ${state.active} stays active (valid local snapshot); serve the bundled one with: npm run client:setup -- --activate`;
  else {
    activate(id, { dir: target.root });
    outcome = state.active ? `activated (previous ${state.active}${activeValid ? '' : ', which failed integrity'} kept in history for rollback)` : 'activated';
  }
  const final = target.readState();
  const check = target.validate(target.load(final.active), { deep: true, requiredRoutes: ['home'] });
  if (!check.ok) throw new BundleError(`active snapshot ${final.active} failed integrity after setup: ${check.errors.slice(0, 5).join('; ')}`);
  log(`${id}: ${outcome}`);
  log(`active: ${final.active}; integrity ok (${check.stats.documents} documents, ${check.stats.answers} answers, ${check.stats.assets} assets)`);
  return { id, active: final.active, written, outcome };
}

function exportBundle({ id = null, clientDir = process.env.CLIENT_DIR || path.join(ROOT, '.cache', 'client'), outDir = DEFAULT_BUNDLE, log = console.log } = {}) {
  const source = openSnapshotStore(clientDir);
  const snapshotId = id || source.readState().active;
  if (!snapshotId) throw new BundleError(`no active snapshot in ${clientDir}; name one to export`);
  const manifest = source.load(snapshotId);
  if (!['active', 'verified', 'retired'].includes(manifest.status)) throw new BundleError(`snapshot ${snapshotId} is ${manifest.status}; only a verified snapshot is bundled`);
  const check = source.validate(manifest, { deep: true, requiredRoutes: ['home'] });
  if (!check.ok) throw new BundleError(`snapshot ${snapshotId} failed integrity: ${check.errors.slice(0, 5).join('; ')}`);
  const out = openSnapshotStore(outDir);
  const blobs = referencedBlobs(manifest);
  let written = 0;
  for (const hash of blobs.keys()) if (copyBlob(source, out, hash)) written += 1;
  // The manifest byte for byte, so its hash is the store's own.
  const raw = fs.readFileSync(source.manifestPath(snapshotId));
  fs.mkdirSync(path.dirname(out.manifestPath(snapshotId)), { recursive: true });
  fs.writeFileSync(out.manifestPath(snapshotId), raw);
  // The bundle holds one snapshot: drop the previous one's manifest and blobs.
  let removed = 0;
  const snapshotsDir = path.join(out.root, 'snapshots');
  for (const other of fs.readdirSync(snapshotsDir)) if (other !== snapshotId) fs.rmSync(path.join(snapshotsDir, other), { recursive: true, force: true });
  const blobsDir = path.join(out.root, 'blobs');
  for (const prefix of fs.readdirSync(blobsDir)) {
    for (const name of fs.readdirSync(path.join(blobsDir, prefix))) {
      if (!blobs.has(name)) {
        fs.rmSync(path.join(blobsDir, prefix, name), { force: true });
        removed += 1;
      }
    }
  }
  const descriptor = {
    format: BUNDLE_FORMAT,
    snapshot: snapshotId,
    revision: String(manifest.revision),
    manifestSha256: sha256(raw),
    blobs: blobs.size,
    bytes: [...blobs.values()].reduce((a, b) => a + b, 0),
    contentsSha256: contentsDigest(blobs),
    exportedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(out.root, 'bundle.json'), `${JSON.stringify(descriptor, null, 1)}\n`);
  log(`exported ${snapshotId} (revision ${descriptor.revision}) to ${path.relative(ROOT, out.root)}: ${descriptor.blobs} blobs, ${descriptor.bytes} bytes (${written} written, ${removed} of the previous bundle removed)`);
  return descriptor;
}

/** True when clientDir already holds the bundled snapshot, complete and valid. */
function installedLocally(bundleDir, clientDir) {
  try {
    const { descriptor } = readDescriptor(bundleDir);
    const target = openSnapshotStore(clientDir);
    const check = target.validate(target.load(descriptor.snapshot), { deep: true, requiredRoutes: ['home'] });
    return check.ok ? descriptor : null;
  } catch {
    return null;
  }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const value = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const bundleDir = value('--bundle') ? path.resolve(value('--bundle')) : DEFAULT_BUNDLE;
  const clientDir = process.env.CLIENT_DIR || path.join(ROOT, '.cache', 'client');
  // The artifact download gets the real fetch, explicitly; everything else
  // runs under the upstream guard, so any other network attempt fails the command.
  const realFetch = globalThis.fetch;
  const guard = require('./lib/offline').strictOffline();
  const hosts = [];
  const getBlobs = async () => {
    const r = await fetchBlobs({ bundleDir, source: value('--artifact') || null, replace: process.argv.includes('--replace'), fetchImpl: realFetch });
    hosts.push(...r.hosts);
  };
  try {
    if (cmd === 'setup') {
      const blobsPresent = fs.existsSync(path.join(bundleDir, 'blobs'));
      const local = !blobsPresent && !process.argv.includes('--activate') && installedLocally(bundleDir, clientDir);
      if (local) {
        console.log(`${local.snapshot} (revision ${local.revision}) is already installed and valid in ${path.relative(ROOT, clientDir) || clientDir}; nothing fetched`);
        // Still report which snapshot is active.
        const state = openSnapshotStore(clientDir).readState();
        console.log(`active: ${state.active}`);
      } else {
        if (!blobsPresent) await getBlobs();
        setup({ bundleDir, clientDir, activate: process.argv.includes('--activate') });
      }
    } else if (cmd === 'fetch') await getBlobs();
    else if (cmd === 'pack') await pack({ bundleDir, outFile: value('--out') ? path.resolve(value('--out')) : null });
    else if (cmd === 'check') {
      const { descriptor, stats } = readBundle(bundleDir);
      console.log(`bundle ${descriptor.snapshot} (revision ${descriptor.revision}): ${descriptor.blobs} blobs, ${descriptor.bytes} bytes: integrity ok`);
    } else if (cmd === 'export') exportBundle({ id: arg && !arg.startsWith('--') ? arg : null, outDir: value('--out') ? path.resolve(value('--out')) : DEFAULT_BUNDLE });
    else {
      console.error('usage: node scripts/client-bundle.js setup [--activate] [--artifact URL|FILE] [--replace] [--bundle DIR] | fetch [--artifact URL|FILE] [--replace] | pack [--out FILE] | check [--bundle DIR] | export [<id>] [--out DIR]');
      return 2;
    }
  } catch (error) {
    if (!(error instanceof BundleError)) throw error;
    console.error(`client bundle: ${error.message}`);
    return 1;
  }
  if (guard.attempts.length) {
    console.error(`client bundle: ${guard.attempts.length} network attempt(s) made; this must not happen`);
    return 1;
  }
  console.log(`hosts contacted: ${hosts.length ? [...new Set(hosts)].join(', ') : 'none'}`);
  return 0;
}

if (require.main === module) main().then((code) => (process.exitCode = code), (error) => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = { setup, exportBundle, readBundle, readDescriptor, pack, fetchBlobs, referencedBlobs, contentsDigest, BundleError, BlobsAbsent };
