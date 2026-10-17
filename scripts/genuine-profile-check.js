#!/usr/bin/env node
'use strict';

/**
 * End-to-end check of profile pages in the GENUINE client, strictly offline.
 * Headless Chromium over CDP:
 *
 *   1. local accounts A and B; B publishes a photo post; A follows B;
 *   2. A (signed in: the session cookie of a local login) opens `/<B>/`, which
 *      the loader serves as the genuine signed-in profile route
 *      (src/shell/signedInRoute.js, profileRoute);
 *   3. the header shows B's counts from the database and "Following"; the
 *      grid shows B's post, its photo served from /__media;
 *   4. A unfollows B through the genuine "Following" menu and follows again
 *      with the genuine "Follow" button; each step is checked in the database;
 *   5. A's own profile renders with A's own controls.
 *
 * Signing in through the genuine form is covered by genuine-login-check and
 * genuine-feed-check; here the browser gets the session cookie of a local
 * login. Strict offline as in genuine-feed-check: the pinned snapshot only, no
 * request to any other host.
 *
 *   node scripts/genuine-profile-check.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const upstreamGuard = require('./lib/offline').strictOffline();

const { launchChromium, openSession, captureScreenshot, watchExternal, evaluateIsolated } = require('./lib/browser');
const { sunsetPng, waitFor, sleep } = require('./lib/scenario');
const { Browser } = require('../test/clone-helpers');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, '.scratch', 'genuine-profile-check');
const SHOTS = path.resolve(process.env.SCREENSHOT_DIR || path.join(ROOT, 'test-artifacts', 'screenshots'));
const PASSWORD = 'correct horse 42';
const CAPTION = 'Harbour at dusk, on B\'s profile';

/** Click the first visible element whose own text is exactly `label` (in an isolated world). */
function clickText(session, label, scope = 'document') {
  return evaluateIsolated(session, `(() => {
    const els = [...${scope}.querySelectorAll('button, [role=button], div[role=menuitem], a')];
    const e = els.find((x) => (x.innerText || '').trim() === ${JSON.stringify(label)} && x.getBoundingClientRect().width > 0);
    if (!e) return false;
    e.click();
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
  const nameA = `prof_a_${tag}`;
  const nameB = `prof_b_${tag}`;
  let session = null;

  try {
    // 1. Accounts, B's post, the follow.
    const A = new Browser(base);
    const B = new Browser(base);
    await B.signup(null, { username: nameB, fullName: 'Profile B', password: PASSWORD });
    await A.signup(null, { username: nameA, fullName: 'Profile A', password: PASSWORD });
    const userA = sql('SELECT id, pk FROM users WHERE username_ci = ?', nameA);
    const userB = sql('SELECT id, pk FROM users WHERE username_ci = ?', nameB);
    const uploadId = String(Date.now());
    await B.request('POST', `/rupload_igphoto/fb_uploader_${uploadId}`, { raw: sunsetPng(), headers: { 'x-instagram-rupload-params': JSON.stringify({ upload_id: uploadId, media_type: 1 }), 'content-type': 'image/png' } });
    const configured = await B.post('/api/v1/media/configure/', { upload_id: uploadId, caption: CAPTION });
    const post = sql('SELECT p.pk, p.code, m.storage_key FROM posts p JOIN media m ON m.id = p.media_id WHERE p.author_id = ? AND p.deleted_at IS NULL', userB.id);
    await A.post(`/api/v1/friendships/create/${userB.pk}/`, {});
    const following = () => sql('SELECT state FROM follows WHERE follower_id = ? AND followee_id = ?', userA.id, userB.id);
    check('setup: A and B exist, B has a post with stored media, A follows B', userA && userB && configured.status === 200 && post && (following() || {}).state === 'accepted', JSON.stringify(post));

    // 2. A's browser opens B's profile.
    session = await openSession(browserWsUrl);
    watchExternal(session, base);
    await session.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const [name, value] of A.jar) await session.cdp.send('Network.setCookie', { name, value: encodeURIComponent(value), url: base });
    await session.cdp.send('Page.navigate', { url: `${base}/${nameB}/` });
    const header = await waitFor(session, `document.body.innerText.includes(${JSON.stringify(nameB)}) && /\\b1\\s+post\\b/.test(document.body.innerText)`, 30000);
    await waitFor(session, `[...document.images].some((i) => i.src.includes(${JSON.stringify(post.storage_key)}) && i.complete && i.naturalWidth > 0)`, 15000);
    await sleep(1000);
    const view = JSON.parse(await evaluateIsolated(session, `JSON.stringify({
      text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300),
      img: [...document.images].filter((i) => i.src.includes(${JSON.stringify(post.storage_key)})).map((i) => ({ done: i.complete && i.naturalWidth > 0, src: new URL(i.src).pathname }))[0] || null,
      postLink: Boolean(document.querySelector('a[href*="/p/${post.code}/"]')),
    })`));
    await shot(session, 'profile-01-other-user-from-database.png');
    check("B's profile renders in the genuine client: username, counts from the database, Following", header && /1 post/.test(view.text) && /1 follower/.test(view.text) && view.text.includes('Following'), view.text.slice(0, 120));
    check("B's post is in the profile grid, its photo served from /__media", view.img && view.img.done && view.img.src.startsWith('/__media/') && view.postLink, JSON.stringify(view.img));

    // 3. Unfollow through the genuine "Following" menu.
    await clickText(session, 'Following');
    const menu = await waitFor(session, "[...document.querySelectorAll('[role=dialog] *')].some((e) => (e.innerText || '').trim() === 'Unfollow')", 8000);
    await shot(session, 'profile-02-following-menu.png');
    await clickText(session, 'Unfollow', "(document.querySelector('[role=dialog]') || document)");
    const unfollowedUi = await waitFor(session, "[...document.querySelectorAll('button, [role=button]')].some((e) => (e.innerText || '').trim() === 'Follow')", 8000);
    await sleep(800);
    const afterUnfollow = following();
    await shot(session, 'profile-03-after-unfollow.png');
    check('unfollow through the genuine menu: the follow row is gone and the button reads Follow', menu && unfollowedUi && !afterUnfollow, JSON.stringify(afterUnfollow));

    // 4. Follow again through the genuine button.
    await clickText(session, 'Follow');
    const followedUi = await waitFor(session, "[...document.querySelectorAll('button, [role=button]')].some((e) => (e.innerText || '').trim() === 'Following')", 8000);
    await sleep(800);
    const afterFollow = following();
    await shot(session, 'profile-04-after-follow.png');
    check('follow through the genuine button: the follow row is back (accepted) and the button reads Following', followedUi && afterFollow && afterFollow.state === 'accepted', JSON.stringify(afterFollow));

    // 5. A's own profile.
    await session.cdp.send('Page.navigate', { url: `${base}/${nameA}/` });
    const own = await waitFor(session, `document.body.innerText.includes(${JSON.stringify(nameA)}) && /\\b0\\s+posts\\b/.test(document.body.innerText)`, 30000);
    await sleep(1000);
    const ownText = await evaluateIsolated(session, "document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300)");
    await shot(session, 'profile-05-own-profile.png');
    check("A's own profile renders with the owner's controls (Edit profile) and A's counts", own && /Edit profile/i.test(ownText) && /1 following/.test(ownText), ownText.slice(0, 120));

    check('strict offline: the browser sent no request to an external host', session.externalRequests.length === 0, session.externalRequests.map((x) => x.url).slice(0, 5).join(' '));

    check('no upstream request was attempted by the server (upstream guard)', upstreamGuard.attempts.length === 0, upstreamGuard.attempts.map((a) => `${a.method} ${a.url}`).slice(0, 5).join(' '));
    const reqs = [...session.requests.values()];
    const friendly = (r) => ((r.postData || '').match(/fb_api_req_friendly_name=([^&]+)/) || [])[1] || null;
    const unanswered = [...new Set(reqs.filter((r) => friendly(r) && r.status && r.status !== 200).map((r) => `${friendly(r)}:${r.status}`))];
    const failed = [...new Set(reqs.filter((r) => !friendly(r) && r.status >= 400).map((r) => { const u = new URL(r.url); const mods = u.pathname.startsWith('/ajax/bootloader-endpoint') ? ` ${u.searchParams.get('modules') || ''}|${u.searchParams.get('nb_modules') || ''}@${u.searchParams.get('__rev') || ''}` : ''; return `${r.status} ${u.pathname}${mods}`; }))];
    check('every operation and module the profile pages asked for was answered', unanswered.length === 0 && failed.length === 0, [...unanswered, ...failed].join(', '));
    const errors = session.consoleMessages.filter((m) => m.level === 'error').map((m) => m.text.replace(/\s+/g, ' ').slice(0, 160));
    if (errors.length) console.log(`INFO  console errors: ${[...new Set(errors)].join(' | ')}`);
    check('no uncaught page errors', session.exceptions.length === 0, session.exceptions.map((e) => e.text.split('\n')[0].slice(0, 160)).join(' | '));
  } catch (error) {
    check('scenario ran to completion', false, error.stack || String(error));
    if (session) await shot(session, 'profile-FAILED.png').catch(() => {});
  } finally {
    child.kill('SIGKILL');
    server.close();
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} genuine profile checks passed`);
  if (shots.length) console.log(`screenshots: ${shots.join(', ')}`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
