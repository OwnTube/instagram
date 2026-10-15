# Implementation status

Checkpoint for resuming work. Verify against `git log` and `npm test` before trusting it.

## Architecture

```
original client (served by the loader from Instagram's CDN, anonymously)
  -> src/shell      per-request edits to the page's bootstrap JSON: our password
                    encryption key, this browser's CSRF token, the clone viewer;
                    /__clone/runtime.js transport guard; optional signed-in
                    templates; module-scoped bundle patch registry (empty)
  -> src/clone      the client's own API paths (/api/v1/*, /graphql/query,
                    /api/graphql, /rupload_igphoto/*, account forms) answered in
                    Instagram's response shapes; telemetry sunk locally;
                    unimplemented clone paths return 501 and are listed on
                    /__clone/health; nothing clone-owned is forwarded upstream
  -> src/backend    services + SQLite (node:sqlite), migrations 0001, 0002
  -> .data/         database, media files, password-encryption keypair (0600)
```

Sessions: `sessionid` (HttpOnly), `csrftoken` (= session CSRF secret, echoed by the
client as X-CSRFToken), `ds_user_id`, all Path=/ on our origin. Browser cookies and
X-CSRFToken are never forwarded upstream. There is no Instagram session anywhere.

## Verified by automated tests (124 passing)

- Signup through the original form endpoints, with email codes and enc_password v10.
- Login/logout, uniform failure answer, CSRF bound to the session.
- Upload (rupload + configure), stored media, media serving follows visibility.
- GraphQL feed (`PolarisFeedTimelineRootV2Query`) per viewer, with pagination.
- Likes, comments, saves, follows/requests, private accounts, profiles and edits.
- Direct threads (send, idempotent retry, seen, membership), stories (tray, seen, viewers).
- Search, activity inbox, unknown-operation reporting.
- No clone request, cookie or telemetry reaches the upstream stand-in.

## Not verified

- **Nothing has run against the genuine Instagram client in this session.** The
  container's network policy refuses every Instagram/Meta host, so no page or bundle
  could be fetched. Response shapes come from Instagram's public v1 contract and the
  earlier captures in docs/; they may need adjustment once the live client runs.
- `src/shell` (personalize, templates/scrubber, runtime, bundlePatches) has no
  dedicated tests yet; it is exercised only indirectly by the document path.
- No browser test has been run.

## Known gaps

- Signed-in shell needs an operator-captured template (`scripts/snapshot-shell.js`);
  without one, a signed-in clone user still receives the logged-out page.
- `/ajax/bulk-route-definitions/` is still forwarded upstream; its body can contain
  clone usernames in route URLs.
- Realtime DM delivery (MQTT) is not reproduced; DMs work over REST polling only.
- Mailer has only a development `log` transport.

## Next tasks

1. Add tests for src/shell.
2. With network access to Instagram: load `/` through the loader in Chromium, confirm
   the encryption/CSRF substitutions take effect, and drive the real login form.
3. Capture a signed-in template, then iterate on `/__clone/health` unsupported lists.
4. Answer bulk-route-definitions locally.
