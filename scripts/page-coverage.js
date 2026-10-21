#!/usr/bin/env node
'use strict';

/**
 * Page coverage of the active pinned client (or --snapshot <id>), from the
 * page registry (src/pages/registry.js): per page, whether this server
 * serves it, what the snapshot is missing for it, and its next step. Also
 * checks the registry against the snapshot's own route builders. Exits 1
 * while any page is not served or any route builder is unaccounted for.
 *
 *   node scripts/page-coverage.js [--snapshot <id>] [--json]
 */

const path = require('node:path');
const { openSnapshotStore } = require('../src/clientSnapshot');
const registry = require('../src/pages/registry');
const { routeBuilders } = require('../src/pages/inventory');

const dir = path.join(__dirname, '..', process.env.CLIENT_DIR || '.cache/client');
const i = process.argv.indexOf('--snapshot');
const store = openSnapshotStore(dir);
const id = i >= 0 ? process.argv[i + 1] : store.readState().active;
if (!id) {
  console.error('no active pinned client (npm run client:setup)');
  process.exit(1);
}
const m = store.load(id);
const pages = registry.coverage({ hasAnswer: (a) => Boolean(m.answers[`${a}|`]), hasDocument: (p) => Boolean(m.documents[p]) });
const inv = routeBuilders(dir, id);
const classified = registry.classifiedBuilders();
const unclassified = Object.keys(inv.builders).filter((b) => !classified.has(b));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ snapshot: id, revision: m.revision, pages, unclassifiedBuilders: unclassified }, null, 2));
} else {
  console.log(`snapshot ${id} (revision ${m.revision}): ${pages.length} registered pages, ${Object.keys(inv.builders).length} page route builders in the client`);
  for (const p of pages) {
    const gap = p.missing.length ? ` missing ${p.missing.join(', ')}` : '';
    const target = p.targetMissing.length ? ` (recorded root not held: ${p.targetMissing.join(', ')})` : '';
    console.log(`${p.status.padEnd(16)} ${p.id.padEnd(24)}${gap}${target}${p.status !== 'served' && p.status !== 'document' && p.next ? `\n${' '.repeat(17)}next: ${p.next}` : ''}`);
  }
  if (unclassified.length) console.log(`route builders not in the registry: ${unclassified.join(', ')}`);
  const count = (s) => pages.filter((p) => p.status === s).length;
  console.log(`served ${count('served')}, anonymous documents ${count('document')}, missing answers ${count('missing-answers')}, missing documents ${count('missing-document')}, not served ${count('not-served')}`);
}
const complete = pages.every((p) => p.status === 'served' || p.status === 'document') && unclassified.length === 0;
process.exit(complete ? 0 : 1);
