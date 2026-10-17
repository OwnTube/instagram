# Manual testing

## Start

```sh
npm ci
npm start            # http://localhost:12000/   (PORT=... to change)
```

The machine running the server must reach `www.instagram.com` and
`static.cdninstagram.com`: the original client's page and code are fetched from
there anonymously. Nothing else about Instagram is used. There is no Instagram
account, cookie or session anywhere in the server.

## Data

- SQLite at `.data/backend.db` (`BACKEND_DB` to move it). Migrations run on every
  start and only apply what is missing; data survives restarts.
- Uploaded media in `.data/media/`, the password-encryption keypair in
  `.data/keys/` (mode 0600). Keep the key: if it changes, open pages must be
  reloaded before login works.
- Reset everything by stopping the server and deleting `.data/`.

## Signup

An account needs only a **username and a password**. No email and no
verification code are required; the account is created and signed in at once.
An email is optional: if one is given it must be valid and not already used,
and it can then be used to log in.

Passwords must be at least 10 characters with a letter and a number. This is
stricter than the form's own check, so a shorter password passes the form and
is then rejected with our message.

Instagram's own signup form may still insist on its "mobile number or email"
field or show a confirmation-code screen; that is the form's behaviour, not a
server requirement. If it shows a code screen, the code is at
**http://localhost:12000/__clone/dev/outbox** (same machine, development only).

## Why the page should no longer hang on the loading screen

The server serves Instagram's anonymous page as-is, keeping the page's own
prefetched (anonymous) data that it renders from, and only swaps in our
encryption key, CSRF token and the viewer. It does NOT strip that data, which
earlier left the client waiting on a query we cannot answer. If a page still
hangs, check `http://localhost:12000/__clone/health` (same machine) for GraphQL
operations or REST paths the client called that are unimplemented: those return
`501` immediately rather than hanging, and are listed there as the work queue.

## What to expect after logging in

A signed-in clone user gets the client's own signed-in route, built from the
pinned snapshot's anonymous document plus Instagram's own bootloader answer
for that route's root (`src/shell/signedInRoute.js`). The home feed needs
`PolarisFeedRoot.react`; a profile needs `PolarisProfilePostsTabRoot.entrypoint`
and `PolarisProfileRoot.react` of the snapshot's revision. A route whose
answers the active snapshot does not hold is served as the anonymous page and
listed at `/__loader/health` -> `client.missingRequests` (kind `route`); it is
never filled from Instagram at request time. `npm run client:status` shows
which routes the active snapshot supports.

No Instagram session is used anywhere: the snapshot is built from anonymous
material, and viewer state is added per request.

## When something fails

- `http://localhost:12000/__clone/health` (from this machine): for each recent page,
  whether our encryption key, CSRF token and viewer were substituted; counts of
  password-decryption failures by reason; GraphQL operations and REST paths the
  client called that are not implemented yet.
- A login error "This page is out of date" means the page encrypted to a key
  that is not ours, i.e. the key substitution missed this page. The server log
  also warns when a page mentions a public key that was not replaced.
- `http://localhost:12000/__loader/health`: the active snapshot (`client`: id, revision,
  routes, requests it could not answer, integrity failures). A 503 "Pinned client
  unavailable" means no valid active snapshot: run `npm run client:status`.

## Settings you may need

| Variable | Default | When |
| --- | --- | --- |
| `PORT` / `HOST` | `12000` / `0.0.0.0` | |
| `BACKEND_SECURE_COOKIES` | off | set `1` when served over HTTPS |
| `CLONE_MAIL_TRANSPORT` | `outbox` (dev), `disabled` (prod) | `log` prints codes to the console |
| `CLIENT_DIR` | `.cache/client` | the snapshot store |
| `SHELL_DROP_PREFETCHES` | off | debug only: `1` strips Relay prefetches from every page |
| `AUTH_RATE_LIMIT_MAX` | 20 per minute per IP | raise if testing hits 429 |
