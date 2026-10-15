'use strict';

/**
 * Runtime verification of the loader against the live upstream.
 *
 *   node scripts/verify.js [baseUrl]
 *
 * Fetches the proxied document, extracts every asset reference the loader
 * rewrote, downloads each one through the loader, and reports status,
 * content-type and size. Also exercises the cache and the allow-list guard.
 *
 * Exits non-zero if any referenced asset failed to load.
 */

const baseUrl = (process.argv[2] || `http://localhost:${process.env.PORT || 12000}`).replace(/\/$/, '');
const CONCURRENCY = 6;

const results = [];

async function get(url) {
  const res = await fetch(url, { redirect: 'follow' });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body: buf };
}

function extractAssetRefs(html) {
  const refs = new Set();
  // Only srcset needs comma-splitting; attribute URLs may legitimately contain
  // commas (e.g. Instagram's `/rsrc.php/v5/yx/l/0,cross/<hash>.css`).
  const attrPatterns = [
    /<script\b[^>]*?\bsrc="(\/__ig\/[^"]+)"/gi,
    /<link\b[^>]*?\bhref="(\/__ig\/[^"]+)"/gi,
    /<img\b[^>]*?\bsrc="(\/__ig\/[^"]+)"/gi,
    /url\((\/__ig\/[^)]+)\)/gi,
  ];
  for (const re of attrPatterns) {
    for (const match of html.matchAll(re)) refs.add(match[1]);
  }
  for (const match of html.matchAll(/\bsrcset="([^"]*)"/gi)) {
    for (const candidate of match[1].split(',')) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url.startsWith('/__ig/')) refs.add(url);
    }
  }
  return [...refs];
}

async function pool(items, worker, limit) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function kindOf(contentType, url) {
  const type = (contentType || '').split(';')[0].trim();
  if (type) return type;
  if (url.endsWith('.js')) return 'application/javascript';
  if (url.endsWith('.css')) return 'text/css';
  return '(none)';
}

(async () => {
  console.log(`\n=== 1. Document fetch: ${baseUrl}/ ===`);
  let page;
  try {
    page = await get(`${baseUrl}/`);
  } catch (error) {
    console.error(`  FAILED to reach the loader: ${error.message}`);
    process.exit(2);
  }
  const pageHeaders = Object.fromEntries(page.headers.entries());
  const html = page.body.toString('utf8');
  console.log(`  status        : ${page.status}`);
  console.log(`  bytes         : ${page.body.length}`);
  console.log(`  upstream      : ${pageHeaders['x-loader-upstream'] || '(missing)'}`);
  console.log(`  content-type  : ${pageHeaders['content-type'] || '(missing)'}`);

  const refs = extractAssetRefs(html);
  console.log(`  rewritten refs: ${refs.length} unique asset URLs\n`);

  console.log('=== 2. Asset fetch through the loader ===');
  await pool(
    refs,
    async (ref) => {
      try {
        const res = await get(baseUrl + ref);
        const row = {
          ref,
          status: res.status,
          type: kindOf(res.headers.get('content-type'), ref),
          bytes: res.body.length,
          cache: res.headers.get('x-loader-cache') || '-',
        };
        results.push(row);
        const flag = res.status >= 200 && res.status < 400 ? 'ok  ' : 'FAIL';
        console.log(
          `  ${flag} ${String(res.status).padEnd(3)} ${String(row.bytes).padStart(9)}B ` +
            `${row.type.padEnd(28)} cache=${row.cache.padEnd(12)} ${ref.slice(0, 70)}`,
        );
      } catch (error) {
        results.push({ ref, status: 0, type: '-', bytes: 0, cache: '-', error: error.message });
        console.log(`  FAIL   -  ${ref.slice(0, 90)} :: ${error.message}`);
      }
    },
    CONCURRENCY,
  );

  const byType = {};
  for (const row of results) {
    const bucket = byType[row.type] || (byType[row.type] = { count: 0, bytes: 0, failed: 0 });
    bucket.count += 1;
    bucket.bytes += row.bytes;
    if (row.status < 200 || row.status >= 400) bucket.failed += 1;
  }

  console.log('\n=== 3. Summary by content-type ===');
  for (const [type, bucket] of Object.entries(byType).sort((a, b) => b[1].count - a[1].count)) {
    console.log(
      `  ${String(bucket.count).padStart(3)} x ${type.padEnd(30)} ` +
        `${String(bucket.bytes).padStart(10)}B failed=${bucket.failed}`,
    );
  }

  console.log('\n=== 4. Cache behaviour ===');
  const sample = refs.find((r) => r.endsWith('.js')) || refs[0];
  if (sample) {
    const first = await get(baseUrl + sample);
    const second = await get(baseUrl + sample);
    console.log(`  ${sample.slice(0, 70)}`);
    console.log(`    first  x-loader-cache = ${first.headers.get('x-loader-cache')}`);
    console.log(`    second x-loader-cache = ${second.headers.get('x-loader-cache')}`);
  }

  console.log('\n=== 5. Allow-list guard ===');
  const blocked = await get(`${baseUrl}/__ig/evil.example.com/x.js`);
  console.log(`  GET /__ig/evil.example.com/x.js -> ${blocked.status} (expected 403)`);

  console.log('\n=== 6. Loader diagnostics ===');
  const health = await get(`${baseUrl}/__loader/health`);
  const info = JSON.parse(health.body.toString('utf8'));
  console.log(`  cache size=${info.cache.size} hits=${info.cache.hits} misses=${info.cache.misses} ` +
    `revalidated=${info.cache.revalidated} evictions=${info.cache.evictions}`);
  console.log(`  recent failures recorded: ${info.recentFailures.length}`);
  for (const f of info.recentFailures.slice(0, 10)) {
    console.log(`    - ${f.kind} ${f.status} ${f.url} :: ${f.reason}`);
  }

  const failed = results.filter((r) => r.status < 200 || r.status >= 400);
  console.log(`\n=== RESULT: ${results.length - failed.length}/${results.length} assets loaded, ${failed.length} failed ===`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAILED ${f.status} ${f.ref} ${f.error || ''}`);
    process.exit(1);
  }
  if (blocked.status !== 403) process.exit(1);
  process.exit(0);
})();
