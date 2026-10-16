'use strict';

/**
 * Read a GraphQL operation's selection tree from the client's own compiled Relay
 * artifact (`<Operation>.graphql`, a pure `__d` factory in the stored bundles).
 * The factory runs in a sandbox with stubbed requires (provider modules and the
 * operation-id module are only referenced, not needed for the shape).
 *
 * selectionTree(node) -> { field: subtree | true } for the operation's
 * normalisation AST (`operation.selections`), merging inline fragments and
 * conditions, with `__typename`-keyed alternatives kept as `... on Type`.
 *
 * Two node kinds follow Relay's own semantics:
 *  - `ClientExtension` holds client-schema fields; the server never sends them
 *    and RelayReader does not count them as missing, so they are left out;
 *  - `RelayResolver` carries the resolver's root `fragment`: the server fields a
 *    client resolver reads are selected only there (e.g. `view_state_item_type`
 *    read by `client__feedDedupedIds`). If any is absent, `readFragment` throws
 *    Relay's missing-data sentinel and the resolver yields nothing.
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const vm = require('node:vm');

function moduleSource(index, name, assetDir = '.cache/assets') {
  const mod = index.modules.get(name);
  if (!mod) return null;
  const file = path.join(assetDir, `${crypto.createHash('sha256').update(mod.file).digest('hex')}.body`);
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf(`__d("${name}"`);
  if (start < 0) return null;
  // The definition ends where the next __d( begins (or at the package delimiter).
  const nextDelim = text.indexOf('/*FB_PKG_DELIM*/', start);
  const nextDefine = text.indexOf('__d("', start + 5);
  const ends = [nextDelim, nextDefine].filter((x) => x > start);
  return text.slice(start, ends.length ? Math.min(...ends) : text.length);
}

/** Evaluate a compiled `.graphql` module and return its exports. */
function loadArtifact(index, name) {
  const source = moduleSource(index, name);
  if (!source) return null;
  let exportsValue = null;
  const stub = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : stub), apply: () => stub });
  const sandbox = {
    __d(modName, deps, factory) {
      const module = { exports: {} };
      const req = (dep) => (typeof dep === 'string' && dep.endsWith('_facebookRelayOperation') ? `${dep}` : stub);
      factory(globalThis, req, req, req, module, module.exports);
      exportsValue = module.exports;
    },
  };
  vm.runInNewContext(source, sandbox, { timeout: 2000 });
  return exportsValue;
}

function selectionTree(selections, out = {}) {
  for (const sel of selections || []) {
    switch (sel.kind) {
      case 'ScalarField':
        out[sel.alias || sel.name] = out[sel.alias || sel.name] || true;
        break;
      case 'LinkedField': {
        const key = sel.alias || sel.name;
        const sub = out[key] && typeof out[key] === 'object' ? out[key] : {};
        out[key] = selectionTree(sel.selections, sub);
        if (sel.plural) out[key].__plural = true;
        if (sel.concreteType) out[key].__concrete = sel.concreteType;
        break;
      }
      case 'InlineFragment':
        if (sel.type && sel.abstractKey == null) {
          const key = `... on ${sel.type}`;
          out[key] = selectionTree(sel.selections, out[key] || {});
        } else selectionTree(sel.selections, out);
        break;
      case 'ClientExtension':
        break;
      case 'RelayResolver':
      case 'RelayLiveResolver':
        if (sel.fragment) selectionTree([sel.fragment], out);
        break;
      case 'Condition':
      case 'Defer':
      case 'Stream':
      case 'ModuleImport':
      case 'TypeDiscriminator':
        selectionTree(sel.selections, out);
        break;
      default:
        if (sel.selections) selectionTree(sel.selections, out);
    }
  }
  return out;
}

/** The operation's response tree (normalisation AST). */
function operationTree(index, operationName) {
  const artifact = loadArtifact(index, `${operationName}.graphql`);
  if (!artifact || !artifact.operation) return null;
  return selectionTree(artifact.operation.selections);
}

/** Paths present in `tree` but absent from `value` (an actual response). */
/** The `... on Type` subtree keys that apply to `value` (by its own or the declared type). */
function matchingFragments(tree, value) {
  const type = value.__typename || tree.__concrete;
  return Object.keys(tree).filter((key) => key.startsWith('... on ') && key.slice(7) === type);
}

function missingPaths(tree, value, prefix = '') {
  const out = [];
  if (value == null || typeof value !== 'object') return out;
  for (const key of matchingFragments(tree, value)) out.push(...missingPaths(tree[key], value, prefix));
  for (const [key, sub] of Object.entries(tree)) {
    if (key === '__plural' || key === '__concrete' || key.startsWith('... on ')) continue;
    if (key.startsWith('__') && key !== '__typename') continue;
    const at = prefix ? `${prefix}.${key}` : key;
    if (!(key in value)) {
      out.push(at);
      continue;
    }
    if (sub && typeof sub === 'object') {
      const v = value[key];
      const items = Array.isArray(v) ? v : [v];
      for (const item of items.slice(0, 1)) out.push(...missingPaths(sub, item, at));
    }
  }
  return out;
}

/**
 * Complete `value` to the selection tree: a selected field the resolver did not
 * produce becomes an explicit null, and `__typename` becomes the concrete type
 * the artifact declares for that field. A `... on Type` selection applies when
 * the record is of that type. Present values are never changed.
 * Returns the number of fields added.
 */
function completeToContract(tree, value) {
  let added = 0;
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return added;
  for (const key of matchingFragments(tree, value)) added += completeToContract({ ...tree[key], __concrete: tree.__concrete }, value);
  for (const [key, sub] of Object.entries(tree)) {
    if (key === '__plural' || key === '__concrete' || key.startsWith('... on ')) continue;
    // Relay-internal fields (`__id` is the record's own client ID) are not
    // server data; a null there corrupts the store.
    if (key.startsWith('__') && key !== '__typename') continue;
    if (!(key in value)) {
      value[key] = key === '__typename' && tree.__concrete ? tree.__concrete : null;
      added += 1;
      continue;
    }
    if (sub && typeof sub === 'object' && value[key] != null) {
      for (const item of Array.isArray(value[key]) ? value[key] : [value[key]]) added += completeToContract(sub, item);
    }
  }
  return added;
}

/** Cached operation trees for a module index (null when an artifact is not stored). */
function createContractCache(getIndex) {
  const trees = new Map();
  return {
    tree(operationName) {
      if (!trees.has(operationName)) {
        let tree = null;
        try {
          const index = getIndex();
          tree = index ? operationTree(index, operationName) : null;
        } catch {
          tree = null;
        }
        trees.set(operationName, tree);
      }
      return trees.get(operationName);
    },
  };
}

module.exports = { moduleSource, loadArtifact, selectionTree, operationTree, missingPaths, completeToContract, createContractCache };
