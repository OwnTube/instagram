'use strict';

/**
 * Structure-aware editing of the bootstrap data embedded in an original page.
 *
 * Meta's server renders its bootstrap into `<script type="application/json">`
 * blocks (ServerJS payloads: `require` call tuples and `define` module
 * tuples `[name, deps, exports, id]`), some of which contain further JSON
 * serialised into string fields. Rather than regex the HTML, each block is
 * parsed, walked with a visitor, and re-serialised safely. Blocks that do not
 * parse are left byte-for-byte untouched.
 */

const SCRIPT_JSON = /(<script\b[^>]*\btype\s*=\s*["']application\/json["'][^>]*>)([\s\S]*?)(<\/script>)/gi;
const REMOVE = Symbol('remove');

/** JSON that is safe inside a <script> element and the JS string grammar. */
function safeStringify(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003C')
    .replace(/>/g, '\\u003E')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function looksLikeJson(s) {
  return typeof s === 'string' && s.length > 1 && s.length < 5_000_000 && /^\s*[{[]/.test(s) && /[}\]]\s*$/.test(s);
}

/**
 * Depth-first walk. visit(node, ctx) may mutate node in place, return a
 * replacement, or return REMOVE to drop it from its parent array/object.
 * Strings that contain JSON are parsed, walked and re-serialised.
 */
function walk(node, visit, ctx = { depth: 0 }) {
  if (ctx.depth > 200) return node;
  const replaced = visit(node, ctx);
  if (replaced === REMOVE) return REMOVE;
  if (replaced !== undefined) node = replaced;

  if (typeof node === 'string' && looksLikeJson(node)) {
    let inner;
    try {
      inner = JSON.parse(node);
    } catch {
      return node;
    }
    const before = JSON.stringify(inner);
    const after = walk(inner, visit, { depth: ctx.depth + 1 });
    if (after === REMOVE) return node;
    const serialised = JSON.stringify(after);
    return serialised === before ? node : serialised;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const out = walk(node[i], visit, { depth: ctx.depth + 1 });
      if (out === REMOVE) {
        node.splice(i, 1);
        i -= 1;
      } else node[i] = out;
    }
    return node;
  }
  if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      const out = walk(node[key], visit, { depth: ctx.depth + 1, key, parent: node });
      if (out === REMOVE) delete node[key];
      else node[key] = out;
    }
  }
  return node;
}

/** Apply a visitor to every JSON script block. Returns { html, blocks, edited }. */
function editJsonBlocks(html, visit) {
  let blocks = 0;
  let edited = 0;
  const out = html.replace(SCRIPT_JSON, (whole, open, body, close) => {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return whole;
    }
    blocks += 1;
    const before = JSON.stringify(data);
    const after = walk(data, visit);
    if (after === REMOVE || JSON.stringify(after) === before) return whole;
    edited += 1;
    return `${open}${safeStringify(after)}${close}`;
  });
  return { html: out, blocks, edited };
}

/** A `define` tuple: ["ModuleName", [deps], {exports}, id]. */
function isDefineTuple(node) {
  return (
    Array.isArray(node) &&
    node.length >= 3 &&
    typeof node[0] === 'string' &&
    Array.isArray(node[1]) &&
    node[2] !== null &&
    typeof node[2] === 'object' &&
    !Array.isArray(node[2])
  );
}

/** A Relay prefetch: ["RelayPrefetchedStreamCache", "next", [], [preloaderKey, payload]]. */
function prefetchKey(node) {
  if (Array.isArray(node) && node[0] === 'RelayPrefetchedStreamCache' && node[1] === 'next' && Array.isArray(node[3])) {
    return typeof node[3][0] === 'string' ? node[3][0] : null;
  }
  return null;
}

module.exports = { walk, editJsonBlocks, isDefineTuple, prefetchKey, safeStringify, looksLikeJson, REMOVE };
