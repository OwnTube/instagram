'use strict';
/*
 * Capture the RESPONSE BODY of every /api/graphql POST a page makes, via
 * Network.getResponseBody. Reveals the exact success envelope the genuine
 * client expects (prefix, content type, top-level keys, data path).
 *
 *   node scripts/diagnostics/capture-bodies.js <url> [scrolls]
 */
const fs = require('node:fs');
const path = require('node:path');
const { launchChromium, openSession, navigate } = require('../lib/browser');

const targetUrl = process.argv[2] || 'http://localhost:12000/popular/psg/';
const scrolls = Number(process.argv[3] || 4);
const profileDir = path.join(__dirname, '.chrome-profile-bodies');

(async () => {
  const { browserWsUrl } = await launchChromium(profileDir);
  const session = await openSession(browserWsUrl);
  await navigate(session, targetUrl, 9000);
  for (let i = 0; i < scrolls; i++) {
    await session.cdp.send('Runtime.evaluate', {
      expression: 'window.scrollTo(0, document.body.scrollHeight)',
    });
    await new Promise((r) => setTimeout(r, 2500));
  }

  const ids = [...session.requests.entries()].filter(
    ([, r]) => /\/api\/graphql/.test(r.url || '') && r.method === 'POST'
  );
  const out = [];
  for (const [id, r] of ids) {
    const params = new URLSearchParams(r.postData || '');
    const op = params.get('fb_api_req_friendly_name');
    let body = null;
    try {
      const res = await session.cdp.send('Network.getResponseBody', { requestId: id });
      body = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
    } catch (e) {
      body = `<unavailable: ${e.message}>`;
    }
    const prefix = body.slice(0, 10);
    console.log(`\n=== op=${op} status=${r.status} ctype=${r.mimeType}`);
    console.log(`  prefix: ${JSON.stringify(prefix)}  len=${body.length}`);
    console.log(`  head  : ${body.slice(0, 220).replace(/\s+/g, ' ')}`);
    out.push({ op, status: r.status, mimeType: r.mimeType, body });
  }
  fs.writeFileSync(path.join(__dirname, 'response-bodies.json'), JSON.stringify(out, null, 2));
  console.log(`\nsaved ${out.length} bodies to scripts/diagnostics/response-bodies.json`);
  session.ws.close();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
