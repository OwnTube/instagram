'use strict';

/**
 * Pinned client snapshots: one explicitly chosen, revision-consistent copy of
 * Instagram's PUBLIC web client (anonymous documents, static assets, bootloader
 * answers), stored locally and served without contacting Instagram.
 *
 * Layout (CLIENT_DIR, default .cache/client):
 *
 *   blobs/<aa>/<sha256>          content-addressed bodies, immutable. Filled by
 *                                hard-linking the existing stores' files (no copy;
 *                                a later rewrite of a store entry replaces its
 *                                directory entry, not this inode), else copied.
 *   snapshots/<id>/manifest.json one manifest per snapshot
 *   state.json                   { active, history[], updatedAt }
 *
 * Blob paths are computed from validated sha256 values only; no manifest field
 * is ever used as a path, so a manifest cannot point outside CLIENT_DIR.
 * Nothing per-user is stored: documents are the anonymous upstream bytes, and
 * viewer state is added per request by src/shell (personalize).
 *
 * Manifest (format 1): id, revision, createdAt, updatedAt, status
 * (candidate | verified | active | retired), source, documents{path: entry},
 * answers{"modules|nb_modules": entry}, assets{url: entry}, routes{name:
 * {root, answers, supported, missing}}, knownMissing[], rejected[], patches[],
 * validation[]. An entry is { sha256, bytes, contentType, ... }.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FORMAT = 1;
const SHA256 = /^[0-9a-f]{64}$/;
const SNAPSHOT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const STATUSES = new Set(['candidate', 'verified', 'active', 'retired']);
const REVISION = /"consistency":\{"rev":(\d+)\}/;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const revisionOfText = (text) => (REVISION.exec(text) || [])[1] || null;

/** The revision an endpoint answer declares (hsrp.hblp.consistency.rev), or null. */
function answerRevision(text) {
  try {
    const j = JSON.parse(String(text).replace(/^for \(;;\);/, ''));
    const rev = j && j.hrp && j.hrp.hsrp && j.hrp.hsrp.hblp && j.hrp.hsrp.hblp.consistency && j.hrp.hsrp.hblp.consistency.rev;
    return rev == null ? null : String(rev);
  } catch {
    return null;
  }
}

function openSnapshotStore(dir) {
  const root = path.resolve(dir);
  const blobsDir = path.join(root, 'blobs');
  const snapshotsDir = path.join(root, 'snapshots');
  const stateFile = path.join(root, 'state.json');

  function blobPath(hash) {
    if (!SHA256.test(hash)) throw new Error(`invalid sha256 ${String(hash).slice(0, 80)}`);
    return path.join(blobsDir, hash.slice(0, 2), hash);
  }

  function manifestPath(id) {
    if (!SNAPSHOT_ID.test(String(id))) throw new Error(`invalid snapshot id ${String(id).slice(0, 80)}`);
    return path.join(snapshotsDir, id, 'manifest.json');
  }

  /** Store bytes (or hard-link an existing file holding them); returns the entry fields. */
  function putBlob({ body, file }) {
    const data = body || fs.readFileSync(file);
    const hash = sha256(data);
    const dest = blobPath(hash);
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.${process.pid}.tmp`;
      let linked = false;
      if (file) {
        try {
          fs.linkSync(file, tmp);
          // The source may have been rewritten between the read and the link.
          linked = sha256(fs.readFileSync(tmp)) === hash;
          if (!linked) fs.rmSync(tmp, { force: true });
        } catch {
          linked = false;
        }
      }
      if (!linked) fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, dest);
    }
    return { sha256: hash, bytes: data.length };
  }

  function readBlob(hash) {
    return fs.readFileSync(blobPath(hash));
  }

  function readState() {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return { active: s.active || null, history: Array.isArray(s.history) ? s.history : [], updatedAt: s.updatedAt || null };
    } catch {
      return { active: null, history: [], updatedAt: null };
    }
  }

  function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
    fs.renameSync(tmp, file);
  }

  function writeState(state) {
    writeJson(stateFile, { ...state, updatedAt: new Date().toISOString() });
  }

  function load(id) {
    return JSON.parse(fs.readFileSync(manifestPath(id), 'utf8'));
  }

  function save(manifest) {
    writeJson(manifestPath(manifest.id), { ...manifest, updatedAt: new Date().toISOString() });
  }

  function list() {
    if (!fs.existsSync(snapshotsDir)) return [];
    return fs
      .readdirSync(snapshotsDir)
      .filter((id) => SNAPSHOT_ID.test(id) && fs.existsSync(path.join(snapshotsDir, id, 'manifest.json')))
      .map((id) => {
        try {
          const m = load(id);
          return { id, revision: m.revision, status: m.status, createdAt: m.createdAt };
        } catch (error) {
          return { id, error: error.message };
        }
      });
  }

  /**
   * Check a manifest. `deep` re-hashes every blob (the activation gate);
   * otherwise blob presence and size are checked. Returns { ok, errors[], stats }.
   */
  function validate(manifest, { deep = false, requiredRoutes = [] } = {}) {
    const errors = [];
    const err = (msg) => errors.length < 200 && errors.push(msg);
    if (!manifest || manifest.format !== FORMAT) err(`format must be ${FORMAT}`);
    if (!manifest || !SNAPSHOT_ID.test(String(manifest.id))) err('invalid id');
    if (!manifest || !/^\d+$/.test(String(manifest.revision))) err('invalid revision');
    if (!manifest || !STATUSES.has(manifest.status)) err(`invalid status ${manifest && manifest.status}`);
    if (errors.length) return { ok: false, errors, stats: {} };
    const rev = String(manifest.revision);
    const stats = { documents: 0, answers: 0, assets: 0, bytes: 0 };
    const checkEntry = (kind, key, e, after) => {
      if (!e || !SHA256.test(String(e.sha256)) || !Number.isInteger(e.bytes) || typeof e.contentType !== 'string') {
        err(`${kind} ${key}: malformed entry`);
        return;
      }
      let file;
      try {
        file = blobPath(e.sha256);
      } catch (error) {
        err(`${kind} ${key}: ${error.message}`);
        return;
      }
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        err(`${kind} ${key}: blob ${e.sha256.slice(0, 12)} missing`);
        return;
      }
      if (st.size !== e.bytes) err(`${kind} ${key}: size ${st.size} != ${e.bytes}`);
      stats.bytes += e.bytes;
      if (deep || after) {
        const body = fs.readFileSync(file);
        if (deep && sha256(body) !== e.sha256) err(`${kind} ${key}: hash mismatch`);
        if (after) after(body);
      }
    };
    for (const [p, e] of Object.entries(manifest.documents || {})) {
      if (typeof p !== 'string' || !p.startsWith('/')) err(`document key ${String(p).slice(0, 60)} is not a path`);
      // The server looks documents up by path; a key with a query is unreachable.
      else if (/[?#]/.test(p)) err(`document key ${p.slice(0, 60)} has a query; documents are served by path`);
      stats.documents += 1;
      checkEntry('document', p, e, /text\/html/.test(e && e.contentType) ? (body) => {
        const docRev = revisionOfText(body.toString('utf8'));
        if (docRev !== rev) err(`document ${p}: revision ${docRev} != ${rev}`);
      } : null);
    }
    for (const [k, e] of Object.entries(manifest.answers || {})) {
      stats.answers += 1;
      if (!e || String(e.revision) !== rev) err(`answer ${k}: revision ${e && e.revision} != ${rev}`);
      checkEntry('answer', k, e, (body) => {
        const declared = answerRevision(body.toString('utf8'));
        if (declared !== rev) err(`answer ${k}: body declares revision ${declared}, snapshot is ${rev}`);
      });
    }
    for (const [u, e] of Object.entries(manifest.assets || {})) {
      stats.assets += 1;
      if (!/^https:\/\/(?:static|scontent)\.cdninstagram\.com\//.test(u)) err(`asset ${u.slice(0, 80)}: not a public static URL`);
      checkEntry('asset', u, e, null);
    }
    if (!manifest.documents || !manifest.documents['/']) err('no document for /');
    for (const name of requiredRoutes) {
      const r = manifest.routes && manifest.routes[name];
      if (!r || !r.supported) err(`required route ${name} is not supported by this snapshot${r && r.missing ? ` (missing ${r.missing.join(', ')})` : ''}`);
    }
    return { ok: errors.length === 0, errors, stats };
  }

  return { root, blobPath, putBlob, readBlob, readState, writeState, load, save, list, validate, manifestPath };
}

module.exports = { openSnapshotStore, answerRevision, revisionOfText, sha256, FORMAT, SHA256, SNAPSHOT_ID };
