'use strict';

/**
 * Narrow, reviewable patches to the original client's JavaScript.
 *
 * The client's bundles are concatenations of Haste module definitions,
 * `__d("ModuleName", [deps], function factory(...) {...}, flags)`. A patch
 * names ONE module and a find/replace inside that module's definition only,
 * the way Equicord patches name a webpack module by a unique string. A patch
 * whose module or text is not found is reported, never applied elsewhere, so a
 * client update turns a stale patch into a visible miss instead of a silent
 * mis-edit.
 *
 * Patches are the last resort. Prefer, in order: answering the request on the
 * server (src/clone), editing bootstrap data (src/shell/personalize.js), the
 * transport guard (src/shell/runtime.js), then a patch here. The registry is
 * empty until a live run shows a module that cannot work any other way;
 * add entries to PATCHES with a `why` and keep them minimal.
 */

/** @type {{ id: string, module: string, find: string | RegExp, replace: string, why: string }[]} */
const PATCHES = [];

/** Locate each `__d("Name",` definition: start offsets keyed by module name. */
function moduleSpans(source) {
  const spans = [];
  const re = /__d\(\s*(["'])([^"'\\]{1,200})\1\s*,/g;
  let m;
  while ((m = re.exec(source))) spans.push({ name: m[2], start: m.index });
  for (let i = 0; i < spans.length; i += 1) spans[i].end = i + 1 < spans.length ? spans[i + 1].start : source.length;
  return spans;
}

function createPatcher(patches = PATCHES) {
  const report = new Map(patches.map((p) => [p.id, { id: p.id, module: p.module, applied: 0, missedFind: 0 }]));

  function apply(source) {
    if (!patches.length || typeof source !== 'string' || !source.includes('__d(')) return { source, applied: [] };
    const spans = moduleSpans(source);
    const byName = new Map();
    for (const s of spans) if (!byName.has(s.name)) byName.set(s.name, s);
    const edits = [];
    for (const patch of patches) {
      const span = byName.get(patch.module);
      if (!span) continue;
      const segment = source.slice(span.start, span.end);
      const next = segment.replace(patch.find, patch.replace);
      if (next === segment) {
        report.get(patch.id).missedFind += 1;
        continue;
      }
      edits.push({ span, next, id: patch.id });
    }
    if (!edits.length) return { source, applied: [] };
    edits.sort((a, b) => b.span.start - a.span.start);
    let out = source;
    for (const e of edits) {
      out = out.slice(0, e.span.start) + e.next + out.slice(e.span.end);
      report.get(e.id).applied += 1;
    }
    return { source: out, applied: edits.map((e) => e.id) };
  }

  return { apply, report: () => [...report.values()], count: patches.length };
}

module.exports = { createPatcher, moduleSpans, PATCHES };
