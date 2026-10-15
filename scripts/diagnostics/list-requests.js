'use strict';
/*
 * List every request a page makes, with method+path, and report what rendered.
 * Scratch diagnostic for feed/explore activation. Not part of the test suite.
 *
 *   node scripts/diagnostics/list-requests.js <url>
 */
const path = require('node:path');
const { launchChromium, openSession, navigate, probeDom } = require('../lib/browser');

const targetUrl = process.argv[2] || 'http://localhost:12000/explore/';
const profileDir = path.join(__dirname, '.chrome-profile-list');

(async () => {
  const { browserWsUrl } = await launchChromium(profileDir);
  const session = await openSession(browserWsUrl);
  await navigate(session, targetUrl, 12000);
  const dom = await probeDom(session);
  session.ws.close();

  const list = [...session.requests.values()];
  console.log(`\n=== ${targetUrl} ===`);
  console.log(`final: ${dom.location}`);
  console.log(`title: ${dom.title} | reactRoots: ${dom.reactRoots} | requireLazy: ${dom.hasRequireLazy}`);
  console.log(`text: ${String(dom.visibleText || '').slice(0, 120).replace(/\s+/g, ' ')}`);
  console.log(`\ntotal: ${list.length}`);

  const interesting = list.filter((r) => {
    const u = r.url || '';
    return (
      u.includes('localhost') &&
      !u.includes('/__ig/') &&
      !/\.(js|css|webp|png|jpg|ico|svg|woff2?)(\?|$)/.test(u)
    );
  });
  console.log(`\n=== same-origin non-asset requests (${interesting.length}) ===`);
  for (const r of interesting) {
    const mark = r.failed || (r.status && r.status >= 400) ? 'FAIL' : 'ok  ';
    console.log(`  ${mark} ${String(r.status || r.error || '').slice(0, 22).padEnd(22)} ${r.method} ${r.url}`);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
