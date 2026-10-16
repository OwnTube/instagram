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

Automated, `npm test`: all pass (229 at the time of writing).

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
- The home feed in the genuine client (needs a signed-in client first).

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
`npm run verify:genuine-signup` 11/11 and `npm run verify:genuine-login` 8/8, each
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

Open: React error #418 (hydration mismatch, recoverable) appears in about half
of the login-page loads, with or without the sprite edit. Not yet diagnosed.

## Signed-in initialisation (research, in progress)

Established from the cached `/` document and bundles (offline):

- The route is chosen by the server, not derived from the user id:
  `CometPlatformRootClient.initialize` carries `initialRouteInfo.route` (root
  view `CAAIGLoginHomepageRoot`, entry point, `actorID:"0"`) and
  `expectedPreloaders` for actor "0". Editing only `CurrentUserInitialData.USER_ID`
  leaves the client waiting on preloaders for another actor; that, not a tamper
  check, is the likely reason the earlier identity edit never mounted.
- The signed-in home is `PolarisFeedRoot.entrypoint` (in the cached bundles; its
  preload props name PolarisFeedTimelineRootV2Query, the stories tray and
  suggested users). `src/shell/signedInRoute.js` switches the whole route to it
  for a signed-in viewer (SHELL_SIGNED_IN_HOME=1, experimental, OFF by default).
- With the switch on, the mount stays hidden, with no exception (caught or
  uncaught, checked with the debugger pausing on all exceptions) and no request.
  The Bootloader contract, read from the cached `Bootloader` module, explains it:
  `loadModules(ms)` proceeds only when `j(ms)` holds: every component is in the
  component map `T` (filled from `compMap` payloads via `enableBootload`) and
  every hash in its `r` / `rdfds.r` / `rds.r` is in the resource map `D` (from
  `rsrcMap`). Otherwise the call is queued (`v`) and retried only when a later
  payload adds component-map entries. An unknown component therefore waits
  forever, silently. The bootloader endpoint is used only for components that
  ARE in `compMap` with the `be` flag; it does not resolve unknown components.
- `PolarisFeedRoot.react` is absent because the anonymous login page's payloads
  carry only what the login route needs. The entries for the feed root (and its
  dependency closure, with Instagram's resource hashes) are only in Instagram's
  signed-in documents / route definitions. Fabricating them is not acceptable.
- Not fully explained: in the switched run, an in-page `requireLazy(['Bootloader'])`
  probe also never fired, while it fires on the unswitched page.
- Conclusion: a genuine signed-in feed root cannot be produced from anonymous
  material alone. Options needing a decision: (a) a scrubbed signed-in page saved
  once by an operator (the existing template mechanism, docs/MANUAL-TESTING.md);
  (b) a dedicated synthetic Instagram account used only to capture public code
  maps, never as clone auth. Neither is done here without the owner's decision.

## Next tasks

1. Signed-in initialisation: see the research section above.
2. Home feed against the local database in the genuine client; work through the
   unsupported lists on `/__clone/health`.
