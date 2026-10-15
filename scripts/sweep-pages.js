'use strict';

/**
 * Runtime route inventory sweep.
 *
 *   node scripts/sweep-pages.js [baseUrl]
 *
 * Loads routes through the mirror in real Chromium and records what actually
 * happened. Two distinct things are measured and reported separately, because
 * they are different claims:
 *
 *   documentDelivery - the origin's HTML document reached the browser
 *                      (HTTP status, byte size, content type, challenge or not)
 *   clientRendering  - the genuine client bootstrapped and rendered content
 *                      (react mount root, requireLazy, rendered bytes, text)
 *
 * Results are merged into .scratch/route-inventory.json. Routes already recorded
 * as working, and routes the operator personally verified, are carried forward
 * WITHOUT re-requesting them. This keeps load off Instagram while it throttles.
 * Set FORCE=1 to re-request everything.
 *
 * Outcomes:
 *   working       - client rendered page content
 *   auth-required - client rendered only a login/signup gate
 *   partial       - client booted but content is empty, or a challenge did not settle
 *   inconclusive  - throttled or transient origin error; the route was NOT judged
 *   unavailable   - origin returned 404 with no page
 *   untested      - navigation failed outright
 *
 * A 429 or a redirect carrying a rate-limit indicator is never treated as
 * evidence that a page is missing or needs authentication.
 */

const fs = require('node:fs');
const path = require('node:path');
const { launchChromium, openSession, navigate, probeDom } = require('./lib/browser');
const { routes, patterns } = require('./lib/routes');

const baseUrl = (process.argv[2] || `http://localhost:${process.env.PORT || 12000}`).replace(/\/$/, '');
const SETTLE_MS = Number(process.env.SETTLE_MS || 7000);
const BETWEEN_MS = Number(process.env.BETWEEN_MS || 8000);
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const FORCE = process.env.FORCE === '1';
// Re-requesting routes that already came back throttled is exactly what we are
// told not to do, so it is opt-in rather than the default.
const RETRY_INCONCLUSIVE = process.env.RETRY_INCONCLUSIVE === '1';

const OUT_DIR = path.join(__dirname, '..', '.scratch');
const OUT_FILE = path.join(OUT_DIR, 'route-inventory.json');

// Routes whose legitimate anonymous content IS the login/sign-up form, so a
// rendered login form there is success rather than a gate.
const LOGIN_SURFACES = new Set([
  '/',
  '/accounts/login/',
  '/accounts/login/?next=%2F&source=mobile_nav',
  '/accounts/emailsignup/',
  '/accounts/password/reset/',
  '/accounts/password/reset/confirm/',
  '/accounts/two_factor_authentication/',
]);

/** Decide the outcome from observed evidence only. */
function classify(route, docStatus, dom) {
  // Non-page endpoints (robots.txt, manifest) are judged purely on document
  // delivery: no client is expected to render there.
  if (route.category === 'non-page') {
    if (docStatus === 429) return 'inconclusive';
    if (docStatus === 0 || docStatus === null) return 'untested';
    if (docStatus === 200) return 'working';
    if (docStatus === 404) return 'unavailable';
    if (docStatus >= 500) return 'inconclusive';
    return 'unavailable';
  }

  const clientBooted = dom.reactRoots > 0 || dom.hasRequireLazy;

  if (docStatus === 429) return 'inconclusive'; // throttled; not a judgement
  if (docStatus === 0 || docStatus === null) return 'untested';
  if (!clientBooted) {
    if (docStatus === 404) return 'unavailable';
    if (docStatus >= 500) return 'inconclusive';
    if (dom.isChallenge) return 'partial';
    return 'unavailable';
  }
  if (dom.isChallenge) return 'partial';

  const rendered = dom.mountRootInnerHtml > 500;
  const text = (dom.visibleText || '').trim();
  const looksGated = /^(log in|sign up|log into instagram)/i.test(text) || /log in\s+sign up/i.test(text);

  if (!rendered) return 'partial';
  if (LOOKS_GATED_PATHS.has(route.path)) return looksGated ? 'auth-required' : 'working';
  if (LOGIN_SURFACES.has(route.path)) return 'working';
  if (looksGated && dom.mountRootInnerHtml < 20000) return 'auth-required';
  return 'working';
}

// Routes where a login gate is the expected anonymous behaviour.
const LOOKS_GATED_PATHS = new Set(['/reels/']);

function loadExisting() {
  try {
    const data = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    return new Map(data.rows.map((r) => [r.path, r]));
  } catch {
    return new Map();
  }
}

(async () => {
  const existing = loadExisting();
  const selected = ONLY ? routes.filter((r) => ONLY.includes(r.path)) : routes;

  const profileDir = path.join(__dirname, '..', '.scratch', 'sweep-profile');
  const { child, browserWsUrl } = await launchChromium(profileDir);
  const rows = [];
  let exitCode = 0;
  let requested = 0;

  try {
    const session = await openSession(browserWsUrl);

    console.log(`\n=== Route inventory sweep: ${selected.length} routes ===`);
    console.log(`    FORCE=${FORCE}  (working/user-verified routes are not re-requested)\n`);

    for (const route of selected) {
      const prior = existing.get(route.path);
      const carried =
        !FORCE &&
        prior &&
        (route.userVerified ||
          ['working', 'auth-required', 'unavailable'].includes(prior.outcome) ||
          (prior.outcome === 'inconclusive' && !RETRY_INCONCLUSIVE));

      if (carried) {
        // Normalise a carried-forward record onto the current schema. The old
        // schema stored the rendered DOM size under `documentDelivery.bytes`,
        // which conflated delivered bytes with rendered bytes; that number moves
        // to clientRendering.domBytes and delivered bytes become null (not
        // re-measured, so unknown rather than guessed).
        const normalized = {
          path: prior.path,
          category: route.category,
          expect: route.expect,
          userVerified: Boolean(route.userVerified),
          outcome: prior.outcome,
          documentDelivery: {
            status: prior.documentDelivery?.status ?? null,
            bytes: null,
            contentType: prior.documentDelivery?.contentType ?? null,
            challenge: prior.documentDelivery?.challenge ?? false,
          },
          clientRendering: {
            reactRoots: prior.clientRendering?.reactRoots ?? 0,
            requireLazy: prior.clientRendering?.requireLazy ?? false,
            renderedBytes: prior.clientRendering?.renderedBytes ?? 0,
            domBytes: prior.clientRendering?.domBytes ?? prior.documentDelivery?.bytes ?? 0,
            text: prior.clientRendering?.text ?? '',
          },
          interactionVerified: false,
          network: prior.network ?? { total: 0, failed: 0, failedSample: [] },
          verifiedAt: prior.verifiedAt ?? null,
          source: prior.source ?? 'automated',
          carriedForward: true,
        };
        rows.push(normalized);
        console.log(`[${String(prior.outcome).toUpperCase()}] ${route.path}  (carried forward${route.userVerified ? ', user-verified' : ''}; no request made)`);
        continue;
      }

      requested += 1;
      await navigate(session, baseUrl + route.path, SETTLE_MS);
      const dom = await probeDom(session);

      const failed = [...session.requests.values()].filter((r) => r.failed || (r.status !== null && r.status >= 400));
      const docReq = [...session.requests.values()].find((r) => r.type === 'Document');
      const docStatus = docReq ? docReq.status : null;
      const outcome = route.userVerified ? 'working' : classify(route, docStatus, dom);

      const row = {
        path: route.path,
        category: route.category,
        expect: route.expect,
        userVerified: Boolean(route.userVerified),
        outcome,
        // The three verification levels, kept separate on purpose.
        // 1. documentDelivery - did the origin's HTML reach the browser?
        documentDelivery: {
          status: docStatus,
          bytes: docReq ? docReq.encodedDataLength ?? docReq.contentLength ?? 0 : 0,
          contentType: docReq ? docReq.mimeType : null,
          challenge: dom.isChallenge,
        },
        // 2. clientRendering - did the genuine client bootstrap and render?
        clientRendering: {
          reactRoots: dom.reactRoots,
          requireLazy: dom.hasRequireLazy,
          renderedBytes: dom.mountRootInnerHtml,
          domBytes: dom.htmlLength,
          text: (dom.visibleText || '').slice(0, 200),
        },
        // 3. interaction is NOT measured here; see `interactionVerified`.
        interactionVerified: false,
        network: {
          total: session.requests.size,
          failed: failed.length,
          failedSample: failed.slice(0, 5).map((r) => `${r.status ?? 'ERR'} ${r.url.slice(0, 90)}`),
        },
        verifiedAt: new Date().toISOString(),
        source: route.userVerified ? 'user' : 'automated',
      };
      rows.push(row);

      console.log(`[${outcome.toUpperCase()}] ${route.path}`);
      console.log(`    document : http ${docStatus ?? '-'} ${dom.htmlLength}B${dom.isChallenge ? ' [challenge]' : ''}`);
      console.log(`    rendered : mount ${dom.mountRootInnerHtml}B reactRoots ${dom.reactRoots} requireLazy ${dom.hasRequireLazy}`);
      console.log(`    network  : ${session.requests.size} reqs, ${failed.length} failed`);
      console.log(`    text     : ${JSON.stringify(row.clientRendering.text.slice(0, 110))}`);
      console.log('');

      session.requests.clear();
      session.consoleMessages.length = 0;
      session.exceptions.length = 0;
      session.logEntries.length = 0;

      await new Promise((r) => setTimeout(r, BETWEEN_MS));
    }

    session.ws.close();

    // Merge: keep rows for routes this run did not select, so an ONLY-filtered
    // batch extends the inventory instead of replacing it.
    const byPath = new Map(rows.map((r) => [r.path, r]));
    for (const route of routes) {
      if (byPath.has(route.path)) continue;
      const prior = existing.get(route.path);
      if (prior) byPath.set(route.path, prior);
    }
    const finalRows = routes.map((r) => byPath.get(r.path)).filter(Boolean);

    const byOutcome = {};
    for (const r of finalRows) (byOutcome[r.outcome] = byOutcome[r.outcome] || []).push(r);

    console.log('\n=== Summary by outcome ===');
    for (const key of ['working', 'auth-required', 'partial', 'inconclusive', 'unavailable', 'untested']) {
      const group = byOutcome[key] || [];
      if (!group.length) continue;
      console.log(`  ${key.padEnd(14)} ${group.length}/${finalRows.length}`);
      for (const r of group) console.log(`      ${r.path}${r.userVerified ? '  (user-verified)' : ''}${r.carriedForward ? '  (carried)' : ''}`);
    }

    console.log('\n=== Summary by category ===');
    for (const category of ['public', 'auth-flow', 'auth-only', 'non-page', 'unknown']) {
      const group = finalRows.filter((r) => r.category === category);
      if (!group.length) continue;
      const tally = {};
      for (const r of group) tally[r.outcome] = (tally[r.outcome] || 0) + 1;
      console.log(`  ${category.padEnd(10)} ${group.length} routes: ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }

    console.log(`\n  upstream requests made this run: ${requested}`);

    console.log('\n=== URL patterns with identifier segments ===');
    for (const p of patterns) {
      const tested = p.example ? `example ${p.example} [${p.exampleSource}] requested=${p.requested} delivered=${p.delivered} rendered=${p.rendered} interactions=${p.interactions}` : `NOT TESTED - ${p.blocker}`;
      console.log(`  ${p.pattern.padEnd(34)} ${tested}`);
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl, rows: finalRows, patterns }, null, 2));
    console.log(`\n  inventory written to ${path.relative(process.cwd(), OUT_FILE)}`);

    // Fail only on genuine defects: a public page that is definitively broken.
    // Throttling and challenges are environmental and do not fail the run.
    const defects = finalRows.filter((r) => r.category === 'public' && ['unavailable', 'untested', 'partial'].includes(r.outcome));
    if (defects.length) exitCode = 1;
  } catch (error) {
    console.error(`sweep failed: ${error.message}`);
    exitCode = 2;
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(profileDir, { recursive: true, force: true });
  }

  process.exit(exitCode);
})();
