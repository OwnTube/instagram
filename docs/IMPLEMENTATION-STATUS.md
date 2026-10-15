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

Automated, `npm test`: 180 tests, 180 pass, 0 fail, 0 skipped (clean `.scratch`).

- Database: clean install, idempotent migrations, persistence across restart,
  hashed passwords/tokens/codes, unique races mapped to 409, FK cascades.
- Signup: username + password only (email optional, no code), field validation,
  duplicate username/email (case-insensitive), concurrent and repeated
  submissions create one account, works in production with no email provider.
  The optional confirmation-code endpoints still answer for the original form.
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

Real browser, `npm run verify:browser-auth` (headless Chromium, CDP): 15/15. It
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
- Realtime DM delivery (MQTT) is not reproduced; DMs work over REST.
- The original signup form may still require its contact field or show a code
  step; removing those needs a client patch once the live form can be inspected.
- Commits are local only: pushing to vibecodeforever/instagram is refused (403).

## Next tasks

1. With network access: open `/` through the loader, check `/__clone/health`
   `documents[0].encryption >= 1`, then sign up and log in through the real form.
2. Capture a signed-in template and work through the unsupported lists on
   `/__clone/health`.
3. Profile and post pages against the live client.
