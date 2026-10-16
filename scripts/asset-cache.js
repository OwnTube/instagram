#!/usr/bin/env node
'use strict';

/**
 * The persistent local asset store (.cache/assets) and its manifest.
 *
 *   node scripts/asset-cache.js status   write .cache/manifest.json, list what is missing
 *   node scripts/asset-cache.js warm     fetch the missing PUBLIC static assets once
 *
 * References are collected from the cached anonymous documents
 * (.cache/documents): script/link tags, every `rsrcMap` entry (the code the
 * client's Bootloader may load later), image-sprite URLs (`ixData`), and the
 * url() references inside stored stylesheets (fonts, images), resolved against
 * each stylesheet's own URL. Only allow-listed static hosts are fetched, with
 * the loader's anonymous upstream client (no cookies), so its 429 cooldown and
 * LOADER_OFFLINE=1 apply. Nothing per-user is involved.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);
const { editJsonBlocks } = require('../src/shell/sjs');
const { createAssetStore } = require('../src/assetStore');
const { fetchUpstream, UpstreamError } = require('../src/upstream');
const { isAllowedUpstreamUrl } = require('../src/rewrite');

const ASSET_DIR = process.env.ASSET_CACHE_DIR || '.cache/assets';
const DOC_DIR = process.env.DOCUMENT_CACHE_DIR || '.cache/documents';
const MANIFEST = path.join('.cache', 'manifest.json');
const STATIC = /^https:\/\/(?:static|scontent)\.cdninstagram\.com\//;

function storedKeys() {
  const keys = new Map();
  if (!fs.existsSync(ASSET_DIR)) return keys;
  for (const f of fs.readdirSync(ASSET_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(ASSET_DIR, f), 'utf8'));
      keys.set(meta.key, { file: path.join(ASSET_DIR, f.replace(/\.json$/, '.body')), meta });
    } catch {
      /* a half-written entry; ignored */
    }
  }
  return keys;
}

function collectReferences(stored) {
  const refs = new Map();
  const add = (url, type, from) => {
    if (typeof url !== 'string' || !STATIC.test(url) || !isAllowedUpstreamUrl(url)) return;
    if (!refs.has(url)) refs.set(url, { type, from });
  };
  if (fs.existsSync(DOC_DIR)) {
    for (const f of fs.readdirSync(DOC_DIR).filter((x) => x.endsWith('.body'))) {
      const html = fs.readFileSync(path.join(DOC_DIR, f), 'utf8');
      // Stored documents are already rewritten: tags point at /__ig/<host>/...
      for (const m of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="((?:https:\/\/|\/__ig\/)[^"]+)"/g)) {
        const u = m[1].replace(/&amp;/g, '&');
        add(u.startsWith('/__ig/') ? `https://${u.slice('/__ig/'.length)}` : u, 'tag', 'document');
      }
      editJsonBlocks(html, (n) => {
        if (n && typeof n === 'object' && !Array.isArray(n)) {
          if (n.rsrcMap && typeof n.rsrcMap === 'object') {
            for (const e of Object.values(n.rsrcMap)) if (e && e.src) add(e.src, e.type || 'js', 'rsrcMap');
          }
          for (const k of ['spi', '_spi']) if (typeof n[k] === 'string') add(n[k], 'img', 'ixData');
        }
        return undefined;
      });
    }
  }
  // url() references in stored stylesheets, resolved against the sheet's URL.
  for (const [url, { file, meta }] of stored) {
    if (!/text\/css/.test(meta.entry.contentType || '') || !fs.existsSync(file)) continue;
    const css = fs.readFileSync(file, 'utf8');
    for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
      const raw = m[2].trim();
      if (/^(data:|#)/i.test(raw)) continue;
      let abs;
      if (raw.startsWith('/__ig/')) abs = `https://${raw.slice('/__ig/'.length)}`;
      else {
        try {
          abs = new URL(raw, url).href;
        } catch {
          continue;
        }
      }
      add(abs, /\.woff2?($|\?)/.test(abs) ? 'font' : 'img', 'css');
    }
  }
  return refs;
}

function writeManifest(refs, stored) {
  const entries = [];
  for (const [url, ref] of refs) {
    const s = stored.get(url);
    let bytes = null;
    let sha256 = null;
    if (s && fs.existsSync(s.file)) {
      const body = fs.readFileSync(s.file);
      bytes = body.length;
      sha256 = crypto.createHash('sha256').update(body).digest('hex');
    }
    entries.push({ url, type: ref.type, from: ref.from, stored: Boolean(s), bytes, sha256, storedAt: s ? s.meta.storedAt : null });
  }
  entries.sort((a, b) => a.url.localeCompare(b.url));
  const summary = { generatedAt: new Date().toISOString(), referenced: entries.length, stored: entries.filter((e) => e.stored).length };
  summary.missing = summary.referenced - summary.stored;
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify({ ...summary, entries }, null, 1));
  return { summary, entries };
}

async function warm() {
  const store = createAssetStore(ASSET_DIR);
  let fetched = 0;
  let failed = 0;
  // Stylesheets first, so the fonts and images they name are found next round.
  for (let round = 0; round < 2; round += 1) {
    const stored = storedKeys();
    const missing = [...collectReferences(stored)].filter(([url]) => !stored.has(url)).sort(([, a], [, b]) => (a.type === 'css' ? -1 : 0) - (b.type === 'css' ? -1 : 0));
    let index = 0;
    const worker = async () => {
      while (index < missing.length) {
        const [url] = missing[index++];
        try {
          const res = await fetchUpstream(url, { headers: { accept: '*/*' } });
          if (res.status !== 200) {
            failed += 1;
            console.warn(`  ${res.status} ${url}`);
            continue;
          }
          await store.write(url, {
            body: res.body,
            contentType: res.headers.get('content-type') || 'application/octet-stream',
            etag: res.headers.get('etag') || undefined,
            lastModified: res.headers.get('last-modified') || undefined,
          });
          fetched += 1;
        } catch (error) {
          failed += 1;
          console.warn(`  ${error instanceof UpstreamError ? error.status : 'ERR'} ${url}: ${error.message}`);
          if (error instanceof UpstreamError && (error.status === 429 || error.status === 504)) {
            index = missing.length; // throttled or offline: stop, do not hammer
          }
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }
  console.log(`warm: fetched ${fetched}, failed ${failed}`);
}

async function main() {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'warm') await warm();
  const stored = storedKeys();
  const { summary, entries } = writeManifest(collectReferences(stored), stored);
  console.log(`assets referenced ${summary.referenced}, stored ${summary.stored}, missing ${summary.missing} (manifest: ${MANIFEST})`);
  const byType = {};
  for (const e of entries.filter((x) => !x.stored)) byType[e.type] = (byType[e.type] || 0) + 1;
  if (summary.missing) console.log('missing by type', byType);
  process.exit(cmd === 'check' && summary.missing ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
