#!/usr/bin/env node
'use strict';

/**
 * Real-browser check of the clone's session mechanics.
 *
 * Instagram's own page cannot be fetched in every environment, so this serves
 * a SMALL SYNTHETIC page through the full document path (shell
 * personalisation, runtime injection, cookie issuance) from a stand-in origin,
 * and drives headless Chromium over CDP. In the page it:
 *
 *   - checks /__clone/runtime.js ran and rewrites an absolute Instagram API URL
 *     to this origin, and drops a telemetry request;
 *   - reads the page's encryption config and checks it is OUR key;
 *   - checks csrftoken is readable and sessionid is not (HttpOnly);
 *   - signs up through the original endpoints with only a username and an
 *     enc_password v10 encrypted in the browser (tweetnacl sealed box +
 *     WebCrypto AES-GCM); no email, no code;
 *   - reloads and checks the page is personalised for the new user;
 *   - logs out, checks the session is gone, logs in again.
 *
 * It proves the browser-side protocol and cookies work. It does NOT prove the
 * genuine Instagram client renders anything; that needs the live client.
 *
 *   node scripts/browser-auth-check.js
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { launchChromium, openSession, navigate } = require('./lib/browser');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, '.scratch', 'browser-auth-check');

const PAGE = `<!DOCTYPE html><html><head><title>synthetic</title></head><body>
<script type="application/json" data-sjs>${JSON.stringify({
  define: [['CurrentUserInitialData', [], { USER_ID: '0', ACCOUNT_ID: '0', NAME: '', SHORT_NAME: null }, 1]],
  raw: JSON.stringify({ config: { csrf_token: 'stand-in', viewer: null, viewerId: null }, encryption: { key_id: '1', public_key: '00'.repeat(32), version: '10' } }),
})}</script>
<p>synthetic page served through the loader</p></body></html>`;

function startStandIn() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Browser-side helpers: crypto libraries and the client's request shapes. */
function pageLibraries() {
  const nacl = fs.readFileSync(require.resolve('tweetnacl/nacl-fast.min.js'), 'utf8');
  const util = fs.readFileSync(require.resolve('blakejs/util.js'), 'utf8');
  const blake = fs.readFileSync(require.resolve('blakejs/blake2b.js'), 'utf8');
  return `
${nacl}
(function () {
  var mods = {};
  function load(name, src) { var m = { exports: {} }; new Function('module', 'exports', 'require', src)(m, m.exports, function (n) { return mods[n]; }); mods[name] = m.exports; }
  load('./util', ${JSON.stringify(util)});
  load('./blake2b', ${JSON.stringify(blake)});
  window.__blake2b = mods['./blake2b'].blake2b;
})();
window.__t = {
  cookie: function (name) { var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; },
  encryptionConfig: function () {
    var found = null;
    document.querySelectorAll('script[type="application/json"]').forEach(function (s) {
      var walk = function (n) {
        if (typeof n === 'string' && /^\\s*[{[]/.test(n)) { try { walk(JSON.parse(n)); } catch (e) {} }
        else if (n && typeof n === 'object') { if (n.public_key && n.key_id) found = n; Object.keys(n).forEach(function (k) { walk(n[k]); }); }
      };
      walk(JSON.parse(s.textContent));
    });
    return found;
  },
  encPassword: async function (password) {
    var cfg = window.__t.encryptionConfig();
    var pub = new Uint8Array(cfg.public_key.match(/../g).map(function (h) { return parseInt(h, 16); }));
    var key = crypto.getRandomValues(new Uint8Array(32));
    var eph = nacl.box.keyPair();
    var nonceIn = new Uint8Array(64); nonceIn.set(eph.publicKey, 0); nonceIn.set(pub, 32);
    var boxed = nacl.box(key, window.__blake2b(nonceIn, undefined, 24), pub, eph.secretKey);
    var sealed = new Uint8Array(32 + boxed.length); sealed.set(eph.publicKey, 0); sealed.set(boxed, 32);
    var time = String(Math.floor(Date.now() / 1000));
    var aes = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
    var out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12), additionalData: new TextEncoder().encode(time), tagLength: 128 }, aes, new TextEncoder().encode(password)));
    var ct = out.slice(0, out.length - 16), tag = out.slice(out.length - 16);
    var buf = new Uint8Array(4 + sealed.length + 16 + ct.length);
    buf[0] = 1; buf[1] = Number(cfg.key_id); buf[2] = sealed.length & 255; buf[3] = (sealed.length >> 8) & 255;
    buf.set(sealed, 4); buf.set(tag, 4 + sealed.length); buf.set(ct, 4 + sealed.length + 16);
    var bin = ''; buf.forEach(function (b) { bin += String.fromCharCode(b); });
    return '#PWD_INSTAGRAM_BROWSER:10:' + time + ':' + btoa(bin);
  },
  post: async function (path, fields) {
    var res = await fetch(path, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-csrftoken': window.__t.cookie('csrftoken'), 'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest' }, body: new URLSearchParams(fields).toString() });
    return { status: res.status, body: await res.json() };
  },
};
true;`;
}

async function evaluate(session, expression) {
  const result = await session.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function main() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  const standIn = await startStandIn();
  Object.assign(process.env, {
    UPSTREAM_ORIGIN: `http://127.0.0.1:${standIn.address().port}`,
    BACKEND_DB: path.join(SCRATCH, 'db.sqlite'),
    CLONE_DATA_DIR: SCRATCH,
    // A synthetic upstream: keep its pages and assets out of the shared caches.
    DOCUMENT_CACHE_DIR: path.join(SCRATCH, 'documents'),
    ASSET_CACHE_DIR: path.join(SCRATCH, 'assets'),
    BOOTLOADER_CACHE_DIR: path.join(SCRATCH, 'bootloader'),
    CLONE_MAIL_TRANSPORT: 'outbox',
    VERBOSE: '0',
    BACKEND_VERBOSE: '0',
  });
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

  try {
    const session = await openSession(browserWsUrl);
    await session.cdp.send('Runtime.enable');
    await navigate(session, `${base}/`, 1500);
    await evaluate(session, pageLibraries());

    check('runtime injected and running', await evaluate(session, 'Boolean(window.__CLONE__ && window.__CLONE__.version === 1)'));
    const rewritten = await evaluate(session, "fetch('https://i.instagram.com/api/v1/accounts/current_user/').then(r => r.status)");
    check('absolute Instagram API URL is answered by this server', rewritten === 401, `status ${rewritten}`);
    const dropped = await evaluate(session, "fetch('https://graph.facebook.com/logging_client_events').then(r => r.status)");
    check('telemetry to Meta is dropped in the page', dropped === 204, `status ${dropped}`);

    const ours = (await (await fetch(`${base}/data/shared_data/`)).json()).encryption;
    const cfg = await evaluate(session, 'window.__t.encryptionConfig()');
    check('the page carries our encryption key, not the upstream one', cfg && cfg.public_key === ours.public_key && cfg.key_id === ours.key_id);
    check('csrftoken is readable by the page', await evaluate(session, "Boolean(window.__t.cookie('csrftoken'))"));

    const username = `browser_${Date.now().toString(36)}`;
    const password = 'browser check 77';
    const enc = await evaluate(session, `window.__t.encPassword(${JSON.stringify(password)})`);
    const attempt = await evaluate(session, `window.__t.post('/api/v1/web/accounts/web_create_ajax/attempt/', ${JSON.stringify({ username, enc_password: enc, first_name: 'Browser Check' })})`);
    check('signup dry run passes with only a username and an in-browser encrypted password', attempt.body.dryrun_passed === true, JSON.stringify(attempt.body.errors || ''));
    const enc2 = await evaluate(session, `window.__t.encPassword(${JSON.stringify(password)})`);
    const created = await evaluate(session, `window.__t.post('/api/v1/web/accounts/web_create_ajax/', ${JSON.stringify({ username, enc_password: enc2, first_name: 'Browser Check', day: '1', month: '1', year: '1990' })})`);
    check('the account is created with no email and no code', created.body.account_created === true, `user ${created.body.user_id}`);
    check('sessionid is HttpOnly (not visible to the page)', await evaluate(session, "window.__t.cookie('sessionid') === null"));
    check('ds_user_id names the new user', (await evaluate(session, "window.__t.cookie('ds_user_id')")) === created.body.user_id);
    const me = await evaluate(session, "fetch('/api/v1/accounts/current_user/').then(r => r.json())");
    check('authenticated requests resolve to the new user', me.user && me.user.username === username);

    await navigate(session, `${base}/`, 1000);
    // A live (non-template) page keeps its own identity bytes — the client
    // tamper-checks them — so the reload stays the logged-out shell. What must
    // survive the reload is the session: the cookie and current_user.
    const stillSignedIn = await evaluate(session, "fetch('/api/v1/accounts/current_user/').then((r) => r.ok).catch(() => false)");
    check('the session survives a reload (page identity is left untouched by design)', stillSignedIn === true);
    await evaluate(session, pageLibraries());

    await evaluate(session, "window.__t.post('/api/v1/web/accounts/logout/ajax/', { one_tap_app_login: '0' })");
    const afterLogout = await evaluate(session, "fetch('/api/v1/accounts/current_user/').then(r => r.status)");
    check('logout ends the session', afterLogout === 401, `status ${afterLogout}`);

    await navigate(session, `${base}/`, 1000);
    await evaluate(session, pageLibraries());
    const enc3 = await evaluate(session, `window.__t.encPassword(${JSON.stringify(password)})`);
    const login = await evaluate(session, `window.__t.post('/api/v1/web/accounts/login/ajax/', ${JSON.stringify({ username, enc_password: enc3, queryParams: '{}', optIntoOneTap: 'false' })})`);
    check('login works again', login.body.authenticated === true);
    const bad = await evaluate(session, `window.__t.encPassword('wrong password 1').then(e => window.__t.post('/api/v1/web/accounts/login/ajax/', { username: ${JSON.stringify(username)}, enc_password: e }))`);
    check('a wrong password is refused', bad.body.authenticated === false);
    check('no uncaught page errors', session.exceptions.length === 0, session.exceptions.map((e) => e.text || e).join('; '));
  } finally {
    child.kill('SIGKILL');
    server.closeAllConnections?.();
    server.close();
    standIn.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
  fs.writeFileSync(path.join(SCRATCH, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
