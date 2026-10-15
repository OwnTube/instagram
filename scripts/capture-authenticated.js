'use strict';

/**
 * Authenticated runtime capture.
 *
 * Drives a real headless Chromium over CDP, injects a session cookie supplied
 * through the environment, visits authenticated pages, and records the network
 * activity and response SHAPES.
 *
 * A real browser is required rather than plain HTTP: Instagram rejects requests
 * that do not present a genuine browser TLS fingerprint, answering 302 to the
 * homepage even when the session cookie is valid. Raw fetch/curl cannot
 * reproduce authenticated behaviour.
 *
 * Safety properties, deliberately enforced here:
 *   - the session is read from IG_SESSIONID and is never written to disk;
 *   - the browser profile is created under .scratch/ and removed afterwards, so
 *     no cookie is left behind;
 *   - only navigation (GET) happens. Nothing is posted, liked, followed or
 *     modified, so the account is not altered;
 *   - the report records paths and response shapes only: no query strings, no
 *     cookie values, no response values, no personal data.
 *
 * Usage:
 *   IG_SESSIONID='<value>' IG_USERNAME='<own username>' node scripts/capture-authenticated.js [route ...]
 */

const fs = require('node:fs');
const path = require('node:path');
const { launchChromium, openSession, navigate } = require('./lib/browser');

const SESSION = process.env.IG_SESSIONID;
if (!SESSION) {
  console.error('IG_SESSIONID is not set');
  process.exit(2);
}

const USERNAME = process.env.IG_USERNAME || '';
const SETTLE_MS = Number(process.env.NAV_SETTLE_MS || 9000);
const ORIGIN = 'https://www.instagram.com';

const DEFAULT_ROUTES = ['/', '/explore/', '/direct/inbox/', '/accounts/edit/'];
const ROUTES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [...DEFAULT_ROUTES, ...(USERNAME ? [`/${USERNAME}/`] : [])];

/**
 * Describe a JSON body by shape only. Never returns values, so a report can be
 * shared without exposing account data.
 */
function shapeOf(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { json: false, bytes: raw.length };
  }

  const describe = (value) => {
    if (Array.isArray(value)) return { array: value.length };
    if (value === null) return 'null';
    if (typeof value === 'object') return { object: Object.keys(value).slice(0, 40) };
    return typeof value;
  };

  if (Array.isArray(parsed)) {
    return {
      json: true,
      top: 'array',
      length: parsed.length,
      item0: parsed[0] ? describe(parsed[0]) : null,
    };
  }
  if (parsed && typeof parsed === 'object') {
    const out = { json: true, top: 'object', keys: Object.keys(parsed).slice(0, 40) };
    // These short status fields are useful and carry no personal data.
    for (const key of ['status', 'message', 'authenticated']) {
      if (typeof parsed[key] === 'string') out[key] = parsed[key].slice(0, 60);
    }
    for (const key of ['user', 'data', 'items', 'media', 'graphql', 'viewer', 'friendship_status']) {
      if (parsed[key] !== undefined) out[key] = describe(parsed[key]);
    }
    return out;
  }
  return { json: true, top: typeof parsed };
}

/** Strip a URL down to its path; the query is discarded so nothing leaks. */
function safePath(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!u.hostname.endsWith('instagram.com')) return null;
    if (u.pathname.startsWith('/__')) return null; // our own loader/backend
    return u.pathname;
  } catch {
    return null;
  }
}

/**
 * For a GraphQL POST body, return the operation names and the top-level
 * variable names — never their values, which can identify a user or a post.
 *
 * Instagram sends these as either JSON or form-encoded, so handle both.
 */
function graphqlRequestKeys(postData) {
  if (!postData) return undefined;
  let fields;
  if (postData.trimStart().startsWith('{')) {
    try {
      fields = JSON.parse(postData);
    } catch {
      return undefined;
    }
  } else {
    fields = {};
    for (const pair of postData.split('&')) {
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      fields[decodeURIComponent(pair.slice(0, idx))] = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
    }
  }

  const out = {};
  for (const key of ['doc_id', 'operation_name', 'query_hash', 'fb_api_req_friendly_name', '__a', '__d']) {
    const value = fields[key];
    // A doc_id / hash / operation name is an opaque identifier, not personal data.
    if (typeof value === 'string' && value.length <= 64) out[key] = value;
  }
  // Variable NAMES only; the values can name a user, post or thread.
  const rawVars = fields.variables || fields.query_params;
  if (typeof rawVars === 'string') {
    try {
      const parsed = JSON.parse(rawVars);
      if (parsed && typeof parsed === 'object') out.variableNames = Object.keys(parsed).slice(0, 30);
    } catch {
      /* not JSON, skip */
    }
  }
  return Object.keys(out).length ? out : undefined;
}

(async () => {
  const profileDir = path.join(__dirname, '..', '.scratch', 'auth-profile');
  const outDir = path.join(__dirname, '..', '.scratch', 'auth-capture');
  fs.mkdirSync(outDir, { recursive: true });

  const { child, browserWsUrl } = await launchChromium(profileDir);
  let exitCode = 0;

  try {
    const session = await openSession(browserWsUrl);

    // Inject the session into this browser's cookie store only.
    const userId = SESSION.split('%3A')[0];
    for (const [name, value, httpOnly] of [
      ['sessionid', SESSION, true],
      ['ds_user_id', userId, false],
    ]) {
      await session.cdp.send('Network.setCookie', {
        name,
        value,
        domain: '.instagram.com',
        path: '/',
        secure: true,
        httpOnly,
      });
    }

    // Capture JSON response shapes for API traffic.
    session.cdp.on(async (msg) => {
      if (msg.method !== 'Network.loadingFinished') return;
      const entry = session.requests.get(msg.params.requestId);
      if (!entry || !/json/i.test(entry.mimeType || '')) return;
      try {
        const body = await session.cdp.send('Network.getResponseBody', {
          requestId: msg.params.requestId,
        });
        entry.shape = shapeOf(body.body);
      } catch {
        /* body already evicted */
      }
    });

    const report = { startedAt: new Date().toISOString(), routes: [] };

    for (const route of ROUTES) {
      session.requests.clear();
      session.consoleMessages.length = 0;
      session.exceptions.length = 0;

      await navigate(session, `${ORIGIN}${route}`, SETTLE_MS);

      // Where did we actually land, and are we authenticated?
      const landed = await session.cdp.send('Runtime.evaluate', {
        expression:
          'JSON.stringify({path:location.pathname,loggedOut:document.documentElement.className.includes("not-logged-in"),hasNav:!!document.querySelector(\'a[href="/direct/inbox/"]\')})',
        returnByValue: true,
      });
      const state = JSON.parse(landed.result.value);

      const requests = [];
      for (const [, entry] of session.requests) {
        const p = safePath(entry.url);
        if (!p) continue;
        requests.push({
          path: p,
          method: entry.method,
          status: entry.status,
          type: entry.type,
          mimeType: entry.mimeType,
          bytes: entry.encodedDataLength,
          failed: entry.failed || undefined,
          shape: entry.shape,
          // For a GraphQL POST, record only which top-level operation keys the
          // request body carries — never the variables, which can be personal.
          requestKeys: graphqlRequestKeys(entry.postData),
        });
      }
      // De-duplicate identical path+status pairs, keep the first shape seen.
      const seen = new Set();
      const unique = requests.filter((r) => {
        const key = `${r.path} ${r.status} ${r.type}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      report.routes.push({
        route,
        landedOn: state.path,
        authenticated: !state.loggedOut && state.hasNav,
        loggedOutMarker: state.loggedOut,
        requestCount: unique.length,
        apiCalls: unique.filter((r) => /json/i.test(r.mimeType || '')),
        consoleErrors: session.consoleMessages.filter((m) => m.level === 'error').slice(0, 10),
        exceptions: session.exceptions.slice(0, 5),
        otherRequests: unique.filter((r) => !/json/i.test(r.mimeType || '')).slice(0, 40),
      });

      console.log(
        `${state.loggedOut ? 'LOGGED-OUT' : 'AUTHED'}  ${route} -> ${state.path}  (${unique.length} reqs, ${unique.filter((r) => /json/i.test(r.mimeType || '')).length} json)`,
      );
    }

    const outFile = path.join(outDir, `capture-${Date.now()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log(`\n[capture] wrote shape-only report: ${outFile}`);
  } catch (error) {
    console.error(`[capture] failed: ${error.message}`);
    exitCode = 1;
  } finally {
    // Remove the profile so the injected session never persists on disk.
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    fs.rmSync(profileDir, { recursive: true, force: true });
  }

  process.exit(exitCode);
})();
