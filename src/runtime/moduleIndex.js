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
 *   files      upstream URL -> { hash (from rsrcMap, if any), modules }
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

function buildModuleIndex({ assetDir = '.cache/assets', documentDir = '.cache/documents' } = {}) {
  const modules = new Map();
  const files = new Map();
  const rsrc = new Map();
  const comp = new Map();
  const documents = [];

  for (const doc of readStore(documentDir)) {
    const html = fs.readFileSync(doc.bodyPath, 'utf8');
    documents.push(doc.key);
    editJsonBlocks(html, (n) => {
      if (n && typeof n === 'object' && !Array.isArray(n)) {
        if (n.rsrcMap && typeof n.rsrcMap === 'object') {
          for (const [hash, e] of Object.entries(n.rsrcMap)) if (e && e.src && !rsrc.has(hash)) rsrc.set(hash, { type: e.type, src: e.src, from: doc.key });
        }
        if (n.compMap && typeof n.compMap === 'object') {
          for (const [name, e] of Object.entries(n.compMap)) if (!comp.has(name)) comp.set(name, { ...e, from: doc.key });
        }
      }
      return undefined;
    });
  }
  const hashBySrc = new Map([...rsrc].map(([hash, e]) => [e.src, hash]));

  for (const asset of readStore(assetDir)) {
    if (!/javascript/.test(asset.meta.entry && asset.meta.entry.contentType)) continue;
    const text = fs.readFileSync(asset.bodyPath, 'utf8');
    const names = [];
    for (const m of text.matchAll(DEFINE)) {
      const name = m[1];
      names.push(name);
      if (!modules.has(name)) modules.set(name, { file: asset.key, deps: parseDeps(m[2]) });
    }
    files.set(asset.key, { hash: hashBySrc.get(asset.key) || null, modules: names, bytes: fs.statSync(asset.bodyPath).size });
  }

  return {
    modules,
    files,
    rsrc,
    comp,
    documents,
    /** Every dependency of `name` (transitively) and those not defined locally. */
    closure(name) {
      const seen = new Set();
      const missing = new Set();
      const stack = [name];
      while (stack.length) {
        const cur = stack.pop();
        if (seen.has(cur)) continue;
        seen.add(cur);
        const mod = modules.get(cur);
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

module.exports = { buildModuleIndex, parseDeps };
