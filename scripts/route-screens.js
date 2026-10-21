#!/usr/bin/env node
'use strict';

/**
 * Screenshots of every page of the page registry (src/pages/registry.js) as a signed-in local account sees them in
 * the GENUINE client, strictly offline (the pinned snapshot only; upstream
 * guard on). Complements scripts/route-audit.js, which only reports what the
 * server answers: this renders each page in headless Chromium and records,
 * per route, the document status, whether the anonymous login markup is
 * visible, the first lines of visible text, console errors and every failed
 * request (status >= 400), so a "before" and an "after" run can be compared.
 *
 * Content is local and real: B publishes a photo post and a story, A follows B.
 *
 * Each page gets a verdict from what the browser shows, not only from the
 * server's status:
 *  - WORKING: a signed-in page answered 200 that renders in the signed-in
 *    chrome, without login markup or the client's "isn't available" page,
 *    without uncaught exceptions or failed requests; an anonymous page
 *    (visited signed out) answered 200 that shows its expected text;
 *  - UNAVAILABLE: the server says it does not serve the page (501), and the
 *    client's "isn't available" page shows in the signed-in chrome;
 *  - DEGRADED: served in a lesser form the server names
 *    (x-clone-page-degraded, e.g. the mobile Reels viewer);
 *  - NOT FOUND (expected): a URL naming nothing shows the not-found page, 404;
 *  - WRONG: anything else.
 * Exit status: 0 only with no WRONG, no upstream or external request, and no
 * UNAVAILABLE or DEGRADED page (unless --allow-unavailable).
 *
 *   CHROMIUM_BIN=... node scripts/route-screens.js <label> [--allow-unavailable]
 *
 * Output: test-artifacts/screenshots/routes-<label>-<n>-<route>.png and
 *         test-artifacts/reports/routes-<label>.json
 */

const upstreamGuard = require('./lib/offline').strictOffline();

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { launchChromium, openSession, captureScreenshot, watchExternal } = require('./lib/browser');
const { sunsetPng, evaluate, sleep } = require('./lib/scenario');
const { Browser } = require('../test/clone-helpers');
const { PAGES, matchPage } = require('../src/pages/registry');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, '.scratch', 'route-screens');
const SHOTS = path.join(ROOT, 'test-artifacts', 'screenshots');
const REPORTS = path.join(ROOT, 'test-artifacts', 'reports');
const label = (process.argv.slice(2).find((a) => !a.startsWith('--')) || 'run').replace(/[^a-z0-9_-]/gi, '');
const allowUnavailable = process.argv.includes('--allow-unavailable');
const NOT_AVAILABLE = /Sorry, this page isn't available/;
const NOT_FOUND_URLS = ['/no..such..account/', '/no_such_user_here/'];

/** The verdict for one rendered route (see the header). */
function verdictFor({ route, page, server, row, text }) {
  const shown = (re) => re.test(text);
  const problems = [];
  if (row.pageExceptions.length) problems.push(`${row.pageExceptions.length} uncaught exception(s)`);
  if (row.failedRequests.length) problems.push(`${row.failedRequests.length} failed request(s)`);
  if (NOT_FOUND_URLS.includes(route)) {
    return row.documentStatus === 404 && shown(NOT_AVAILABLE) && row.signedInChrome ? ['NOT FOUND', 'expected'] : ['WRONG', `expected the not-found page, got ${row.documentStatus}`];
  }
  if (!page) return ['WRONG', 'no registry page'];
  if (page.access === 'anonymous') {
    if (row.documentStatus !== 200) return ['WRONG', `status ${row.documentStatus}`];
    if (page.expect.text && !text.includes(page.expect.text)) return ['WRONG', `"${page.expect.text}" not shown`];
    return problems.length ? ['WRONG', problems.join(', ')] : ['WORKING', 'anonymous page'];
  }
  if (row.loginMarkupVisible) return ['WRONG', 'login markup for a signed-in viewer'];
  if (!row.signedInChrome && page.expect.chrome !== false) return ['WRONG', 'no signed-in chrome'];
  if (row.documentStatus === 501) return shown(NOT_AVAILABLE) ? ['UNAVAILABLE', server.unavailable || ''] : ['WRONG', '501 without the not-available page'];
  if (row.documentStatus !== 200) return ['WRONG', `status ${row.documentStatus}`];
  if (shown(NOT_AVAILABLE)) return ['WRONG', 'answered 200 but shows the not-available page'];
  if (problems.length) return ['WRONG', problems.join(', ')];
  if (server.degraded) return ['DEGRADED', server.degraded];
  return ['WORKING', ''];
}

async function main() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(REPORTS, { recursive: true });
  const dbFile = path.join(SCRATCH, 'db.sqlite');
  Object.assign(process.env, { BACKEND_DB: dbFile, CLONE_DATA_DIR: SCRATCH, VERBOSE: '0', BACKEND_VERBOSE: '0' });
  const { app } = require('../src/server');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { child, browserWsUrl } = await launchChromium(path.join(SCRATCH, 'profile'));
  const rows = [];
  let session = null;
  try {
    const tag = Date.now().toString(36).slice(-5);
    const A = new Browser(base);
    const B = new Browser(base);
    const a = await A.signup(null, { username: `routes_a_${tag}`, fullName: 'Routes A' });
    const b = await B.signup(null, { username: `routes_b_${tag}`, fullName: 'Routes B' });
    await A.post(`/api/v1/friendships/create/${b.pk}/`, {});
    const png = sunsetPng();
    const postId = String(Date.now());
    await B.request('POST', `/rupload_igphoto/fb_uploader_${postId}`, { raw: png, headers: { 'x-instagram-rupload-params': JSON.stringify({ upload_id: postId, media_type: 1 }), 'content-type': 'image/png' } });
    await B.post('/api/v1/media/configure/', { upload_id: postId, caption: 'route screens' });
    const storyId = String(Date.now() + 1);
    await B.request('POST', `/rupload_igphoto/fb_uploader_${storyId}`, { raw: png, headers: { 'x-instagram-rupload-params': JSON.stringify({ upload_id: storyId, media_type: 1, is_story: '1' }), 'content-type': 'image/png' } });
    await B.post('/api/v1/media/configure_to_story/', { upload_id: storyId });
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const code = db.prepare('SELECT p.code FROM posts p JOIN users u ON u.id = p.author_id WHERE u.username_ci = ?').get(b.username).code;
    db.close();

    const thread = await A.post('/api/v1/direct_v2/threads/broadcast/text/', { recipient_users: JSON.stringify([[String(b.pk)]]), text: 'route screens', client_context: `screens-${tag}` });
    // Every page of the registry with a sample URL, then two URLs that name nothing.
    const fixtures = { username: b.username, postCode: code, storyOwner: b.username, threadId: String(thread.body.payload.thread_id) };
    const sampled = PAGES.filter((p) => p.sample && p.sample(fixtures));
    const routes = [...sampled.filter((p) => p.access === 'signed-in').map((p) => p.sample(fixtures)), ...NOT_FOUND_URLS, ...sampled.filter((p) => p.access === 'anonymous').map((p) => p.sample(fixtures))];
    const nav = { accept: 'text/html', 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    session = await openSession(browserWsUrl);
    watchExternal(session, base);
    await session.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const [name, value] of A.jar) await session.cdp.send('Network.setCookie', { name, value: encodeURIComponent(value), url: base });
    let n = 0;
    for (const route of routes) {
      n += 1;
      const page = matchPage(new URL(route, base).pathname)?.page || null;
      const anonymous = Boolean(page && page.access === 'anonymous') && !NOT_FOUND_URLS.includes(route);
      // Anonymous pages are seen signed out.
      if (anonymous) await session.cdp.send('Network.clearBrowserCookies');
      // What the server says about the page (headers the browser does not expose to the page).
      const head = await (anonymous ? new Browser(base) : A).get(route, { headers: nav });
      const server = { unavailable: head.headers.get('x-clone-page-unavailable'), degraded: head.headers.get('x-clone-page-degraded') };
      session.requests.clear();
      session.consoleMessages.length = 0;
      session.exceptions.length = 0;
      await session.cdp.send('Page.navigate', { url: `${base}${route}` });
      await sleep(7000);
      const info = JSON.parse(
        (await evaluate(
          session,
          `JSON.stringify({ path: location.pathname, text: (document.body ? document.body.innerText : '').split('\\n').map((s) => s.trim()).filter(Boolean).slice(0, 8), login: /Log into Instagram|Log in\\b/.test(document.body ? document.body.innerText : ''), fullText: (document.body ? document.body.innerText : '').slice(0, 5000), profileLink: Boolean(document.querySelector('a[href="/${a.username}/"]')) })`
        )) || '{}'
      );
      const requests = [...session.requests.values()];
      const doc = requests.find((r) => r.type === 'Document');
      const file = `routes-${label}-${String(n).padStart(2, '0')}-${route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home'}.png`;
      await captureScreenshot(session, path.join(SHOTS, file));
      const row = {
        route,
        finalPath: info.path,
        documentStatus: doc ? doc.status : null,
        signedInChrome: info.profileLink,
        loginMarkupVisible: info.login,
        text: info.text,
        failedRequests: requests.filter((r) => r.status >= 400).map((r) => `${r.status} ${r.url.replace(base, '').slice(0, 160)}`),
        consoleErrors: session.consoleMessages.filter((m) => m.level === 'error').map((m) => m.text.slice(0, 200)).slice(0, 10),
        pageExceptions: session.exceptions.map((e) => e.text.split('\n')[0].slice(0, 200)).slice(0, 10),
        screenshot: path.relative(ROOT, path.join(SHOTS, file)),
      };
      [row.verdict, row.detail] = verdictFor({ route, page, server, row, text: info.fullText || '' });
      row.page = page ? page.id : null;
      delete info.fullText;
      rows.push(row);
      console.log(`${row.verdict.padEnd(11)} ${(row.page || '-').padEnd(22)} ${route.padEnd(30)} doc ${String(row.documentStatus).padEnd(4)} ${row.detail}`);
    }
  } finally {
    child.kill('SIGKILL');
    server.closeAllConnections?.();
    server.close();
  }
  const report = { label, at: new Date().toISOString(), externalRequests: session ? session.externalRequests.length : null, upstreamAttempts: upstreamGuard.attempts.length, routes: rows };
  fs.writeFileSync(path.join(REPORTS, `routes-${label}.json`), JSON.stringify(report, null, 1));
  console.log(`browser requests to other hosts: ${report.externalRequests}; upstream attempts: ${report.upstreamAttempts}`);
  console.log(`report: ${path.relative(ROOT, path.join(REPORTS, `routes-${label}.json`))}`);
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  console.log(`pages: ${count('WORKING')} working, ${count('DEGRADED')} degraded, ${count('UNAVAILABLE')} unavailable, ${count('WRONG')} wrong, ${count('NOT FOUND')} not-found URLs as expected`);
  const failed = report.upstreamAttempts > 0 || report.externalRequests > 0 || count('WRONG') > 0 || (!allowUnavailable && count('UNAVAILABLE') + count('DEGRADED') > 0);
  if (failed) console.log(`route screens FAILED${!allowUnavailable && count('UNAVAILABLE') + count('DEGRADED') ? ' (unavailable and degraded pages count as failures; --allow-unavailable checks the rest)' : ''}`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
