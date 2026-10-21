#!/usr/bin/env node
'use strict';

/**
 * Page load timing over a slow link, against the active pinned client with
 * the upstream guard on. A signed-in viewer (following one account with one
 * post) opens the home feed in Chromium with the network emulated as a remote
 * server would be: RTT_MS round trip (default 100) and DOWN_MBPS down
 * (default 20). Localhost hides what a VPS behind a domain shows: every
 * request costs a round trip and every byte crosses a real link.
 *
 * Three loads: cold (empty cache), warm (a reload: the browser revalidates
 * what it holds) and revisit (a new navigation, after the cache lifetime has
 * run out: pass REVISIT_AFTER_MS to wait, default none). Each reports the
 * time until the feed shows a post, the request count, the bytes transferred
 * and how many responses came from the cache or as 304.
 *
 * Report: test-artifacts/reports/load-timing.json.
 *
 *   node scripts/load-timing.js [--max-cold-ms N] [--max-warm-ms N]
 */

const upstreamGuard = require('./lib/offline').strictOffline();

const fs = require('node:fs');
const path = require('node:path');
const { launchChromium, openSession, captureScreenshot } = require('./lib/browser');
const { evaluate, sleep, sunsetPng } = require('./lib/scenario');
const { Browser } = require('../test/clone-helpers');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, '.scratch', 'load-timing');
const SHOTS = path.join(ROOT, 'test-artifacts', 'screenshots');
const REPORTS = path.join(ROOT, 'test-artifacts', 'reports');
const RTT_MS = Number(process.env.RTT_MS || 100);
const DOWN_MBPS = Number(process.env.DOWN_MBPS || 20);
const UP_MBPS = Number(process.env.UP_MBPS || 5);
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : null;
};
const MAX_COLD = arg('--max-cold-ms');
const MAX_WARM = arg('--max-warm-ms');

// The feed shows the followed account's post.
const READY = `Boolean([...document.querySelectorAll('article img')].find((i) => i.getBoundingClientRect().width > 200 && i.complete))`;

async function load(s, url, label) {
  s.requests.clear();
  const t0 = Date.now();
  await s.cdp.send('Page.navigate', { url });
  let ready = null;
  while (Date.now() - t0 < 120000) {
    if (await evaluate(s, READY).catch(() => false)) {
      ready = Date.now() - t0;
      break;
    }
    await sleep(100);
  }
  // Let late requests (lazy modules, polling) settle into the count.
  await sleep(3000);
  const rows = [...s.requests.values()].filter((r) => !r.url.startsWith('data:') && !r.url.startsWith('blob:'));
  const bytes = rows.reduce((n, r) => n + (r.encodedDataLength || 0), 0);
  const byKind = {};
  for (const r of rows) {
    const u = new URL(r.url);
    const kind = u.pathname.startsWith('/ajax/bootloader-endpoint') ? 'bootloader' : u.pathname.startsWith('/__ig/') ? 'asset' : u.pathname.startsWith('/api/') || u.pathname.startsWith('/graphql') ? 'api' : r.type === 'Document' ? 'document' : 'other';
    const k = (byKind[kind] = byKind[kind] || { requests: 0, bytes: 0, notModified: 0, cached: 0 });
    k.requests += 1;
    k.bytes += r.encodedDataLength || 0;
    if (r.status === 304) k.notModified += 1;
    if (r.fromCache) k.cached += 1;
  }
  const largest = rows
    .filter((r) => r.encodedDataLength)
    .sort((a, b) => b.encodedDataLength - a.encodedDataLength)
    .slice(0, 5)
    .map((r) => ({ path: new URL(r.url).pathname.slice(0, 90), bytes: r.encodedDataLength, status: r.status }));
  const result = { load: label, readyMs: ready, requests: rows.length, bytes, byKind, largest };
  console.log(`${label.padEnd(8)} ready ${ready == null ? 'never' : `${ready} ms`}, ${rows.length} requests, ${(bytes / 1024).toFixed(0)} KiB transferred`);
  for (const [kind, k] of Object.entries(byKind)) console.log(`         ${kind.padEnd(10)} ${String(k.requests).padStart(4)} requests ${String((k.bytes / 1024).toFixed(0)).padStart(6)} KiB, ${k.notModified} not modified, ${k.cached} from cache`);
  return result;
}

async function main() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(REPORTS, { recursive: true });
  Object.assign(process.env, {
    BACKEND_DB: path.join(SCRATCH, 'db.sqlite'),
    CLONE_DATA_DIR: SCRATCH,
    VERBOSE: '0',
    BACKEND_VERBOSE: '0',
  });
  const { app } = require('../src/server');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { child, browserWsUrl } = await launchChromium(path.join(SCRATCH, 'profile'));
  const results = [];
  try {
    const A = new Browser(base);
    await A.signup(null, { username: 'timing_viewer', fullName: 'Timing Viewer' });
    const B = new Browser(base);
    const b = await B.signup(null, { username: 'timing_author', fullName: 'Timing Author' });
    await A.post(`/api/v1/friendships/create/${b.pk}/`, {});
    const id = String(Date.now());
    await B.request('POST', `/rupload_igphoto/fb_uploader_${id}`, {
      raw: sunsetPng(1080, 1080),
      headers: { 'content-type': 'image/png', 'x-instagram-rupload-params': JSON.stringify({ upload_id: id, media_type: 1 }) },
    });
    await B.post('/api/v1/media/configure/', { upload_id: id, caption: 'timing post' });

    const s = await openSession(browserWsUrl);
    await s.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await s.cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: RTT_MS,
      downloadThroughput: (DOWN_MBPS * 1e6) / 8,
      uploadThroughput: (UP_MBPS * 1e6) / 8,
    });
    for (const [name, value] of A.jar) await s.cdp.send('Network.setCookie', { name, value: encodeURIComponent(value), url: base });
    console.log(`emulated link: ${RTT_MS} ms round trip, ${DOWN_MBPS} Mbit/s down, ${UP_MBPS} Mbit/s up`);
    results.push(await load(s, `${base}/`, 'cold'));
    await captureScreenshot(s, path.join(SHOTS, 'load-timing-cold.png'));
    results.push(await load(s, `${base}/`, 'warm'));
    const wait = Number(process.env.REVISIT_AFTER_MS || 0);
    if (wait) await sleep(wait);
    results.push(await load(s, `${base}/`, 'revisit'));
    s.ws.close();
  } finally {
    child.kill('SIGKILL');
    server.closeAllConnections?.();
    server.close();
  }
  fs.writeFileSync(path.join(REPORTS, 'load-timing.json'), JSON.stringify({ at: new Date().toISOString(), rttMs: RTT_MS, downMbps: DOWN_MBPS, upstreamAttempts: upstreamGuard.attempts.length, loads: results }, null, 1));
  console.log(`upstream attempts: ${upstreamGuard.attempts.length}`);
  const [cold, warm] = results;
  const problems = [];
  if (results.some((r) => r.readyMs == null)) problems.push('the feed never showed its post');
  if (MAX_COLD != null && cold.readyMs > MAX_COLD) problems.push(`cold load ${cold.readyMs} ms > ${MAX_COLD} ms`);
  if (MAX_WARM != null && warm.readyMs > MAX_WARM) problems.push(`warm load ${warm.readyMs} ms > ${MAX_WARM} ms`);
  if (upstreamGuard.attempts.length) problems.push('upstream requests');
  console.log(problems.length ? `load timing FAILED: ${problems.join('; ')}` : 'load timing PASS');
  return problems.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
