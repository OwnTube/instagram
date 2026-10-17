#!/usr/bin/env node
'use strict';

/**
 * Screenshots of the backlog routes as a signed-in local account sees them in
 * the GENUINE client, strictly offline (the pinned snapshot only; upstream
 * guard on). Complements scripts/route-audit.js, which only reports what the
 * server answers: this renders each page in headless Chromium and records,
 * per route, the document status, whether the anonymous login markup is
 * visible, the first lines of visible text, console errors and every failed
 * request (status >= 400), so a "before" and an "after" run can be compared.
 *
 * Content is local and real: B publishes a photo post and a story, A follows B.
 *
 *   CHROMIUM_BIN=... node scripts/route-screens.js <label>
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

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, '.scratch', 'route-screens');
const SHOTS = path.join(ROOT, 'test-artifacts', 'screenshots');
const REPORTS = path.join(ROOT, 'test-artifacts', 'reports');
const label = (process.argv[2] || 'run').replace(/[^a-z0-9_-]/gi, '');

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

    const routes = [
      '/', `/${b.username}/`, `/p/${code}/`, `/stories/${b.username}/`, '/no..such..account/', '/no_such_user_here/',
      '/explore/', '/reels/', '/direct/inbox/', '/accounts/activity/', '/accounts/login/', '/accounts/password/reset/',
      '/accounts/emailsignup/', '/accounts/edit/', '/create/select/',
    ];
    session = await openSession(browserWsUrl);
    watchExternal(session, base);
    await session.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const [name, value] of A.jar) await session.cdp.send('Network.setCookie', { name, value: encodeURIComponent(value), url: base });
    let n = 0;
    for (const route of routes) {
      n += 1;
      session.requests.clear();
      session.consoleMessages.length = 0;
      await session.cdp.send('Page.navigate', { url: `${base}${route}` });
      await sleep(7000);
      const info = JSON.parse(
        (await evaluate(
          session,
          `JSON.stringify({ path: location.pathname, text: (document.body ? document.body.innerText : '').split('\\n').map((s) => s.trim()).filter(Boolean).slice(0, 8), login: /Log into Instagram|Log in\\b/.test(document.body ? document.body.innerText : ''), profileLink: Boolean(document.querySelector('a[href="/${a.username}/"]')) })`
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
        screenshot: path.relative(ROOT, path.join(SHOTS, file)),
      };
      rows.push(row);
      console.log(`${route.padEnd(28)} doc ${String(row.documentStatus).padEnd(4)} ${row.signedInChrome ? 'signed-in chrome' : 'no signed-in chrome'}${row.loginMarkupVisible ? ', LOGIN MARKUP' : ''}; failed ${row.failedRequests.length}; console errors ${row.consoleErrors.length}; "${(info.text || []).slice(0, 2).join(' / ').slice(0, 70)}"`);
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
  process.exit(report.upstreamAttempts === 0 && report.externalRequests === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
