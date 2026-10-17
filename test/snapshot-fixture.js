'use strict';

/**
 * Small pinned-client snapshots for tests, written with the real snapshot store
 * (src/clientSnapshot.js) into a test directory. The documents are synthetic,
 * in the shape of Meta's bootstrap (a Bootloader payload carrying the client
 * revision); they prove the serving rules, not Instagram's exact page.
 */

const { openSnapshotStore } = require('../src/clientSnapshot');

const sjs = (obj) => `<script type="application/json" data-sjs>${JSON.stringify(obj)}</script>`;

/** A document of `revision`: the revision payload, optional extra blocks, then `body`. */
function documentAt(revision, { blocks = [], body = '<p>pinned document</p>' } = {}) {
  return `<!doctype html><html><head></head><body>${[
    { require: [['Bootloader', 'handlePayload', null, [{ consistency: { rev: Number(revision) }, rsrcMap: {}, compMap: {} }]]] },
    ...blocks,
  ].map(sjs).join('')}${body}</body></html>`;
}

/** A bootloader-endpoint answer declaring `revision`. */
function answerAt(revision, { allResources = [], rsrcMap = {}, jsmods = { define: [], require: [] } } = {}) {
  return `for (;;);${JSON.stringify({ hrp: { allResources, hsrp: { hblp: { consistency: { rev: Number(revision) }, rsrcMap, compMap: {} } }, jsmods } })}`;
}

/**
 * Write a snapshot. `documents` {path: html}, `answers` {"modules|nb": text},
 * `assets` {url: {body, contentType}}. `activate` makes it the store's active
 * snapshot (the previous active one goes to history). Returns the manifest.
 */
function writeSnapshot(dir, { id, revision = '100', documents, answers, assets = {}, status = 'verified', activate = true, routes } = {}) {
  const store = openSnapshotStore(dir);
  // The home route's answer by default, so the snapshot is valid (home is required).
  if (answers === undefined) answers = { 'PolarisFeedRoot.react|': answerAt(revision) };
  if (assets === undefined) assets = {};
  const entries = (table, contentTypeOf, extra = () => ({})) =>
    Object.fromEntries(
      Object.entries(table).map(([k, v]) => {
        const body = Buffer.from(typeof v === 'string' ? v : v.body);
        return [k, { ...store.putBlob({ body }), contentType: contentTypeOf(v), ...extra(k) }];
      }),
    );
  const manifest = {
    format: 1,
    id: id || `rev${revision}-test`,
    revision: String(revision),
    createdAt: new Date().toISOString(),
    status: activate ? 'active' : status,
    source: 'test-fixture',
    documents: entries(documents || { '/': documentAt(revision), '/accounts/emailsignup/': documentAt(revision) }, (v) => (typeof v === 'string' ? 'text/html; charset=utf-8' : v.contentType), () => ({ revision: String(revision) })),
    answers: entries(answers, () => 'application/x-javascript', (k) => ({ revision: String(revision), modules: k.split('|')[0], nbModules: k.split('|')[1] || '' })),
    assets: entries(assets, (v) => v.contentType),
    routes: routes || { home: { root: 'PolarisFeedRoot', answers: ['PolarisFeedRoot.react'], supported: Boolean(answers['PolarisFeedRoot.react|']), missing: [] } },
    knownMissing: [],
    rejected: [],
    patches: [],
    validation: [],
  };
  store.save(manifest);
  if (activate) {
    const state = store.readState();
    if (state.active && state.active !== manifest.id) {
      const prev = store.load(state.active);
      store.save({ ...prev, status: 'retired' });
    }
    store.writeState({ active: manifest.id, history: [state.active, ...state.history].filter((x) => x && x !== manifest.id) });
  }
  return manifest;
}

module.exports = { writeSnapshot, documentAt, answerAt, sjs };
