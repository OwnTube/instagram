#!/usr/bin/env node
'use strict';

/**
 * Real-browser check of the GENUINE Instagram sign-up form served through the
 * loader (not a synthetic page). Headless Chromium over CDP:
 *
 *   1. the form renders without "Mobile number or email" and without
 *      "You may receive notifications from us.";
 *   2. a synthetic username + password + birthday submitted through the form
 *      creates exactly one user row (no email) and signs the browser in as it;
 *   3. the same username again is refused under the Username field, no row
 *      is added and no session is issued;
 *   4. a too-short password is refused by the form and nothing is written.
 *
 * It needs the page and its bundles: from Instagram, or from the disk caches
 * (.cache/documents, .cache/assets) with LOADER_PREFER_CACHE=1, which makes no
 * request to www.instagram.com. CHROMIUM_BIN must point at Chromium.
 *
 *   LOADER_PREFER_CACHE=1 node scripts/genuine-signup-check.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { launchChromium, openSession, navigate, captureScreenshot } = require('./lib/browser');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, '.scratch', 'genuine-signup-check');
const PASSWORD = 'correct horse 42';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(session, expression) {
  const result = await session.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function type(session, selectorExpr, text) {
  const ok = await evaluate(session, `(() => { const e = ${selectorExpr}; if (!e) return false; e.focus(); return true; })()`);
  if (ok) await session.cdp.send('Input.insertText', { text });
  return ok;
}

async function pick(session, label, option) {
  await evaluate(session, `document.querySelector('[aria-label="${label}"]')?.click()`);
  await sleep(500);
  const ok = await evaluate(session, `(() => { const o = [...document.querySelectorAll('[role=option]')].find((x) => (x.innerText || '').trim() === ${JSON.stringify(option)}); if (!o) return false; o.click(); return true; })()`);
  await sleep(400);
  return ok;
}

/** Load the form (retrying once if it is still on the splash), fill it, submit. */
async function submitForm(session, base, { username, password }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await navigate(session, `${base}/accounts/emailsignup/`, 14000);
    if (await evaluate(session, "Boolean(document.querySelector('input[type=password]'))")) break;
  }
  const text = await evaluate(session, 'document.body.innerText');
  const filled = [
    await type(session, "document.querySelector('input[type=password]')", password),
    await type(session, "[...document.querySelectorAll('input[type=text]')].find((e) => /full name/i.test(e.closest('label')?.innerText || ''))", 'Synthetic Tester'),
    await type(session, "document.querySelector('input[aria-label=Username]')", username),
    await pick(session, 'Select Month', 'January'),
    await pick(session, 'Select Day', '15'),
    await pick(session, 'Select Year', '1990'),
  ];
  await sleep(2000);
  await evaluate(session, "[...document.querySelectorAll('[role=button]')].find((e) => (e.innerText || '').trim() === 'Submit')?.click()");
  await sleep(7000);
  return { formText: text, filled: filled.every(Boolean), after: await evaluate(session, 'document.body.innerText'), url: await evaluate(session, 'location.href') };
}

async function main() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  Object.assign(process.env, { BACKEND_DB: path.join(SCRATCH, 'db.sqlite'), CLONE_DATA_DIR: SCRATCH, VERBOSE: '0', BACKEND_VERBOSE: '0' });
  const { app } = require('../src/server');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { child, browserWsUrl } = await launchChromium(path.join(SCRATCH, 'profile'));
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: Boolean(ok), detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  };
  const db = () => new DatabaseSync(path.join(SCRATCH, 'db.sqlite'));
  const count = () => {
    const d = db();
    const n = d.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    d.close();
    return n;
  };
  const me = (session) => evaluate(session, "fetch('/api/v1/accounts/current_user/').then(async (r) => ({ status: r.status, username: (await r.json().catch(() => ({}))).user?.username }))");
  const username = `synth_${Date.now().toString(36).slice(-6)}`;

  try {
    let session = await openSession(browserWsUrl);
    const created = await submitForm(session, base, { username, password: PASSWORD });
    await captureScreenshot(session, path.join(SCRATCH, 'created.png'));
    check('the form rendered and was filled', created.filled);
    check('"Mobile number or email" is not on the form', !/Mobile number or email/.test(created.formText));
    check('"You may receive notifications from us." is not on the form', !/You may receive notifications from us/.test(created.formText));
    const d = db();
    const row = d.prepare('SELECT pk, username, email, display_name FROM users WHERE username_ci = ?').get(username);
    d.close();
    check('one user row was written, with no email', row && row.email === null && count() === 1, JSON.stringify(row));
    const who = await me(session);
    check('the browser is signed in as the new user', who.status === 200 && who.username === username, JSON.stringify(who));
    check('the form left the sign-up page (redirect followed)', !/emailsignup/.test(created.url), created.url);

    await session.cdp.send('Network.clearBrowserCookies');
    const dup = await submitForm(session, base, { username, password: PASSWORD });
    check('a duplicate username is refused under the field', /already exists/i.test(dup.after) && /emailsignup/.test(dup.url));
    check('the duplicate wrote nothing and signed nobody in', count() === 1 && (await me(session)).status === 401);

    await session.cdp.send('Network.clearBrowserCookies');
    const weak = await submitForm(session, base, { username: `${username}_w`, password: 'abc' });
    check('a too-short password is refused and nothing is written', count() === 1 && /emailsignup/.test(weak.url) && (await me(session)).status === 401);
    check('no uncaught page errors', session.exceptions.length === 0, session.exceptions.map((e) => e.text).join('; ').slice(0, 300));
    session = null;
  } finally {
    child.kill('SIGKILL');
    server.closeAllConnections?.();
    server.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} genuine sign-up checks passed`);
  fs.writeFileSync(path.join(SCRATCH, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
