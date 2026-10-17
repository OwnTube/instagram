# Implementation status

Checkpoint for resuming work. Verify against `git log` and `npm test` before trusting it.
Manual testing instructions: docs/MANUAL-TESTING.md.

## Architecture

```
original client (ONE pinned, validated snapshot of Instagram's anonymous page,
                 code and bootloader answers; never fetched at runtime;
                 docs/CLIENT-PINNING.md)
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
  -> .cache/client  the snapshot store (blobs by sha256, manifests, state);
                    .cache/{documents,bootloader,assets,acquired} are operator
                    acquisition material the snapshot is built from
```

Sessions: `sessionid` (HttpOnly), `csrftoken` (= session CSRF secret, echoed as
X-CSRFToken), `ds_user_id`, Path=/ on our origin. Browser cookies and X-CSRFToken
are never forwarded upstream. Identity-bearing pages (profile, post, reel, stories,
DM thread) are served from a canonical snapshot document. There is no
Instagram session anywhere, and the server makes no upstream request at all.

## Verified

Automated, `npm test`: all pass (247 on 2026-10-16, with the P4 fixes).

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

## Known gaps

- Without a signed-in template, a logged-in clone user is served the logged-out
  page. Templates need a one-time save of a signed-in page (docs/MANUAL-TESTING.md).
- Route definitions are answered as unavailable for every URL (error 1357004,
  in the contract the client expects); the router then loads such URLs as
  pages instead of soft-navigating. Real definitions name per-route bundles we
  cannot build without inventing them.
- The client's Facebook cross-site probes cannot succeed here (Meta hosts are
  dropped): `ig_xsite_user_info` is no longer named by the page (see checklist);
  `ig_xsite_user_obid` is hardcoded in `PolarisLoggedInFBUserOBIDProvider` and
  logs a caught warning. The DGW realtime client logs
  `unsupported_environment_retry_with_mqtt` (no realtime gateway here).
- Some bundles are loaded by the client straight from static.cdninstagram.com
  (not through /__ig), so patches and the disk cache do not cover them. None of
  the patched modules is among them today.
- Realtime DM delivery (MQTT) is not reproduced; DMs work over REST.
- Instagram throttles this environment (HTTP 429) after a few page loads. Live
  checks: one deliberate request at a milestone; on 429, continue offline.

## Running independently of Instagram

Since 2026-10-17 this is the only mode: `npm start` serves the active pinned
snapshot (docs/CLIENT-PINNING.md). The historical notes below describe the
earlier `LOADER_OFFLINE=1 LOADER_PREFER_CACHE=1` mode, which is removed. The
loader never contacts any origin, and every document carries a Content-Security-Policy
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

React error #418 and "Route definition unavailable": SOLVED (checklist P4).

## Signed-in home and feed (genuine client)

How the signed-in route is built from the anonymous `/` document plus Instagram's
own public bootloader answer for `PolarisFeedRoot.react`: docs/REVERSE-ENGINEERING.md
sections 2-7 (`src/shell/signedInRoute.js`). On by default for a signed-in
viewer since P0 below; `SHELL_SIGNED_IN_HOME=0` opts out. The earlier conclusion that anonymous material could not provide the
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
LOADER_PREFER_CACHE=1 SHELL_SIGNED_IN_HOME=1`): 17/17 (2026-10-16, three consecutive runs).
Local accounts A and B; A follows B (row in `follows`); B uploads a generated
1080x1080 PNG and publishes it (rows in `media` and `posts`); A signs in through
the genuine login form (useCDSWebLoginMutation); `/` mounts the genuine feed
root, the client asks PolarisFeedTimelineRootV2Query, the answer carries B's
post from the database, and the post renders: author, relative time, caption,
and the photo loaded from `/__media` (naturalWidth 1080). No browser request to
an external host; no outbound connection from the loader process (global fetch
and http/https instrumented); `/__loader/health` reports offline and cache-only.
Screenshots: `test-artifacts/screenshots/feed-0*.png` (not committed).

The run also checks the home components against database content (account C,
B's story, a follow notification, a DM for A): the stories tray shows B, the
suggestions rail shows C with "Followed by <B>", every home operation is
answered 200, and after a reload A is still signed in with no logged-out
controls.

## Status checklist

Each item: status, root cause, change, tests, screenshot (in
`test-artifacts/screenshots/`, not committed), remaining work. Re-verify with
`npm test` and the `verify:genuine-*` scripts (strict offline) before trusting.

### P1 Signed-in header showed "Log In" / "Sign Up": DONE (a047fb4)
- Cause: the feed root's anonymous answer binds `cr:2696` (PolarisDesktopNav)
  and `cr:4477` (logged-out container); the server binds these per viewer.
- Change: `src/shell/signedInRoute.js` unbinds them for a signed-in viewer
  (the answer's own unbound form); REVERSE-ENGINEERING.md section 9.
- Tests: test/shell.test.js; feed check "no logged-out controls" after reload.
- Screenshot: m05 (sent), feed-05-signed-in-header-after-reload.png.

### P2 Home operations returning 501: DONE (540890b, extended in 915f560)
- Cause: no resolvers. Now `src/clone/homeOperations.js`, from the database,
  in each operation's compiled shape (REVERSE-ENGINEERING.md section 10):
  stories tray, suggestions (and its refetch), notifications badge, Direct
  badge/jewel/chat-tab content (threads with newest messages), Direct picker,
  stories ads pools (empty: no ads locally), quick promotions (none),
  presence (on), viewer settings (reduce motion off).
- Tests: test/home-operations.test.js (11). Screenshot: m06, m07 (sent).

### P3 Lazy modules, service worker, launcher icon: DONE (915f560)
- Cause: the stored page (rev 1050596935) and feed-root answer (rev
  1050606970) were of different revisions, and the chat-tab/post-modal answers
  were never stored. `scripts/refresh-client.js` moved documents and answers
  to one revision (1050627067, backup in `.cache/backup-1050596935/`); lazy
  answers stored by one anonymous request each: PolarisImmersiveFeedPostModal,
  IGDChatTabsRootContentOffMsys (nb), IGDChatTabsContentOffMsys,
  IGDChatTabsThreadListContentOffMsys, PolarisFeedEmptySULWrapper,
  VultureJSSampleRatesLoader; `npm run cache:warm` stored their CDN files
  (6887 of 6888; the one missing is a bogus `#clip0_` URL).
- Launcher icon: the proxy now stores public origin images.
- Service worker: `/www-service-worker.js` is an explicit 404 (push
  notifications would need Meta's push service; not served, by decision).
- Screenshot: m07-lazy-chat-tabs-module-loaded-offline.png (sent).

### P4 React #418 and "Route definition unavailable": DONE
- #418 cause: the anonymous `/` document carries a Comet SSR render of the
  logged-out page (`CometSSRClientInjector.ssrInit {enabled:true}` +
  onPayloadReceived passes); CometSSRStateManager hydrates it with whatever
  root initializes, i.e. the feed root, so hydration mismatched. Fix: the
  signed-in route's document says SSR is disabled (`enabled:false`), the
  client's own "disabled from server" path (client render via createRoot).
  Found by reading the modules; confirmed with REA (section 11).
- Route error cause: our bulk-route-definitions answer lacked `sr_payload`,
  which `fetchAnonymousCometRoute` requires; now `{payloads, sr_payload:{}}`.
- Facebook cross-site probe (`ig_xsite_user_info`): the page no longer names
  it (`PolarisSiteData.cross_site_request_url = null`, a state the provider
  handles by skipping the probe).
- Tests: test/shell.test.js (2 new), test/upstream-leak.test.js.
  Feed check 3 consecutive runs 17/17 with no #418 and no route error;
  signup 11/11, login 8/8 (no uncaught errors).
- Screenshots: m08-p4-no-hydration-or-route-errors-after-3-runs.png,
  m09-rea-comet-ssr-call-sites.png (sent).

### P5 Layout at 1280x900: DONE (one fix, two findings)
- Broken empty-feed illustration: FIXED. It is a plain `ixData` image
  (`{sprited:0, uri}`) in the stored PolarisFeedEmptySULWrapper answer; the
  asset manifest only collected sprited images (`spi`), so it was never
  stored and the offline guard refused it. `scripts/asset-cache.js` now
  collects both; `cache:warm` stored 51 such images (6938 of 6939 assets).
  Test: test/asset-cache.test.js. Screenshot: m10 (sent).
- Collapsed icon rail: GENUINE, not a defect. `PolarisNavigationSimple.react`
  hides labels unless the rail is hovered or keyboard-focused
  (`Ce=T!==null||!E&&!(j&&X)&&!(k&&Z)&&!fe`), widths 50/72, overlaying the
  page. Verified: hovering expands it to labelled items (m11, sent).
- Footer under the rail on the empty feed: the client's own layout. Every
  atomic class used on the page (305) has a rule in the loaded stylesheets, so
  no CSS is missing; the rail overlays a full-width page by design. Not
  compared with a signed-in instagram.com page (no account may be used).

### P6 Core features
- Signup, login, session, logout: verified (genuine forms; logout REST).
- Feed and pagination: feed verified; pagination verified at API level only.
- Stories tray, suggestions, Direct chat tabs: verified rendering (above).
- Profiles and follow/unfollow: DONE. `npm run verify:genuine-profile` 9/9,
  strict offline: `/<username>/` is served as the genuine signed-in profile
  route (`profileRoute` in src/shell/signedInRoute.js); header counts and the
  Following button come from the database; the grid photo is served from
  /__media; unfollow through the genuine Following menu and follow through the
  genuine Follow button are each checked in the `follows` table; the own
  profile shows Edit profile. Screenshots: m12-profile-01/03/05. Answers added:
  PolarisSchoolPartnerProfileBadgeQuery, usePolarisFollowMutation,
  usePolarisUnfollowMutation, viewer fields in the profile queries,
  /api/v1/archive/reel/day_shells/. Tests: test/profile-operations.test.js.
  Observed, not fixed: the follower count in the header does not change after
  unfollow until reload (the mutation contract returns friendship_status only).
  Note: the profile entry point and three other answers were acquired at
  revision 1050642531, the rest of the store is 1050627067 (no refresh seen;
  a full refresh is pending while Instagram throttles document fetches).
- Post creation: DONE. `npm run verify:genuine-create` 9/9, strict offline:
  New post > Post opens the genuine creation dialog (module answer
  PolarisCreationModal.next.react acquired once, anonymously); a real PNG goes
  into the dialog's own file input; Crop, Edit (WebGL filters, the 12 public
  filter thumbnails under /images/instagram/xig/filters/ cached once) and the
  caption step are the genuine ones; Share uploads (rupload) and configures the
  post, checked in the database (caption, stored media); the post appears in
  the owner's grid from /__media. Screenshots: m13-create-02..05. Fixes:
  - the test browser had no WebGL (`--disable-gpu`); PolarisFilterGLContext
    throws without a context and the step's error boundary showed "Something
    went wrong". Now SwiftShader (`--use-angle=swiftshader`), as a desktop
    browser has WebGL;
  - the genuine uploader sends no CSRF token, only the session cookie and the
    custom X-Instagram-Rupload-Params header; rupload requests carrying that
    header are exempt from the token (a custom header cannot be sent
    cross-site without a CORS preflight, which this origin never grants);
  - answered fetchThreadsCrosspostingMetadataQuery (no linked profile),
    fetchFBCrosspostingMetadataQuery (no service result; the client rejects by
    design and reports it through promiseDone) and
    usePolarisCoppaEnforcementStatusViewerQuery (`is_coppa_enforced:false`).
  Tests: test/create-operations.test.js.
- genuine-login-check and genuine-signup-check now default to LOADER_OFFLINE=1
  and LOADER_PREFER_CACHE=1 like the others. Without them `npm run` fetched `/`
  from Instagram, which failed here ("Upstream fetch failed"; 4/8). That was
  also the likely cause of the earlier one-off login 401 in the feed check.
- Likes and comments: DONE. `npm run verify:genuine-engage` 8/8, strict
  offline: the feed's genuine Like button (usePolarisLikeMediaXIGLikeMutation)
  stores the like; the genuine Comment button opens the post view at
  /p/<code>/, whose comment field (usePolarisCommentCreateMutation) stores the
  comment; the post view's Unlike (PolarisAPIUnlikePostMutation) removes the
  like; after a fresh load of home the reopened post reads the comment back
  from the database. Each step is checked in the `likes`/`comments` tables.
  Screenshots: m14-engage-01..04. Answered from the bundles' selections:
  `xig_media_like`/`xig_media_unlike` {media {id, has_liked}} for the four like
  mutations (input {media_id}); `xig_comment_create` (success response with
  `comment_dict`; `fbid_v2` null, local accounts have no Facebook id). Tests:
  test/engage-operations.test.js.
  Known gap: loading /p/<code>/ directly (not through the app) serves the
  logged-out page. There is no signed-in post route yet, because the post
  route's entry point and props need a real post document, which is not
  cached (Instagram throttled document fetches).
- Search, notifications page, stories viewer, Direct thread view: NOT yet
  verified in the browser (APIs exist and are tested at API level).

### P0 Login flash, sign-up back to login, homepage flash, revisions: DONE (verified offline)

Reproduced in a real browser first (`.scratch/repro/signup-flow.js`,
`.scratch/repro/home-load.js`; screenshots `test-artifacts/screenshots/repro-*`).

- Sign-up landed on the login page. Root cause: the signed-in route was behind
  `SHELL_SIGNED_IN_HOME=1`, off by default, so after the genuine form signed the
  browser in (current_user 200) the redirect to `/` served the anonymous
  document. Fix: the route is the default for a signed-in viewer
  (`src/server.js` sendHtml); `SHELL_SIGNED_IN_HOME=0` opts out.
- Login page visible for seconds before the feed (the "auth flash"). Root
  cause: the anonymous `/` document carries the server-rendered login page in
  the SSR mount (`<div id="mount_0_0_*" style="content-visibility:hidden">`).
  With SSR disabled, `CometSSRClientInjector.ssrInit` takes the
  "SSR is disabled from server" path, which calls
  `CometSSRContentRevealer.unhideElement`: it removes the splash screen and
  reveals the mount at once, so the login markup showed until the client's
  first commit (1.2 s to 5.8 s in the repro). Fix: the signed-in route keeps
  the mount element and drops only its children (`emptySSRMount`,
  `src/shell/signedInRoute.js`). After: no login text or password field at any
  sample of the timeline.
- Homepage "renders then changes": no reload or navigation remains on `/`
  (one main-frame navigation in the timeline). Remaining, genuine client
  behaviour: a blank white page between the splash removal (about 0.8 s) and
  the first commit (2.4 s to 4.4 s across runs), because the client removes
  the splash on its SSR-disabled path. Not patched.
- Revision-aware answers: the route's code is a stored bootloader answer of the
  page's revision. A new upstream revision without a stored answer used to
  fall back silently to the anonymous page (the sign-up bug again). Now
  (`routeWithAnswers`, `src/server.js`): fetch the answer for that revision
  once (anonymous, skipped offline and during a cooldown); else serve the last
  document this route was served from consistently; else the anonymous page,
  reported. Answers of another revision are never mixed in. State in
  `/__loader/health` -> `revisions`.

Tests: test/signed-in-route.test.js (default route, no login markup, anonymous
page unchanged, self-healing by fetch and by the last consistent document,
opt-out); test/shell.test.js (`emptySSRMount`); `npm run verify:genuine-signup`
now asserts the signed-in app is shown after sign-up (12/12).

Route audit (`node scripts/route-audit.js`, offline): see the table in
docs/REVERSE-ENGINEERING.md section 13.

## Next tasks

1. P6 in order: search, notifications, stories viewer, Direct threads; each with a
   DB check and a screenshot.
2. Signed-in post, stories and Direct inbox routes on a direct load: each needs
   its route's entry point, props and bootloader answer from a real document
   or answer, not stored yet (document fetches were throttled; offline those
   routes answer 504 rather than a stand-in).
