# Implementation status

Checkpoint for resuming work. Verify against `git log` and `npm test` before trusting it.
Manual testing instructions: docs/MANUAL-TESTING.md.

## Architecture

```
original client (page + code fetched from Instagram anonymously by the loader)
  -> src/shell      per-request edits to the page's bootstrap JSON: our password
                    encryption key, this browser's CSRF token, the clone viewer;
                    /__clone/runtime.js transport guard; signed-in templates;
                    module-scoped bundle patches (applied when an asset is sent)
  -> src/clone      the client's own API paths answered in Instagram's shapes;
                    route definitions answered locally; telemetry sunk locally;
                    unimplemented clone paths return 501 and are listed on
                    /__clone/health; nothing clone-owned is forwarded upstream
  -> src/backend    services + SQLite (node:sqlite, WAL), migrations 0001, 0002
  -> .data/         database, media files, password-encryption keypair (0600)
  -> .cache/        disk copies of PUBLIC assets and ANONYMOUS documents
                    (LOADER_PREFER_CACHE=1 serves them without contacting Instagram)
```

Sessions: `sessionid` (HttpOnly), `csrftoken` (= session CSRF secret, echoed as
X-CSRFToken), `ds_user_id`, Path=/ on our origin. Browser cookies and X-CSRFToken
are never forwarded upstream. Identity-bearing pages (profile, post, reel, stories,
DM thread) fetch a canonical shell upstream so their identifiers stay here. There
is no Instagram session anywhere.

## Verified

Automated, `npm test`: all pass (233 at the time of writing).

- Database: clean install, idempotent migrations, persistence across restart,
  hashed passwords/tokens/codes, unique races mapped to 409, FK cascades.
- Genuine sign-up form (`/accounts/emailsignup/`, CAARegistrationFormDesktop).
  Root cause of "Registration Error": the form submits GraphQL
  `useCAARegistrationFormSubmitMutation` (and validates with
  `useCAARegistrationFieldValidationQuery`, username typeahead query); none was
  implemented, so every submit got a 501. Now answered in
  `src/clone/caaRegistration.js` from contracts read in the client's own modules.
  Accounts need username + password + birthday (13+); an email contact point is
  optional, a phone number is refused. Shares `createAccount` with the REST route;
  failures write nothing and issue no session.
  Two follow-up defects found in the real browser and fixed: a successful field
  validation must name the checked field (else the form loops on the password
  check until rate-limited), and the form encrypts as `#PWD_BROWSER:10:...`.
  The "Mobile number or email" field and "You may receive notifications from us."
  are removed by module-scoped patches (src/shell/bundlePatches.js); the form then
  no longer requires a contact point and, after success, follows the server's
  same-site redirect instead of the confirmation-code page.
- Login mutation: `useCDSWebLoginMutation` in `src/clone/graphql.js` from the
  client's own module: `input.identifier` + `enc_password.sensitive_string_value`
  in, `caa_login_web` out (same-site `redirect_uri`, in-band `error_message`);
  shares `authenticateAndIssue` with the REST route; rate limited; CSRF enforced;
  a new login revokes the browser's earlier session. Verified in the real
  browser (below).
- Login/logout (REST): username/email, uniform failure, enc_password v10, foreign
  key rejected with a reason, logout revokes in DB, expired/revoked sessions
  refused, password change revokes other sessions, restart keeps sessions.
- Isolation: per-user responses, CSRF bound to session, private accounts, DMs.
- Upstream: no clone username, shortcode, thread id, session, CSRF token or
  password reaches the stand-in origin across a browsing session.
- Feed: GraphQL and REST timeline equal an independent SQL query through follow,
  approve, unfollow, delete, likes and pagination.
- Shell: key/CSRF/viewer substitution, per-user output, HTML escaping, prefetch
  dropping, scrubbing incl. escaped and double-escaped Unicode, template serving.
- Caches: public assets and anonymous documents persist to `.cache/`; a restart
  with the origin answering 429 still serves the page.

Real browser, GENUINE Instagram client, `LOADER_PREFER_CACHE=1 npm run
verify:genuine-signup` (headless Chromium; page and bundles from the disk cache,
no request to www.instagram.com): 10/10. Form renders without the contact field
and its helper text; a synthetic account is created (one row, no email), the
browser is signed in as that user and redirected to `/`; a duplicate username is
refused under the field with no row and no session; a short password is refused.

Real browser, GENUINE client, `LOADER_PREFER_CACHE=1 npm run verify:genuine-login`:
7/7. On the logged-out home page (`/`, which carries the genuine login form): a
wrong password typed into the form is refused with no session; the right one
sends useCDSWebLoginMutation and signs the browser in as the account created
with the sign-up mutation (current_user and ds_user_id name it).

Real browser, SYNTHETIC page: `npm run verify:browser-auth` 15/15 and
`npm run verify:browser-loading` (session mechanics and the loading-screen fix).

## Not verified

- The `/accounts/login/` page itself (live loads got HTTP 429; not cached). The
  same form and mutation were verified on `/`.
- After sign-up the redirect lands on `/`, which renders the logged-out page:
  without a signed-in template the genuine client shows anonymous views even
  though the session is valid (current_user answers the new user).
- Stories tray, suggested users, notifications, DM badges and quick promotions on
  the signed-in home: their operations still get 501 (listed below).

## Known gaps

- Without a signed-in template, a logged-in clone user is served the logged-out
  page. Templates need a one-time save of a signed-in page (docs/MANUAL-TESTING.md).
- Route definitions are answered with empty entries; client navigation may then
  load route code differently than on instagram.com.
- Some bundles are loaded by the client straight from static.cdninstagram.com
  (not through /__ig), so patches and the disk cache do not cover them. None of
  the patched modules is among them today.
- Realtime DM delivery (MQTT) is not reproduced; DMs work over REST.
- Instagram throttles this environment (HTTP 429) after a few page loads. Live
  checks: one deliberate request at a milestone; on 429, continue offline.

## Running independently of Instagram

Strict offline mode: `LOADER_OFFLINE=1 LOADER_PREFER_CACHE=1 npm start`. The loader
then never contacts any origin, and every document carries a Content-Security-Policy
allowing only this origin (plus data:/blob:), so the browser itself refuses any
request that would leave it.

- Local store: `.cache/documents` (anonymous pages, raw upstream bytes, keyed by
  upstream origin + path), `.cache/assets` (public CDN scripts, styles, fonts,
  images), `.cache/bootloader` (bootloader-endpoint answers). CSS rewriting and
  bundle patches apply when an asset is sent, so stored bytes stay pristine.
- Manifest: `npm run cache:status` writes `.cache/manifest.json` (every asset the
  cached pages reference: script/link tags, every `rsrcMap` entry the Bootloader
  may load, sprites, url()s inside stored stylesheets; stored or missing, size,
  sha256). `npm run cache:warm` fetches the missing public assets once (static CDN
  only, honouring the 429 cooldown). Current: 644 referenced, 644 stored.
- Runtime (`/__clone/runtime.js`): absolute static-CDN URLs set as script/link/img
  src/href/srcset, inline background styles, fetch and XHR go through `/__ig`.
- Fixed on the way: root-relative url()s in proxied CSS (fonts) resolved against
  the stylesheet's own URL; `mapUrl` no longer turns relative non-URL text into a
  path (it corrupted an inline style); `/data/manifest.json` is served locally; a
  429 is not retried and starts a per-host cooldown.
- Cache poisoning fixed: document keys did not include the upstream origin, so the
  synthetic browser check overwrote Instagram's cached `/` with its stand-in page.
  Keys now include the origin and the synthetic checks use their own cache dirs.

Verified, real browser, genuine client, `LOADER_OFFLINE=1 LOADER_PREFER_CACHE=1`:
`npm run verify:genuine-signup` 11/11 and `npm run verify:genuine-login` 8/8 (on
2026-10-16 the login check gives 7/8: everything passes except "no uncaught page
errors", React #418, see below), each
asserting that no request was sent to any external host (requests are observed,
not intercepted). One URL is refused by the CSP and so never sent: the logo sprite
`Ny6hrBVLYjl.webp`, which the client paints from a CSS rule it inserts at runtime
(the logo is missing offline).

Boot stall: SOLVED. Root cause (docs/REVERSE-ENGINEERING.md section 6): the
payload listener skips a JSON block whose length differs from its
`data-content-len`. Each data directory gets a random password-key id (1-255);
when its digit count differed from Instagram's ("219"), the swapped encryption
block changed length and was skipped. Pinned key ids proved it (old editor:
key_id 42 and 7 stall, 219 mounts; fixed editor: all mount). The earlier
`getComputedStyle` explanation was wrong (those runs shared one server/key).
With the fix, the logo sprite is also served locally (the `ixData` URL edit no
longer breaks boot), so nothing is refused by the CSP any more.

Open: React error #418 (hydration mismatch, recoverable). Not reproduced on
direct loads (0/4 signed-in and anonymous loads on 2026-10-16, also 0 with the
debugger pausing on exceptions); seen in flows that sign in through the in-page
form and then land on `/` (2026-10-16, strict offline: genuine-login check 3 of
3 runs, one of them with `CLONE_CONTRACTS=0`, so not caused by answer
completion; feed check every run, 4 of 4). Those flows also log `Route definition unavailable` (error 1357004) from
the client router, whose route-definition requests are answered with empty
entries (see Known gaps). Lead, not yet proven: the post-login soft navigation.

## Signed-in home and feed (genuine client)

How the signed-in route is built from the anonymous `/` document plus Instagram's
own public bootloader answer for `PolarisFeedRoot.react`: docs/REVERSE-ENGINEERING.md
sections 2-7 (`src/shell/signedInRoute.js`, `SHELL_SIGNED_IN_HOME=1`, off by
default). The earlier conclusion that anonymous material could not provide the
feed root was wrong: the bootloader endpoint, asked anonymously, returns it.

Feed answers (`src/clone/graphql.js`, `src/runtime/graphqlContract.js`):
`PolarisFeedTimelineRootV2Query` is resolved from the database, then completed
to the selection set of the client's own compiled operation
(`PolarisFeedTimelineRootV2Query.graphql` in the stored bundles): a selected
field the resolver does not produce becomes an explicit null, so Relay does not
treat the record as missing. Relay-internal fields (`__id`), client-schema
fields (`ClientExtension`) and client resolver fields are never written.

Root cause of the empty feed (B's post in the answer, glimmer on screen): the
feed list is the client resolver `client__feedDedupedIds`
(`polarisFeedDedupeIdsResolver`), whose fragment reads `media.view_state_item_type`
and `media.brs_severity`. Those server fields appear only in the
`RelayResolver.fragment` of the normalisation AST, which the contract reader did
not visit, so they were absent; Relay's `readFragment` then throws its
missing-data sentinel, the resolver yields nothing, `PolarisVirtualFeed` sees 0
items and switches to the empty-feed suggested-users view (seen in the store:
`__resolverSnapshot.isMissingData: true`). Fixed by reading resolver fragments
(docs/REVERSE-ENGINEERING.md section 8; test/graphql-contract.test.js).

Verified, real browser, genuine client, strict offline
(`npm run verify:genuine-feed`, which sets `LOADER_OFFLINE=1
LOADER_PREFER_CACHE=1 SHELL_SIGNED_IN_HOME=1`): 11/11.
Local accounts A and B; A follows B (row in `follows`); B uploads a generated
1080x1080 PNG and publishes it (rows in `media` and `posts`); A signs in through
the genuine login form (useCDSWebLoginMutation); `/` mounts the genuine feed
root, the client asks PolarisFeedTimelineRootV2Query, the answer carries B's
post from the database, and the post renders: author, relative time, caption,
and the photo loaded from `/__media` (naturalWidth 1080). No browser request to
an external host; no outbound connection from the loader process (global fetch
and http/https instrumented); `/__loader/health` reports offline and cache-only.
Screenshots: `test-artifacts/screenshots/feed-0*.png` (not committed).

Still reported by that run (not failures of the scenario):
- 501, no local answer yet: PolarisStoriesV3TrayContainerQuery,
  PolarisSuggestedUserListQuery, usePolarisNotificationsNavItemQuery,
  IGDBadgeCountOffMsysQuery, IGDChatTabsJewelOffMsysQuery,
  IGDOmniPickerNullStateListQuery, QuickPromotionSupportIGSchemaBatchFetchQuery
  (stories tray and suggestions stay as glimmers);
- 504 from the offline guard: `/ajax/bootloader-endpoint/` for
  `PolarisImmersiveFeedPostModal.react` and `IGDChatTabsRootContentOffMsys.react`
  (not yet stored; one anonymous endpoint request each when not throttled),
  `www-service-worker.js`, the launcher icon;
- the logged-out top bar ("Log In", "Sign Up") stays above the signed-in shell;
  not yet explained;
- React #418 (above).

## Next tasks

1. Answer the remaining signed-in home operations (stories tray, suggested
   users, notifications, badges) from the database, completed to their
   compiled contracts like the feed.
2. Store the two missing bootloader-endpoint answers; explain the logged-out top
   bar; diagnose React #418 in the post-login flow.
3. Make `SHELL_SIGNED_IN_HOME` the default once the above hold.
