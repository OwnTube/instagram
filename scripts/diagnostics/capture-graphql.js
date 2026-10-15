'use strict';
/*
 * Dump the body of every POST /api/graphql and /graphql/query a page makes.
 * Scratch diagnostic: it reveals the exact operation name, variables and
 * persisted-query id the genuine client sends, which is what a compatibility
 * layer must satisfy. Not part of the test suite.
 *
 *   node scripts/diagnostics/capture-graphql.js <url>
 */
const fs = require('node:fs');
const path = require('node:path');
const { launchChromium, openSession, navigate, probeDom } = require('../lib/browser');

const targetUrl = process.argv[2] || 'http://localhost:12000/explore/';
const profileDir = path.join(__dirname, '.chrome-profile-gql');

(async () => {
  const { browserWsUrl } = await launchChromium(profileDir);
  const session = await openSession(browserWsUrl);
  await navigate(session, targetUrl, 14000);
  const dom = await probeDom(session);

  const list = [...session.requests.values()].filter(
    (r) => /\/api\/graphql|\/graphql\/query/.test(r.url || '') && r.method === 'POST'
  );

  const out = [];
  console.log(`\n=== ${targetUrl} ===`);
  console.log(`final=${dom.location} title=${dom.title} reactRoots=${dom.reactRoots} text="${String(dom.visibleText).slice(0, 100)}"`);
  console.log(`\n=== GraphQL POSTs: ${list.length} ===`);
  list.forEach((r, i) => {
    console.log(`\n--- [${i}] ${r.status} ${r.url}`);
    let body = r.postData || '';
    if (body.length > 1200) body = body.slice(0, 1200) + ` …(+${r.postData.length - 1200})`;
    console.log(body);
    out.push({ url: r.url, status: r.status, postData: r.postData });
  });

  fs.writeFileSync(path.join(__dirname, 'graphql-captures.json'), JSON.stringify(out, null, 2));
  console.log(`\nsaved ${out.length} captures to scripts/diagnostics/graphql-captures.json`);
  session.ws.close();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
