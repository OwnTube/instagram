#!/usr/bin/env node
'use strict';

/**
 * End-to-end check of likes and comments in the GENUINE client, strictly
 * offline. Headless Chromium over CDP:
 *
 *   1. local accounts A and B; B publishes a photo post; A follows B;
 *   2. A (signed in: the session cookie of a local login) likes B's post with
 *      the genuine Like button of the home feed; the like is in the database;
 *   3. the genuine Comment button opens the post; A types a comment into the
 *      genuine comment field and posts it; the comment is in the database;
 *   4. A unlikes the post with the genuine button in the post view;
 *   5. after a fresh load of the home page, the post opened again shows the
 *      comment, read back from the database.
 *
 * Loading /p/<code>/ directly is not covered: the loader has no signed-in post
 * route yet (docs/IMPLEMENTATION-STATUS.md).
 *
 * Strict offline as in genuine-feed-check: the pinned snapshot only, no
 * request to any other host.
 *
 *   node scripts/genuine-engage-check.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const upstreamGuard = require('./lib/offline').strictOffline();

const { launchChromium, openSession, captureScreenshot, watchExternal, evaluateIsolated } = require('./lib/browser');
const { sunsetPng, waitFor, sleep, mouseClickText } = require('./lib/scenario');
const { Browser } = require('../test/clone-helpers');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, '.scratch', 'genuine-engage-check');
const SHOTS = path.resolve(process.env.SCREENSHOT_DIR || path.join(ROOT, 'test-artifacts', 'screenshots'));
const PASSWORD = 'correct horse 42';
const CAPTION = 'Evening light over the harbour';
const COMMENT = 'Lovely colours, where was this?';

/** Click the button around the first visible icon labelled `label` inside `scope` (isolated world). */
function clickIcon(session, label, scope = 'document') {
  return evaluateIsolated(session, `(() => {
    const svg = [...${scope}.querySelectorAll('svg[aria-label=${JSON.stringify(label)}]')].find((s) => s.getBoundingClientRect().width > 0);
    const b = svg && svg.closest('[role=button],button,a');
    if (!b) return false;
    b.click();
    return true;
  })()`);
}

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
    results.push({ name, ok: Boolean(ok), detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  };
  const shot = async (session, name) => {
    const file = await captureScreenshot(session, path.join(SHOTS, name));
    if (file) shots.push(path.relative(ROOT, file));
  };
  const sql = (query, ...args) => {
    const d = new DatabaseSync(path.join(SCRATCH, 'db.sqlite'));
    try {
      return d.prepare(query).get(...args);
    } finally {
      d.close();
    }
  };
  const tag = Date.now().toString(36).slice(-5);
  const nameA = `eng_a_${tag}`;
  const nameB = `eng_b_${tag}`;
  let session = null;

  try {
    // 1. Accounts, B's post, the follow.
    const A = new Browser(base);
    const B = new Browser(base);
    await B.signup(null, { username: nameB, fullName: 'Engage B', password: PASSWORD });
    await A.signup(null, { username: nameA, fullName: 'Engage A', password: PASSWORD });
    const userA = sql('SELECT id, pk FROM users WHERE username_ci = ?', nameA);
    const userB = sql('SELECT id, pk FROM users WHERE username_ci = ?', nameB);
    const uploadId = String(Date.now());
    await B.request('POST', `/rupload_igphoto/fb_uploader_${uploadId}`, { raw: sunsetPng(), headers: { 'x-instagram-rupload-params': JSON.stringify({ upload_id: uploadId, media_type: 1 }), 'content-type': 'image/png' } });
    await B.post('/api/v1/media/configure/', { upload_id: uploadId, caption: CAPTION });
    const post = sql('SELECT id, pk, code FROM posts WHERE author_id = ? AND deleted_at IS NULL', userB.id);
    await A.post(`/api/v1/friendships/create/${userB.pk}/`, {});
    const like = () => sql('SELECT created_at FROM likes WHERE user_id = ? AND post_id = ?', userA.id, post.id);
    const comment = () => sql('SELECT body FROM comments WHERE author_id = ? AND post_id = ? AND deleted_at IS NULL', userA.id, post.id);
    check('setup: B has a post, A follows B', post && sql('SELECT state FROM follows WHERE follower_id = ? AND followee_id = ?', userA.id, userB.id));

    // 2. Like from the home feed.
    session = await openSession(browserWsUrl);
    watchExternal(session, base);
    await session.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const [k, v] of A.jar) await session.cdp.send('Network.setCookie', { name: k, value: encodeURIComponent(v), url: base });
    await session.cdp.send('Page.navigate', { url: `${base}/` });
    await waitFor(session, `document.body.innerText.includes(${JSON.stringify(CAPTION)}) && Boolean(document.querySelector('svg[aria-label="Like"]'))`, 30000);
    await sleep(1000);
    await mouseClickText(session, 'Not Now');
    await clickIcon(session, 'Like');
    const likedUi = await waitFor(session, "Boolean(document.querySelector('article svg[aria-label=\"Unlike\"]'))", 8000);
    await sleep(800);
    await shot(session, 'engage-01-liked-in-feed.png');
    check('the genuine Like button in the feed likes the post: the like is in the database and the button turns to Unlike', likedUi && like());

    // 3. Comment in the post view.
    await clickIcon(session, 'Comment');
    const opened = await waitFor(session, `location.pathname === '/p/${post.code}/' && Boolean(document.querySelector('[role=dialog] textarea'))`, 15000);
    await evaluateIsolated(session, "(() => { const t = document.querySelector('[role=dialog] textarea'); t.focus(); return true; })()");
    await session.cdp.send('Input.insertText', { text: COMMENT });
    await sleep(500);
    await mouseClickText(session, 'Post', "document.querySelector('[role=dialog]')");
    const shown = await waitFor(session, `[...document.querySelectorAll('[role=dialog] *')].some((e) => (e.innerText || '').trim() === ${JSON.stringify(COMMENT)})`, 10000);
    await sleep(800);
    await shot(session, 'engage-02-commented.png');
    check('the genuine Comment button opens the post and the comment field posts the comment, stored in the database', opened && shown && comment() && comment().body === COMMENT, JSON.stringify(comment()));

    // 4. Unlike in the post view.
    await clickIcon(session, 'Unlike', "document.querySelector('[role=dialog]')");
    const unlikedUi = await waitFor(session, "Boolean(document.querySelector('[role=dialog] svg[aria-label=\"Like\"]'))", 8000);
    await sleep(800);
    await shot(session, 'engage-03-unliked.png');
    check('the genuine Unlike button removes the like from the database', unlikedUi && !like());

    // 5. A fresh load of home; the post opened again reads the comment back.
    await session.cdp.send('Page.navigate', { url: `${base}/` });
    await waitFor(session, `document.body.innerText.includes(${JSON.stringify(CAPTION)}) && Boolean(document.querySelector('article svg[aria-label="Comment"]'))`, 30000);
    await sleep(1000);
    await clickIcon(session, 'Comment', "document.querySelector('article')");
    const reread = await waitFor(session, `[...document.querySelectorAll('[role=dialog] *')].some((e) => (e.innerText || '').trim() === ${JSON.stringify(COMMENT)}) && Boolean(document.querySelector('[role=dialog] svg[aria-label="Like"]'))`, 15000);
    await sleep(1000);
    await shot(session, 'engage-04-reloaded-post.png');
    check('after a fresh page load the post shows the comment from the database and no like', reread);

    check('strict offline: the browser sent no request to an external host', session.externalRequests.length === 0, session.externalRequests.map((x) => x.url).slice(0, 5).join(' '));

    check('no upstream request was attempted by the server (upstream guard)', upstreamGuard.attempts.length === 0, upstreamGuard.attempts.map((a) => `${a.method} ${a.url}`).slice(0, 5).join(' '));
    const reqs = [...session.requests.values()];
    const friendly = (r) => ((r.postData || '').match(/fb_api_req_friendly_name=([^&]+)/) || [])[1] || null;
    const unanswered = [...new Set(reqs.filter((r) => friendly(r) && r.status && r.status !== 200).map((r) => `${friendly(r)}:${r.status}`))];
    const failed = [...new Set(reqs.filter((r) => !friendly(r) && r.status >= 400).map((r) => { const u = new URL(r.url); const mods = u.pathname.startsWith('/ajax/bootloader-endpoint') ? ` ${u.searchParams.get('modules') || ''}|${u.searchParams.get('nb_modules') || ''}@${u.searchParams.get('__rev') || ''}` : ''; return `${r.status} ${u.pathname}${mods}`; }))];
    check('every operation, module and image the pages asked for was answered', unanswered.length === 0 && failed.length === 0, [...unanswered, ...failed].join(', '));
    const errors = session.consoleMessages.filter((m) => m.level === 'error').map((m) => m.text.replace(/\s+/g, ' ').slice(0, 160));
    if (errors.length) console.log(`INFO  console errors: ${[...new Set(errors)].join(' | ')}`);
    check('no uncaught page errors', session.exceptions.length === 0, session.exceptions.map((e) => e.text.split('\n')[0].slice(0, 160)).join(' | '));
  } catch (error) {
    check('scenario ran to completion', false, error.stack || String(error));
    if (session) await shot(session, 'engage-FAILED.png').catch(() => {});
  } finally {
    child.kill('SIGKILL');
    server.close();
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} genuine like and comment checks passed`);
  if (shots.length) console.log(`screenshots: ${shots.join(', ')}`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
