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

Bootloader requests are one module each: the served page sets the client's
own `BootloaderEndpointConfig.maxBatchSize` to 1 (src/shell/personalize.js).
Left at the page's default (`-1`, unlimited), the client batches every
endpoint module asked for in one tick into one request (`modules=A,B`), so
which sets it asks for depends on timing; the snapshot holds genuine
single-module answers, and a set it does not hold may not be made up from
them (see "Combined sets" below). A module the snapshot lacks is still an
explicit, counted 404.

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

## Current snapshot (2026-10-17)

Active: `rev1050722040-20261017T153014Z`, revision 1050722040, built from
acquisition `20261017T152635Z` plus the local stores. Rollback:
`rev1050701999-20261017T075357Z` (kept verified; `client:rollback` returns to
it). 15 documents, 39 answers, 8743 assets (8766 unique blobs, 174.2 MB),
known missing 0, integrity ok, all 4 bundle patches apply. This is the
snapshot packaged in `client/` (`npm run client:setup`, below).

Acquisition 20261017T152635Z (anonymous, one bounded pass, provenance in the
manifest): 3 documents (`/`, `/accounts/emailsignup/`, and the not-found page
`/no..such..account/`, which answered 200 where a 404 is expected, so the pass
stopped there and did not store it), 39 bootloader answers and 47 assets, all
at 200; nothing retried. New against the previous snapshot: the Direct
"New message" dialog (`IGDOmniPickerDialogRoot.react`) and its search list.

Verification (`client-snapshot.js verify rev1050722040-20261017T153014Z
--browser`, upstream guard on): login 10/10, signup 13/13, feed 18/18, engage
9/9, create 10/10, profile 10/10; scope complete; then activated. Also on it:
restart 7/7, Direct 9/9, activity 8/8, search 9/9, stories 8/9 (same tray
limitation as before), and the New-message search lists local accounts
(`IGDOmniPickerSearchResultsListQuery`, items carrying `__isShareSheetItem`).

### Packaged copy (`client/`)

`npm run client:bundle` writes the active snapshot to `client/` in the store's
layout (manifest byte for byte, its blobs, `bundle.json`); `npm run
client:setup` installs it into `.cache/client/` offline, re-hashing every
blob, activating it only when no valid snapshot is active (or with
`--activate`), idempotently. Fresh-install proof (a clone in
`.scratch/fresh-install/`, every step in a network namespace with only
loopback): setup, integrity, active == packaged, the server serving the
packaged revision, misses as explicit 404s with 0 upstream attempts, repeated
setup a no-op, an existing valid snapshot kept, altered bundles refused; the
login, signup and feed browser checks passed from that clone. The bodies
(`client/blobs/`) are not committed pending the publishing decision.

### Previous snapshot rev1050701999-20261017T075357Z

Acquisition 20261017T074937Z (anonymous, one bounded pass; provenance in the
manifest): 143 requests: 2 documents, 32 bootloader answers and 108 assets at
200; 1 document, the not-found page `/no..such..account/`, at HTTP 429 with no
Retry-After. The pass stopped at that 429 and nothing was retried. The
answers it asked for now include every answer key of the then-active snapshot
(`moduleSets()` in scripts/client-acquire.js), so a new revision does not drop
a root the old one served (32 answers, against 19 planned before). Its assets
came in two steps of the asset cache (97, then 11, after `bxData` URIs, the
client's binary data files such as a wasm module, were added to the
references it collects). Cooldown: `node scripts/client-acquire.js
--check-cooldown` reported "cooling down until 2026-10-17T08:51:37Z" (the
60-minute cap, as the 429 carried no Retry-After); no acquisition was started
because time had passed.

Verification (`client-snapshot.js verify rev1050701999-20261017T075357Z
--browser`, real snapshot, upstream guard on): login 10/10, signup 13/13,
feed 18/18, engage 9/9, create 10/10, profile 10/10; scope complete; status
`verified`, then activated. The first verification run failed login 8/9 on
React #418; the same failure reproduced on the previous active snapshot and
at earlier commits, and was traced to narrow windows (docs/REVERSE-ENGINEERING.md
section 11, fixed in the runtime and src/server.js). The login check now also
covers a narrow-window reload.

Genuine checks on the active snapshot (real snapshot, strictly offline):
restart 7/7, Direct 8/8, activity 8/8, search 9/9, stories 8/9 (the tray
ring still opens the story with a page load: no genuine route definition).

### Route report (direct loads in the genuine client, signed in, `scripts/route-screens.js after2`, 0 upstream attempts, 0 requests to other hosts)

| Route | Signed in | Status |
| --- | --- | --- |
| `/` | feed (PolarisFeedRoot) | working |
| `/<local user>/` | profile (PolarisProfilePostsTabRoot) | working |
| `/<unknown user>/`, `/no..such..account/` | the client's own "Sorry, this page isn't available." (404) | working |
| `/stories/<user>/` | stories viewer (PolarisStoriesMediaRoot) | working (direct load); from the tray: page load |
| `/notifications/`, `/accounts/activity/` | activity feed (PolarisActivityFeedRoot; the client redirects the old URL) | working |
| `/direct/inbox/`, `/direct/t/<thread>/` | Direct inbox and thread (PolarisDirectInboxRoot); send, read state | working; no live delivery (no realtime gateway) |
| `/reels/` | Reels tab (PolarisClipsTabRoot) with no clips | renders; local accounts cannot publish clips, so it is empty |
| `/p/<code>/` | anonymous page with login markup | broken: PolarisPostRoot renders only through `cr:2882`, which the anonymous answer leaves unbound |
| `/explore/` | 404, not in snapshot | blocked: its root module is never named in the bundles |
| `/accounts/login/`, `/accounts/password/reset/` | 404, not in snapshot | blocked: their documents got 429 on every pass |
| `/accounts/edit/` | 404, not in snapshot | unsupported: no document |
| `/create/select/` | 404, not in snapshot | unsupported as a direct load: the creation dialog pushes this URL for its Select step; inside the app the dialog works |
| `/accounts/emailsignup/` | sign-up page | working anonymous |

Signed out, every signed-in-only path above is a 404, not the anonymous home
page. Inside the app, navigation to a route whose definition is not in the
page (stories from the tray, explore, reels from the nav) falls back to a page
load: no genuine `/ajax/bulk-route-definitions/` sample exists, and none is
made up.

## References

- Meowcord, the client-pinning comparison: https://github.com/meowcorded/meowcord
- REA, used for reverse engineering of the client bundles: https://github.com/morluto/rea, docs https://morluto.github.io/rea/
- Browser automation. The checks drive Chromium over CDP directly (`scripts/lib/browser.js`):
  - Chrome DevTools Protocol: https://github.com/ChromeDevTools/devtools-protocol, https://chromedevtools.github.io/devtools-protocol/
  - Playwright, whose Chromium build is the one used: https://github.com/microsoft/playwright, https://playwright.dev/docs/intro, trace viewer https://playwright.dev/docs/trace-viewer
  - Puppeteer: https://github.com/puppeteer/puppeteer, https://pptr.dev/
- Relay, the client's GraphQL runtime. Its operations and preloadable queries are what `src/clone/graphql.js` answers: https://github.com/facebook/relay, https://relay.dev/docs/
