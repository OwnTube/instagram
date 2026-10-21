#!/usr/bin/env node
'use strict';

/**
 * Operator commands for the pinned client snapshot (src/clientSnapshot.js).
 * Nothing here runs on a page load; every change of the served client is one of
 * these deliberate commands.
 *
 *   node scripts/client-snapshot.js build [--revision N] [--acquired DIR[,DIR...]]
 *                                                       candidate from the local stores
 *                                                       (and an acquisition's staging dir)
 *   node scripts/client-snapshot.js verify <id> [--browser] integrity (+ genuine browser checks)
 *   node scripts/client-snapshot.js activate <id>           serve it (must be verified)
 *   node scripts/client-snapshot.js rollback                re-activate the previous snapshot
 *   node scripts/client-snapshot.js status                  active snapshot, list, health
 *
 * `build` reads the existing stores (.cache/documents, .cache/bootloader,
 * .cache/assets) and never contacts Instagram. Only material of ONE revision
 * goes in: a document of another revision, an answer stored under one revision
 * whose body declares another, or an unparsable answer is rejected and listed.
 * To get material of a newer revision first, run `npm run client:acquire`
 * (scripts/client-acquire.js, the only command that contacts Instagram), then
 * build with --acquired <its staging directory>.
 *
 * `verify --browser` runs the genuine-client checks with the server serving the
 * candidate (CLIENT_SNAPSHOT_ID) and the upstream guard on; a snapshot becomes
 * `verified` only when integrity and those checks pass. `activate` re-runs the
 * deep integrity check and refuses anything not verified. The previous active
 * snapshot is kept for `rollback`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const { openSnapshotStore, answerRevision, revisionOfText, sha256 } = require('../src/clientSnapshot');
const { referencesFrom, storedKeys } = require('./asset-cache');
const pages = require('../src/pages/registry');
const { createPatcher, PATCHES } = require('../src/shell/bundlePatches');

const CLIENT_DIR = process.env.CLIENT_DIR || '.cache/client';
const DOC_DIR = process.env.DOCUMENT_CACHE_DIR || '.cache/documents';
const BOOT_DIR = process.env.BOOTLOADER_CACHE_DIR || '.cache/bootloader';
const ORIGIN = 'https://www.instagram.com';

/** The routes a snapshot can claim, with the answers each needs. */
// From the page registry (src/pages/registry.js): every page this server serves signed in.
const ROUTES = Object.fromEntries(
  pages.PAGES.filter((p) => p.served).map((p) => [p.id, { root: p.served, answers: pages.servedAnswers(p) }]),
);
/**
 * Browser checks (scripts/genuine-*-check.js). A snapshot becomes verified only
 * if every core check passes; the others are run and recorded as the
 * snapshot's scope (a failing or unsupported one is reported, never counted
 * as working). The profile check runs only if the snapshot supports the route.
 */
const CORE_CHECKS = ['login', 'signup', 'feed', 'engage'];
const SCOPE_CHECKS = ['create', 'profile'];

function storeEntries(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push({ key: meta.key, meta, file: path.join(dir, f.replace(/\.json$/, '.body')) });
    } catch {
      /* half-written entry */
    }
  }
  return out;
}

/**
 * Build a candidate from the stores. `acquired` names one acquisition staging
 * directory (scripts/client-acquire.js, scripts/client-import-har.js) or a
 * list of them: their documents and answers are read first, in order, and
 * their provenance is recorded. They must all be of one revision, which is
 * the snapshot's; staging of different revisions is refused, never combined.
 */
function build({ revision, dir = CLIENT_DIR, acquired = null } = {}) {
  const store = openSnapshotStore(dir);
  const rejected = [];
  const knownMissing = [];
  const staged = acquired ? (Array.isArray(acquired) ? acquired : [acquired]) : [];
  const provenances = [];
  for (const a of staged) {
    const p = JSON.parse(fs.readFileSync(path.join(a, 'provenance.json'), 'utf8'));
    if (!p.revision) throw new Error(`acquisition ${a} found no revision (${p.stoppedReason || 'incomplete'})`);
    if (revision && String(revision) !== String(p.revision)) throw new Error(`${path.basename(a)} is revision ${p.revision}, not ${revision}: staging of different revisions is not combined`);
    revision = p.revision;
    provenances.push({ dir: path.basename(a), ...p });
  }
  const provenance = provenances.length === 0 ? null : provenances.length === 1 ? provenances[0] : provenances;
  const docDirs = [...staged.map((a) => path.join(a, 'documents')), DOC_DIR];
  const bootDirs = [...staged.map((a) => path.join(a, 'bootloader')), BOOT_DIR];
  const firstByKey = (entries) => [...new Map(entries.reverse().map((e) => [e.key, e])).values()];
  const docs = firstByKey(docDirs.flatMap(storeEntries)).filter((e) => e.key.startsWith(`doc:${ORIGIN}:`) && fs.existsSync(e.file));
  const home = docs.find((e) => e.key === `doc:${ORIGIN}:nav:/`);
  const rev = String(revision || (home && revisionOfText(fs.readFileSync(home.file, 'utf8'))) || '');
  if (!/^\d+$/.test(rev)) throw new Error('no revision: no stored navigation document for / (or pass --revision)');

  // Documents: navigation variants (the full app shell) of this revision, and
  // the public images the origin serves under /images/.
  const documents = {};
  const documentTexts = [];
  for (const e of docs) {
    const [, , , variant, ...rest] = e.key.split(':');
    // Served by path: the server looks documents up without the query.
    const p = rest.join(':').split('?')[0];
    const type = (e.meta.entry && e.meta.entry.contentType) || '';
    if (/text\/html/.test(type)) {
      const text = fs.readFileSync(e.file, 'utf8');
      const docRev = revisionOfText(text);
      if (variant !== 'nav') rejected.push({ kind: 'document', key: `${variant}:${p}`, reason: `variant ${variant} (only navigation documents are served)` });
      else if (docRev !== rev) rejected.push({ kind: 'document', key: p, reason: `revision ${docRev}, snapshot is ${rev}` });
      else if (!documents[p]) {
        documents[p] = { ...store.putBlob({ file: e.file }), contentType: type, revision: rev };
        documentTexts.push(text);
      }
    } else if (/^\/images\//.test(p) && variant === 'file' && /^image\//.test(type) && !documents[p]) {
      documents[p] = { ...store.putBlob({ file: e.file }), contentType: type };
    }
  }
  if (!documents['/']) throw new Error(`no navigation document for / at revision ${rev}`);

  // Bootloader answers stored under this revision whose body agrees.
  const answers = {};
  const answerTexts = [];
  for (const e of firstByKey(bootDirs.flatMap(storeEntries))) {
    if (!e.key.startsWith(`boot:${ORIGIN}:`)) continue;
    const rest = e.key.slice(`boot:${ORIGIN}:`.length).split('|');
    const [modules, nbModules, keyRev] = rest;
    const id = `${modules}|${nbModules}`;
    if (keyRev !== rev) continue; // another revision's answer: not part of this build
    const text = fs.readFileSync(e.file, 'utf8');
    const bodyRev = answerRevision(text);
    if (bodyRev !== rev) {
      rejected.push({ kind: 'answer', key: id, reason: bodyRev ? `stored under ${rev} but the body declares ${bodyRev}` : 'not a parsable endpoint answer' });
      continue;
    }
    answers[id] = { ...store.putBlob({ file: e.file }), contentType: (e.meta.entry && e.meta.entry.contentType) || 'application/x-javascript', revision: rev, modules, nbModules };
    answerTexts.push(text);
  }

  // Static assets the documents and answers reference (and the stylesheets'
  // url()s), from the asset store.
  const stored = storedKeys();
  const refs = referencesFrom({ documents: documentTexts, answers: answerTexts, stored });
  const assets = {};
  for (const [url, ref] of refs) {
    const s = stored.get(url);
    if (!s || !fs.existsSync(s.file)) {
      knownMissing.push({ kind: 'asset', key: url, from: ref.from, reason: 'referenced but not in the asset store' });
      continue;
    }
    const entry = s.meta.entry || {};
    assets[url] = { ...store.putBlob({ file: s.file }), contentType: entry.contentType || 'application/octet-stream', etag: entry.etag, lastModified: entry.lastModified, type: ref.type, from: ref.from };
  }

  // Routes this snapshot can serve signed in.
  const routes = {};
  for (const [name, spec] of Object.entries(ROUTES)) {
    const missing = spec.answers.filter((a) => !answers[`${a}|`]);
    routes[name] = { root: spec.root, answers: spec.answers, supported: missing.length === 0, missing };
    for (const a of missing) knownMissing.push({ kind: 'answer', key: `${a}|`, reason: `needed by the ${name} route; no answer of revision ${rev}` });
  }
  // Every registered page, served or not: what it needs and what is still missing.
  const pageCoverage = pages.coverage({ hasAnswer: (a) => Boolean(answers[`${a}|`]), hasDocument: (p) => Boolean(documents[p]) });

  // Bundle patches over the snapshot's scripts (applied when served).
  const patcher = createPatcher();
  for (const e of Object.values(assets)) if (/javascript/.test(e.contentType)) patcher.apply(store.readBlob(e.sha256).toString('utf8'));
  const patches = patcher.report().map((r) => ({ ...r, ok: r.applied > 0 }));

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const id = `rev${rev}-${stamp}`;
  const manifest = {
    format: 1,
    id,
    revision: rev,
    createdAt: new Date().toISOString(),
    status: 'candidate',
    source: staged.length ? `acquired:${staged.map((a) => path.basename(a)).join('+')} + local-stores` : 'local-stores',
    provenance,
    patchSet: sha256(Buffer.from(JSON.stringify(PATCHES))).slice(0, 16),
    documents,
    answers,
    assets,
    routes,
    pages: pageCoverage,
    knownMissing,
    rejected,
    patches,
    validation: [],
  };
  const check = store.validate(manifest, { deep: true });
  manifest.validation.push({ at: new Date().toISOString(), check: 'integrity', ok: check.ok, errors: check.errors, stats: check.stats });
  store.save(manifest);
  return manifest;
}

function summary(m) {
  const routes = Object.entries(m.routes).map(([n, r]) => `${n}:${r.supported ? 'supported' : `missing ${r.missing.join(',')}`}`).join(' ');
  return [
    `snapshot ${m.id}  revision ${m.revision}  status ${m.status}`,
    `  documents ${Object.keys(m.documents).length}, answers ${Object.keys(m.answers).length}, assets ${Object.keys(m.assets).length}`,
    `  routes ${routes}`,
    m.pages ? `  pages ${m.pages.filter((p) => p.status === 'served').length} served, ${m.pages.filter((p) => p.status === 'document').length} anonymous documents, ${m.pages.filter((p) => p.status === 'missing-document').length} missing documents, ${m.pages.filter((p) => p.status === 'missing-answers').length} missing answers, ${m.pages.filter((p) => p.status === 'not-served').length} not served: ${m.pages.filter((p) => !['served', 'document'].includes(p.status)).map((p) => p.id).join(',')}` : '  pages not recorded (built before the page registry)',
    `  patches ${m.patches.map((p) => `${p.id}:${p.applied ? 'applies' : 'MISSED'}`).join(' ')}`,
    `  known missing ${m.knownMissing.length}${m.knownMissing.length ? `: ${m.knownMissing.slice(0, 6).map((x) => `${x.kind} ${x.key}`).join('; ')}` : ''}`,
    `  rejected ${m.rejected.length}${m.rejected.length ? `: ${m.rejected.map((x) => `${x.kind} ${x.key} (${x.reason})`).join('; ')}` : ''}`,
    m.scope ? `  scope ${m.scope.complete ? 'complete' : 'PARTIAL'}: working ${m.scope.working.join(',') || '-'}; failing ${m.scope.failing.join(',') || '-'}; unsupported ${m.scope.unsupported.join(',') || '-'}` : '  scope not browser-checked',
  ].join('\n');
}

function runBrowserChecks(id, checks, dir) {
  const results = [];
  for (const name of checks) {
    const env = { ...process.env, CLIENT_SNAPSHOT_ID: id, CLIENT_DIR: dir, UPSTREAM_GUARD: '1' };
    delete env.LOADER_OFFLINE;
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', `genuine-${name}-check.js`)], { env, encoding: 'utf8', timeout: 15 * 60 * 1000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const line = (out.match(/^\d+\/\d+ .*passed$/m) || [`exit ${r.status}`])[0];
    const failed = out.split('\n').filter((l) => l.startsWith('FAIL')).map((l) => l.slice(0, 200));
    results.push({ check: name, ok: r.status === 0, result: line, failed });
    console.log(`  ${r.status === 0 ? 'PASS' : 'FAIL'} ${name}: ${line}${failed.length ? `\n    ${failed.join('\n    ')}` : ''}`);
  }
  return results;
}

function verify(id, { browser, dir = CLIENT_DIR, runChecks = runBrowserChecks } = {}) {
  const store = openSnapshotStore(dir);
  const m = store.load(id);
  // An active snapshot can be re-checked (e.g. after a serving change): the
  // results and scope are recorded, its status is not changed either way.
  if (!['candidate', 'verified', 'active'].includes(m.status)) throw new Error(`snapshot ${id} is ${m.status}; only a candidate, verified or active snapshot is verified`);
  const check = store.validate(m, { deep: true, requiredRoutes: ['home'] });
  m.validation.push({ at: new Date().toISOString(), check: 'integrity', ok: check.ok, errors: check.errors, stats: check.stats });
  console.log(`integrity: ${check.ok ? 'ok' : 'FAILED'} ${JSON.stringify(check.stats)}${check.errors.length ? `\n  ${check.errors.slice(0, 20).join('\n  ')}` : ''}`);
  const patchesOk = m.patches.every((p) => p.applied > 0);
  if (!patchesOk) console.log(`patches: MISSED ${m.patches.filter((p) => !p.applied).map((p) => p.id).join(', ')}`);
  let browserOk = null;
  if (check.ok && patchesOk && browser) {
    const core = runChecks(id, CORE_CHECKS, dir);
    browserOk = core.every((r) => r.ok);
    // A route the snapshot does not support is recorded as such, not checked.
    const scoped = SCOPE_CHECKS.filter((c) => c !== 'profile' || (m.routes.profile && m.routes.profile.supported));
    const extra = browserOk ? runChecks(id, scoped, dir) : [];
    const results = [...core, ...extra];
    m.scope = {
      working: results.filter((r) => r.ok).map((r) => r.check),
      failing: results.filter((r) => !r.ok).map((r) => r.check),
      unsupported: SCOPE_CHECKS.filter((c) => !scoped.includes(c)),
      complete: results.every((r) => r.ok) && scoped.length === SCOPE_CHECKS.length,
    };
    m.validation.push({ at: new Date().toISOString(), check: 'browser', ok: browserOk, results, scope: m.scope });
  }
  const passed = check.ok && patchesOk && browserOk === true;
  if (m.status !== 'active' && (m.status === 'candidate' || !passed)) m.status = passed ? 'verified' : 'candidate';
  store.save(m);
  const scope = m.scope ? ` scope: working ${m.scope.working.join(',') || '-'}; failing ${m.scope.failing.join(',') || '-'}; unsupported ${m.scope.unsupported.join(',') || '-'}; ${m.scope.complete ? 'complete' : 'PARTIAL'}` : '';
  console.log(`snapshot ${id}: ${passed ? 'VERIFIED' : browserOk === null && check.ok && patchesOk ? 'integrity ok; run with --browser to verify' : 'NOT verified'} (status ${m.status})${scope}`);
  return passed;
}

function activate(id, { dir = CLIENT_DIR } = {}) {
  const store = openSnapshotStore(dir);
  const m = store.load(id);
  if (!['verified', 'active', 'retired'].includes(m.status)) throw new Error(`snapshot ${id} is ${m.status}; only a verified snapshot can be activated`);
  const check = store.validate(m, { deep: true, requiredRoutes: ['home'] });
  if (!check.ok) throw new Error(`snapshot ${id} failed integrity: ${check.errors.slice(0, 5).join('; ')}`);
  const state = store.readState();
  if (state.active === id) return state;
  if (state.active) {
    try {
      const prev = store.load(state.active);
      prev.status = 'retired';
      store.save(prev);
    } catch {
      /* the previous manifest is gone; history still names it */
    }
  }
  m.status = 'active';
  store.save(m);
  const history = [state.active, ...state.history].filter((x, i, a) => x && x !== id && a.indexOf(x) === i).slice(0, 10);
  store.writeState({ active: id, history });
  return store.readState();
}

function rollback({ dir = CLIENT_DIR } = {}) {
  const store = openSnapshotStore(dir);
  const state = store.readState();
  for (const id of state.history) {
    try {
      const m = store.load(id);
      if (!store.validate(m, { deep: true, requiredRoutes: ['home'] }).ok) continue;
      if (m.status !== 'retired' && m.status !== 'verified') continue;
      return activate(id, { dir });
    } catch {
      /* not usable; try the next */
    }
  }
  throw new Error('no previous verified snapshot to roll back to');
}

function status({ dir = CLIENT_DIR } = {}) {
  const store = openSnapshotStore(dir);
  const state = store.readState();
  console.log(`active: ${state.active || '(none)'}  previous: ${state.history.join(', ') || '(none)'}`);
  if (state.active) {
    const m = store.load(state.active);
    console.log(summary(m));
    const check = store.validate(m, { requiredRoutes: ['home'] });
    console.log(`  integrity (sizes): ${check.ok ? 'ok' : `FAILED: ${check.errors.slice(0, 5).join('; ')}`}`);
  }
  for (const s of store.list()) console.log(`  ${s.id}  ${s.status}  rev ${s.revision}`);
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  const flag = (name) => process.argv.includes(name);
  const value = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  if (cmd === 'build') {
    // --acquired A[,B...]: staging directories of one revision, read in that order.
    const m = build({ revision: value('--revision'), acquired: value('--acquired') ? value('--acquired').split(',') : null });
    console.log(summary(m));
    const integrity = m.validation[m.validation.length - 1];
    console.log(`  integrity: ${integrity.ok ? 'ok' : `FAILED: ${integrity.errors.slice(0, 5).join('; ')}`}`);
    console.log(`candidate written; next: node scripts/client-snapshot.js verify ${m.id} --browser`);
    return integrity.ok ? 0 : 1;
  }
  if (cmd === 'verify') return verify(arg, { browser: flag('--browser') }) ? 0 : 1;
  if (cmd === 'activate') {
    const s = activate(arg);
    console.log(`active: ${s.active}; previous: ${s.history[0] || '(none)'}`);
    return 0;
  }
  if (cmd === 'rollback') {
    const s = rollback();
    console.log(`rolled back; active: ${s.active}`);
    return 0;
  }
  if (cmd === 'status' || !cmd) {
    status();
    return 0;
  }
  console.error(`unknown command ${cmd}`);
  return 2;
}

if (require.main === module) {
  process.chdir(ROOT);
  try {
    process.exit(main());
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { build, verify, activate, rollback, status, ROUTES, CORE_CHECKS, SCOPE_CHECKS };
