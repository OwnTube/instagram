#!/usr/bin/env node
'use strict';

/**
 * Route audit, strictly offline (LOADER_OFFLINE=1, LOADER_PREFER_CACHE=1): every
 * document route the client can be opened at, requested as a top-level
 * navigation by an anonymous visitor and by a signed-in local account. For each
 * it reports the status, which document was served (the signed-in route, the
 * anonymous page, or an error), and whether the anonymous login markup is in it.
 * It does not render pages (the genuine-*-check scripts do that); it shows what
 * the server answers, so no route is silently redirected or hidden.
 *
 *   node scripts/route-audit.js [--json]
 */

Object.assign(process.env, { LOADER_OFFLINE: '1', LOADER_PREFER_CACHE: '1', ...process.env });

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, '.scratch', 'route-audit');

async function main() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  Object.assign(process.env, { BACKEND_DB: path.join(SCRATCH, 'db.sqlite'), CLONE_DATA_DIR: SCRATCH, VERBOSE: '0', BACKEND_VERBOSE: '0' });
  const { Browser } = require('../test/clone-helpers');
  const { app } = require('../src/server');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const rows = [];
  try {
    const owner = new Browser(base);
    const me = await owner.signup(null, { username: `audit_${Date.now().toString(36).slice(-5)}`, fullName: 'Route Audit' });
    const routes = [
      '/', '/explore/', '/explore/search/', '/reels/', '/direct/inbox/', '/accounts/activity/',
      `/${me.username}/`, '/no_such_user_here/', '/p/AAAAAAAAAAA/', '/stories/' + me.username + '/',
      '/accounts/login/', '/accounts/emailsignup/', '/accounts/password/reset/', '/accounts/edit/', '/create/select/',
    ];
    const navigation = { accept: 'text/html', 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    for (const route of routes) {
      for (const [who, b] of [['anonymous', new Browser(base)], ['signed-in', owner]]) {
        const res = await b.get(route, { headers: navigation });
        const html = typeof res.text === 'string' ? res.text : '';
        // The signed-in route runs under the viewer's actor; the anonymous page under actor 0.
        const signedIn = html.includes(`"actorID":"${me.pk}"`);
        const routeRoot = signedIn ? (/"__dr":"(Polaris\w+Root(?:\.react|\.entrypoint))"/.exec(html) || [])[1] || '?' : null;
        rows.push({
          route,
          who,
          status: res.status,
          location: res.headers.get('location') || null,
          cache: res.headers.get('x-loader-cache') || null,
          served: res.status >= 400 ? `error: ${html.trim().split('\n')[0].slice(0, 70)}` : signedIn ? `signed-in route (${routeRoot})` : 'anonymous page',
          loginMarkup: /Log into Instagram/.test(html),
        });
      }
    }
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else for (const r of rows) console.log(`${r.route.padEnd(28)} ${r.who.padEnd(10)} ${r.status} ${(r.location || '').padEnd(18)} ${r.served}${r.loginMarkup ? '  [login markup]' : ''}`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
