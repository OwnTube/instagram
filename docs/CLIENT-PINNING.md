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

## Current snapshot (2026-10-17)

Active: `rev1050669561-20261017T030543Z`, revision 1050669561, status
`active`, built from acquisition `20261017T030239Z` (2 documents, 15 answers,
136 new assets; 153 requests, all 200, none refused) plus the local asset
store. 15 documents, 15 answers, 7508 assets (152.5 MB), known missing 0.
Routes: home and profile supported (the previously missing
`PolarisProfilePostsTabRoot.entrypoint`, `PolarisCreationModal.next.react`,
`PolarisEmptyProfileOtherUsers.react`, `PolarisProfileNewUserActivatorsUnit.react`
and `PolarisFollowingActionsModal.next.react` are all present at this
revision). Bundle patches: all 4 apply.

Verification (`client:verify --browser`, real snapshot, upstream guard on):
login 9/9, signup 13/13, feed 18/18, engage 9/9 (core: pass, so `verified`);
create 9/10, profile 9/10 (scope: PARTIAL).
- create: the client asked `/ajax/bootloader-endpoint/?modules=
  PolarisImmersiveFeedPostModal.react,PolarisFeedEmptySULWrapper.react`
  (one combined set); the snapshot holds each module's own answer but not
  that set, so it is a 404. Needs one more acquisition pass
  (`--set 'PolarisImmersiveFeedPostModal.react,PolarisFeedEmptySULWrapper.react|'`).
- profile: one bootloader request 404'd during verification; a standalone
  re-run passed 10/10, so the failing set was not reproduced (the check now
  prints the full `modules|nb_modules@rev` key).

Composing that set from the two single-module answers was tried and
abandoned: the real parts disagree in per-response fields (`hsdp.qexData.*.l`
exposure ids, `hblp.compMap.*.rds.r` tier lists, `hblp.indexUpgrades`
index lists), so a merged answer would be one the server never produced.
The set stays an explicit 404 until it is acquired as one answer. The same
set blocks a new account's empty home feed (it stays on its loading
skeleton), and with it the genuine search box there
(`scripts/genuine-search-check.js`: 4/8; the local search operations in
`src/clone/searchOperations.js` pass their API tests).

Activation and rollback on the real store: activating the older verified
snapshot `rev1050627067-20261017T030220Z` served it (0 upstream attempts);
`client:rollback` returned to `rev1050669561-20261017T030543Z` (0 upstream
attempts); activating the unverified candidate `rev1050669561-20261017T030508Z`
was refused.

The second acquisition pass (20261017T031253Z, for the combined set and
the roots below) got HTTP 429 at its third document and stopped; nothing
was built from it and the active snapshot is unchanged. It is not retried
during the cooldown.

Restart (`scripts/pinned-restart-check.js`, server as a child process with
the guard preloaded): 7/7 - cold and warm signed-in loads, restart keeps
the same snapshot and the session, no browser request left the origin,
neither process attempted an upstream request.

### Route report (direct loads, `npm run audit:routes`, 0 upstream attempts)

| Route | Anonymous | Signed in | Status |
| --- | --- | --- | --- |
| `/` | anonymous page | signed-in route (PolarisFeedRoot) | working |
| `/<local user>/` | anonymous page | signed-in route (PolarisProfilePostsTabRoot) | working |
| `/accounts/emailsignup/` | sign-up page | sign-up page | working anonymous; signed-in behaviour unverified |
| `/p/<code>/`, `/stories/<user>/`, `/<unknown user>/` | anonymous page | anonymous page with login markup | broken signed in (needs PolarisPostRoot / PolarisStoriesMediaRoot answers) |
| `/explore/`, `/explore/search/`, `/reels/`, `/direct/inbox/`, `/accounts/activity/`, `/create/select/` | 404 not in snapshot | 404 | unsupported as direct loads |
| `/accounts/login/`, `/accounts/password/reset/` | 404 not in snapshot | 404 | unsupported (documents in the next acquisition pass) |
| `/accounts/edit/` | 501 | 501 | unsupported (no local handler for the document) |

Inside the app the client reaches the post modal, likes/comments, creation
and the chat tabs through its own router (genuine checks). In-app navigation
to explore, reels, Direct inbox and notifications asks for a route
definition, which is answered "unavailable", so the client loads the URL as
a page: a 404 today.
