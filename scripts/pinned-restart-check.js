#!/usr/bin/env node
'use strict';

/**
 * Restart check for the pinned client, in a real browser: the server runs as a
 * separate process (`node src/server.js`, the active snapshot of CLIENT_DIR)
 * with the upstream guard preloaded. A local account signs in, the signed-in
 * home is loaded (cold, then warm), the server process is stopped and started
 * again on the same data, and the page is reloaded with the same browser
 * session. Checks: the same snapshot id and revision before and after, the
 * session persists, the signed-in route is served both times, no browser
 * request leaves this origin, and neither server process attempted an
 * upstream request.
 *
 *   CHROMIUM_BIN=... node scripts/pinned-restart-check.js
 *
 * Screenshots: test-artifacts/screenshots/pin-D-*.png
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { launchChromium, openSession, captureScreenshot, watchExternal } = require('./lib/browser');
const { waitFor, sleep } = require('./lib/scenario');
const { Browser } = require('../test/clone-helpers');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, '.scratch', 'pinned-restart-check');
const SHOTS = path.resolve(process.env.SCREENSHOT_DIR || path.join(ROOT, 'test-artifacts', 'screenshots'));
const PORT = Number(process.env.CHECK_PORT || 12099);
const base = `http://127.0.0.1:${PORT}`;

// Preloaded into the server process: record and refuse non-local requests,
// report them on exit.
const PRELOAD = path.join(SCRATCH, 'guard-preload.js');
const PRELOAD_SOURCE = `const { installUpstreamGuard } = require(${JSON.stringify(path.join(__dirname, 'lib', 'upstream-guard.js'))});
const g = installUpstreamGuard();
const report = () => { try { require('node:fs').writeFileSync(process.env.GUARD_REPORT, JSON.stringify(g.attempts)); } catch {} };
process.on('SIGTERM', () => { report(); process.exit(0); });
process.on('exit', report);
`;

// Server processes this check spawned, killed on any exit (an exception
// before the try block must not leave one holding the port).
const spawned = new Set();
process.on('exit', () => {
  for (const c of spawned) if (c.exitCode === null) c.kill('SIGKILL');
});

async function startServer(label) {
  // A health answer from a process this check did not start would be taken
  // for this server's (e.g. one left behind by an interrupted run).
  const stale = await fetch(`${base}/__loader/health`).then(() => true, () => false);
  if (stale) throw new Error(`port ${PORT} is already answering; stop that process (or set CHECK_PORT) and run again`);
  const report = path.join(SCRATCH, `guard-${label}.json`);
  const child = spawn(process.execPath, ['--require', PRELOAD, path.join(ROOT, 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      BACKEND_DB: path.join(SCRATCH, 'db.sqlite'),
      CLONE_DATA_DIR: SCRATCH,
      VERBOSE: '0',
      BACKEND_VERBOSE: '0',
      GUARD_REPORT: report,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.add(child);
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}) before answering:\n${out}`);
    try {
      const r = await fetch(`${base}/__loader/health`);
      if (r.status) return { child, report, health: await r.json(), log: () => out };
    } catch {
      await sleep(100);
    }
  }
  child.kill('SIGTERM');
  throw new Error(`server did not start:\n${out}`);
}

async function stopServer(s) {
  if (s.child.exitCode === null) {
    await new Promise((resolve) => {
      s.child.once('exit', resolve);
      s.child.kill('SIGTERM');
    });
  }
  return JSON.parse(fs.readFileSync(s.report, 'utf8'));
}

async function main() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(PRELOAD, PRELOAD_SOURCE);
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: Boolean(ok) });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  };
  const shots = [];
  const shot = async (session, name) => {
    const f = await captureScreenshot(session, path.join(SHOTS, name));
    if (f) shots.push(path.relative(ROOT, f));
  };

  let first = await startServer('first');
  const pinnedBefore = `${first.health.client.snapshot}@${first.health.client.revision}`;
  check('the server starts on the active pinned snapshot', first.health.ok && first.health.client.ready, `${first.health.client.snapshot} rev ${first.health.client.revision}`);
  const api = new Browser(base);
  const username = `restart_${Date.now().toString(36).slice(-5)}`;
  await api.signup(null, { username, fullName: 'Restart Check' });

  const { child: chrome, browserWsUrl } = await launchChromium(path.join(SCRATCH, 'profile'));
  // Signed in: the mount is visible, the shell links to the viewer's profile,
  // and none of the logged-out page's login markup is present.
  const signedIn = `(() => { const t = document.body ? document.body.innerText : ''; const m = document.querySelector('[id^=mount_]'); return Boolean(m && getComputedStyle(m).contentVisibility === 'visible' && document.querySelector('a[href="/${username}/"]') && !/Log into Instagram|Create new account|Sign up/.test(t)); })()`;
  // The first signed-in visit opens "Turn on Notifications"; dismiss it as a user would.
  const dismiss = "(() => { const b = [...document.querySelectorAll('button')].find((e) => (e.innerText || '').trim() === 'Not Now'); b && b.click(); return Boolean(b); })()";
  let second = null;
  try {
    const session = await openSession(browserWsUrl);
    watchExternal(session, base);
    await session.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const [name, value] of api.jar) await session.cdp.send('Network.setCookie', { name, value: encodeURIComponent(value), url: base, path: '/' });

    await session.cdp.send('Page.navigate', { url: `${base}/` });
    const cold = await waitFor(session, signedIn, 45000);
    await sleep(1500);
    await session.cdp.send('Runtime.evaluate', { expression: dismiss });
    await sleep(800);
    await shot(session, 'pin-D-1-signed-in-home-cold.png');
    check('cold load: the signed-in home renders from the pinned client', cold);

    await session.cdp.send('Page.reload', {});
    const warm = await waitFor(session, signedIn, 45000);
    await sleep(1000);
    check('warm load: the same', warm);

    const attemptsFirst = await stopServer(first);
    first = null;
    second = await startServer('second');
    check('after restart the same snapshot is active', first === null && `${second.health.client.snapshot}@${second.health.client.revision}` === pinnedBefore, `${second.health.client.snapshot} rev ${second.health.client.revision}`);

    await session.cdp.send('Page.reload', {});
    const after = await waitFor(session, signedIn, 45000);
    await sleep(1500);
    await session.cdp.send('Runtime.evaluate', { expression: dismiss });
    await sleep(800);
    await shot(session, 'pin-D-2-signed-in-home-after-restart.png');
    const me = await session.cdp.send('Runtime.evaluate', { expression: "fetch('/api/v1/accounts/current_user/').then(async (r) => (await r.json()).user?.username)", awaitPromise: true, returnByValue: true });
    check('after restart: the session persists and the signed-in home renders', after && me.result.value === username, me.result.value);

    await session.cdp.send('Page.navigate', { url: `${base}/__loader/health` });
    await sleep(800);
    await shot(session, 'pin-D-3-health-after-restart.png');
    check('no browser request left this origin', session.externalRequests.length === 0, session.externalRequests.slice(0, 3).map((e) => e.url).join(', '));
    const attemptsSecond = await stopServer(second);
    second = null;
    check('neither server process attempted an upstream request', attemptsFirst.length === 0 && attemptsSecond.length === 0, [...attemptsFirst, ...attemptsSecond].map((a) => a.url).slice(0, 3).join(', '));
  } finally {
    if (first) await stopServer(first).catch(() => {});
    if (second) await stopServer(second).catch(() => {});
    chrome.kill('SIGKILL');
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} pinned restart checks passed`);
  console.log(`screenshots: ${shots.join(', ')}`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
