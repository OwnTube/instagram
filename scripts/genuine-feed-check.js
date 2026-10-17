#!/usr/bin/env node
'use strict';

/**
 * End-to-end check of the signed-in home feed in the GENUINE client, strictly
 * offline. Headless Chromium over CDP:
 *
 *   1. two local accounts, A and B, are created; A follows B;
 *   2. B publishes a photo post (a generated PNG) through the upload and
 *      configure endpoints, so the post and its media live in our database;
 *   3. A signs in through the genuine login form (useCDSWebLoginMutation) and
 *      loads `/`, which the loader serves as the genuine signed-in feed route
 *      (SHELL_SIGNED_IN_HOME=1, src/shell/signedInRoute.js);
 *   4. B's post must render: author, caption, and the photo loaded from /__media.
 *
 * Strict offline: page, bundles and answers come from the active pinned
 * client snapshot (or CLIENT_SNAPSHOT_ID); documents carry a self-only CSP; the
 * upstream guard fails any server request to a non-local host and the check
 * asserts none was attempted. Every request the browser sends is watched; any
 * request to a host other than the loader fails the check.
 *
 * Screenshots go to test-artifacts/screenshots/ (SCREENSHOT_DIR overrides).
 *
 *   node scripts/genuine-feed-check.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const upstreamGuard = require('./lib/offline').strictOffline();

// Server side of strict offline: every outbound attempt this process makes
// (global fetch, http/https requests) to a host other than loopback is recorded.
const outbound = [];
const isLoopback = (host) => /^(127\.0\.0\.1|localhost|\[?::1\]?)$/.test(String(host || ''));
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (!isLoopback(url.hostname)) outbound.push(url.href);
  return realFetch(input, init);
};
for (const mod of [require('node:http'), require('node:https')]) {
  for (const fn of ['request', 'get']) {
    const real = mod[fn];
    mod[fn] = function patched(...args) {
      const a = args[0];
      const host = typeof a === 'string' || a instanceof URL ? new URL(String(a)).hostname : a && (a.hostname || a.host);
      if (!isLoopback(host)) outbound.push(`${fn} ${host}`);
      return real.apply(this, args);
    };
  }
}

const { launchChromium, openSession, captureScreenshot, watchExternal, evaluateIsolated } = require('./lib/browser');
const { sunsetPng, evaluate, type, waitFor } = require('./lib/scenario');
const { Browser } = require('../test/clone-helpers');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, '.scratch', 'genuine-feed-check');
const SHOTS = path.resolve(process.env.SCREENSHOT_DIR || path.join(ROOT, 'test-artifacts', 'screenshots'));
const PASSWORD = 'correct horse 42';
const CAPTION = 'Sunset over the harbour, posted by B';
const { sleep } = require('./lib/scenario');

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
    results.push({ name, ok: Boolean(ok), detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  };
  const shot = async (session, name) => {
    const file = await captureScreenshot(session, path.join(SHOTS, name));
    if (file) shots.push(path.relative(ROOT, file));
    return file;
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
  const nameA = `feed_a_${tag}`;
  const nameB = `feed_b_${tag}`;
  const nameC = `feed_c_${tag}`;
  let session = null;

  try {
    // 1. Accounts and the follow, through the local API.
    const A = new Browser(base);
    const B = new Browser(base);
    const b = await B.signup(null, { username: nameB, fullName: 'Feed B', password: PASSWORD });
    const a = await A.signup(null, { username: nameA, fullName: 'Feed A', password: PASSWORD });
    const userA = sql('SELECT id, pk FROM users WHERE username_ci = ?', nameA);
    const userB = sql('SELECT id, pk FROM users WHERE username_ci = ?', nameB);
    check('accounts A and B exist in the database', userA && userB && userA.pk === String(a.pk) && userB.pk === String(b.pk));
    const follow = await A.post(`/api/v1/friendships/create/${userB.pk}/`, {});
    const edge = sql('SELECT state FROM follows WHERE follower_id = ? AND followee_id = ?', userA.id, userB.id);
    check('A follows B (database row)', follow.status === 200 && edge && edge.state === 'accepted', JSON.stringify(edge));

    // 2. B publishes a photo post.
    const uploadId = String(Date.now());
    const png = sunsetPng();
    const up = await B.request('POST', `/rupload_igphoto/fb_uploader_${uploadId}`, { raw: png, headers: { 'x-instagram-rupload-params': JSON.stringify({ upload_id: uploadId, media_type: 1 }), 'content-type': 'image/png' } });
    const configured = await B.post('/api/v1/media/configure/', { upload_id: uploadId, caption: CAPTION });
    const post = sql('SELECT p.pk, p.code, p.caption, m.storage_key, m.width, m.height FROM posts p JOIN media m ON m.id = p.media_id WHERE p.author_id = ? AND p.deleted_at IS NULL', userB.id);
    check('B published a photo post (database row with stored media)', up.status === 200 && configured.status === 200 && post && post.caption === CAPTION && post.width === 1080, JSON.stringify(post));

    // Content behind the home page's other components, all local: C (whom B
    // follows, A does not) is a suggestion for A; B's story is in A's tray;
    // B following A is a notification; B's message is an unread Direct thread.
    const C = new Browser(base);
    const c = await C.signup(null, { username: nameC, fullName: 'Feed C', password: PASSWORD });
    const storyId = String(Date.now() + 1);
    await B.request('POST', `/rupload_igphoto/fb_uploader_${storyId}`, { raw: png, headers: { 'x-instagram-rupload-params': JSON.stringify({ upload_id: storyId, media_type: 1, is_story: '1' }), 'content-type': 'image/png' } });
    const extras = [
      (await B.post(`/api/v1/friendships/create/${c.pk}/`, {})).status,
      (await B.post('/api/v1/media/configure_to_story/', { upload_id: storyId })).status,
      (await B.post(`/api/v1/friendships/create/${a.pk}/`, {})).status,
      (await B.post('/api/v1/direct_v2/threads/broadcast/text/', { recipient_users: [[a.pk]], text: 'hello from B', client_context: 'feed-check-1', action: 'send_item' })).status,
    ];
    const rows = sql(`SELECT (SELECT COUNT(*) FROM stories WHERE author_id = ?) AS stories, (SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL) AS notes,
      (SELECT COUNT(*) FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id WHERE cm.user_id = ? AND m.sender_id = ?) AS dms`, userB.id, userA.id, userA.id, userB.id);
    check('local content for the home components: C, B\'s story, a notification and a message for A', extras.every((x) => x === 200) && rows.stories === 1 && rows.notes >= 1 && rows.dms === 1, JSON.stringify({ extras, ...rows }));

    // 3. A signs in through the genuine login form, strictly offline.
    session = await openSession(browserWsUrl);
    watchExternal(session, base);
    await session.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const bodies = new Map();
    session.cdp.on((msg) => {
      if (msg.method !== 'Network.loadingFinished') return;
      const r = session.requests.get(msg.params.requestId);
      if (r && friendly(r) === 'PolarisFeedTimelineRootV2Query') {
        session.cdp.send('Network.getResponseBody', { requestId: msg.params.requestId }).then((x) => bodies.set(msg.params.requestId, x.body), () => {});
      }
    });
    await session.cdp.send('Page.navigate', { url: `${base}/` });
    const formReady = await waitFor(session, "Boolean(document.querySelector('[id^=mount_]') && getComputedStyle(document.querySelector('[id^=mount_]')).contentVisibility === 'visible' && document.querySelector('input[type=password]'))", 30000);
    await type(session, "[...document.querySelectorAll('input')].find((e) => e.type !== 'password' && e.type !== 'hidden' && e.type !== 'checkbox')", nameA);
    await type(session, "document.querySelector('input[type=password]')", PASSWORD);
    await sleep(800);
    await shot(session, 'feed-01-genuine-login-form-filled.png');
    const before = new Set(session.requests.keys());
    await evaluate(session, "(() => { const b = [...document.querySelectorAll('[role=button],button')].find((e) => (e.innerText || '').trim() === 'Log in'); b && b.click(); return Boolean(b); })()");
    await sleep(6000);
    const mutation = [...session.requests.entries()].find(([id, r]) => !before.has(id) && friendly(r) === 'useCDSWebLoginMutation');
    const me = await evaluate(session, "fetch('/api/v1/accounts/current_user/').then(async (r) => ({ status: r.status, username: (await r.json().catch(() => ({}))).user?.username }))");
    check('A signed in through the genuine form (useCDSWebLoginMutation)', formReady && mutation && mutation[1].status === 200 && me.username === nameA, JSON.stringify(me));

    // 4. The signed-in home.
    session.requests.clear();
    await session.cdp.send('Page.navigate', { url: `${base}/` });
    const article = `(() => { const a = [...document.querySelectorAll('main article')].find((x) => x.innerText.includes(${JSON.stringify(nameB)})); return Boolean(a && a.innerText.includes(${JSON.stringify(CAPTION)})); })()`;
    const rendered = await waitFor(session, article, 45000);
    await sleep(1500);
    await shot(session, 'feed-02-signed-in-home.png');
    // A modal the signed-in home opens on first visit ("Turn on Notifications")
    // covers the feed; dismiss it the way a user would.
    await evaluate(session, "[...document.querySelectorAll('button,[role=button]')].find((e) => (e.innerText || '').trim() === 'Not Now')?.click()");
    await sleep(1000);
    const view = await evaluateIsolated(session, `(() => {
      const a = [...document.querySelectorAll('main article')].find((x) => x.innerText.includes(${JSON.stringify(nameB)}));
      if (!a) return JSON.stringify(null);
      window.scrollTo(0, a.getBoundingClientRect().top + window.scrollY - 70);
      const imgs = [...a.querySelectorAll('img')].map((i) => ({ src: i.getAttribute('src'), w: i.naturalWidth, done: i.complete, box: Math.round(i.getBoundingClientRect().width) }));
      return JSON.stringify({ text: a.innerText.slice(0, 400), imgs });
    })()`).then((x) => JSON.parse(x || 'null'));
    await sleep(800);
    await shot(session, rendered ? 'feed-03-post-from-B-rendered.png' : 'feed-03-FAILED-post-not-rendered.png');

    const reqs = [...session.requests.values()];
    const feedReq = reqs.find((r) => friendly(r) === 'PolarisFeedTimelineRootV2Query');
    const feedBody = [...bodies.values()][0] || '';
    check('the genuine client asked for PolarisFeedTimelineRootV2Query and got 200', feedReq && feedReq.status === 200);
    check('the feed answer carries B\'s post from the database', feedBody.includes(`"pk":"${post && post.pk}"`) && feedBody.includes(CAPTION));
    check('B\'s post renders for A: author and caption', rendered && view && view.text.includes(nameB) && view.text.includes(CAPTION), view && view.text.replace(/\s+/g, ' ').slice(0, 160));
    const photo = view && view.imgs.find((i) => i.src && post && i.src.includes(post.storage_key));
    check('B\'s photo is displayed, served from /__media', photo && photo.done && photo.w === 1080 && photo.box > 200, JSON.stringify(photo || (view && view.imgs)));
    check('strict offline: the browser sent no request to an external host', session.externalRequests.length === 0, session.externalRequests.map((x) => x.url).slice(0, 5).join(' '));
    check('no upstream request was attempted by the server (upstream guard)', upstreamGuard.attempts.length === 0, upstreamGuard.attempts.map((a) => `${a.method} ${a.url}`).slice(0, 5).join(' '));
    check('strict offline: the loader made no outbound connection', outbound.length === 0, outbound.slice(0, 5).join(' '));

    // Report (not checks): what remains unanswered or failing on this page.
    const ops = new Map();
    for (const r of reqs) if (friendly(r)) ops.set(friendly(r), { status: r.status, path: new URL(r.url).pathname });
    const unsupported = [...ops].filter(([, o]) => o.status !== 200).map(([n, o]) => `${n}:${o.status} (${o.path})`);
    const failed = reqs.filter((r) => !friendly(r) && (r.failed || r.status >= 400)).map((r) => { const u = new URL(r.url); const keep = ['modules', 'nb_modules', '__rev'].filter((k) => u.searchParams.has(k)).map((k) => `${k}=${u.searchParams.get(k)}`); return `${r.failed || r.status} ${u.pathname}${keep.length ? `?${keep.join('&')}` : ''}`; });
    if (session.cspRefused.length) console.log(`INFO  ${session.cspRefused.length} external load(s) refused by the offline CSP (never sent): ${[...new Set(session.cspRefused)].slice(0, 3).join(' ')}`);
    if (unsupported.length) console.log(`INFO  operations without a local answer: ${unsupported.join(', ')}`);
    if (failed.length) console.log(`INFO  failed requests: ${[...new Set(failed)].join(' | ')}`);
    const errors = session.consoleMessages.filter((m) => m.level === 'error').map((m) => m.text.replace(/\s+/g, ' ').slice(0, 160));
    if (errors.length) console.log(`INFO  console errors: ${[...new Set(errors)].join(' | ')}`);
    if (session.exceptions.length) console.log(`INFO  uncaught page errors: ${[...new Set(session.exceptions.map((e) => e.text.split('\n')[0].slice(0, 160)))].join(' | ')}`);

    // Reload: the session persists and the shell is the signed-in one (no
    // logged-out "Log In" / "Sign Up" controls anywhere on the page).
    await session.cdp.send('Page.navigate', { url: `${base}/` });
    const again = await waitFor(session, article, 45000);
    await evaluate(session, "[...document.querySelectorAll('button,[role=button]')].find((e) => (e.innerText || '').trim() === 'Not Now')?.click()");
    await sleep(1500);
    const authUi = JSON.parse(await evaluateIsolated(session, `JSON.stringify({
      loggedOutControls: [...document.querySelectorAll('a,button,[role=button]')].filter((e) => /^(Log In|Sign Up|Log in|Sign up)$/.test((e.innerText || '').trim()) && e.getBoundingClientRect().width > 0).map((e) => e.innerText.trim()),
      profileLink: Boolean(document.querySelector('a[href="/${nameA}/"]')),
    })`));
    // The home components answered from the database (screen text of the tray,
    // the suggestions rail and the badges).
    const home = JSON.parse(await evaluateIsolated(session, `JSON.stringify({
      tray: [...document.querySelectorAll('main [role=menu] li, main ul li')].map((e) => e.innerText.trim()).filter(Boolean).slice(0, 8),
      text: document.body.innerText,
      badges: [...document.querySelectorAll('nav a, [role=link]')].map((e) => e.innerText.trim()).filter((t) => /^\\d+\\+?$/.test(t) || /\\n\\d+$/.test(t)).slice(0, 5),
    })`));
    check('the stories tray shows B\'s story', home.text.includes(nameB) && home.tray.some((t) => t.includes(nameB)), JSON.stringify(home.tray));
    check('the suggestions rail shows C (full name), with the real "Followed by" context', home.text.includes('Feed C') && home.text.includes(`Followed by ${nameB}`));
    const homeOps = new Map();
    for (const r of session.requests.values()) if (friendly(r)) homeOps.set(friendly(r), r.status);
    const homeFailed = ['PolarisStoriesV3TrayContainerQuery', 'PolarisStoriesV3AdsPoolQuery', 'IGDChatTabsJewelOffMsysQuery', 'PolarisSuggestedUserListQuery', 'usePolarisNotificationsNavItemQuery', 'IGDBadgeCountOffMsysQuery', 'QuickPromotionSupportIGSchemaBatchFetchQuery'].filter((n) => homeOps.has(n) && homeOps.get(n) !== 200);
    check('the home operations are answered locally (200)', homeFailed.length === 0, homeFailed.join(', '));
    const meAfter = await evaluate(session, "fetch('/api/v1/accounts/current_user/').then(async (r) => (await r.json().catch(() => ({}))).user?.username)");
    await shot(session, 'feed-05-signed-in-header-after-reload.png');
    check('after reload A is still signed in and B\'s post renders again', again && meAfter === nameA, meAfter);
    check('the signed-in shell shows no logged-out controls and links to A\'s profile', authUi.loggedOutControls.length === 0 && authUi.profileLink, JSON.stringify(authUi));

    // The running loader's own status, as the browser sees it.
    await session.cdp.send('Page.navigate', { url: `${base}/__loader/health` });
    await sleep(1500);
    const health = JSON.parse(await evaluate(session, 'document.body.innerText'));
    await shot(session, 'feed-04-strict-offline-loader-health.png');
    check('the loader reports pinned serving from one snapshot, with no Instagram session', health.ok === true && health.client.mode === 'pinned' && Boolean(health.client.snapshot) && health.client.integrityFailures.length === 0 && health.instagramSessions.relayed === false, JSON.stringify({ snapshot: health.client.snapshot, revision: health.client.revision }));
  } catch (error) {
    console.error(error);
    results.push({ name: 'the scenario ran to completion', ok: false, detail: String(error) });
    if (session) await shot(session, 'feed-FAILED-exception.png');
  } finally {
    child.kill('SIGKILL');
    server.closeAllConnections?.();
    server.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} genuine feed checks passed`);
  console.log(`screenshots: ${shots.join(', ')}`);
  fs.writeFileSync(path.join(SCRATCH, 'results.json'), JSON.stringify({ results, shots }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
