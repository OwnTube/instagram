'use strict';

/**
 * The client the server serves in pinned mode (the default): one snapshot from
 * src/clientSnapshot.js, chosen at startup (the store's active snapshot, or
 * CLIENT_SNAPSHOT_ID to serve a candidate while verifying it). Documents,
 * static assets and bootloader answers come only from it; nothing is fetched
 * from Instagram and nothing newer replaces it while the process runs.
 *
 * A request for something the snapshot does not hold is answered with an
 * explicit error naming the resource and the snapshot revision, and counted in
 * `diagnostics()` (served at /__loader/health -> client). Every blob's hash is
 * checked the first time it is read; a mismatch is refused, never served.
 */

const { openSnapshotStore, sha256 } = require('./clientSnapshot');
const { snapshotSource } = require('./runtime/moduleIndex');

const MAX_BODIES = 300;

function openPinnedClient({ dir, snapshotId = null } = {}) {
  const store = openSnapshotStore(dir);
  let manifest = null;
  let error = null;
  try {
    const id = snapshotId || store.readState().active;
    if (!id) throw new Error(`no active client snapshot in ${store.root}; build, verify and activate one (npm run client:build, client:verify, client:activate)`);
    manifest = store.load(id);
    if (!snapshotId && manifest.status !== 'active') throw new Error(`snapshot ${id} is ${manifest.status}, not active`);
    const check = store.validate(manifest, { requiredRoutes: ['home'] });
    if (!check.ok) throw new Error(`snapshot ${id} failed validation: ${check.errors.slice(0, 5).join('; ')}`);
  } catch (e) {
    error = e.message;
    manifest = null;
  }

  const missing = new Map();
  const integrityFailures = [];
  const verified = new Set();
  const bodies = new Map(); // sha -> Buffer, least recently used first

  function noteMissing(kind, key, reason) {
    const k = `${kind} ${key}`;
    const m = missing.get(k) || { kind, key: String(key).slice(0, 300), reason, count: 0, lastAt: null };
    m.count += 1;
    m.lastAt = new Date().toISOString();
    missing.set(k, m);
    if (missing.size > 500) missing.delete(missing.keys().next().value);
  }

  /** The bytes of a manifest entry, hash-checked once per process; null if refused. */
  function body(entry) {
    const hit = bodies.get(entry.sha256);
    if (hit) {
      bodies.delete(entry.sha256);
      bodies.set(entry.sha256, hit);
      return hit;
    }
    let data;
    try {
      data = store.readBlob(entry.sha256);
    } catch {
      integrityFailures.push({ sha256: entry.sha256, reason: 'blob unreadable', at: new Date().toISOString() });
      return null;
    }
    if (!verified.has(entry.sha256)) {
      if (sha256(data) !== entry.sha256) {
        integrityFailures.push({ sha256: entry.sha256, reason: 'hash mismatch', at: new Date().toISOString() });
        return null;
      }
      verified.add(entry.sha256);
    }
    bodies.set(entry.sha256, data);
    if (bodies.size > MAX_BODIES) bodies.delete(bodies.keys().next().value);
    return data;
  }

  const lookup = (table, key) => (manifest && Object.prototype.hasOwnProperty.call(manifest[table], key) ? manifest[table][key] : null);

  return {
    get ready() {
      return Boolean(manifest);
    },
    get error() {
      return error;
    },
    get revision() {
      return manifest ? String(manifest.revision) : null;
    },
    get id() {
      return manifest ? manifest.id : null;
    },
    /** A document by path (no query), an asset by its upstream URL, an answer by "modules|nb_modules". */
    document: (p) => lookup('documents', p),
    asset: (url) => lookup('assets', url),
    answer: (key) => lookup('answers', key),
    body,
    noteMissing,
    /** The snapshot as a module-index source (operation contracts), or null. */
    contractSource: () => (manifest ? snapshotSource(store, manifest) : null),
    diagnostics() {
      return {
        mode: 'pinned',
        ready: Boolean(manifest),
        error,
        snapshot: manifest ? manifest.id : null,
        revision: manifest ? String(manifest.revision) : null,
        status: manifest ? manifest.status : null,
        routes: manifest ? manifest.routes : null,
        knownMissing: manifest ? manifest.knownMissing.length : null,
        missingRequests: [...missing.values()].sort((a, b) => b.count - a.count).slice(0, 50),
        integrityFailures: integrityFailures.slice(-20),
      };
    },
  };
}

module.exports = { openPinnedClient };
