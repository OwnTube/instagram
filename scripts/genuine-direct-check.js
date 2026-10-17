#!/usr/bin/env node
'use strict';

/**
 * End-to-end check of the Direct inbox and thread pages in the GENUINE client,
 * strictly offline (the pinned snapshot only; upstream guard on). Headless
 * Chromium over CDP:
 *
 *   1. accounts A and B; B sends A a text message (local API);
 *   2. A loads /direct/inbox/ directly: the client's inbox (the signed-in
 *      PolarisDirectInboxRoot route) lists the thread with B's message;
 *   3. A loads /direct/t/<thread>/ directly: the thread page shows B's name
 *      and the message;
 *   4. opening the thread marks it read: A's last_seen_at is set in the
 *      database (useIGDMarkThreadAsReadMutation);
 *   5. A types a reply in the thread's composer and presses Enter: the
 *      message is stored (IGDirectTextSendMutation, a messages row) and shown
 *      after B's;
 *   6. signed out, /direct/inbox/ is not served the anonymous home page;
 *   7. nothing left this origin; the server attempted no upstream request.
 *
 * Needs a snapshot holding the PolarisDirectInboxRoot answers
 * (CLIENT_SNAPSHOT_ID selects one; default: the active snapshot).
 * Screenshots: test-artifacts/screenshots/direct-*.png
 *
 *   CHROMIUM_BIN=... node scripts/genuine-direct-check.js
 */

const upstreamGuard = require('./lib/offline').strictOffline();

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { launchChromium, openSession, captureScreenshot, watchExternal } = require('./lib/browser');
const { evaluate, waitFor, sleep, mouseClickText } = require('./lib/scenario');
const { Browser } = require('../test/clone-helpers');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, '.scratch', 'genuine-direct-check');
const SHOTS = path.resolve(process.env.SCREENSHOT_DIR || path.join(ROOT, 'test-artifacts', 'screenshots'));

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
  const nameA = `dm_a_${tag}`;
  const nameB = `dm_b_${tag}`;
  const reply = `reply from A ${tag}`;
  let session = null;
  const navigate = async (p) => {
    session.requests.clear();
    await session.cdp.send('Page.navigate', { url: `${base}${p}` });
  };
  const documentStatus = () => {
    const doc = [...session.requests.values()].find((r) => r.type === 'Document');
    return doc ? doc.status : null;
  };
  // The client's "Turn on Notifications" dialog covers the page on a first
  // signed-in visit; dismiss it the way a user does.
  const dismissDialog = async () => {
    if (await waitFor(session, "[...document.querySelectorAll('button')].some((e) => (e.innerText || '').trim() === 'Not Now')", 6000)) {
      await mouseClickText(session, 'Not Now');
      await sleep(500);
    }
  };
  try {
    const A = new Browser(base);
    const B = new Browser(base);
    const a = await A.signup(null, { username: nameA, fullName: 'Direct A' });
    await B.signup(null, { username: nameB, fullName: 'Direct B' });
    const sent = await B.post('/api/v1/direct_v2/threads/broadcast/text/', { recipient_users: JSON.stringify([[String(a.pk)]]), text: 'hello from B' });
    const threadKey = sent.body && sent.body.payload ? sent.body.payload.thread_id : null;
    check('B sent A a message (database row)', sent.status === 200 && threadKey && sql("SELECT 1 AS ok FROM messages WHERE body = 'hello from B'"), `thread ${threadKey}`);

    session = await openSession(browserWsUrl);
    watchExternal(session, base);
    await session.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const [name, value] of A.jar) await session.cdp.send('Network.setCookie', { name, value: encodeURIComponent(value), url: base });

    // 2. The inbox.
    await navigate('/direct/inbox/');
    const listed = await waitFor(session, `(() => { const nav = document.querySelector('[aria-label="Thread list"]'); return Boolean(nav && nav.innerText.includes(${JSON.stringify(nameB)}) && nav.innerText.includes('hello from B')); })()`, 30000);
    await dismissDialog();
    await shot(session, 'direct-01-inbox.png');
    check("a direct load of /direct/inbox/ lists B's thread with the message", listed && documentStatus() === 200, `document ${documentStatus()}`);

    // 3. The thread.
    await navigate(`/direct/t/${threadKey}/`);
    const opened = await waitFor(session, `(() => { const main = document.querySelector('[role=main]') || document.body; const t = main.innerText; return t.includes(${JSON.stringify(nameB)}) && t.split('hello from B').length > 2; })()`, 30000);
    await dismissDialog();
    await shot(session, 'direct-02-thread.png');
    check("a direct load of /direct/t/<thread>/ shows the thread with B's message", opened && documentStatus() === 200, `document ${documentStatus()}`);

    // 4. Read state.
    let seen = null;
    for (let i = 0; i < 20 && !seen; i += 1) {
      seen = sql('SELECT cm.last_seen_at FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id JOIN users u ON u.id = cm.user_id WHERE c.pk = ? AND u.username_ci = ? AND cm.last_seen_at IS NOT NULL', String(threadKey), nameA);
      if (!seen) await sleep(500);
    }
    check('opening the thread marks it read for A (conversation_members.last_seen_at)', seen, seen ? seen.last_seen_at : 'not set');

    // 5. Reply through the composer.
    // The thread page's own composer: the widest visible message box (a chat
    // tab, when one is open, has its own, narrower one).
    const composer = "[...document.querySelectorAll('textarea, [role=textbox][contenteditable=true]')].filter((e) => e.getBoundingClientRect().width > 0).sort((x, y) => y.getBoundingClientRect().width - x.getBoundingClientRect().width)[0]";
    const hasComposer = await waitFor(session, `Boolean(${composer})`, 15000);
    if (hasComposer) {
      await evaluate(session, `${composer}.focus()`);
      await session.cdp.send('Input.insertText', { text: reply });
      await sleep(300);
      await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }
    let stored = null;
    for (let i = 0; i < 20 && hasComposer && !stored; i += 1) {
      stored = sql('SELECT m.pk FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.body = ? AND u.username_ci = ?', reply, nameA);
      if (!stored) await sleep(500);
    }
    // Shown, and after B's message: the newest message is the last one (a
    // client clock off from this server's would misplace it).
    const shown = hasComposer && (await waitFor(session, `(() => { const t = (document.querySelector('[role=main]') || document.body).innerText; return t.lastIndexOf(${JSON.stringify(reply)}) > t.lastIndexOf('hello from B'); })()`, 10000));
    await shot(session, 'direct-03-reply.png');
    check("A's reply typed in the thread's composer is stored and shown after B's message", stored && shown, `composer ${hasComposer}, stored ${Boolean(stored)}, shown in order ${shown}`);

    const errors = session.consoleMessages.filter((m) => m.level === 'error').map((m) => m.text.slice(0, 160));
    if (errors.length) console.log(`INFO  console errors: ${[...new Set(errors)].slice(0, 6).join(' | ')}`);
    const failed = [...session.requests.values()].filter((r) => r.status >= 400).map((r) => `${r.status} ${r.url.replace(base, '').slice(0, 120)}`);
    if (failed.length) console.log(`INFO  failed requests (last page): ${failed.slice(0, 8).join(', ')}`);
    const health = await new Browser(base).get('/__clone/health');
    const missing = health.body && health.body.graphql ? health.body.graphql.unsupported : [];
    if (missing.length) console.log(`INFO  GraphQL operations without a resolver: ${missing.map((m) => `${m.name || m.docId} x${m.count}`).join('; ')}`);

    // 6. Signed out.
    const anon = await new Browser(base).get('/direct/inbox/', { headers: { accept: 'text/html', 'sec-fetch-site': 'none' } });
    check('signed out, /direct/inbox/ is not served the anonymous home page', anon.status === 404 && !/Log into Instagram/.test(anon.text), `HTTP ${anon.status}`);

    check('strict offline: the browser sent no request to an external host', session.externalRequests.length === 0, session.externalRequests.map((x) => x.url).slice(0, 3).join(' '));
    check('no upstream request was attempted by the server (upstream guard)', upstreamGuard.attempts.length === 0);
  } catch (error) {
    console.error(error);
    if (session) await shot(session, 'direct-FAILED-exception.png');
    check('no exception', false, error.message);
  } finally {
    child.kill('SIGKILL');
    server.closeAllConnections?.();
    server.close();
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} genuine direct checks passed`);
  console.log(`screenshots: ${shots.join(', ')}`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
