# Implementation status

Checkpoint for resuming work. Verify against `git log` and `npm test` before trusting it.
Manual testing instructions: docs/MANUAL-TESTING.md.

## Architecture

```
original client (page + code fetched from Instagram anonymously by the loader)
  -> src/shell      per-request edits to the page's bootstrap JSON: our password
                    encryption key, this browser's CSRF token, the clone viewer;
                    /__clone/runtime.js transport guard; signed-in templates;
                    module-scoped bundle patch registry (empty)
  -> src/clone      the client's own API paths answered in Instagram's shapes;
                    route definitions answered locally; telemetry sunk locally;
                    unimplemented clone paths return 501 and are listed on
                    /__clone/health; nothing clone-owned is forwarded upstream
  -> src/backend    services + SQLite (node:sqlite, WAL), migrations 0001, 0002
  -> .data/         database, media files, password-encryption keypair (0600)
```

Sessions: `sessionid` (HttpOnly), `csrftoken` (= session CSRF secret, echoed as
X-CSRFToken), `ds_user_id`, Path=/ on our origin. Browser cookies and X-CSRFToken
are never forwarded upstream. Identity-bearing pages (profile, post, reel, stories,
DM thread) fetch a canonical shell upstream so their identifiers stay here. There
is no Instagram session anywhere.

## Verified

Automated, `npm test`: see the count in the latest commit message / run; all pass.

- Database: clean install, idempotent migrations, persistence across restart,
  hashed passwords/tokens/codes, unique races mapped to 409, FK cascades.
- Signup: username + password only (email optional, no code), field validation,
  duplicate username/email (case-insensitive), concurrent and repeated
  submissions create one account, works in production with no email provider.
  The optional confirmation-code endpoints still answer for the original form.
- Login mutation: `useCDSWebLoginMutation` (the genuine login form's GraphQL call) is
  implemented in `src/clone/graphql.js` from the client's own module (read from a
  locally cached bundle): `input.identifier` + `enc_password.sensitive_string_value`
  in, `caa_login_web` out (same-site `redirect_uri` on success, in-band
  `error_message` otherwise). It shares `authenticateAndIssue` with the REST route.
  Automated tests only; NOT yet confirmed with the real form in a browser.
- Login/logout: username/email, uniform failure, enc_password v10, foreign key
  rejected with a reason, logout revokes in DB, expired/revoked sessions refused,
  password change revokes other sessions, re-login, restart keeps sessions.
- Isolation: per-user responses, CSRF bound to session, private accounts, DMs.
- Upstream: no clone username, shortcode, thread id, session, CSRF token or
  password reaches the stand-in origin across a browsing session.
- Feed: GraphQL and REST timeline equal an independent SQL query through follow,
  approve, unfollow, delete, likes and pagination.
- Shell: key/CSRF/viewer substitution, per-user output, HTML escaping, prefetch
  dropping, scrubbing incl. escaped and double-escaped Unicode, template serving.

Real browser, `npm run verify:browser-auth` (headless Chromium, CDP): 15/15, and
`npm run verify:browser-loading` reproduces the loading-screen hang when prefetch
dropping is forced on and confirms it is gone by default (a page that renders from
its seeded store clears the spinner). It
serves a SYNTHETIC page through the document path and runs signup (username and
password encrypted in the browser), session cookies, personalised reload, logout,
re-login. It does not involve the genuine Instagram client.

## Not verified

- The genuine Instagram client has not been run: this environment's network
  policy refuses every Instagram/Meta host. Response shapes come from Instagram's
  public v1 contract and earlier captures; the bootstrap keys the shell edits
  (encryption config, csrf_token, CurrentUserInitialData) are assumed, not seen.

## Known gaps

- Without a signed-in template, a logged-in clone user is served the logged-out
  page. Templates need a one-time save of a signed-in page (docs/MANUAL-TESTING.md).
- Route definitions are answered with empty entries; client navigation may then
  load route code differently than on instagram.com.
- A signed-in clone viewer without a template is served the anonymous page
  personalised with their id; it renders the logged-out view (does not hang).
- Realtime DM delivery (MQTT) is not reproduced; DMs work over REST.
- SIGNUP FORM (open): the genuine form's "Registration Error" is not yet reproduced
  and its "Mobile number or email" field / helper text are not yet removed. The
  signup route's bundles (submit thunk, form component) were never loaded in this
  environment, so neither the form's module names nor its request shape are known;
  guessing them is not acceptable. Known so far from `polarisNormalizeSignupResponse`:
  field errors come as `errors.<field>: [{message, code}]`, and an `emailOrPhone`
  form value switches the email/phone branches (absent value skips them).
  Needs one successful live load of `/accounts/emailsignup/` (the asset proxy now
  keeps public bundles on disk in `.cache/assets`, so one load is enough to inspect
  them offline), then a module-scoped patch in `src/shell/bundlePatches.js`.
- Instagram has been answering this environment's requests with HTTP 429 after
  repeated diagnostic runs; live checks are paused until it clears.

## Next tasks

1. With network access: open `/` through the loader, check `/__clone/health`
   `documents[0].encryption >= 1`, then sign up and log in through the real form.
2. Capture a signed-in template and work through the unsupported lists on
   `/__clone/health`.
3. Profile and post pages against the live client.
