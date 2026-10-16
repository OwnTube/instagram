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

Automated, `npm test`: 223 tests, 223 pass (at commit eb51d0a and later).

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
  a new login revokes the browser's earlier session. Automated tests only.
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

Real browser, SYNTHETIC page: `npm run verify:browser-auth` 15/15 and
`npm run verify:browser-loading` (session mechanics and the loading-screen fix).

## Not verified

- The genuine LOGIN form in a browser: every attempt to load `/accounts/login/`
  live got Instagram's HTTP 429, and that document is not cached yet. The mutation
  contract is from the client's code and covered by automated tests only.
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

## Next tasks

1. When `/accounts/login/` loads live once (it is then cached on disk): verify the
   genuine login form with an account created through the genuine sign-up form.
2. Signed-in initialisation: the genuine client must identify the local user
   after login without editing tamper-checked bootstrap values. Investigate how
   the client derives the viewer (current_user / CurrentUserInitialData) and
   whether a signed-in document can be produced without an Instagram session.
3. Home feed against the local database in the genuine client; work through the
   unsupported lists on `/__clone/health`.
