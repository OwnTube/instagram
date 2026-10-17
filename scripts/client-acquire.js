#!/usr/bin/env node
'use strict';

/**
 * Operator-only client acquisition: the ONE command that contacts Instagram
 * for client material. The server never runs it and never imports
 * src/upstream.js; a page load cannot start it.
 *
 * One bounded, anonymous pass (no cookies of any account, no login):
 *   1. the navigation documents / and /accounts/emailsignup/ - both must be
 *      200 HTML of the SAME revision, else the pass stops;
 *   2. the bootloader-endpoint answers for the modules the client needs (the
 *      signed-in routes' roots and the lazily loaded modules already known),
 *      each asked for that revision; an answer declaring another revision is
 *      refused, never kept;
 *   3. the public static assets those documents and answers reference that the
 *      asset store lacks, up to --max-assets.
 * Requests are sequential with a pause between them; the pass stops at the
 * first 429 or failure (src/upstream.js starts its cooldown and never retries
 * a 429). Nothing already stored is overwritten, and the active snapshot is
 * never touched.
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
 *   NODE_USE_ENV_PROXY=1 node scripts/client-acquire.js [--modules A,B] [--max-assets N] [--dry-run]
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);
const { createAssetStore } = require('../src/assetStore');
const { fetchUpstream, UpstreamError } = require('../src/upstream');
const { answerRevision, revisionOfText } = require('../src/clientSnapshot');
const { referencesFrom, storedKeys } = require('./asset-cache');
const { ROUTES } = require('./client-snapshot');

const ORIGIN = 'https://www.instagram.com';
const BOOT_DIR = process.env.BOOTLOADER_CACHE_DIR || '.cache/bootloader';
const ASSET_DIR = process.env.ASSET_CACHE_DIR || '.cache/assets';
const DOCUMENTS = ['/', '/accounts/emailsignup/'];
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

/** The module sets to ask for: the routes' answers plus every set already known. */
function moduleSets() {
  const sets = new Map();
  for (const spec of Object.values(ROUTES)) for (const a of spec.answers) sets.set(`${a}|`, { modules: a, nbModules: '' });
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
  return [...sets.values()];
}

async function main() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const staging = path.join(ROOT, '.cache', 'acquired', stamp);
  const docStore = createAssetStore(path.join(staging, 'documents'));
  const bootStore = createAssetStore(path.join(staging, 'bootloader'));
  const assetStore = createAssetStore(ASSET_DIR);
  const maxAssets = Number(option('--max-assets', 600));
  const sets = moduleSets();
  const provenance = { origin: ORIGIN, startedAt: new Date().toISOString(), finishedAt: null, revision: null, anonymous: true, requests: [], stoppedReason: null, complete: false };
  const save = () => {
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'provenance.json'), JSON.stringify(provenance, null, 1));
  };

  if (process.argv.includes('--dry-run')) {
    console.log(`would fetch documents ${DOCUMENTS.join(', ')}, ${sets.length} answers, up to ${maxAssets} assets, into ${path.relative(ROOT, staging)}`);
    for (const s of sets) console.log(`  answer ${s.modules}|${s.nbModules}`);
    return 0;
  }

  /** One request; returns the response or null after recording why the pass stops. */
  async function get(kind, url, headers) {
    const at = new Date().toISOString();
    try {
      const res = await fetchUpstream(url, { headers });
      provenance.requests.push({ kind, url, status: res.status, sha256: sha256(res.body), bytes: res.body.length, contentType: res.headers.get('content-type'), at });
      if (res.status !== 200) {
        provenance.stoppedReason = `${kind} ${url}: HTTP ${res.status}`;
        return null;
      }
      return res;
    } catch (error) {
      const status = error instanceof UpstreamError ? error.status : null;
      provenance.requests.push({ kind, url, status, error: error.message, at });
      provenance.stoppedReason = `${kind} ${url}: ${error.message}`;
      return null;
    }
  }

  const documentTexts = [];
  const answerTexts = [];
  try {
    for (const p of DOCUMENTS) {
      const res = await get('document', `${ORIGIN}${p}`, NAVIGATION);
      if (!res) return 1;
      const text = res.body.toString('utf8');
      const rev = revisionOfText(text);
      if (!/text\/html/.test(res.headers.get('content-type') || '') || !rev) {
        provenance.stoppedReason = `document ${p}: not an HTML document with a client revision`;
        return 1;
      }
      if (provenance.revision && rev !== provenance.revision) {
        provenance.stoppedReason = `document ${p} is revision ${rev}, ${DOCUMENTS[0]} was ${provenance.revision}: Instagram changed revision mid-pass; nothing is combined`;
        provenance.revision = null;
        return 1;
      }
      provenance.revision = rev;
      await docStore.write(`doc:${ORIGIN}:nav:${p}`, { body: res.body, contentType: res.headers.get('content-type') });
      documentTexts.push(text);
      await sleep(PAUSE_MS);
    }
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
    // Public static assets of this revision the asset store lacks (new URLs only).
    for (let round = 0; round < 2; round += 1) {
      const stored = storedKeys();
      const missing = [...referencesFrom({ documents: documentTexts, answers: answerTexts, stored })].filter(([url]) => !stored.has(url) && !url.includes('%23'));
      if (!missing.length) break;
      if (provenance.requests.filter((r) => r.kind === 'asset').length + missing.length > maxAssets) {
        provenance.stoppedReason = `${missing.length} assets missing, more than --max-assets ${maxAssets}`;
        return 1;
      }
      for (const [url] of missing) {
        const res = await get('asset', url, { accept: '*/*' });
        if (!res) return 1;
        await assetStore.write(url, { body: res.body, contentType: res.headers.get('content-type') || 'application/octet-stream', etag: res.headers.get('etag') || undefined, lastModified: res.headers.get('last-modified') || undefined });
        await sleep(250);
      }
    }
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
