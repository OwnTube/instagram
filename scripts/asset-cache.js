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
 * client's Bootloader may load later), image URLs (`ixData`, sprited or not), and the
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
const BOOT_DIR = process.env.BOOTLOADER_CACHE_DIR || '.cache/bootloader';
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

/** Every stored document's and answer's text, as collectReferences reads them. */
function storedTexts() {
  const read = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.body')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')) : []);
  return { documents: read(DOC_DIR), answers: read(BOOT_DIR) };
}

function collectReferences(stored) {
  return referencesFrom({ ...storedTexts(), stored });
}

/**
 * The public static assets that `documents` (HTML) and `answers`
 * (bootloader-endpoint answer texts) reference, plus the url()s inside the
 * stylesheets among them found in `stored`. Map url -> { type, from }.
 */
function referencesFrom({ documents, answers, stored }) {
  const refs = new Map();
  const add = (url, type, from) => {
    if (typeof url !== 'string' || !STATIC.test(url) || !isAllowedUpstreamUrl(url)) return;
    if (!refs.has(url)) refs.set(url, { type, from });
  };
  {
    for (const html of documents) {
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
          // A non-sprited image entry ({sprited: 0, uri, width, height}).
          if ('sprited' in n && typeof n.uri === 'string') add(n.uri, 'img', 'ixData');
        }
        return undefined;
      });
    }
  }
  // Stored bootloader-endpoint answers: the resource map of lazily loaded modules.
  {
    for (const text of answers) {
      try {
        const answer = JSON.parse(text.replace(/^for \(;;\);/, ''));
        const map = answer && answer.hrp && answer.hrp.hsrp && answer.hrp.hsrp.hblp && answer.hrp.hsrp.hblp.rsrcMap;
        for (const e of Object.values(map || {})) if (e && e.src) add(e.src, e.type || 'js', 'bootloader');
        const ix = answer && answer.hrp && answer.hrp.hsrp && answer.hrp.hsrp.hsdp && answer.hrp.hsrp.hsdp.ixData;
        for (const e of Object.values(ix || {})) {
          for (const k of ['spi', '_spi']) if (e && typeof e[k] === 'string') add(e[k], 'img', 'bootloader');
          if (e && 'sprited' in e && typeof e.uri === 'string') add(e.uri, 'img', 'bootloader');
        }
      } catch {
        /* not a JSON answer */
      }
    }
  }

  // url() references in stored stylesheets, resolved against the sheet's URL.
  for (const [url, { file, meta }] of stored) {
    if (!refs.has(url) || !/text\/css/.test(meta.entry.contentType || '') || !fs.existsSync(file)) continue;
    const css = fs.readFileSync(file, 'utf8');
    for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
      const raw = m[2].trim();
      // A fragment (also percent-encoded, as in url(%23clip0_...)) names an SVG element, not a file.
      if (/^(data:|#|%23)/i.test(raw)) continue;
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

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { collectReferences, referencesFrom, storedKeys };
