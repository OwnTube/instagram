#!/usr/bin/env node
'use strict';

/**
 * Real-browser check of the GENUINE Instagram login form (the logged-out home
 * page `/`, CAALoginHomepageLoginForm, which submits useCDSWebLoginMutation)
 * served through the loader. Headless Chromium over CDP:
 *
 *   1. an account is created with the genuine sign-up form's own mutation
 *      contract (username + password only, no contact point);
 *   2. a wrong password typed into the genuine form is refused, with no session;
 *   3. the right password signs the browser in as that user (current_user,
 *      ds_user_id) and the form follows the same-site redirect.
 *
 * Page and bundles come from Instagram or, with LOADER_PREFER_CACHE=1, from the
 * disk caches without any request to www.instagram.com.
 *
 *   LOADER_PREFER_CACHE=1 node scripts/genuine-login-check.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { launchChromium, openSession, navigate, captureScreenshot, watchExternal, evaluateIsolated } = require('./lib/browser');
const { encryptLikeClient } = require('../src/clone/passwordEncryption');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, '.scratch', 'genuine-login-check');
const PASSWORD = 'correct horse 42';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True once the genuine client has mounted (not just server-rendered markup). */
const MOUNTED = "(() => { const m = document.querySelector('[id^=mount_]'); return Boolean(m && getComputedStyle(m).contentVisibility === 'visible' && document.querySelector('input[type=password]')); })()";
const stalls = [];

/**
 * Load a page and let the client boot undisturbed, then check once that it
 * mounted. Probing during boot is avoided: forcing style computation (e.g.
 * getComputedStyle) while the client's stylesheets load was shown to stall its
 * boot, in the page's context or an isolated one. A load that did not mount is
 * reported as a stall, and the page is loaded once more.
 */
async function loadMounted(session, url) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await session.cdp.send('Page.navigate', { url });
    await sleep(12000);
    if (await evaluateIsolated(session, MOUNTED).catch(() => false)) return true;
    stalls.push(url);
  }
  return false;
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

/** Create an account through the sign-up form's mutation, as the form sends it. */
async function createAccount(base, username) {
  // shared_data issues the anonymous csrftoken and names our encryption key;
  // no document (and so no request to Instagram) is needed.
  const first = await fetch(`${base}/data/shared_data/`);
  const cookie = first.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const csrf = decodeURIComponent((cookie.match(/csrftoken=([^;]+)/) || [])[1] || '');
  const enc = (await first.json()).encryption;
  const encPassword = encryptLikeClient({ keyId: enc.key_id, publicKeyHex: enc.public_key, password: PASSWORD, time: Math.floor(Date.now() / 1000), tag: '#PWD_BROWSER', version: '10' });
  const variables = { input: { reg_data: { username: { sensitive_string_value: username }, fullname: { sensitive_string_value: 'Login Tester' }, reg_passwd__: { sensitive_string_value: encPassword }, contactpoint: { sensitive_string_value: '' }, birthday_day: 15, birthday_month: 1, birthday_year: 1990 } } };
  const res = await fetch(`${base}/api/graphql`, {
    method: 'POST',
    headers: { cookie, 'x-csrftoken': csrf, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ fb_api_req_friendly_name: 'useCAARegistrationFormSubmitMutation', variables: JSON.stringify(variables) }).toString(),
  });
  return (await res.json()).data.caa_registration_homepage_submit;
}

async function loginThroughForm(session, base, username, password) {
  await loadMounted(session, `${base}/`);
  const filled = [
    await type(session, "[...document.querySelectorAll('input')].find((e) => e.type !== 'password' && e.type !== 'hidden' && e.type !== 'checkbox')", username),
    await type(session, "document.querySelector('input[type=password]')", password),
  ];
  await sleep(800);
  const before = new Set(session.requests.keys());
  await evaluate(session, "(() => { const b = [...document.querySelectorAll('[role=button],button')].find((e) => (e.innerText || '').trim() === 'Log in'); b && b.click(); return Boolean(b); })()");
  await sleep(7000);
  const mutation = [...session.requests.entries()].find(([id, r]) => !before.has(id) && /useCDSWebLoginMutation/.test(r.postData || ''));
  return {
    filled: filled.every(Boolean),
    sent: Boolean(mutation),
    status: mutation ? mutation[1].status : null,
    text: await evaluate(session, 'document.body.innerText'),
    url: await evaluate(session, 'location.href'),
  };
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
  const username = `login_${Date.now().toString(36).slice(-6)}`;
  const me = (session) => evaluate(session, "fetch('/api/v1/accounts/current_user/').then(async (r) => ({ status: r.status, username: (await r.json().catch(() => ({}))).user?.username }))");

  try {
    const created = await createAccount(base, username);
    check('an account was created with username and password only', created.status === 'SUCCESS', JSON.stringify(created.errors));
    const session = await openSession(browserWsUrl);
    watchExternal(session, base);

    const wrong = await loginThroughForm(session, base, username, 'wrong password 1');
    await captureScreenshot(session, path.join(SCRATCH, 'wrong.png'));
    check('the genuine form sent useCDSWebLoginMutation', wrong.filled && wrong.sent && wrong.status === 200, `status ${wrong.status}`);
    check('a wrong password is refused with no session', (await me(session)).status === 401 && /incorrect/i.test(wrong.text));

    await session.cdp.send('Network.clearBrowserCookies');
    const right = await loginThroughForm(session, base, username, PASSWORD);
    await captureScreenshot(session, path.join(SCRATCH, 'right.png'));
    const who = await me(session);
    check('the right password signs the browser in as that user', right.sent && who.status === 200 && who.username === username, JSON.stringify(who));
    const ds = await evaluate(session, "(document.cookie.match(/ds_user_id=([^;]+)/) || [])[1] || null");
    check('ds_user_id names that user', ds === created.created_user_id, `${ds} vs ${created.created_user_id}`);
    check('the form showed no login error', !/incorrect|could not be read|try again/i.test(right.text));
    check('no request was sent to an external host', session.externalRequests.length === 0, session.externalRequests.map((x) => x.url).slice(0, 5).join(' '));
    if (session.cspRefused.length) console.log(`INFO  ${session.cspRefused.length} external load(s) refused by the offline CSP (never sent): ${[...new Set(session.cspRefused)].slice(0, 3).join(' ')}`);
    if (stalls.length) console.log(`WARN  the client stalled on ${stalls.length} load(s) and was reloaded: ${stalls.join(', ')}`);
    check('no uncaught page errors', session.exceptions.length === 0, session.exceptions.map((e) => e.text).join('; ').slice(0, 300));
  } finally {
    child.kill('SIGKILL');
    server.closeAllConnections?.();
    server.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} genuine login checks passed`);
  fs.writeFileSync(path.join(SCRATCH, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
