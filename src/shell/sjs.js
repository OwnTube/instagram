'use strict';

/**
 * Structure-aware, byte-preserving editing of the bootstrap data embedded in an
 * original page.
 *
 * Meta's server renders its bootstrap into `<script type="application/json">`
 * blocks (ServerJS payloads: `require` call tuples and `define` module tuples
 * `[name, deps, exports, id]`), some of which carry further JSON inside string
 * fields. A visitor sees each block as plain parsed values and may mutate them,
 * replace them, or return REMOVE.
 *
 * The output is NOT a re-serialisation of the parsed block. A JSON.parse /
 * JSON.stringify round trip is lossy for this data: integers above 2^53 lose
 * precision, integer-like object keys are reordered, duplicate keys collapse,
 * and number and escape spellings change. The client's module bootstrap
 * (HasteSupportData) does not survive that. Instead every block is parsed
 * with source positions, and every value the visitor left unchanged is copied
 * from the original text byte for byte; only changed values are re-encoded.
 * A block the visitor did not change is returned exactly as it arrived.
 */

const SCRIPT_JSON = /(<script\b[^>]*\btype\s*=\s*["']application\/json["'][^>]*>)([\s\S]*?)(<\/script>)/gi;
const REMOVE = Symbol('remove');
const MAX_DEPTH = 200;

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

/* ------------------------------ parsing ------------------------------- */

const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/**
 * Parse JSON text into span nodes: { t, start, end, v, kids }.
 *   t     'o' object, 'a' array, 's' string, 'n' number, 'l' true/false/null
 *   v     the plain parsed value (fresh objects/arrays, linked back by spanOf)
 *   kids  object: [{ key, keyStart, node }]; array: [node]
 * Throws on malformed input, so the caller can leave such a block untouched.
 */
function parseWithSpans(text, spanOf) {
  let i = 0;
  const ws = () => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i += 1;
  };
  const fail = () => {
    throw new SyntaxError(`invalid JSON at ${i}`);
  };

  function str() {
    const start = i;
    i += 1;
    let out = '';
    let chunk = i;
    for (;;) {
      if (i >= text.length) fail();
      const c = text.charCodeAt(i);
      if (c === 34) break;
      if (c === 92) {
        out += text.slice(chunk, i);
        const e = text[i + 1];
        if (e === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else if (e in ESCAPES) {
          out += ESCAPES[e];
          i += 2;
        } else fail();
        chunk = i;
      } else {
        if (c < 0x20) fail();
        i += 1;
      }
    }
    out += text.slice(chunk, i);
    i += 1;
    return { t: 's', start, end: i, v: out };
  }

  function value(depth) {
    if (depth > MAX_DEPTH * 4) fail();
    ws();
    const start = i;
    const c = text[i];
    if (c === '"') return str();
    if (c === '{') {
      i += 1;
      const kids = [];
      const v = {};
      ws();
      if (text[i] === '}') i += 1;
      else {
        for (;;) {
          ws();
          if (text[i] !== '"') fail();
          const keyNode = str();
          ws();
          if (text[i] !== ':') fail();
          i += 1;
          const node = value(depth + 1);
          kids.push({ key: keyNode.v, keyStart: keyNode.start, node });
          v[keyNode.v] = node.v;
          ws();
          if (text[i] === ',') i += 1;
          else if (text[i] === '}') {
            i += 1;
            break;
          } else fail();
        }
      }
      const node = { t: 'o', start, end: i, v, kids };
      spanOf.set(v, node);
      return node;
    }
    if (c === '[') {
      i += 1;
      const kids = [];
      ws();
      if (text[i] === ']') i += 1;
      else {
        for (;;) {
          kids.push(value(depth + 1));
          ws();
          if (text[i] === ',') i += 1;
          else if (text[i] === ']') {
            i += 1;
            break;
          } else fail();
        }
      }
      const v = kids.map((k) => k.v);
      const node = { t: 'a', start, end: i, v, kids };
      spanOf.set(v, node);
      return node;
    }
    const num = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (num) {
      i += num[0].length;
      return { t: 'n', start, end: i, v: Number(num[0]) };
    }
    for (const [word, lit] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return { t: 'l', start, end: i, v: lit };
      }
    }
    return fail();
  }

  const root = value(0);
  ws();
  if (i !== text.length) fail();
  return root;
}

/* ------------------------------ visiting ------------------------------ */

/**
 * Depth-first visit with the original contract: visit(value, ctx) may mutate
 * value in place, return a replacement, or return REMOVE. Strings that contain
 * JSON are edited recursively with the same byte-preserving rules.
 *
 * Array elements removed under a span are marked with REMOVE in place, so the
 * emitter can still pair the remaining elements with their original text.
 */
function walk(value, visit, spanOf, ctx) {
  if (ctx.depth > MAX_DEPTH) return value;
  const replaced = visit(value, ctx);
  if (replaced === REMOVE) return REMOVE;
  if (replaced !== undefined) value = replaced;

  if (typeof value === 'string') {
    return looksLikeJson(value) ? editJsonText(value, visit, ctx.depth + 1) : value;
  }
  if (Array.isArray(value)) {
    const spanned = spanOf.has(value);
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] === REMOVE) continue;
      const out = walk(value[i], visit, spanOf, { depth: ctx.depth + 1, key: i, parent: value });
      if (out === REMOVE && !spanned) {
        value.splice(i, 1);
        i -= 1;
      } else value[i] = out;
    }
    return value;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const out = walk(value[key], visit, spanOf, { depth: ctx.depth + 1, key, parent: value });
      if (out === REMOVE) delete value[key];
      else value[key] = out;
    }
  }
  return value;
}

/* ------------------------------ emitting ------------------------------ */

/** A value with no original text (new or replaced): encode it, dropping removal marks. */
function encodeFresh(value, style) {
  const clean = (v) => {
    if (Array.isArray(v)) return v.filter((x) => x !== REMOVE).map(clean);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = clean(v[k]);
      return out;
    }
    return v;
  };
  return applyStyle(safeStringify(clean(value)), style);
}

/**
 * Match the original block's spelling where it is unambiguous: escaped
 * forward slashes, and non-ASCII written as \uXXXX. Both are valid anywhere a
 * new JSON fragment can appear, since outside strings JSON has neither.
 */
function applyStyle(text, style) {
  let out = text;
  if (style.slashes) out = out.replace(/\//g, '\\/');
  if (style.asciiOnly) out = out.replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return out;
}

function sameScalar(node, value) {
  if (node.t === 's') return typeof value === 'string' && value === node.v;
  if (node.t === 'n') return typeof value === 'number' && (value === node.v || (Number.isNaN(value) && Number.isNaN(node.v)));
  if (node.t === 'l') return value === node.v;
  return false;
}

/** Span of a value-and-one-comma to delete, so a removed member/element leaves valid JSON. */
function removalSpan(src, start, end) {
  let a = start;
  let b = end;
  let j = b;
  while (j < src.length && /\s/.test(src[j])) j += 1;
  if (src[j] === ',') return { start: a, end: j + 1 }; // swallow the following comma
  let k = a - 1;
  while (k >= 0 && /\s/.test(src[k])) k -= 1;
  if (src[k] === ',') a = k; // swallow the preceding comma (last member/element)
  return { start: a, end: b };
}

/**
 * Collect the minimal edits (each { start, end, text }) that turn the original
 * JSON text into one carrying the visitor's changes. Every node the visitor
 * left alone contributes no edit, so its bytes, whitespace and separators are
 * preserved exactly. Values the visitor replaced wholesale, or added, are the
 * only text that is freshly encoded.
 */
function collectEdits(src, node, value, spanOf, style, edits) {
  if (node.t === 'o' && value && typeof value === 'object' && !Array.isArray(value) && spanOf.get(value) === node) {
    const counts = Object.create(null);
    for (const kid of node.kids) counts[kid.key] = (counts[kid.key] || 0) + 1;
    const originalKeys = new Set(node.kids.map((k) => k.key));
    const added = Object.keys(value).filter((k) => !originalKeys.has(k));
    if (added.length) {
      // Adding keys is not something our visitors do; re-encode the one object.
      edits.push({ start: node.start, end: node.end, text: encodeFresh(value, style) });
      return;
    }
    for (const kid of node.kids) {
      if (!Object.prototype.hasOwnProperty.call(value, kid.key)) {
        edits.push({ ...removalSpan(src, kid.keyStart, kid.node.end), text: '' });
        continue;
      }
      // A duplicate key cannot be disambiguated from the decoded value, so its
      // original bytes are kept rather than guessed at.
      if (counts[kid.key] > 1) continue;
      collectEdits(src, kid.node, value[kid.key], spanOf, style, edits);
    }
    return;
  }

  if (node.t === 'a' && Array.isArray(value) && spanOf.get(value) === node) {
    if (value.length > node.kids.length) {
      edits.push({ start: node.start, end: node.end, text: encodeFresh(value, style) });
      return;
    }
    node.kids.forEach((kid, i) => {
      if (value[i] === REMOVE) {
        edits.push({ ...removalSpan(src, kid.start, kid.end), text: '' });
        return;
      }
      collectEdits(src, kid, value[i], spanOf, style, edits);
    });
    return;
  }

  if ((node.t === 's' || node.t === 'n' || node.t === 'l') && sameScalar(node, value)) return;

  if (node.t === 's' && typeof value === 'string') {
    const literalStyle = { slashes: style.slashes || src.slice(node.start, node.end).includes('\\/'), asciiOnly: style.asciiOnly };
    edits.push({ start: node.start, end: node.end, text: applyStyle(safeStringify(value), literalStyle) });
    return;
  }
  edits.push({ start: node.start, end: node.end, text: encodeFresh(value, style) });
}

function applyEdits(text, edits) {
  if (!edits.length) return text;
  edits.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const e of edits) {
    if (e.start < cursor) continue; // never happens for a tree, but stay safe
    out += text.slice(cursor, e.start) + e.text;
    cursor = e.end;
  }
  return out + text.slice(cursor);
}

/**
 * Apply a visitor to one JSON document's text. Returns the text unchanged
 * (the same string) when nothing changed or the text is not valid JSON.
 */
function editJsonText(text, visit, depth = 0) {
  const spanOf = new WeakMap();
  let root;
  try {
    root = parseWithSpans(text, spanOf);
  } catch {
    return text;
  }
  const value = walk(root.v, visit, spanOf, { depth });
  if (value === REMOVE) return text;
  const style = {
    slashes: /\\\//.test(text),
    asciiOnly: /\\u[0-9a-fA-F]{4}/.test(text) && !/[\u0080-\uffff]/.test(text),
  };
  const edits = [];
  if (spanOf.get(value) === root) collectEdits(text, root, value, spanOf, style, edits);
  else edits.push({ start: root.start, end: root.end, text: encodeFresh(value, style) });
  return applyEdits(text, edits);
}

/** Apply a visitor to every JSON script block. Returns { html, blocks, edited }. */
function editJsonBlocks(html, visit) {
  let blocks = 0;
  let edited = 0;
  const out = html.replace(SCRIPT_JSON, (whole, open, body, close) => {
    blocks += 1;
    const next = editJsonText(body, visit);
    if (next === body) return whole;
    edited += 1;
    return `${open}${next}${close}`;
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

module.exports = { editJsonBlocks, editJsonText, parseWithSpans, isDefineTuple, prefetchKey, safeStringify, looksLikeJson, REMOVE };
