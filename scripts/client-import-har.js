#!/usr/bin/env node
'use strict';

/**
 * Import client material from a HAR recorded in a browser, without sending
 * any request. Only the genuine client's own public material is taken:
 *
 *  - static bundles (scripts, styles, wasm) from the client's static hosts,
 *    keyed by their URL in the asset store (.cache/assets). Those URLs name
 *    immutable files. A URL already stored is never overwritten; a stored
 *    copy whose bytes differ is reported as a conflict;
 *  - bootloader-endpoint answers, staged by the revision each declares, in
 *    .cache/acquired/har-<stamp>-rev<revision>/bootloader. They are keyed by
 *    `modules|nb_modules` only: the request's other parameters (session,
 *    user and token fields) are never read or stored;
 *  - navigation documents (HTML of www.instagram.com pages), staged the same
 *    way, when the HAR has them.
 *
 * Nothing else is read: no API or GraphQL response, header or cookie. The
 * HAR itself is not copied (provenance records its sha256 only).
 *
 * A staged revision becomes a snapshot only through the normal build, which
 * needs that revision's root document: the build refuses a revision without
 * one, and never mixes material of two revisions.
 *
 *   node scripts/client-import-har.js <file.har> [--dry-run]
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);
const { createAssetStore } = require('../src/assetStore');
const { answerRevision, revisionOfText } = require('../src/clientSnapshot');
const { isAllowedUpstreamUrl } = require('../src/rewrite');

const ORIGIN = 'https://www.instagram.com';
const ASSET_DIR = process.env.ASSET_CACHE_DIR || '.cache/assets';
const ACQUIRED_DIR = process.env.ACQUIRED_DIR || path.join(ROOT, '.cache', 'acquired');
const STATIC_PATH = /^\/rsrc\.php\//;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function body(content) {
  if (!content || typeof content.text !== 'string' || !content.text) return null;
  return content.encoding === 'base64' ? Buffer.from(content.text, 'base64') : Buffer.from(content.text, 'utf8');
}

/** What an entry is, for import: { kind, ... } or { kind: 'ignored', why }. */
function classify(entry) {
  let url;
  try {
    url = new URL(entry.request.url);
  } catch {
    return { kind: 'ignored', why: 'bad URL' };
  }
  const status = entry.response && entry.response.status;
  const contentType = (entry.response && entry.response.content && entry.response.content.mimeType) || '';
  if (entry.request.method !== 'GET' || status !== 200) return { kind: 'ignored', why: 'not a 200 GET' };
  if (STATIC_PATH.test(url.pathname) && !url.search && isAllowedUpstreamUrl(url.href) && /javascript|css|wasm/.test(contentType)) return { kind: 'asset', url: url.href, contentType };
  if (url.origin === ORIGIN && url.pathname === '/ajax/bootloader-endpoint/') {
    // Only the module names; every other parameter of this request is session state.
    return { kind: 'answer', modules: url.searchParams.get('modules') || '', nbModules: url.searchParams.get('nb_modules') || '', contentType };
  }
  if (url.origin === ORIGIN && /text\/html/.test(contentType) && entry.request.headers.some((h) => /^sec-fetch-dest$/i.test(h.name) && h.value === 'document')) return { kind: 'document', path: url.pathname, contentType };
  return { kind: 'ignored', why: 'not client material' };
}

async function main() {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) {
    console.error('usage: node scripts/client-import-har.js <file.har> [--dry-run]');
    return 2;
  }
  const dryRun = process.argv.includes('--dry-run');
  const raw = fs.readFileSync(file);
  const har = JSON.parse(raw.toString('utf8'));
  const entries = (har.log && har.log.entries) || [];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const assetStore = createAssetStore(ASSET_DIR);
  const groups = new Map(); // revision -> { answers: [], documents: [] }
  const group = (rev) => groups.get(rev) || groups.set(rev, { answers: [], documents: [] }).get(rev);
  const report = { assets: { added: 0, present: 0, conflict: [] }, ignored: {}, refused: [] };

  for (const entry of entries) {
    const c = classify(entry);
    if (c.kind === 'ignored') {
      report.ignored[c.why] = (report.ignored[c.why] || 0) + 1;
      continue;
    }
    const bytes = body(entry.response.content);
    if (!bytes) {
      report.refused.push({ kind: c.kind, key: c.url || c.modules || c.path, reason: 'no body recorded' });
      continue;
    }
    if (c.kind === 'asset') {
      const stored = await assetStore.read(c.url);
      if (stored) {
        if (sha256(stored.body) === sha256(bytes)) report.assets.present += 1;
        else report.assets.conflict.push(c.url);
        continue;
      }
      if (!dryRun) await assetStore.write(c.url, { body: bytes, contentType: c.contentType, fetchedAt: Date.now(), source: 'har' });
      report.assets.added += 1;
    } else if (c.kind === 'answer') {
      const rev = answerRevision(bytes.toString('utf8'));
      if (!rev) {
        report.refused.push({ kind: 'answer', key: `${c.modules}|${c.nbModules}`, reason: 'declares no revision' });
        continue;
      }
      group(rev).answers.push({ key: `${c.modules}|${c.nbModules}`, modules: c.modules, nbModules: c.nbModules, bytes, contentType: c.contentType });
    } else if (c.kind === 'document') {
      const rev = revisionOfText(bytes.toString('utf8'));
      if (!rev) {
        report.refused.push({ kind: 'document', key: c.path, reason: 'no client revision' });
        continue;
      }
      group(rev).documents.push({ path: c.path, bytes, contentType: c.contentType });
    }
  }

  console.log(`HAR ${path.basename(file)}: ${entries.length} entries`);
  console.log(`  static assets: ${report.assets.added} new, ${report.assets.present} already stored${report.assets.conflict.length ? `, ${report.assets.conflict.length} CONFLICT (stored bytes differ; kept the stored copy)` : ''}`);
  for (const [why, n] of Object.entries(report.ignored)) console.log(`  ignored ${n}: ${why}`);
  for (const r of report.refused) console.log(`  refused ${r.kind} ${r.key}: ${r.reason}`);
  for (const [rev, g] of groups) {
    const staging = path.join(ACQUIRED_DIR, `har-${stamp}-rev${rev}`);
    const hasRoot = g.documents.some((d) => d.path === '/');
    console.log(`  revision ${rev}: ${g.answers.length} answers, ${g.documents.length} documents${hasRoot ? '' : ' (no root document: this revision cannot be built into a snapshot on its own)'}${dryRun ? '' : ` -> ${path.relative(ROOT, staging)}`}`);
    if (dryRun) continue;
    const bootStore = createAssetStore(path.join(staging, 'bootloader'));
    const docStore = createAssetStore(path.join(staging, 'documents'));
    const requests = [];
    for (const a of g.answers) {
      await bootStore.write(`boot:${ORIGIN}:${a.key}|${rev}`, { body: a.bytes, contentType: a.contentType || 'application/x-javascript' });
      requests.push({ kind: 'answer', key: a.key, status: 200, sha256: sha256(a.bytes), bytes: a.bytes.length, contentType: a.contentType });
    }
    for (const d of g.documents) {
      await docStore.write(`doc:${ORIGIN}:nav:${d.path}`, { body: d.bytes, contentType: d.contentType });
      requests.push({ kind: 'document', key: d.path, status: 200, sha256: sha256(d.bytes), bytes: d.bytes.length, contentType: d.contentType });
    }
    const provenance = {
      origin: ORIGIN,
      source: 'har',
      harSha256: sha256(raw),
      importedAt: new Date().toISOString(),
      revision: rev,
      // Recorded by a signed-in browser: answers may carry that session's
      // feature-flag values (support data), never its identity (not imported).
      recordedSignedIn: true,
      anonymous: false,
      requests,
      complete: hasRoot,
      stoppedReason: hasRoot ? null : `the HAR has no root document of revision ${rev}`,
    };
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'provenance.json'), JSON.stringify(provenance, null, 1));
  }
  return report.assets.conflict.length ? 1 : 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { classify };
