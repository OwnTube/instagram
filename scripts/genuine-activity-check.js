#!/usr/bin/env node
'use strict';

/**
 * End-to-end check of the activity feed ("Notifications") in the GENUINE
 * client, strictly offline (the pinned snapshot only; upstream guard on).
 * Headless Chromium over CDP:
 *
 *   1. accounts A and B; A posts a photo; B follows A, likes the post and
 *      comments on it (local API calls, the notifications are database rows);
 *   2. A loads /notifications/ directly: the client's activity feed (the
 *      signed-in PolarisActivityFeedRoot route), listing B's follow, like and
 *      comment, loaded through /api/v1/news/inbox/;
 *      and "Suggested for you" lists a third account C (A follows nobody);
 *   3. a reload renders it again;
 *   4. /accounts/activity/ ends on /notifications/ with the same feed (the
 *      client's own redirect);
 *   5. signed out, /notifications/ is not served the anonymous home page;
 *   6. nothing left this origin; the server attempted no upstream request.
 *
 * Needs a snapshot holding the PolarisActivityFeedRoot answers
 * (CLIENT_SNAPSHOT_ID selects one; default: the active snapshot).
 * Screenshots: test-artifacts/screenshots/activity-*.png
 *
 *   CHROMIUM_BIN=... node scripts/genuine-activity-check.js
 */

const upstreamGuard = require('./lib/offline').strictOffline();

const fs = require('node:fs');
const path = require('node:path');
const { launchChromium, openSession, captureScreenshot, watchExternal } = require('./lib/browser');
const { sunsetPng, evaluate, waitFor, sleep } = require('./lib/scenario');
const { Browser } = require('../test/clone-helpers');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, '.scratch', 'genuine-activity-check');
const SHOTS = path.resolve(process.env.SCREENSHOT_DIR || path.join(ROOT, 'test-artifacts', 'screenshots'));

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
  const nameA = `act_a_${tag}`;
  const nameB = `act_b_${tag}`;
  let session = null;
  const navigate = async (p) => {
    session.requests.clear();
    await session.cdp.send('Page.navigate', { url: `${base}${p}` });
  };
  const documentStatus = () => {
    const doc = [...session.requests.values()].find((r) => r.type === 'Document');
    return doc ? doc.status : null;
  };
  const inboxLoaded = () => [...session.requests.values()].some((r) => /\/api\/v1\/news\/inbox\/$/.test(r.url.split('?')[0]) && r.status === 200);
  // B's three notifications, as the client words them.
  const FEED = `(() => { const t = document.body.innerText; return t.includes(${JSON.stringify(nameB)}) && /started following you/.test(t) && /liked your/.test(t) && /commented/.test(t); })()`;
  try {
    const A = new Browser(base);
    const B = new Browser(base);
    const a = await A.signup(null, { username: nameA, fullName: 'Activity A' });
    await B.signup(null, { username: nameB, fullName: 'Activity B' });
    const nameC = `act_c_${tag}`;
    await new Browser(base).signup(null, { username: nameC, fullName: 'Activity C' });
    const postId = String(Date.now());
    await A.request('POST', `/rupload_igphoto/fb_uploader_${postId}`, { raw: sunsetPng(), headers: { 'x-instagram-rupload-params': JSON.stringify({ upload_id: postId, media_type: 1 }), 'content-type': 'image/png' } });
    const posted = await A.post('/api/v1/media/configure/', { upload_id: postId, caption: 'activity check' });
    const mediaPk = String(posted.body.media.pk);
    const follow = await B.post(`/api/v1/friendships/create/${a.pk}/`, {});
    const like = await B.post(`/api/v1/web/likes/${mediaPk}/like/`, {});
    const comment = await B.post(`/api/v1/web/comments/${mediaPk}/add/`, { comment_text: 'nice one' });
    check('B followed A, liked and commented on A\'s post', posted.status === 200 && follow.status === 200 && like.status === 200 && comment.status === 200, `${posted.status} ${follow.status} ${like.status} ${comment.status}`);

    session = await openSession(browserWsUrl);
    watchExternal(session, base);
    await session.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const [name, value] of A.jar) await session.cdp.send('Network.setCookie', { name, value: encodeURIComponent(value), url: base });

    // 2. Direct load.
    await navigate('/notifications/');
    const feed = await waitFor(session, FEED, 30000);
    const login = await evaluate(session, '/Log into Instagram/.test(document.body.innerText)');
    await sleep(800);
    await shot(session, 'activity-01-direct-load.png');
    check("a direct load of /notifications/ renders the client's activity feed with B's follow, like and comment", feed && !login && documentStatus() === 200 && inboxLoaded(), `document ${documentStatus()}, inbox loaded ${inboxLoaded()}`);
    const suggested = await waitFor(session, `(() => { const t = document.body.innerText; const i = t.indexOf('Suggested for you'); return i >= 0 && t.slice(i).includes(${JSON.stringify(nameC)}); })()`, 15000);
    check('"Suggested for you" lists the local account A does not follow', suggested);
    await shot(session, 'activity-01-direct-load.png');
    if (!feed) console.log(`INFO  page text: ${JSON.stringify(((await evaluate(session, 'document.body.innerText')) || '').slice(0, 400))}`);

    // 3. Reload.
    await navigate('/notifications/');
    check('a reload renders the activity feed again', (await waitFor(session, FEED, 30000)) && documentStatus() === 200);

    // 4. The old URL.
    await navigate('/accounts/activity/');
    const moved = await waitFor(session, `location.pathname === '/notifications/' && ${FEED}`, 30000);
    await shot(session, 'activity-02-accounts-activity.png');
    check('/accounts/activity/ ends on /notifications/ with the same feed', moved, `path ${await evaluate(session, 'location.pathname')}`);

    const errors = session.consoleMessages.filter((m) => m.level === 'error').map((m) => m.text.slice(0, 160));
    if (errors.length) console.log(`INFO  console errors: ${[...new Set(errors)].slice(0, 6).join(' | ')}`);
    const failed = [...session.requests.values()].filter((r) => r.status >= 400).map((r) => `${r.status} ${r.url.replace(base, '').slice(0, 120)}`);
    if (failed.length) console.log(`INFO  failed requests (last page): ${failed.slice(0, 8).join(', ')}`);

    const health = await new Browser(base).get('/__clone/health');
    const missing = health.body && health.body.graphql ? health.body.graphql.unsupported : [];
    if (missing.length) console.log(`INFO  GraphQL operations without a resolver: ${missing.map((m) => `${m.name || m.docId} x${m.count} {${m.variableKeys.join(',')}}`).join('; ')}`);
    const rest = health.body && health.body.rest ? health.body.rest.unsupported : [];
    if (rest.length) console.log(`INFO  REST routes without a handler: ${rest.map((r) => `${r.route} x${r.count}`).join('; ')}`);

    // 5. Signed out.
    const anon = await new Browser(base).get('/notifications/', { headers: { accept: 'text/html', 'sec-fetch-site': 'none' } });
    check('signed out, /notifications/ is not served the anonymous home page', anon.status === 404 && !/Log into Instagram/.test(anon.text), `HTTP ${anon.status}`);

    check('strict offline: the browser sent no request to an external host', session.externalRequests.length === 0, session.externalRequests.map((x) => x.url).slice(0, 3).join(' '));
    check('no upstream request was attempted by the server (upstream guard)', upstreamGuard.attempts.length === 0);
  } catch (error) {
    console.error(error);
    if (session) await shot(session, 'activity-FAILED-exception.png');
    check('no exception', false, error.message);
  } finally {
    child.kill('SIGKILL');
    server.closeAllConnections?.();
    server.close();
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} genuine activity checks passed`);
  console.log(`screenshots: ${shots.join(', ')}`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
