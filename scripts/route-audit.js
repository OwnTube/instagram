#!/usr/bin/env node
'use strict';

/**
 * Route audit against the active pinned client snapshot, with the upstream
 * guard on (any attempt to reach Instagram is recorded and fails). Every page
 * of the page registry (src/pages/registry.js) with a sample URL is requested
 * as a top-level navigation by a signed-in local account and by an anonymous
 * visitor, with local content seeded (a second account with a photo post,
 * a story and a Direct thread). It does not render pages (scripts/route-screens.js
 * does); it checks what the server answers.
 *
 * A signed-in page is WORKING when it is answered 200 with its own route
 * (the registry's page, under the viewer, with the expected page id) and no
 * login markup; UNAVAILABLE when the server says so (501, the client's error
 * route, with the reason); anything else is WRONG (another page, the login
 * page, an unexpected status). An anonymous page is WORKING when its
 * snapshot document is served. A signed-in page asked for by an anonymous
 * visitor must not be a server error.
 *
 * Exit status: 0 only when every page works and nothing reached upstream.
 * With --allow-unavailable, unavailable pages are reported but do not fail
 * the audit (a dispatch check: nothing is wrong, some pages are not served).
 *
 *   node scripts/route-audit.js [--json] [--allow-unavailable]
 */

const upstreamGuard = require('./lib/offline').strictOffline();

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, '.scratch', 'route-audit');

function initialRoute(html) {
  const blocks = [...html.matchAll(/<script type="application\/json"[^>]*data-sjs>(.*?)<\/script>/g)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    let payload;
    try {
      payload = JSON.parse(blocks[i][1]);
    } catch {
      continue;
    }
    const init = (payload.require || []).find((r) => r[0] === 'CometPlatformRootClient' && r[1] === 'initialize');
    if (init) return init[3][0].initialRouteInfo.route;
  }
  return null;
}

async function seed(base) {
  const { Browser, pngBytes } = require('../test/clone-helpers');
  const tag = Date.now().toString(36).slice(-5);
  const owner = new Browser(base);
  const me = await owner.signup(null, { username: `audit_${tag}`, fullName: 'Route Audit' });
  const other = new Browser(base);
  const o = await other.signup(null, { username: `audit_b_${tag}`, fullName: 'Route Audit B' });
  await owner.post(`/api/v1/friendships/create/${o.pk}/`, {});
  const upload = async (extra) => {
    const id = String(Date.now() + Math.floor(Math.random() * 1000));
    await other.request('POST', `/rupload_igphoto/fb_uploader_${id}`, { raw: pngBytes(), headers: { 'content-type': 'image/png', 'x-instagram-rupload-params': JSON.stringify({ upload_id: id, media_type: 1, ...extra }) } });
    return id;
  };
  const media = (await other.post('/api/v1/media/configure/', { upload_id: await upload({}), caption: 'route audit' })).body.media;
  await other.post('/api/v1/media/configure_to_story/', { upload_id: await upload({ is_story: '1' }) });
  const thread = await owner.post('/api/v1/direct_v2/threads/broadcast/text/', { recipient_users: JSON.stringify([[String(o.pk)]]), text: 'route audit', client_context: `audit-${tag}` });
  return { owner, me, fixtures: { username: o.username, postCode: media.code, storyOwner: o.username, threadId: String(thread.body.payload.thread_id) } };
}

async function main() {
  const allowUnavailable = process.argv.includes('--allow-unavailable');
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  Object.assign(process.env, { BACKEND_DB: path.join(SCRATCH, 'db.sqlite'), CLONE_DATA_DIR: SCRATCH, VERBOSE: '0', BACKEND_VERBOSE: '0' });
  const { Browser } = require('../test/clone-helpers');
  const { PAGES } = require('../src/pages/registry');
  const { app } = require('../src/server');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const rows = [];
  const navigation = { accept: 'text/html', 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  try {
    const { owner, me, fixtures } = await seed(base);
    for (const page of PAGES) {
      const url = page.sample && page.sample(fixtures);
      if (!url) {
        rows.push({ page: page.id, url: null, who: 'signed-in', verdict: 'NO SAMPLE', detail: page.next || page.data });
        continue;
      }
      for (const [who, b] of [['signed-in', owner], ['anonymous', new Browser(base)]]) {
        const res = await b.get(url, { headers: navigation });
        const html = typeof res.text === 'string' ? res.text : '';
        const route = /text\/html/.test(res.headers.get('content-type') || '') ? initialRoute(html) : null;
        const servedPage = res.headers.get('x-clone-page');
        const login = /Log into Instagram/.test(html);
        let verdict;
        let detail = '';
        if (who === 'signed-in' && page.access === 'signed-in') {
          if (servedPage !== page.id) [verdict, detail] = ['WRONG', `dispatched as ${servedPage || 'no page'}`];
          else if (res.status === 501) [verdict, detail] = ['UNAVAILABLE', res.headers.get('x-clone-page-unavailable') || ''];
          else if (res.status !== 200) [verdict, detail] = ['WRONG', `status ${res.status}`];
          else if (login) [verdict, detail] = ['WRONG', 'login markup for a signed-in viewer'];
          else if (!route || route.actorID !== String(me.pk)) [verdict, detail] = ['WRONG', 'not the signed-in route'];
          else if (page.expect.pageID && (route.polarisRouteConfig || {}).pageID !== page.expect.pageID) [verdict, detail] = ['WRONG', `page id ${(route.polarisRouteConfig || {}).pageID}`];
          else [verdict, detail] = ['WORKING', `${(route.rootView.entryPoint || {}).__dr}`];
        } else if (page.access === 'anonymous') {
          if (res.status === 200 && res.headers.get('x-loader-cache') === 'pinned' && servedPage === page.id) [verdict, detail] = ['WORKING', who === 'signed-in' ? 'anonymous document (signed in)' : 'anonymous document'];
          else [verdict, detail] = ['WRONG', `status ${res.status}${res.status === 404 ? ': no document in the snapshot' : ''}`];
        } else {
          // A signed-in page, signed out: the anonymous root page or no document, never a server error.
          if (res.status >= 500) [verdict, detail] = ['WRONG', `status ${res.status} for an anonymous visitor`];
          else [verdict, detail] = ['ok', res.status === 200 ? (login ? 'anonymous page (login)' : 'anonymous page') : `status ${res.status}`];
        }
        rows.push({ page: page.id, url, who, status: res.status, verdict, detail });
      }
    }
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else for (const r of rows) console.log(`${r.verdict.padEnd(11)} ${r.page.padEnd(24)} ${(r.who || '').padEnd(9)} ${String(r.status ?? '').padEnd(4)} ${(r.url || '').padEnd(34)} ${r.detail}`);
  const signedIn = rows.filter((r) => r.who === 'signed-in');
  const count = (v) => signedIn.filter((r) => r.verdict === v).length;
  const wrong = rows.filter((r) => r.verdict === 'WRONG');
  console.log(`pages: ${count('WORKING')} working, ${count('UNAVAILABLE')} unavailable, ${count('NO SAMPLE')} without a sample URL, ${wrong.length} wrong`);
  console.log(`upstream attempts: ${upstreamGuard.attempts.length}${upstreamGuard.attempts.map((a) => `\n  ${a.method} ${a.url}`).join('')}`);
  const failed = wrong.length > 0 || upstreamGuard.attempts.length > 0 || (!allowUnavailable && count('UNAVAILABLE') > 0);
  if (failed) console.log(`route audit FAILED${!allowUnavailable && count('UNAVAILABLE') ? ' (unavailable pages count as failures; --allow-unavailable checks dispatch only)' : ''}`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
