#!/usr/bin/env node
'use strict';

/**
 * End-to-end check of post creation in the GENUINE client, strictly offline.
 * Headless Chromium over CDP:
 *
 *   1. a local account signed in (the session cookie of a local login) opens
 *      the signed-in home and the genuine "New post" > "Post" dialog;
 *   2. a real PNG goes into the dialog's own file input; the genuine Crop and
 *      Edit (filters, rendered with WebGL) steps follow;
 *   3. a caption is typed into the genuine caption field and Share is pressed:
 *      the client uploads the bytes (rupload) and configures the post;
 *   4. the post, its caption and its stored media are checked in the database,
 *      and the post appears in the owner's profile grid, served from /__media.
 *
 * Strict offline as in genuine-feed-check: LOADER_OFFLINE=1,
 * LOADER_PREFER_CACHE=1, no request to any other host.
 *
 *   node scripts/genuine-create-check.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

Object.assign(process.env, { LOADER_OFFLINE: '1', LOADER_PREFER_CACHE: '1', SHELL_SIGNED_IN_HOME: '1', ...process.env });

const { launchChromium, openSession, captureScreenshot, watchExternal, evaluateIsolated } = require('./lib/browser');
const { sunsetPng, waitFor, sleep, mouseClickText } = require('./lib/scenario');
const { Browser } = require('../test/clone-helpers');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, '.scratch', 'genuine-create-check');
const SHOTS = path.resolve(process.env.SCREENSHOT_DIR || path.join(ROOT, 'test-artifacts', 'screenshots'));
const PASSWORD = 'correct horse 42';
const CAPTION = 'Sunset over the bay, shared from the genuine Create dialog';
const DIALOG = "[...document.querySelectorAll('[role=dialog]')].map((d) => d.innerText).join(' ')";

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
  const name = `create_${Date.now().toString(36).slice(-5)}`;
  const png = path.join(SCRATCH, 'sunset.png');
  fs.writeFileSync(png, sunsetPng());
  let session = null;

  try {
    const A = new Browser(base);
    await A.signup(null, { username: name, fullName: 'Create Check', password: PASSWORD });
    const user = sql('SELECT id, pk FROM users WHERE username_ci = ?', name);

    // 1. Home, then the genuine New post > Post dialog.
    session = await openSession(browserWsUrl);
    watchExternal(session, base);
    await session.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const [k, v] of A.jar) await session.cdp.send('Network.setCookie', { name: k, value: encodeURIComponent(v), url: base });
    await session.cdp.send('Page.navigate', { url: `${base}/` });
    await waitFor(session, "Boolean(document.querySelector('svg[aria-label=\"New post\"]'))", 30000);
    await sleep(1500);
    // The genuine "Turn on Notifications" prompt may cover the page; it is dismissed as a user would.
    await mouseClickText(session, 'Not Now');
    await evaluateIsolated(session, "(() => { const s = document.querySelector('svg[aria-label=\"New post\"]'); const a = s && s.closest('a,[role=link],[role=button]'); if (a) a.click(); return Boolean(a); })()");
    await waitFor(session, "[...document.querySelectorAll('*')].some((x) => (x.innerText || '').trim() === 'Post' && x.getBoundingClientRect().width > 0)", 8000);
    await mouseClickText(session, 'Post');
    const picker = await waitFor(session, `${DIALOG}.includes('Create new post') && Boolean(document.querySelector('[role=dialog] input[type=file]'))`, 15000);
    check('the genuine creation dialog opens from New post > Post', picker);

    // 2. The file goes into the dialog's own input; Crop, then Edit.
    const doc = await session.cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeIds } = await session.cdp.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: '[role=dialog] input[type=file]' });
    await session.cdp.send('DOM.setFileInputFiles', { nodeId: nodeIds[nodeIds.length - 1], files: [png] });
    const crop = await waitFor(session, `${DIALOG}.includes('Crop')`, 15000);
    await sleep(800);
    await shot(session, 'create-01-crop.png');
    check('the chosen photo is shown in the genuine Crop step', crop);
    await mouseClickText(session, 'Next', "document.querySelector('[role=dialog]')");
    const edit = await waitFor(session, `${DIALOG}.includes('Filters') && ${DIALOG}.includes('Clarendon')`, 15000);
    const thumbs = await waitFor(session, "[...document.querySelectorAll('[role=dialog] img')].filter((i) => /\\/images\\/instagram\\/xig\\/filters\\//.test(i.src) && i.complete && i.naturalWidth > 0).length >= 12", 10000);
    await sleep(800);
    await shot(session, 'create-02-edit-filters.png');
    check('the genuine Edit step renders (WebGL filters, the 12 filter thumbnails loaded)', edit && thumbs);

    // 3. Caption, then Share.
    await mouseClickText(session, 'Next', "document.querySelector('[role=dialog]')");
    const captionStep = await waitFor(session, "Boolean(document.querySelector('[role=dialog] [contenteditable=true]'))", 15000);
    await evaluateIsolated(session, "(() => { const e = document.querySelector('[role=dialog] [contenteditable=true]'); e.focus(); return true; })()");
    await session.cdp.send('Input.insertText', { text: CAPTION });
    await sleep(800);
    await shot(session, 'create-03-caption.png');
    check('the caption is typed into the genuine caption field', captionStep && (await waitFor(session, `${DIALOG}.includes(${JSON.stringify(CAPTION)})`, 5000)));
    await mouseClickText(session, 'Share', "document.querySelector('[role=dialog]')");
    const shared = await waitFor(session, `${DIALOG}.includes('Your post has been shared')`, 20000);
    await sleep(500);
    await shot(session, 'create-04-shared.png');
    const post = sql('SELECT p.pk, p.code, p.caption, m.storage_key, m.width, m.height FROM posts p JOIN media m ON m.id = p.media_id WHERE p.author_id = ? AND p.deleted_at IS NULL', user.id);
    const stored = post && fs.statSync(path.join(SCRATCH, 'media', post.storage_key), { throwIfNoEntry: false });
    check('Share uploads and configures the post: the database has the caption and the stored photo', shared && post && post.caption === CAPTION && stored, JSON.stringify(post));

    // 4. The post in the owner's profile grid.
    await mouseClickText(session, 'Done', "document.querySelector('[role=dialog]')");
    await session.cdp.send('Page.navigate', { url: `${base}/${name}/` });
    const grid = post && (await waitFor(session, `/\\b1\\s+post\\b/.test(document.body.innerText) && [...document.images].some((i) => i.src.includes(${JSON.stringify(post.storage_key)}) && i.complete && i.naturalWidth > 0)`, 30000));
    await sleep(800);
    await shot(session, 'create-05-profile-grid.png');
    check("the new post is in the owner's profile grid, its photo served from /__media", grid && (await evaluateIsolated(session, `Boolean(document.querySelector('a[href*="/p/${post.code}/"]'))`)));

    check('strict offline: the browser sent no request to an external host', session.externalRequests.length === 0, session.externalRequests.map((x) => x.url).slice(0, 5).join(' '));
    const reqs = [...session.requests.values()];
    const friendly = (r) => ((r.postData || '').match(/fb_api_req_friendly_name=([^&]+)/) || [])[1] || null;
    const unanswered = [...new Set(reqs.filter((r) => friendly(r) && r.status && r.status !== 200).map((r) => `${friendly(r)}:${r.status}`))];
    const failed = [...new Set(reqs.filter((r) => !friendly(r) && r.status >= 400).map((r) => `${r.status} ${new URL(r.url).pathname}`))];
    check('every operation, module and image the creation flow asked for was answered', unanswered.length === 0 && failed.length === 0, [...unanswered, ...failed].join(', '));
    const errors = session.consoleMessages.filter((m) => m.level === 'error').map((m) => m.text.replace(/\s+/g, ' ').slice(0, 160));
    if (errors.length) console.log(`INFO  console errors: ${[...new Set(errors)].join(' | ')}`);
    check('no uncaught page errors', session.exceptions.length === 0, session.exceptions.map((e) => e.text.split('\n')[0].slice(0, 160)).join(' | '));
  } catch (error) {
    check('scenario ran to completion', false, error.stack || String(error));
    if (session) await shot(session, 'create-FAILED.png').catch(() => {});
  } finally {
    child.kill('SIGKILL');
    server.close();
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} genuine create checks passed`);
  if (shots.length) console.log(`screenshots: ${shots.join(', ')}`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
