#!/usr/bin/env node
'use strict';

/**
 * End-to-end check of search in the GENUINE client, strictly offline (the
 * pinned snapshot only; upstream guard on). Headless Chromium over CDP:
 *
 *   1. accounts A and B exist (B with a full name); A is signed in;
 *   2. A's home is the empty feed; A types part of B's full name into its
 *      genuine account search box;
 *   3. B is listed, answered by the local PolarisFeedEmptySULSearch*Query
 *      resolver (src/clone/searchOperations.js);
 *   4. clicking B opens B's profile through the client's router.
 *
 * Screenshots: test-artifacts/screenshots/search-*.png
 *
 *   CHROMIUM_BIN=... node scripts/genuine-search-check.js
 */

const upstreamGuard = require('./lib/offline').strictOffline();

const fs = require('node:fs');
const path = require('node:path');
const { launchChromium, openSession, captureScreenshot, watchExternal } = require('./lib/browser');
const { type, waitFor, sleep, evaluate } = require('./lib/scenario');
const { Browser } = require('../test/clone-helpers');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, '.scratch', 'genuine-search-check');
const SHOTS = path.resolve(process.env.SCREENSHOT_DIR || path.join(ROOT, 'test-artifacts', 'screenshots'));

const friendly = (r) => ((r.postData || '').match(/fb_api_req_friendly_name=([^&]+)/) || [])[1] || null;

async function main() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  Object.assign(process.env, { BACKEND_DB: path.join(SCRATCH, 'db.sqlite'), CLONE_DATA_DIR: SCRATCH, VERBOSE: '0', BACKEND_VERBOSE: '0' });
  const { app } = require('../src/server');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { child, browserWsUrl } = await launchChromium(path.join(SCRATCH, 'profile'));
  const results = [];
  const shots = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: Boolean(ok) });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  };
  const shot = async (session, name) => {
    const f = await captureScreenshot(session, path.join(SHOTS, name));
    if (f) shots.push(path.relative(ROOT, f));
  };
  const tag = Date.now().toString(36).slice(-5);
  const nameA = `search_a_${tag}`;
  const nameB = `harbour_${tag}`;
  const fullB = 'Robert Quayside';
  let session = null;
  try {
    const A = new Browser(base);
    await A.signup(null, { username: nameA, fullName: 'Search A' });
    await new Browser(base).signup(null, { username: nameB, fullName: fullB });
    check('accounts A and B exist', true);

    session = await openSession(browserWsUrl);
    watchExternal(session, base);
    await session.cdp.send('Emulation.setDeviceMetricsOverride', { width: Number(process.env.SEARCH_WIDTH || 1600), height: 900, deviceScaleFactor: 1, mobile: false });
    for (const [name, value] of A.jar) await session.cdp.send('Network.setCookie', { name, value: encodeURIComponent(value), url: base });
    await session.cdp.send('Page.navigate', { url: `${base}/` });
    const home = await waitFor(session, `Boolean(document.querySelector('a[href="/${nameA}/"]') && document.querySelector('svg[aria-label="Search"]'))`, 45000);
    await sleep(1500);
    await evaluate(session, "(() => { const b = [...document.querySelectorAll('button')].find((e) => (e.innerText || '').trim() === 'Not Now'); b && b.click(); return true; })()");
    await sleep(600);
    check('A is signed in on the genuine home', home);

    // A new account's home is the empty feed with its own account search box
    // ("Find friends and accounts you like"). (The rail's search item opens
    // /explore/ in this client build, which the snapshot cannot serve yet.)
    const INPUT = "[...document.querySelectorAll('main input')].find((i) => i.placeholder === 'Search')";
    const box = await waitFor(session, `Boolean(${INPUT}) && document.body.innerText.includes('Find friends')`, 20000);
    check("the empty feed's genuine search box is shown", box);
    if (!box) {
      for (const r of session.requests.values()) {
        const op = friendly(r);
        if (op || r.status >= 400 || /bootloader|graphql/.test(r.url)) console.log(`INFO  ${r.status} ${op || new URL(r.url).pathname + new URL(r.url).search.slice(0, 120)}`);
      }
      for (const m of session.consoleMessages.filter((x) => x.level === 'error').slice(0, 8)) console.log(`INFO  console: ${m.text.slice(0, 200)}`);
    }
    session.requests.clear();
    await type(session, INPUT, 'robert quay');
    const listed = await waitFor(session, `[...document.querySelectorAll('a[href="/${nameB}/"]')].some((a) => a.closest('main') && a.innerText.includes(${JSON.stringify(nameB)}))`, 20000);
    await sleep(1000);
    await shot(session, 'search-01-results.png');
    const ops = new Set(['PolarisFeedEmptySULSearchUsersQuery', 'PolarisFeedEmptySULSearchRefetchQuery']);
    const asked = [...session.requests.values()].filter((r) => ops.has(friendly(r)));
    check('typing asks the client\'s search operation and it is answered (200)', asked.length > 0 && asked.every((r) => r.status === 200), asked.map((r) => `${friendly(r)}:${r.status}`).join(','));
    check('B is listed', listed);

    const link = await evaluate(session, `(() => { const a = [...document.querySelectorAll('main a[href="/${nameB}/"]')].find((x) => x.innerText.includes(${JSON.stringify(nameB)})); if (!a) return null; const b = a.getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); })()`);
    if (link) {
      const { x, y } = JSON.parse(link);
      for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) await session.cdp.send('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', clickCount: 1 });
    }
    const profile = await waitFor(session, `location.pathname === '/${nameB}/' && document.body.innerText.includes(${JSON.stringify(fullB)}) && /\\b0\\s+posts\\b/.test(document.body.innerText)`, 30000);
    await sleep(1000);
    await shot(session, 'search-02-profile-opened.png');
    check("clicking B opens B's profile in the genuine client", profile);

    check('strict offline: the browser sent no request to an external host', session.externalRequests.length === 0, session.externalRequests.map((x) => x.url).slice(0, 3).join(' '));
    check('no upstream request was attempted by the server (upstream guard)', upstreamGuard.attempts.length === 0);
    const unanswered = [...new Set([...session.requests.values()].filter((r) => friendly(r) && r.status && r.status !== 200).map((r) => `${friendly(r)}:${r.status}`))];
    if (unanswered.length) console.log(`INFO  operations not answered 200 after typing: ${unanswered.join(', ')}`);
  } catch (error) {
    console.error(error);
    if (session) await shot(session, 'search-FAILED-exception.png');
    check('no exception', false, error.message);
  } finally {
    child.kill('SIGKILL');
    server.closeAllConnections?.();
    server.close();
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} genuine search checks passed`);
  console.log(`screenshots: ${shots.join(', ')}`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
