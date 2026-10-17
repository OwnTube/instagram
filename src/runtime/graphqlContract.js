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

// Recently read file texts, per index (a bundle holds many modules; a few
// files are kept, not the whole client).
const fileTexts = new WeakMap();
const FILE_TEXTS_KEPT = 16;

function moduleSource(index, name, assetDir = '.cache/assets') {
  const mod = index.modules.get(name);
  if (!mod) return null;
  // The indexed source's own bytes (a pinned snapshot's blob); the URL-keyed
  // disk store only for an index built without text accessors.
  const entry = index.files && index.files.get(mod.file);
  let texts = fileTexts.get(index);
  if (!texts) fileTexts.set(index, (texts = new Map()));
  let text = texts.get(mod.file);
  if (text === undefined) {
    text = entry && typeof entry.text === 'function' ? entry.text() : fs.readFileSync(path.join(assetDir, `${crypto.createHash('sha256').update(mod.file).digest('hex')}.body`), 'utf8');
    if (texts.size >= FILE_TEXTS_KEPT) texts.delete(texts.keys().next().value);
  } else texts.delete(mod.file);
  texts.set(mod.file, text);
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
        if (sel.alias && sel.alias !== sel.name) out.__aliases = { ...out.__aliases, [sel.alias]: sel.name };
        break;
      case 'LinkedField': {
        const key = sel.alias || sel.name;
        if (sel.alias && sel.alias !== sel.name) out.__aliases = { ...out.__aliases, [sel.alias]: sel.name };
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
        } else {
          // An interface's spread: Relay applies it to a record only when the
          // record carries the discriminator (see TypeDiscriminator).
          if (sel.abstractKey) out.__discriminators = [...new Set([...(out.__discriminators || []), sel.abstractKey])];
          selectionTree(sel.selections, out);
        }
        break;
      case 'ClientExtension':
        break;
      case 'RelayResolver':
      case 'RelayLiveResolver':
        if (sel.fragment) selectionTree([sel.fragment], out);
        break;
      // `... on Interface { __isInterface: __typename }`: the server answers
      // the record's type name under the abstract key when the type is one of
      // the interface's possible types, and Relay matches fragments on that
      // interface only for records carrying it (an item without it renders
      // nothing). Nested abstract spreads are recorded at their own level.
      case 'TypeDiscriminator':
        out.__discriminators = [...new Set([...(out.__discriminators || []), sel.abstractKey])];
        break;
      case 'Condition':
      case 'Defer':
      case 'Stream':
      case 'ModuleImport':
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
 * the record is of that type; an abstract type's discriminator
 * (`__isInterface`) is the record's type name when `possibleTypes` (see
 * possibleTypesIndex) lists that type for it. Present values are never
 * changed.
 * Returns the number of fields added.
 */
function completeToContract(tree, value, possibleTypes = null) {
  let added = 0;
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return added;
  for (const key of matchingFragments(tree, value)) added += completeToContract({ ...tree[key], __concrete: tree.__concrete }, value, possibleTypes);
  // An abstract spread's discriminator (`__isShareSheetItem`) is the record's
  // type name, but only for a type the client's own artifacts show to be a
  // possible type of that abstract type (possibleTypes: abstract key -> Set);
  // with no such evidence nothing is added. A value present is kept.
  const typename = value.__typename || tree.__concrete;
  for (const key of tree.__discriminators || []) {
    const possible = possibleTypes ? possibleTypes(key) : null;
    if (!(key in value) && typename && possible && possible.has(typename)) {
      value[key] = typename;
      added += 1;
    }
  }
  for (const [key, sub] of Object.entries(tree)) {
    if (key === '__plural' || key === '__concrete' || key.startsWith('... on ')) continue;
    // Relay-internal fields (`__id` is the record's own client ID) are not
    // server data; a null there corrupts the store.
    if (key.startsWith('__') && key !== '__typename') continue;
    if (!(key in value)) {
      // An aliased field (`owner_id: user`) answered under its own name: the
      // alias is the same field, so it takes that value.
      const field = tree.__aliases && tree.__aliases[key];
      value[key] = field && value[field] !== undefined ? structuredClone(value[field]) : key === '__typename' && tree.__concrete ? tree.__concrete : null;
      added += 1;
      if (!(sub && typeof sub === 'object' && value[key] != null)) continue;
      for (const item of Array.isArray(value[key]) ? value[key] : [value[key]]) added += completeToContract(sub, item, possibleTypes);
      continue;
    }
    if (sub && typeof sub === 'object' && value[key] != null) {
      for (const item of Array.isArray(value[key]) ? value[key] : [value[key]]) added += completeToContract(sub, item, possibleTypes);
    }
  }
  return added;
}

/**
 * Abstract key (`__isX`) -> Set of concrete type names, from the client's own
 * compiled artifacts. Relay's compiler accepts a spread only where it can
 * apply (GraphQL's possible-fragment-spread rule), so two facts are certain:
 *  - an abstract spread `... on X` (or `X`'s TypeDiscriminator) directly
 *    under a field or fragment of concrete type C: C is a possible type of X;
 *  - an inline fragment `... on C` (C concrete) directly inside a fragment or
 *    inline fragment on abstract X: C is a possible type of X.
 * Nothing else is inferred; a type not shown this way gets no discriminator.
 */
function collectPossibleTypes(selections, ctx, out) {
  const add = (key, type) => {
    if (!key || !type) return;
    if (!out.has(key)) out.set(key, new Set());
    out.get(key).add(type);
  };
  for (const sel of selections || []) {
    if (!sel || typeof sel !== 'object') continue;
    switch (sel.kind) {
      case 'LinkedField':
        collectPossibleTypes(sel.selections, { concrete: sel.concreteType || null, abstract: null }, out);
        break;
      case 'InlineFragment':
        if (sel.abstractKey) {
          add(sel.abstractKey, ctx.concrete);
          collectPossibleTypes(sel.selections, { concrete: ctx.concrete, abstract: sel.abstractKey }, out);
        } else if (sel.type) {
          add(ctx.abstract, sel.type);
          collectPossibleTypes(sel.selections, { concrete: sel.type, abstract: null }, out);
        } else collectPossibleTypes(sel.selections, ctx, out);
        break;
      case 'TypeDiscriminator':
        add(sel.abstractKey, ctx.concrete);
        break;
      case 'RelayResolver':
      case 'RelayLiveResolver':
        if (sel.fragment) collectPossibleTypes([sel.fragment], ctx, out);
        break;
      default:
        if (sel.selections) collectPossibleTypes(sel.selections, ctx, out);
    }
  }
  return out;
}

/** The possible-types map of one artifact (fragment and/or operation). */
function artifactPossibleTypes(artifact, out = new Map()) {
  const roots = [artifact, artifact && artifact.fragment, artifact && artifact.operation].filter((n) => n && Array.isArray(n.selections));
  for (const root of new Set(roots)) {
    const isFragment = root.kind === 'Fragment' || root.kind === 'SplitOperation';
    const ctx = isFragment && root.abstractKey ? { concrete: null, abstract: root.abstractKey } : { concrete: isFragment ? root.type || null : null, abstract: null };
    collectPossibleTypes(root.selections, ctx, out);
  }
  return out;
}

/** Scan every stored `.graphql` artifact that mentions an abstract key. */
function possibleTypesIndex(index) {
  const out = new Map();
  for (const name of index.modules.keys()) {
    if (!name.endsWith('.graphql')) continue;
    let source;
    try {
      source = moduleSource(index, name);
    } catch {
      continue;
    }
    if (!source || !source.includes('abstractKey:"__is')) continue;
    try {
      const artifact = loadArtifact(index, name);
      if (artifact) artifactPossibleTypes(artifact, out);
    } catch {
      // An artifact that does not evaluate contributes nothing.
    }
  }
  return out;
}

/** Cached operation trees for a module index (null when an artifact is not stored). */
function createContractCache(getIndex) {
  const trees = new Map();
  let possible = null;
  return {
    /** abstract key -> Set of possible concrete types (built once, lazily). */
    possibleTypes(key) {
      if (!possible) {
        try {
          const index = getIndex();
          possible = index ? possibleTypesIndex(index) : new Map();
        } catch {
          possible = new Map();
        }
      }
      return possible.get(key) || null;
    },
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

module.exports = { moduleSource, loadArtifact, selectionTree, operationTree, missingPaths, completeToContract, createContractCache, artifactPossibleTypes, possibleTypesIndex };
