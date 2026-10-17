'use strict';

/**
 * Upstream guard for checks: replaces the process's global fetch (the only
 * client src/upstream.js uses) with one that records every attempted request
 * to a non-local host and fails it, as if the network were cut. Requests to
 * 127.0.0.1/localhost (the checks' own server) pass through. Install it before
 * src/server.js is required.
 *
 *   const guard = installUpstreamGuard();
 *   ... guard.attempts  // [{ url, method, headers, body, at }]
 */

const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])$/;

function installUpstreamGuard() {
  const real = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url || String(input);
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      /* not absolute */
    }
    if (LOCAL.test(host)) return real(input, init);
    attempts.push({
      url,
      method: (init.method || 'GET').toUpperCase(),
      headers: Object.fromEntries(new Headers(init.headers || {})),
      body: typeof init.body === 'string' ? init.body : null,
      at: Date.now(),
    });
    throw new TypeError(`upstream guard: request to ${host} refused`);
  };
  return { attempts, restore: () => (globalThis.fetch = real) };
}

module.exports = { installUpstreamGuard };
