'use strict';

/**
 * The served HTML document must let the original client boot. The regression
 * this guards: the shell used to strip the anonymous page's own Relay prefetch,
 * which is the data the page renders from, leaving the client waiting on a
 * runtime query we cannot answer (the loading screen then never clears).
 *
 * The pinned fixture snapshot holds a page shaped like Instagram's: a define
 * tuple, an encryption config, a csrf field, and a RelayPrefetchedStreamCache
 * prefetch. These tests assert what the shell does to it, over real HTTP, with
 * every upstream attempt refused and asserted absent.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startCloneServer } = require('./clone-helpers');
const { documentAt } = require('./snapshot-fixture');

// The fixture snapshot is at revision 100; its documents carry that revision.
const REVISION_PAYLOAD = { require: [['Bootloader', 'handlePayload', null, [{ consistency: { rev: 100 }, rsrcMap: {}, compMap: {} }]]] };

const PREFETCH_KEY = 'adp_LoggedOutHomeQueryRelayPreloader_abc';
const PREFETCH_MARK = 'ANON-PREFETCH-PAYLOAD';

function block(obj) {
  return `<script type="application/json" data-sjs>${JSON.stringify(obj)}</script>`;
}

// A big integer and integer-like object keys sit in the SAME block as the csrf
// the shell edits. A whole-block round trip would lose the integer's precision
// and reorder the keys; this fixture lets the served bytes be checked.
const BIG_INT = '12345678901234567890';
// The encryption config (which the shell DOES rewrite) sits in the same block
// as a big integer and integer-like keys. A whole-block round trip would lose
// the integer's precision and reorder the keys; this fixture checks the served
// bytes. The csrf token is here too, to confirm it is NOT rewritten (the client
// tamper-checks it).
const SUPPORT_BLOCK = `{"config":{"csrf_token":"upstream-anon-csrf"},"encryption":{"key_id":"1","public_key":"${'a'.repeat(64)}","version":"10"},"clp":{"1744178":{"r":1},"636":{"r":2}},"hsi":${BIG_INT}}`;

function upstreamPage() {
  return (
    '<!DOCTYPE html><html><head><title>Instagram</title>' +
    '<script src="https://static.cdninstagram.com/rsrc.php/boot.js"></script></head><body><div id="spinner">loading</div>' +
    block({ define: [['CurrentUserInitialData', [], { USER_ID: '0', NAME: '', SHORT_NAME: null }, 1]] }) +
    `<script type="application/json" data-sjs>${SUPPORT_BLOCK}</script>` +
    block({ require: [['RelayPrefetchedStreamCache', 'next', [], [PREFETCH_KEY, { __bbox: { result: { data: { note: PREFETCH_MARK } } } }]]] }) +
    '</body></html>'
  );
}

async function withServer(env, fn) {
  const page = upstreamPage();
  const server = await startCloneServer(env, {
    snapshot: { documents: { '/': page.replace('<body>', `<body>${block(REVISION_PAYLOAD)}`), '/accounts/emailsignup/': documentAt('100') } },
  });
  try {
    await fn(server.base, server);
    assert.deepStrictEqual(server.upstream, [], 'serving the pinned document made an upstream attempt');
  } finally {
    await server.close();
  }
}

test('the served document lets the client boot', async (t) => {
  await t.test('an anonymous page keeps its own prefetch and is valid HTML', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
      assert.strictEqual(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /text\/html/);
      const html = await res.text();
      assert.ok(html.includes(PREFETCH_MARK), 'the anonymous prefetch payload must survive');
      assert.ok(html.includes('RelayPrefetchedStreamCache'));
      // Every JSON block still parses after personalisation.
      for (const m of html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
        assert.doesNotThrow(() => JSON.parse(m[1]), 'a bootstrap JSON block was left invalid');
      }
    });
  });

  await t.test('our encryption key is substituted in; the csrf token and a readable csrftoken cookie are left for the client', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
      const html = await res.text();
      const ours = (await (await fetch(`${base}/data/shared_data/`)).json()).encryption;
      assert.ok(html.includes(ours.public_key) && !html.includes('a'.repeat(64)), 'our key replaces the upstream key');
      assert.ok(html.includes('upstream-anon-csrf'), 'the bootstrap csrf token is preserved (the client tamper-checks it)');
      const csrfCookie = res.headers.getSetCookie().find((c) => c.startsWith('csrftoken='));
      assert.ok(csrfCookie && !/HttpOnly/i.test(csrfCookie), 'a readable csrftoken cookie is issued for the client to echo as X-CSRFToken');
      // The encryption edit must not corrupt the big integer or key order in its block.
      assert.ok(html.includes(`"hsi":${BIG_INT}`), 'the big integer survives the edit to its block');
      assert.ok(html.includes('"clp":{"1744178":{"r":1},"636":{"r":2}}'), 'integer-like key order is preserved');
      const csrf = res.headers.getSetCookie().find((c) => c.startsWith('csrftoken='));
      assert.ok(csrf && !/HttpOnly/i.test(csrf), 'a readable csrftoken is issued for the client to echo');
      assert.ok(html.includes('/__clone/runtime.js'), 'the runtime is injected');
    });
  });

  await t.test('the health endpoint confirms prefetch dropping is off by default', async () => {
    await withServer({}, async (base) => {
      const health = await (await fetch(`${base}/__loader/health`)).json();
      assert.strictEqual(health.shell.forceDropPrefetches, false);
    });
  });

  await t.test('forcing drops on removes the prefetch (debug only), confirming the mechanism', async () => {
    await withServer({ SHELL_DROP_PREFETCHES: '1' }, async (base) => {
      const html = await (await fetch(`${base}/`, { headers: { accept: 'text/html' } })).text();
      assert.ok(!html.includes(PREFETCH_MARK), 'with the debug flag the prefetch is stripped');
    });
  });

  await t.test('a document navigation gets the pinned page whatever the client sends as Accept', async () => {
    await withServer({}, async (base) => {
      for (const accept of ['*/*', 'text/html', 'application/json']) {
        const html = await (await fetch(`${base}/`, { headers: { accept } })).text();
        assert.ok(html.includes(PREFETCH_MARK), `Accept ${accept}: the pinned page was served`);
      }
    });
  });

  await t.test('a file path the snapshot does not hold is an explicit 404, not a fetch', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/static/bundles/unknown.json`, { headers: { accept: 'application/json' } });
      assert.strictEqual(res.status, 404);
      assert.match(await res.text(), /Not in the pinned client snapshot/);
    });
  });

  await t.test('an unsupported GraphQL op the client might issue fails fast with 501, not a hang', async () => {
    await withServer({}, async (base) => {
      const first = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
      const token = first.headers.getSetCookie().find((c) => c.startsWith('csrftoken=')).split(';')[0].split('=')[1];
      const res = await fetch(`${base}/graphql/query`, {
        method: 'POST',
        headers: { cookie: `csrftoken=${token}`, 'x-csrftoken': decodeURIComponent(token), 'content-type': 'application/x-www-form-urlencoded' },
        body: 'fb_api_req_friendly_name=PolarisUnknownBootQuery&variables=%7B%7D',
      });
      assert.strictEqual(res.status, 501);
      assert.strictEqual((await res.json()).data, null);
    });
  });
});
