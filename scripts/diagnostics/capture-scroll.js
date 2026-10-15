'use strict';
/*
 * Scroll a page to trigger its "load more" request, then dump every
 * /api/graphql and /graphql/query POST body. Reveals the pagination
 * operation (doc_id + cursor variable) the genuine client uses.
 *
 *   node scripts/diagnostics/capture-scroll.js <url> [scrolls]
 */
const fs = require('node:fs');
const path = require('node:path');
const { launchChromium, openSession, navigate } = require('../lib/browser');

const targetUrl = process.argv[2] || 'http://localhost:12000/popular/psg/';
const scrolls = Number(process.argv[3] || 6);
const profileDir = path.join(__dirname, '.chrome-profile-scroll');

(async () => {
  const { browserWsUrl } = await launchChromium(profileDir);
  const session = await openSession(browserWsUrl);
  await navigate(session, targetUrl, 10000);

  const before = [...session.requests.values()].filter((r) => /graphql/.test(r.url || '')).length;
  console.log(`graphql requests before scroll: ${before}`);

  for (let i = 0; i < scrolls; i++) {
    await session.cdp.send('Runtime.evaluate', {
      expression: `window.scrollTo(0, document.body.scrollHeight); document.body.scrollHeight`,
      returnByValue: true,
    });
    await new Promise((r) => setTimeout(r, 2500));
  }

  const gql = [...session.requests.values()].filter(
    (r) => /\/api\/graphql|\/graphql\/query/.test(r.url || '') && r.method === 'POST'
  );
  console.log(`graphql requests after scroll: ${gql.length}\n`);

  const out = [];
  for (const r of gql) {
    const body = r.postData || '';
    const params = new URLSearchParams(body);
    const op = params.get('fb_api_req_friendly_name');
    const docId = params.get('doc_id');
    const vars = params.get('variables');
    console.log(`[${r.status}] op=${op} doc_id=${docId}`);
    if (vars) console.log(`    variables=${vars.slice(0, 260)}`);
    out.push({ url: r.url, status: r.status, op, docId, variables: vars, postData: body });
  }
  fs.writeFileSync(path.join(__dirname, 'scroll-captures.json'), JSON.stringify(out, null, 2));
  console.log(`\nsaved ${out.length} to scripts/diagnostics/scroll-captures.json`);
  session.ws.close();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
