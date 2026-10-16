#!/usr/bin/env node
'use strict';

/**
 * Move the stored genuine client to Instagram's current revision, as one
 * consistent set: the anonymous documents, the feed root's bootloader answer and
 * the lazily loaded modules' answers, all for the same revision. (The client's
 * ClientConsistency treats answers of another revision as an inconsistency once
 * their modules overlap loaded ones, and asks for a refresh; offline, a refresh
 * would reload the same stale page.)
 *
 * Every request is anonymous (no cookies, no account), made once through the
 * loader's own document and bootloader-endpoint paths, which store the answers;
 * the run stops at the first non-200 (a 429 starts the loader's cooldown).
 * The previous documents and answers are copied to .cache/backup-<rev>/ first.
 * Afterwards run `npm run cache:warm` to store the public CDN files the new
 * answers name.
 *
 *   NODE_USE_ENV_PROXY=1 node scripts/refresh-client.js [Module.react ...] [--nb Module.react ...]
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, '.scratch', 'refresh-client');
const DOCUMENTS = ['/', '/accounts/emailsignup/'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function args() {
  const blocking = [];
  const nonBlocking = [];
  let nb = false;
  for (const a of process.argv.slice(2)) {
    if (a === '--nb') nb = true;
    else (nb ? nonBlocking : blocking).push(a);
  }
  return { blocking, nonBlocking };
}

function backup(rev) {
  const dest = path.join(ROOT, '.cache', `backup-${rev}`);
  for (const dir of ['documents', 'bootloader']) {
    const src = path.join(ROOT, '.cache', dir);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(dest, dir), { recursive: true });
  }
  return dest;
}

const revOf = (text) => (/"consistency":\{"rev":(\d+)\}/.exec(text) || [])[1] || null;

async function main() {
  const { blocking, nonBlocking } = args();
  const stored = fs.readdirSync(path.join(ROOT, '.cache', 'documents')).filter((f) => f.endsWith('.body'));
  const oldRev = stored.map((f) => revOf(fs.readFileSync(path.join(ROOT, '.cache', 'documents', f), 'utf8'))).find(Boolean) || 'unknown';
  console.log(`stored client revision: ${oldRev}; backup: ${path.relative(ROOT, backup(oldRev))}`);

  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  Object.assign(process.env, { BACKEND_DB: path.join(SCRATCH, 'db.sqlite'), CLONE_DATA_DIR: SCRATCH, VERBOSE: '0', BACKEND_VERBOSE: '0' });
  delete process.env.LOADER_OFFLINE;
  delete process.env.LOADER_PREFER_CACHE;
  const { app } = require('../src/server');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  // A top-level navigation's own headers (the loader relays them).
  const navigation = {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'sec-fetch-site': 'none',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    'sec-fetch-user': '?1',
  };
  let ok = true;
  let rev = null;
  try {
    for (const doc of DOCUMENTS) {
      const res = await fetch(`${base}${doc}`, { headers: navigation });
      const text = await res.text();
      console.log(`${res.status} ${res.headers.get('x-loader-cache') || 'upstream'} document ${doc} rev ${revOf(text)}`);
      if (res.status !== 200 || res.headers.get('x-loader-cache') === 'stale') {
        ok = false;
        break;
      }
      rev = rev || revOf(text);
      await sleep(4000);
    }
    const answers = [
      ...['PolarisFeedRoot.react', ...blocking].map((m) => `modules=${encodeURIComponent(m)}`),
      ...nonBlocking.map((m) => `nb_modules=${encodeURIComponent(m)}`),
    ];
    for (const q of ok && rev ? answers : []) {
      const res = await fetch(`${base}/ajax/bootloader-endpoint/?${q}&__d=www&__a=1&__rev=${rev}`);
      const text = await res.text();
      console.log(`${res.status} ${res.headers.get('x-loader-cache')} answer ${decodeURIComponent(q)} rev ${revOf(text)}`);
      if (res.status !== 200) {
        ok = false;
        break;
      }
      await sleep(4000);
    }
  } finally {
    await sleep(1500); // the stores write asynchronously
    server.closeAllConnections?.();
    server.close();
  }
  console.log(ok ? `client revision now ${rev}; next: npm run cache:warm` : 'stopped early; the stored client is unchanged where a request failed');
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
