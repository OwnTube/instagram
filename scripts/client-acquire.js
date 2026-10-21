#!/usr/bin/env node
'use strict';

/**
 * Operator-only client acquisition: the ONE command that contacts Instagram
 * for client material. The server never runs it and never imports
 * src/upstream.js; a page load cannot start it.
 *
 * One bounded, anonymous pass (no cookies of any account, no login):
 *   1. the navigation documents (/, /accounts/emailsignup/, /accounts/login/,
 *      /accounts/password/reset/) - all must be 200 HTML of the SAME revision,
 *      else the pass stops - and the not-found page (NOT_FOUND_PATH, 404);
 *   2. the bootloader-endpoint answers for the modules the client needs (the
 *      registry's page roots, src/pages/registry.js, and the lazily loaded
 *      modules already known),
 *      each asked for that revision; an answer declaring another revision is
 *      refused, never kept;
 *   3. the public static assets those documents and answers reference that the
 *      asset store lacks, up to --max-assets.
 * Requests are sequential with a pause between them; the pass stops at the
 * first 429 or failure (src/upstream.js starts its cooldown and never retries
 * a 429). Nothing already stored is overwritten, and the active snapshot is
 * never touched.
 *
 * Order: `/` first (it fixes the revision), then the answers, then the other
 * documents, so a throttle late in the pass does not cost the answers.
 *
 * Cooldown across passes: every 429 is recorded in its pass's provenance with
 * the Retry-After the origin sent. A new pass does not start (no request at
 * all) until every recorded 429 is older than its Retry-After, or than
 * MAX_COOLDOWN_MS when none was sent; `--check-cooldown` only reports it.
 *
 * Documents and answers go to a staging directory, .cache/acquired/<stamp>/,
 * with provenance.json (every request: URL, status, sha256, bytes, time, and
 * why the pass stopped). Public static assets are added to the URL-keyed asset
 * store (new URLs only). Then:
 *
 *   node scripts/client-snapshot.js build --acquired .cache/acquired/<stamp>
 *   node scripts/client-snapshot.js verify <id> --browser
 *   node scripts/client-snapshot.js activate <id>
 *
 *   NODE_USE_ENV_PROXY=1 node scripts/client-acquire.js [--modules A,B] [--set 'A,B|C'] [--max-assets N] [--dry-run]
 *   node scripts/client-acquire.js --check-cooldown
 *   NODE_USE_ENV_PROXY=1 node scripts/client-acquire.js --assets-for .cache/acquired/<stamp> [--max-assets N]
 *
 * --skip-documents /a/,/b/ leaves those documents out of a pass (e.g. a page
 * that answered 429 in every pass), the not-found page included; the snapshot
 * then lacks them (404).
 * --assets-for completes the asset step of a pass that stopped before it:
 * only the public static assets that pass's own documents and answers
 * reference, recorded in its provenance (assetPass). Cooldowns are per host:
 * it is refused while a recorded 429 on a static host is cooling down; a
 * www.instagram.com cooldown does not apply to it, since it sends nothing there.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);
const { createAssetStore } = require('../src/assetStore');
const { fetchUpstream, UpstreamError } = require('../src/upstream');
const { answerRevision, revisionOfText, openSnapshotStore } = require('../src/clientSnapshot');
const { referencesFrom, storedKeys } = require('./asset-cache');
const { acquisitionModules, PAGES } = require('../src/pages/registry');

const ORIGIN = 'https://www.instagram.com';
const BOOT_DIR = process.env.BOOTLOADER_CACHE_DIR || '.cache/bootloader';
const ASSET_DIR = process.env.ASSET_CACHE_DIR || '.cache/assets';
// Public anonymous pages. A pass fetches all of them at one revision; a page
// cannot be added to an existing snapshot later (it would be another revision).
// The root document (every signed-in page renders from it) and the registry's anonymous pages.
const DOCUMENTS = ['/', ...PAGES.filter((p) => p.access === 'anonymous').map((p) => p.sample())];
// Instagram's own "page not available" document, for profile URLs naming no
// account. Usernames cannot contain "..", so this path never names an account.
// It is expected to answer 404 (anything else is recorded and not staged).
const NOT_FOUND_PATH = '/no..such..account/';
const ACQUIRED_DIR = path.join(ROOT, '.cache', 'acquired');
// The longest cooldown src/upstream.js ever applies; used when a 429 carried
// no Retry-After (or its pass recorded none).
const MAX_COOLDOWN_MS = 60 * 60 * 1000;
const PAUSE_MS = Number(process.env.ACQUIRE_PAUSE_MS || 3000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

const NAVIGATION = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'sec-fetch-site': 'none',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  'sec-fetch-user': '?1',
};

function option(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/**
 * The module sets to ask for: the routes' answers plus every set already
 * known, including every answer of the active snapshot (a new snapshot must
 * not lose an answer the served one has).
 */
function moduleSets() {
  const sets = new Map();
  // Every page of the registry: its served route's answers and its recorded signed-in root.
  for (const a of acquisitionModules()) sets.set(`${a}|`, { modules: a, nbModules: '' });
  try {
    const store = openSnapshotStore(path.join(ROOT, '.cache', 'client'));
    const active = store.readState().active;
    if (active) {
      for (const key of Object.keys(store.load(active).answers)) {
        const [modules, nbModules = ''] = key.split('|');
        sets.set(`${modules}|${nbModules}`, { modules, nbModules });
      }
    }
  } catch {
    /* no snapshot store yet */
  }
  if (fs.existsSync(BOOT_DIR)) {
    for (const f of fs.readdirSync(BOOT_DIR).filter((x) => x.endsWith('.json'))) {
      try {
        const key = JSON.parse(fs.readFileSync(path.join(BOOT_DIR, f), 'utf8')).key;
        if (!key.startsWith(`boot:${ORIGIN}:`)) continue;
        const [modules, nbModules] = key.slice(`boot:${ORIGIN}:`.length).split('|');
        sets.set(`${modules}|${nbModules}`, { modules, nbModules });
      } catch {
        /* half-written entry */
      }
    }
  }
  const extra = option('--modules', '');
  for (const m of extra.split(',').filter(Boolean)) sets.set(`${m}|`, { modules: m, nbModules: '' });
  // A set the client requests as one (comma-joined modules, optional
  // non-blocking part), exactly as /__loader/health -> client.missingRequests
  // names it: --set "A.react,B.react|C.react" (repeatable).
  process.argv.forEach((a, i) => {
    if (a !== '--set' || !process.argv[i + 1]) return;
    const [modules, nbModules = ''] = process.argv[i + 1].split('|');
    sets.set(`${modules}|${nbModules}`, { modules, nbModules });
  });
  return [...sets.values()];
}

/** Recorded 429s whose cooldown has not passed: [{url, at, until, retryAfter, pass}]. */
function activeCooldowns(now = Date.now()) {
  const out = [];
  if (!fs.existsSync(ACQUIRED_DIR)) return out;
  for (const d of fs.readdirSync(ACQUIRED_DIR)) {
    let p;
    try {
      p = JSON.parse(fs.readFileSync(path.join(ACQUIRED_DIR, d, 'provenance.json'), 'utf8'));
    } catch {
      continue;
    }
    for (const r of p.requests || []) {
      if (r.status !== 429) continue;
      const seconds = Number(r.retryAfter);
      const dated = Date.parse(r.retryAfter);
      let ms = MAX_COOLDOWN_MS;
      if (r.retryAfter != null && Number.isFinite(seconds)) ms = seconds * 1000;
      else if (r.retryAfter != null && Number.isFinite(dated)) ms = dated - Date.parse(r.at);
      const until = Date.parse(r.at) + Math.min(Math.max(ms, 0), MAX_COOLDOWN_MS);
      if (until > now) out.push({ url: r.url, host: new URL(r.url).host, at: r.at, until: new Date(until).toISOString(), retryAfter: r.retryAfter ?? null, pass: d });
    }
  }
  return out;
}

const STATIC_HOSTS = new Set(['static.cdninstagram.com', 'scontent.cdninstagram.com']);

// Every option this command takes. Anything else stops it before any request:
// a mistyped flag must never turn into a network pass.
const VALUE_OPTIONS = new Set(['--assets-for', '--max-assets', '--modules', '--set', '--skip-documents']);
const FLAG_OPTIONS = new Set(['--check-cooldown', '--dry-run', '--help', '-h']);
const USAGE = `usage:
  NODE_USE_ENV_PROXY=1 node scripts/client-acquire.js [--modules A,B] [--set 'A,B|C'] [--skip-documents /a/,/b/] [--max-assets N] [--dry-run]
  node scripts/client-acquire.js --check-cooldown
  NODE_USE_ENV_PROXY=1 node scripts/client-acquire.js --assets-for .cache/acquired/<stamp> [--max-assets N]
(the only command that contacts Instagram; see the header of scripts/client-acquire.js)`;

/** The first problem with the command line, or null. */
function argumentError(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (FLAG_OPTIONS.has(a)) continue;
    if (VALUE_OPTIONS.has(a)) {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) return `${a} needs a value`;
      i += 1;
      continue;
    }
    return `unknown argument ${JSON.stringify(a)}`;
  }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const bad = argumentError(argv);
  if (bad) {
    console.error(`client-acquire: ${bad}; nothing was requested.\n${USAGE}`);
    return 2;
  }
  const assetsFor = option('--assets-for', null);
  // A full pass contacts www.instagram.com and the static hosts; an asset
  // completion only the static hosts.
  const cooling = activeCooldowns().filter((c) => !assetsFor || STATIC_HOSTS.has(c.host));
  if (process.argv.includes('--check-cooldown')) {
    if (!cooling.length) console.log('no recorded 429 is still cooling down');
    for (const c of cooling) console.log(`cooling down until ${c.until}: 429 on ${c.url} at ${c.at} (pass ${c.pass}, Retry-After ${c.retryAfter ?? 'not recorded'})`);
    return cooling.length ? 2 : 0;
  }
  if (cooling.length && !process.argv.includes('--dry-run')) {
    console.log(`not starting: ${cooling.length} recorded 429 still cooling down (until ${cooling.map((c) => c.until).sort().pop()}); no request sent`);
    return 2;
  }

  const stamp = assetsFor ? path.basename(path.resolve(assetsFor)) : new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const staging = path.join(ROOT, '.cache', 'acquired', stamp);
  if (assetsFor && !fs.existsSync(path.join(staging, 'provenance.json'))) throw new Error(`no acquisition pass at ${path.relative(ROOT, staging)}`);
  const skipped = new Set(option('--skip-documents', '').split(',').filter(Boolean));
  const docStore = createAssetStore(path.join(staging, 'documents'));
  const bootStore = createAssetStore(path.join(staging, 'bootloader'));
  const assetStore = createAssetStore(ASSET_DIR);
  const maxAssets = Number(option('--max-assets', 600));
  const sets = moduleSets();
  const provenance = assetsFor
    ? JSON.parse(fs.readFileSync(path.join(staging, 'provenance.json'), 'utf8'))
    : { origin: ORIGIN, startedAt: new Date().toISOString(), finishedAt: null, revision: null, anonymous: true, requests: [], stoppedReason: null, complete: false, skippedDocuments: [...skipped] };
  const save = () => {
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'provenance.json'), JSON.stringify(provenance, null, 1));
  };

  if (process.argv.includes('--dry-run')) {
    console.log(`would fetch documents ${[...DOCUMENTS.filter((p) => !skipped.has(p)), ...(skipped.has(NOT_FOUND_PATH) ? [] : [`${NOT_FOUND_PATH} (404)`])].join(', ')}, ${sets.length} answers, up to ${maxAssets} assets, into ${path.relative(ROOT, staging)}`);
    for (const s of sets) console.log(`  answer ${s.modules}|${s.nbModules}`);
    return 0;
  }

  /** One request; returns the response or null after recording why the pass stops. */
  async function get(kind, url, headers, expected = 200) {
    const at = new Date().toISOString();
    try {
      const res = await fetchUpstream(url, { headers });
      const retryAfter = res.status === 429 ? { retryAfter: res.headers.get('retry-after') } : {};
      provenance.requests.push({ kind, url, finalUrl: res.finalUrl, status: res.status, sha256: sha256(res.body), bytes: res.body.length, contentType: res.headers.get('content-type'), ...retryAfter, at });
      if (res.status !== expected) {
        stop(`${kind} ${url}: HTTP ${res.status}`);
        return null;
      }
      return res;
    } catch (error) {
      const status = error instanceof UpstreamError ? error.status : null;
      provenance.requests.push({ kind, url, status, error: error.message, at });
      stop(`${kind} ${url}: ${error.message}`);
      return null;
    }
  }
  const assetPass = assetsFor ? { startedAt: new Date().toISOString(), finishedAt: null, complete: false, stoppedReason: null } : null;
  if (assetPass) provenance.assetPasses = [...(provenance.assetPasses || []), assetPass];
  function stop(reason) {
    if (assetPass) assetPass.stoppedReason = reason;
    else provenance.stoppedReason = reason;
  }

  const documentTexts = [];
  const answerTexts = [];
  /** Fetch and stage one navigation document; false stops the pass. */
  async function document(p, expected = 200) {
    const res = await get('document', `${ORIGIN}${p}`, NAVIGATION, expected);
    if (!res) return false;
    const landed = new URL(res.finalUrl).pathname;
    if (landed !== p) {
      // Redirected (e.g. a page that needs a session): the bytes are not
      // this page, so they are not stored under its path.
      provenance.requests[provenance.requests.length - 1].refused = `redirected to ${landed}`;
      console.log(`  refused document ${p}: redirected to ${landed}`);
      await sleep(PAUSE_MS);
      return true;
    }
    const text = res.body.toString('utf8');
    const rev = revisionOfText(text);
    if (!/text\/html/.test(res.headers.get('content-type') || '') || !rev) {
      stop(`document ${p}: not an HTML document with a client revision`);
      return false;
    }
    if (provenance.revision && rev !== provenance.revision) {
      // Not staged: the snapshot would mix revisions.
      provenance.requests[provenance.requests.length - 1].refused = `revision ${rev}, the pass is ${provenance.revision}`;
      stop(`document ${p} is revision ${rev}, ${DOCUMENTS[0]} was ${provenance.revision}: Instagram changed revision mid-pass; nothing is combined`);
      return false;
    }
    provenance.revision = rev;
    await docStore.write(`doc:${ORIGIN}:nav:${p}`, { body: res.body, contentType: res.headers.get('content-type') });
    documentTexts.push(text);
    await sleep(PAUSE_MS);
    return true;
  }

  /** Public static assets of this pass's material the asset store lacks (new URLs only). */
  async function assets() {
    for (let round = 0; round < 2; round += 1) {
      const stored = storedKeys();
      const missing = [...referencesFrom({ documents: documentTexts, answers: answerTexts, stored })].filter(([url]) => !stored.has(url) && !url.includes('%23'));
      if (!missing.length) break;
      const already = (assetPass ? provenance.requests.filter((r) => r.kind === 'asset' && r.at >= assetPass.startedAt) : provenance.requests.filter((r) => r.kind === 'asset')).length;
      if (already + missing.length > maxAssets) {
        stop(`${missing.length} assets missing, more than --max-assets ${maxAssets}`);
        return false;
      }
      for (const [url] of missing) {
        if (!STATIC_HOSTS.has(new URL(url).host)) continue;
        const res = await get('asset', url, { accept: '*/*' });
        if (!res) return false;
        await assetStore.write(url, { body: res.body, contentType: res.headers.get('content-type') || 'application/octet-stream', etag: res.headers.get('etag') || undefined, lastModified: res.headers.get('last-modified') || undefined });
        await sleep(250);
      }
    }
    return true;
  }

  if (assetsFor) {
    // Complete the asset step of an earlier pass from its own staged material.
    const read = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.body')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')) : []);
    documentTexts.push(...read(path.join(staging, 'documents')));
    answerTexts.push(...read(path.join(staging, 'bootloader')));
    try {
      assetPass.complete = await assets();
      return assetPass.complete ? 0 : 1;
    } finally {
      assetPass.finishedAt = new Date().toISOString();
      save();
      const n = provenance.requests.filter((r) => r.kind === 'asset' && r.status === 200 && r.at >= assetPass.startedAt).length;
      console.log(`asset completion of ${stamp} (revision ${provenance.revision}): assets ${n}`);
      console.log(assetPass.complete ? `complete; next: node scripts/client-snapshot.js build --acquired ${path.relative(ROOT, staging)}` : `STOPPED: ${assetPass.stoppedReason}; the active snapshot is unchanged`);
    }
  }

  try {
    if (!(await document(DOCUMENTS[0]))) return 1;
    const rev = provenance.revision;
    for (const s of sets) {
      const q = `${s.modules ? `modules=${encodeURIComponent(s.modules)}` : ''}${s.nbModules ? `${s.modules ? '&' : ''}nb_modules=${encodeURIComponent(s.nbModules)}` : ''}`;
      const res = await get('answer', `${ORIGIN}/ajax/bootloader-endpoint/?${q}&__d=www&__a=1&__rev=${rev}`, { accept: '*/*' });
      if (!res) return 1;
      const text = res.body.toString('utf8');
      const declared = answerRevision(text);
      if (declared !== rev) {
        provenance.requests[provenance.requests.length - 1].refused = `declares revision ${declared}`;
        console.log(`  refused ${s.modules}|${s.nbModules}: declares revision ${declared}, documents are ${rev}`);
      } else {
        await bootStore.write(`boot:${ORIGIN}:${s.modules}|${s.nbModules}|${rev}`, { body: res.body, contentType: res.headers.get('content-type') || 'application/x-javascript' });
        answerTexts.push(text);
      }
      await sleep(PAUSE_MS);
    }
    for (const p of DOCUMENTS.slice(1)) {
      if (skipped.has(p)) continue;
      if (!(await document(p))) return 1;
    }
    if (!skipped.has(NOT_FOUND_PATH) && !(await document(NOT_FOUND_PATH, 404))) return 1;
    if (!(await assets())) return 1;
    provenance.complete = true;
    return 0;
  } finally {
    provenance.finishedAt = new Date().toISOString();
    save();
    const n = (k) => provenance.requests.filter((r) => r.kind === k && r.status === 200).length;
    console.log(`acquisition ${stamp}: revision ${provenance.revision || '(none)'}; documents ${n('document')}, answers ${n('answer')}, assets ${n('asset')}`);
    console.log(provenance.complete ? `complete; next: node scripts/client-snapshot.js build --acquired ${path.relative(ROOT, staging)}` : `STOPPED: ${provenance.stoppedReason}; the active snapshot is unchanged`);
    console.log(`provenance: ${path.relative(ROOT, path.join(staging, 'provenance.json'))}`);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
