# Pinned client: lifecycle, guarantees, outbound audit

Decision (2026-10-17): the server serves one pinned, validated snapshot of
Instagram's public web client and nothing else. Live client serving
(`CLIENT_MODE=live`, document proxying, the prefer-cache mode, fallbacks to
Instagram on a miss or an error, the per-route "self-heal" that fetched
bootloader answers at request time, the document/bootloader stores the server
wrote to) has been removed. No hidden switch for it remains.

## Serving rules (src/server.js, src/pinnedClient.js)

| Request | Answer |
| --- | --- |
| Document in the snapshot (by path; profiles, posts, reels and stories use `/`, DM threads `/direct/inbox/`) | 200, personalised per request (our encryption key, CSRF, viewer, signed-in route), `private, no-store`, self-only CSP, `x-client-snapshot: <id>` |
| Document not in the snapshot | 404 `Not in the pinned client snapshot <id> (revision R): document <path>` |
| `/__ig/<host>/<path>`: asset in the snapshot | 200 from the snapshot blob (hash checked on first read; bundle patches applied) |
| Asset not in the snapshot | 404, same message |
| Host not allowed | 403 |
| `/ajax/bootloader-endpoint/` answer in the snapshot | 200 |
| ... for another `__rev` | 409 `Revision X asked; the pinned client is revision R` |
| ... not in the snapshot | 404 |
| Blob whose bytes do not match its sha256 | 500 `Pinned client integrity failure`, recorded in diagnostics; never served |
| No active snapshot, or it fails validation (wrong revision anywhere, missing blob, size mismatch, required route unsupported) | 503 `Pinned client unavailable: <reason>` for every client request; the backend still runs |
| Any other non-GET request no local handler answers | 404; nothing is relayed |

Signed-in routes use only the snapshot's own answers for its revision. A
route whose answers are missing is served as the page's own (anonymous) route
and counted in `/__loader/health` -> `client.missingRequests` (kind `route`).
Every miss is counted there by kind (`document`, `asset`, `answer`, `route`,
`request`).

Session data is separate from the snapshot: the snapshot holds anonymous
upstream bytes only; viewer state is added per response and never stored in
it. The snapshot store never contains cookies or tokens.

## Lifecycle (operator commands, never automatic)

```
npm run client:acquire                      # the ONLY command that contacts Instagram
npm run client:build -- --acquired .cache/acquired/<stamp>
npm run client:verify -- <id> --browser     # integrity + genuine browser checks
npm run client:activate -- <id>             # previous one kept for rollback
npm run client:rollback
npm run client:status
```

- **acquire** (`scripts/client-acquire.js`): one bounded anonymous pass:
  documents `/` and `/accounts/emailsignup/` (must be the same revision),
  the bootloader answers of the known module sets at that revision (an
  answer declaring another revision is refused), then the missing public
  assets they reference (capped by `--max-assets`). Sequential, paused, stops
  at the first 429 or failure (no retry of a 429). Output goes to a staging
  directory with `provenance.json` (URL, status, sha256, bytes, time per
  request, stop reason); assets are added to the URL-keyed asset store (new
  URLs only). The active snapshot is not touched.
- **build** (`scripts/client-snapshot.js`): a `candidate` from material of
  ONE revision. Records documents, answers, assets (sha256, bytes, type,
  validators, referrer), routes and the answers each needs, known-missing,
  rejected material with the reason, bundle-patch results, provenance.
  Blobs are content-addressed; paths come only from validated hashes, and ids
  match `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`, so nothing can escape the store.
- **verify**: deep validation (every hash), patches must apply, then with
  `--browser` the genuine checks against the candidate with the upstream
  guard on. Core checks (login, signup, feed, engage) must all pass for
  `verified`; create and profile are run and recorded as the snapshot's
  `scope` (`working`, `failing`, `unsupported`, `complete`). A partial
  snapshot is never recorded as complete.
- **activate**: only `verified`/`retired` snapshots; deep validation again;
  the previous active one becomes `retired` and heads the history.
- **rollback**: the first snapshot in the history that still validates.

## Outbound request audit

Every component that can make a network request, classified:

| Path | Class | When | Notes |
| --- | --- | --- | --- |
| `src/server.js` and everything it loads | local backend traffic only | serving | Does not load `src/upstream.js` (asserted by `test/pinned-client.test.js`). Contains no `fetch`, `http(s).request`, socket, timer-driven or background task. |
| `src/upstream.js` `fetchUpstream` | library | operator commands only | Anonymous; strips browser cookies and auth; 429 starts a cooldown and is never retried. |
| `scripts/client-acquire.js` | client document acquisition, bootloader/module acquisition, static asset acquisition | operator, explicit | The only client acquisition path. |
| `scripts/asset-cache.js warm` | static asset acquisition | operator, explicit | Public `static/scontent.cdninstagram.com` URLs referenced by stored material; stops at 429. `status`/`check` make no request. |
| Page runtime `src/shell/runtime.js` (in the browser) | user-requested application data -> local backend | page | Rewrites absolute Instagram API URLs to this origin, drops Meta telemetry; the self-only CSP blocks every other origin. |
| Backend `src/backend`, `src/clone` | local backend traffic | serving | All API, GraphQL, upload, media, Direct answered locally. Mail: local outbox or console log; no provider. |
| `scripts/genuine-*-check.js`, `browser-*-check.js`, `route-audit.js`, `rea-live.js`, `diagnostics/*` | local | operator/test | Talk to a local server; genuine checks and route audit fail if the server attempts any upstream request or the browser contacts any other host. |
| `scripts/verify.js`, `sweep-pages.js`, `browser-check.js` | local by default | operator | Take a base URL argument; with the default they test this server. |
| `scripts/capture-authenticated.js` | third-party (Instagram), research | operator, manual, NOT used | Drives a browser to instagram.com with an operator-supplied session cookie. Kept as a historical research tool; it conflicts with the rule against using personal Instagram sessions and was not run in this work. Not reachable from serving. |
| Third-party integrations | none | | |

## Evidence

- `test/pinned-client.test.js`: zero upstream attempts on cold/warm
  document, asset and answer hits and on document, asset, answer and
  non-GET misses; 404/409/500/503 answers; diagnostics; a corrupted blob is
  refused; a snapshot mixing revisions (answer or document) is not served at
  all; startup without a snapshot; restart keeps the activated snapshot even
  when another fixture is offered; no timer created by the client path;
  validation (path escape, foreign asset host, wrong revision, missing blob,
  shallow vs deep hash); failed verification cannot replace the active
  snapshot; verification with failing scope checks records a partial scope;
  activation and rollback; rollback refuses a snapshot that no longer
  validates.
- A mutation check (making a snapshot miss call `fetch` to Instagram) makes
  three of those tests fail, so the guard does detect an attempt.
- `test/upstream-leak.test.js`, `test/viewer-isolation.test.js`,
  `test/document-render.test.js`, `test/signed-in-route.test.js` run on the
  pinned fixture and assert no upstream attempt.

The test snapshots are fixtures (synthetic documents in Instagram's
bootstrap shape); the genuine browser checks run against the real snapshot.
