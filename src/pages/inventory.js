'use strict';

/**
 * The client's own page inventory: every `XPolaris*ControllerRouteBuilder` a
 * snapshot defines, with the URL pattern it builds, read from the stored
 * bundles. The page registry (./registry.js) must account for each one, as a
 * page or as NOT_SERVED; API builders (`XPolarisIGXAPI*`) are not pages.
 */

const { openSnapshotStore } = require('../clientSnapshot');

// jsRouteBuilder(pattern, defaults) or jsExtraRouteBuilder(pattern, defaults, [extra patterns]).
const BUILDER = /__d\("(XPolaris(?!IGXAPI)[A-Za-z0-9]*ControllerRouteBuilder)",\[[^\]]*\],\(?function[^{]*\{[^]{0,600}?js(Extra)?RouteBuilder"\)\("(\/[^"]*)",(?:Object\.freeze\((?:\{[^}]*\})?\)|\{[^}]*\}|void 0)(?:,\[([^\]]*)\])?/g;

/** { builderName: [pattern, ...extra patterns] } from the given snapshot (default: the active one in `dir`). */
function routeBuilders(dir = '.cache/client', id = null) {
  const store = openSnapshotStore(dir);
  const active = id || store.readState().active;
  if (!active) return null;
  const m = store.load(active);
  const out = {};
  for (const e of [...Object.values(m.assets), ...Object.values(m.answers)]) {
    if (!/javascript/.test(e.contentType)) continue;
    const text = store.readBlob(e.sha256).toString('utf8');
    for (const x of text.matchAll(BUILDER)) out[x[1]] = [x[3], ...(x[4] ? [...x[4].matchAll(/"([^"]*)"/g)].map((y) => y[1]) : [])];
  }
  return { snapshot: active, revision: m.revision, builders: out };
}

module.exports = { routeBuilders };
