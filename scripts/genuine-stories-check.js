#!/usr/bin/env node
'use strict';

/**
 * End-to-end check of stories in the GENUINE client, strictly offline (the
 * pinned snapshot only; upstream guard on). Headless Chromium over CDP:
 *
 *   1. accounts A and B; A follows B; B posts a photo story and a photo post
 *      (local uploads; with no post in A's feed the home page is the empty
 *      feed, which has no stories tray);
 *   2. A loads /stories/B/ directly: the client's stories page (the signed-in
 *      PolarisStoriesMediaRoot route), not the anonymous page;
 *   3. A confirms "View story": B's story image is displayed (served from this
 *      server's media store) and the view is recorded (story_views row);
 *   4. a reload of /stories/B/ renders the stories page again;
 *   5. from the home page, B's ring in the stories tray opens B's story
 *      through the client's router;
 *   6. a URL naming no account renders the client's "page isn't available"
 *      page (HTTP 404) to the signed-in viewer;
 *   7. nothing left this origin; the server attempted no upstream request.
 *
 * Needs a snapshot holding the PolarisStoriesMediaRoot and PolarisErrorRoot
 * answers (CLIENT_SNAPSHOT_ID selects one; default: the active snapshot).
 * Screenshots: test-artifacts/screenshots/stories-*.png
 *
 *   CHROMIUM_BIN=... node scripts/genuine-stories-check.js
 */

const upstreamGuard = require('./lib/offline').strictOffline();

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { launchChromium, openSession, captureScreenshot, watchExternal } = require('./lib/browser');
const { sunsetPng, evaluate, waitFor, sleep, mouseClickText } = require('./lib/scenario');
const { Browser } = require('../test/clone-helpers');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, '.scratch', 'genuine-stories-check');
const SHOTS = path.resolve(process.env.SCREENSHOT_DIR || path.join(ROOT, 'test-artifacts', 'screenshots'));

// A displayed story image: an <img> from this server's media store, loaded,
// and large (the story frame, not an avatar).
const STORY_IMAGE = "[...document.querySelectorAll('img')].some((i) => /\\/__media\\//.test(i.currentSrc || i.src) && i.complete && i.naturalWidth > 0 && i.getBoundingClientRect().height > 300)";

async function main() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const dbFile = path.join(SCRATCH, 'db.sqlite');
  Object.assign(process.env, { BACKEND_DB: dbFile, CLONE_DATA_DIR: SCRATCH, VERBOSE: '0', BACKEND_VERBOSE: '0' });
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
  const sql = (q, ...args) => {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      return db.prepare(q).get(...args);
    } finally {
      db.close();
    }
  };
  const tag = Date.now().toString(36).slice(-5);
  const nameA = `story_a_${tag}`;
  const nameB = `story_b_${tag}`;
  let session = null;
  const navigate = async (p) => {
    session.requests.clear();
    await session.cdp.send('Page.navigate', { url: `${base}${p}` });
  };
  const documentStatus = () => {
    const doc = [...session.requests.values()].find((r) => r.type === 'Document');
    return doc ? doc.status : null;
  };
  try {
    const A = new Browser(base);
    const B = new Browser(base);
    await A.signup(null, { username: nameA, fullName: 'Story A' });
    const b = await B.signup(null, { username: nameB, fullName: 'Story B' });
    const follow = await A.post(`/api/v1/friendships/create/${b.pk}/`, {});
    const storyId = String(Date.now());
    const up = await B.request('POST', `/rupload_igphoto/fb_uploader_${storyId}`, { raw: sunsetPng(1080, 1920), headers: { 'x-instagram-rupload-params': JSON.stringify({ upload_id: storyId, media_type: 1, is_story: '1' }), 'content-type': 'image/png' } });
    const configured = await B.post('/api/v1/media/configure_to_story/', { upload_id: storyId });
    const postId = String(Date.now() + 1);
    await B.request('POST', `/rupload_igphoto/fb_uploader_${postId}`, { raw: sunsetPng(), headers: { 'x-instagram-rupload-params': JSON.stringify({ upload_id: postId, media_type: 1 }), 'content-type': 'image/png' } });
    const posted = await B.post('/api/v1/media/configure/', { upload_id: postId, caption: 'stories check' });
    const story = sql('SELECT s.id FROM stories s JOIN users u ON u.id = s.author_id WHERE u.username_ci = ?', nameB);
    check('A follows B; B posted a story and a post (database rows)', follow.status === 200 && up.status === 200 && configured.status === 200 && posted.status === 200 && story);

    session = await openSession(browserWsUrl);
    watchExternal(session, base);
    await session.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const [name, value] of A.jar) await session.cdp.send('Network.setCookie', { name, value: encodeURIComponent(value), url: base });

    // 2. Direct load.
    await navigate(`/stories/${nameB}/`);
    const page = await waitFor(session, `document.body.innerText.includes(${JSON.stringify(nameB)}) && /View story|View as/.test(document.body.innerText)`, 30000);
    const login = await evaluate(session, "/Log into Instagram/.test(document.body.innerText)");
    await sleep(800);
    await shot(session, 'stories-01-direct-load.png');
    check("a direct load of /stories/B/ renders the client's stories page for A", page && !login && documentStatus() === 200, `document ${documentStatus()}`);

    // 3. View the story.
    await mouseClickText(session, 'View story');
    const shown = await waitFor(session, STORY_IMAGE, 20000);
    await sleep(1200);
    await shot(session, 'stories-02-story-shown.png');
    check("B's story image is displayed (from this server's media store)", shown);
    let seen = null;
    for (let i = 0; i < 20 && !seen; i += 1) {
      seen = sql('SELECT v.seen_at FROM story_views v JOIN users u ON u.id = v.viewer_id WHERE v.story_id = ? AND u.username_ci = ?', story.id, nameA);
      if (!seen) await sleep(500);
    }
    check('the view is recorded (story_views row for A)', seen, seen ? seen.seen_at : 'no row');

    // 4. Reload.
    await navigate(`/stories/${nameB}/`);
    const again = await waitFor(session, `document.body.innerText.includes(${JSON.stringify(nameB)}) && (/View story|View as/.test(document.body.innerText) || ${STORY_IMAGE})`, 30000);
    check('a reload renders the stories page again', again && documentStatus() === 200);

    // 5. From the home tray, through the client's router.
    await navigate('/');
    // The tray item: a button holding the owner's avatar (canvas ring + image)
    // and name; the name alone is also a link, to the profile.
    const ring = `[...document.querySelectorAll('[role=button], button')].filter((e) => (e.innerText || '').trim().startsWith(${JSON.stringify(nameB.slice(0, 10))}) && e.querySelector('img, canvas') && e.getBoundingClientRect().top < 250 && e.getBoundingClientRect().width > 0).pop()`;
    const home = await waitFor(session, `Boolean(${ring})`, 30000);
    // The client's "Turn on Notifications" dialog opens shortly after the
    // home page renders and covers the tray; dismiss it the way a user does.
    if (await waitFor(session, "[...document.querySelectorAll('button')].some((e) => (e.innerText || '').trim() === 'Not Now')", 8000)) {
      await mouseClickText(session, 'Not Now');
      await waitFor(session, "![...document.querySelectorAll('button')].some((e) => (e.innerText || '').trim() === 'Not Now')", 5000);
    }
    await sleep(600);
    const before = session.requests.size;
    const at = await evaluate(session, `(() => { const e = ${ring}; if (!e) return null; const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`);
    if (at) {
      const { x, y } = JSON.parse(at);
      for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) await session.cdp.send('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', clickCount: 1 });
    }
    const opened = await waitFor(session, `location.pathname.startsWith('/stories/${nameB}/') && (${STORY_IMAGE} || /View story|View as/.test(document.body.innerText))`, 20000);
    const reloaded = [...session.requests.values()].slice(before).some((r) => r.type === 'Document');
    await sleep(1000);
    await shot(session, 'stories-03-from-tray.png');
    check("B's ring in A's home tray opens B's story in the client (no page load)", home && opened && !reloaded, `home ${home}, opened ${opened}, document reload ${reloaded}`);
    if (!opened || reloaded) {
      console.log(`INFO  after the tray click: path ${await evaluate(session, 'location.pathname')}`);
      for (const r of [...session.requests.values()].slice(before)) if (r.type === 'Document' || /route-definition|bootloader/.test(r.url)) console.log(`INFO    ${r.type} ${r.status} ${r.url.replace(base, '').slice(0, 140)}`);
    }

    // 6. An account that does not exist.
    await navigate('/stories/no_such_account_here/');
    const missing = await waitFor(session, "document.body.innerText.includes(\"Sorry, this page isn't available.\")", 30000);
    await sleep(500);
    await shot(session, 'stories-04-unknown-account.png');
    check("an unknown account's stories URL renders the client's not-found page (404)", missing && documentStatus() === 404, `document ${documentStatus()}`);

    check('strict offline: the browser sent no request to an external host', session.externalRequests.length === 0, session.externalRequests.map((x) => x.url).slice(0, 3).join(' '));
    check('no upstream request was attempted by the server (upstream guard)', upstreamGuard.attempts.length === 0);
    const errors = session.consoleMessages.filter((m) => m.level === 'error').map((m) => m.text.slice(0, 160));
    if (errors.length) console.log(`INFO  console errors: ${[...new Set(errors)].slice(0, 6).join(' | ')}`);
    const failed = [...session.requests.values()].filter((r) => r.status >= 400).map((r) => `${r.status} ${r.url.replace(base, '').slice(0, 120)}`);
    if (failed.length) console.log(`INFO  failed requests (last page): ${failed.slice(0, 8).join(', ')}`);
  } catch (error) {
    console.error(error);
    if (session) await shot(session, 'stories-FAILED-exception.png');
    check('no exception', false, error.message);
  } finally {
    child.kill('SIGKILL');
    server.closeAllConnections?.();
    server.close();
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} genuine stories checks passed`);
  console.log(`screenshots: ${shots.join(', ')}`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
