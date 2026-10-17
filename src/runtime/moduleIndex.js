'use strict';

/**
 * Index of the genuine client's Haste modules held in the local asset store.
 *
 * Meta bundles define modules as `__d("Name", ["Dep", ...], factory, flags)`.
 * The page's resource map (`rsrcMap`: hash -> {type, src}) names the files; the
 * component map (`compMap`: component -> {r: [hashes], rds, rdfds, be}) names
 * which files a lazily loaded component needs. This index records, from the
 * stored bytes only:
 *
 *   modules    name -> { file (upstream URL), deps }
 *   files      upstream URL -> { hash (from rsrcMap, if any), modules, text() }
 *   rsrc       hash -> { type, src } merged from every cached document
 *   comp       component -> entry merged from every cached document
 *
 * Nothing is inferred beyond what the stored bytes and documents state.
 */

const fs = require('node:fs');
const path = require('node:path');
const { editJsonBlocks } = require('../shell/sjs');

const DEFINE = /__d\(\s*"([^"\\]{1,300})"\s*,\s*\[([^\]]*)\]/g;

function parseDeps(list) {
  const deps = [];
  for (const m of list.matchAll(/"([^"\\]{1,300})"/g)) deps.push(m[1]);
  return deps;
}

function readStore(dir) {
  const entries = [];
  if (!fs.existsSync(dir)) return entries;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const body = path.join(dir, f.replace(/\.json$/, '.body'));
      if (fs.existsSync(body)) entries.push({ key: meta.key, meta, bodyPath: body });
    } catch {
      /* half-written entry */
    }
  }
  return entries;
}

/** The disk stores as an index source (operator tools that read the stores directly). */
function storeSource({ assetDir = '.cache/assets', documentDir = '.cache/documents', bootloaderDir = '.cache/bootloader' } = {}) {
  const item = (e) => ({ key: e.key, contentType: (e.meta.entry && e.meta.entry.contentType) || '', text: () => fs.readFileSync(e.bodyPath, 'utf8'), bytes: () => fs.statSync(e.bodyPath).size });
  return { documents: readStore(documentDir).map(item), answers: readStore(bootloaderDir).map(item), assets: readStore(assetDir).map(item) };
}

/**
 * A pinned client snapshot as an index source: exactly the documents, answers
 * and assets the server serves (src/clientSnapshot.js), so operation contracts
 * are those of the client revision the browser runs.
 */
function snapshotSource(store, manifest) {
  const item = (key, e) => ({ key, contentType: e.contentType, text: () => store.readBlob(e.sha256).toString('utf8'), bytes: () => e.bytes });
  const html = Object.entries(manifest.documents).filter(([, e]) => /text\/html/.test(e.contentType));
  return {
    documents: html.map(([k, e]) => item(k, e)),
    answers: Object.entries(manifest.answers).map(([k, e]) => item(k, e)),
    assets: Object.entries(manifest.assets).map(([k, e]) => item(k, e)),
  };
}

/** Index `source` ({documents, answers, assets}: items {key, contentType, text(), bytes()}), or the disk stores by default. */
function buildModuleIndex(source = {}) {
  const { documents: docItems, answers: answerItems, assets: assetItems } = source.documents ? source : storeSource(source);
  const modules = new Map();
  const files = new Map();
  const rsrc = new Map();
  const comp = new Map();
  const documents = [];
  /** Modules defined in payloads (documents' and bootloader answers' `define` lists, e.g. cr:NNN). */
  const payloadDefines = new Map();
  const noteSupport = (n, from) => {
    if (!n || typeof n !== 'object' || Array.isArray(n)) return;
    if (n.rsrcMap && typeof n.rsrcMap === 'object') {
      for (const [hash, e] of Object.entries(n.rsrcMap)) if (e && e.src && !rsrc.has(hash)) rsrc.set(hash, { type: e.type, src: e.src, from });
    }
    if (n.compMap && typeof n.compMap === 'object') {
      for (const [name, e] of Object.entries(n.compMap)) if (!comp.has(name)) comp.set(name, { ...e, from });
    }
    if (Array.isArray(n.define)) {
      for (const d of n.define) if (Array.isArray(d) && typeof d[0] === 'string' && !payloadDefines.has(d[0])) payloadDefines.set(d[0], { deps: Array.isArray(d[1]) ? d[1] : [], from });
    }
  };

  for (const doc of docItems) {
    const html = doc.text();
    documents.push(doc.key);
    editJsonBlocks(html, (n) => {
      noteSupport(n, doc.key);
      return undefined;
    });
  }
  for (const answer of answerItems) {
    try {
      const j = JSON.parse(answer.text().replace(/^for \(;;\);/, ''));
      const hrp = j.hrp || {};
      noteSupport(hrp.hsrp && hrp.hsrp.hblp, answer.key);
      noteSupport(hrp.jsmods, answer.key);
    } catch {
      /* not a JSON answer */
    }
  }
  const hashBySrc = new Map([...rsrc].map(([hash, e]) => [e.src, hash]));

  for (const asset of assetItems) {
    if (!/javascript/.test(asset.contentType)) continue;
    const text = asset.text();
    const names = [];
    for (const m of text.matchAll(DEFINE)) {
      const name = m[1];
      names.push(name);
      if (!modules.has(name)) modules.set(name, { file: asset.key, deps: parseDeps(m[2]) });
    }
    files.set(asset.key, { hash: hashBySrc.get(asset.key) || null, modules: names, bytes: asset.bytes(), text: asset.text });
  }

  return {
    modules,
    files,
    rsrc,
    comp,
    documents,
    payloadDefines,
    /** Every dependency of `name` (transitively) and those not defined locally. */
    closure(name) {
      const seen = new Set();
      const missing = new Set();
      const stack = [name];
      while (stack.length) {
        const cur = stack.pop();
        if (seen.has(cur)) continue;
        seen.add(cur);
        const mod = modules.get(cur) || payloadDefines.get(cur);
        if (!mod) {
          missing.add(cur);
          continue;
        }
        for (const d of mod.deps) if (!seen.has(d)) stack.push(d);
      }
      return { modules: [...seen].filter((m) => !missing.has(m)), missing: [...missing] };
    },
  };
}

module.exports = { buildModuleIndex, snapshotSource, storeSource, parseDeps };
