#!/usr/bin/env node
'use strict';

/**
 * Reproduce and verify the "stuck on the loading screen" symptom WITHOUT the
 * live Instagram client (this environment cannot reach Instagram).
 *
 * The stand-in upstream serves a page that boots the way Instagram's does:
 *   - it shows a spinner (the loading screen);
 *   - it seeds a client-side store from `RelayPrefetchedStreamCache` prefetch
 *     blocks in the document, exactly where Instagram puts the route's initial
 *     data;
 *   - on boot it renders from that store and hides the spinner; only if the
 *     store is empty does it fall back to a runtime POST /graphql/query and
 *     wait for it.
 *
 * So: if the shell strips the page's own (anonymous) prefetch, the store is
 * empty, the runtime query is issued, and the spinner never clears. That is the
 * hang. This driver loads the page through the full server in Chromium and
 * checks whether the spinner clears and what the client waited on.
 *
 *   node scripts/browser-loading-check.js
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { launchChromium, openSession, navigate } = require('./lib/browser');

const SCRATCH = path.join(__dirname, '..', '.scratch', 'loading-check');

/** A page shaped like Instagram's logged-out boot, with a seeded Relay store. */
function upstreamPage() {
  const prefetch = {
    require: [
      [
        'RelayPrefetchedStreamCache',
        'next',
        [],
        [
          'adp_LoggedOutHomeQueryRelayPreloader_abc',
          { __bbox: { result: { data: { xdt_viewer: { seen: true } }, extensions: {} } } },
        ],
      ],
    ],
  };
  const identity = { define: [['CurrentUserInitialData', [], { USER_ID: '0', NAME: '', SHORT_NAME: null }, 1]] };
  const encryption = { raw: JSON.stringify({ config: { csrf_token: 'stand-in-csrf' }, encryption: { key_id: '1', public_key: '00'.repeat(32), version: '10' } }) };
  const block = (o) => `<script type="application/json" data-sjs>${JSON.stringify(o)}</script>`;
  return `<!DOCTYPE html><html><head><title>Loading</title></head>
<body>
<div id="spinner" aria-label="Loading...">loading</div>
<div id="root"></div>
${block(identity)}
${block(encryption)}
${block(prefetch)}
<script>
(function () {
  function store() {
    var found = null;
    document.querySelectorAll('script[type="application/json"]').forEach(function (s) {
      var data; try { data = JSON.parse(s.textContent); } catch (e) { return; }
      (data.require || []).forEach(function (r) {
        if (r[0] === 'RelayPrefetchedStreamCache' && r[3] && /RelayPreloader/.test(r[3][0])) found = r[3][1];
      });
    });
    return found;
  }
  function render(source) {
    document.getElementById('root').textContent = 'rendered from ' + source;
    var s = document.getElementById('spinner'); if (s) s.remove();
    window.__BOOTED__ = source;
  }
  // Instagram renders the route from the seeded store when it is present.
  var seeded = store();
  if (seeded) { render('prefetch'); return; }
  // Otherwise Relay issues the query at runtime and waits for it.
  window.__WAITED_ON_QUERY__ = true;
  fetch('/graphql/query', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'fb_api_req_friendly_name=PolarisLoggedOutHomeQuery&doc_id=1&variables=%7B%7D',
  }).then(function (r) { return r.json(); }).then(function (j) {
    if (j && j.data && j.data.xdt_viewer) render('runtime-query');
    // A 501 / error body leaves the spinner up, like the real hang.
  }).catch(function () {});
})();
</script>
</body></html>`;
}

function startUpstream() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(upstreamPage());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function evaluate(session, expression) {
  const result = await session.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function run(env, label) {
  const upstream = await startUpstream();
  const dir = path.join(SCRATCH, label);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  delete process.env.SHELL_DROP_PREFETCHES;
  Object.assign(process.env, {
    UPSTREAM_ORIGIN: `http://127.0.0.1:${upstream.address().port}`,
    BACKEND_DB: path.join(dir, 'db.sqlite'),
    CLONE_DATA_DIR: dir,
    VERBOSE: '0',
    BACKEND_VERBOSE: '0',
    ...env,
  });
  for (const key of Object.keys(require.cache)) if (key.includes('/src/')) delete require.cache[key];
  const { app } = require('../src/server');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { child, browserWsUrl } = await launchChromium(path.join(dir, 'profile'));
  try {
    const session = await openSession(browserWsUrl);
    await session.cdp.send('Network.enable');
    await session.cdp.send('Runtime.enable');
    await navigate(session, `${base}/`, 2500);
    const booted = await evaluate(session, 'window.__BOOTED__ || null');
    const waited = await evaluate(session, 'Boolean(window.__WAITED_ON_QUERY__)');
    const spinner = await evaluate(session, "Boolean(document.getElementById('spinner'))");
    const pending = [...session.requests.values()].filter((r) => r.status === null && !r.failed).map((r) => r.url);
    const graphql = [...session.requests.values()].filter((r) => /graphql/.test(r.url)).map((r) => `${r.status}`);
    return { booted, waited, spinnerStillUp: spinner, pending, graphqlStatuses: graphql, exceptions: session.exceptions.length };
  } finally {
    child.kill('SIGKILL');
    server.closeAllConnections?.();
    server.close();
    upstream.close();
  }
}

async function main() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  const before = await run({ SHELL_DROP_PREFETCHES: '1' }, 'drop-on');
  console.log('With prefetch dropping forced ON (the reported symptom):');
  console.log(`  spinner still up: ${before.spinnerStillUp}, booted: ${before.booted}, waited on a runtime query: ${before.waited}, graphql: ${before.graphqlStatuses}`);
  const after = await run({}, 'default');
  console.log('With the default (anonymous page served faithfully):');
  console.log(`  spinner still up: ${after.spinnerStillUp}, booted: ${after.booted}, waited on a runtime query: ${after.waited}`);
  const ok = before.spinnerStillUp === true && after.spinnerStillUp === false && after.booted === 'prefetch' && after.exceptions === 0;
  console.log(`\n${ok ? 'PASS' : 'FAIL'}: the hang reproduces with dropping ON and is gone by default`);
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
