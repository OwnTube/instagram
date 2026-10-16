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
 * Strict offline: LOADER_OFFLINE=1 (the origin is never contacted, documents
 * carry a self-only CSP) and LOADER_PREFER_CACHE=1 (page and bundles from the
 * disk caches). Every request the browser sends is watched; any request to a
 * host other than the loader fails the check.
 *
 * Screenshots go to test-artifacts/screenshots/ (SCREENSHOT_DIR overrides).
 *
 *   node scripts/genuine-feed-check.js
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

Object.assign(process.env, { LOADER_OFFLINE: '1', LOADER_PREFER_CACHE: '1', SHELL_SIGNED_IN_HOME: '1', ...process.env });

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
const { Browser } = require('../test/clone-helpers');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, '.scratch', 'genuine-feed-check');
const SHOTS = path.resolve(process.env.SCREENSHOT_DIR || path.join(ROOT, 'test-artifacts', 'screenshots'));
const PASSWORD = 'correct horse 42';
const CAPTION = 'Sunset over the harbour, posted by B';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A real (decodable) PNG: a vertical sunset gradient with a sun disc. */
function sunsetPng(width = 1080, height = 1080) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    const t = y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const sky = [Math.round(255 - 120 * t), Math.round(140 - 100 * t), Math.round(60 + 120 * t)];
      const d = Math.hypot(x - width / 2, y - height * 0.62);
      const px = d < width * 0.14 ? [255, 214, 90] : y > height * 0.7 ? [Math.round(40 + 30 * t), Math.round(50 + 20 * t), Math.round(110 + 40 * t)] : sky;
      px.forEach((v, i) => { row[1 + x * 3 + i] = v; });
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function evaluate(session, expression) {
  const result = await session.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function type(session, selectorExpr, text) {
  const ok = await evaluate(session, `(() => { const e = ${selectorExpr}; if (!e) return false; e.focus(); e.select && e.select(); return true; })()`);
  if (ok) await session.cdp.send('Input.insertText', { text });
  return ok;
}

/** Poll (from an isolated world) until `expression` is truthy or `ms` elapse. */
async function waitFor(session, expression, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evaluateIsolated(session, expression).catch(() => false)) return true;
    await sleep(500);
  }
  return false;
}

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
    check('strict offline: the loader made no outbound connection', outbound.length === 0, outbound.slice(0, 5).join(' '));

    // Report (not checks): what remains unanswered or failing on this page.
    const ops = new Map();
    for (const r of reqs) if (friendly(r)) ops.set(friendly(r), r.status);
    const unsupported = [...ops].filter(([, s]) => s !== 200).map(([n, s]) => `${n}:${s}`);
    const failed = reqs.filter((r) => !friendly(r) && (r.failed || r.status >= 400)).map((r) => `${r.status || r.failed} ${r.url.replace(base, '').split('&')[0]}`);
    if (session.cspRefused.length) console.log(`INFO  ${session.cspRefused.length} external load(s) refused by the offline CSP (never sent): ${[...new Set(session.cspRefused)].slice(0, 3).join(' ')}`);
    if (unsupported.length) console.log(`INFO  operations without a local answer: ${unsupported.join(', ')}`);
    if (failed.length) console.log(`INFO  failed requests: ${[...new Set(failed)].join(' | ')}`);
    const errors = session.consoleMessages.filter((m) => m.level === 'error').map((m) => m.text.replace(/\s+/g, ' ').slice(0, 160));
    if (errors.length) console.log(`INFO  console errors: ${[...new Set(errors)].join(' | ')}`);
    if (session.exceptions.length) console.log(`INFO  uncaught page errors: ${[...new Set(session.exceptions.map((e) => e.text.split('\n')[0].slice(0, 160)))].join(' | ')}`);

    // The running loader's own status, as the browser sees it.
    await session.cdp.send('Page.navigate', { url: `${base}/__loader/health` });
    await sleep(1500);
    const health = JSON.parse(await evaluate(session, 'document.body.innerText'));
    await shot(session, 'feed-04-strict-offline-loader-health.png');
    check('strict offline: the loader reports offline mode and cache-only serving', health.upstream.offline === true && health.cache.preferCache === true && health.instagramSessions.relayed === false, JSON.stringify({ upstream: health.upstream, preferCache: health.cache.preferCache }));
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
