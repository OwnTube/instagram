# Backend architecture

This document describes the application backend added alongside the Instagram
runtime loader. It is deliberately separate from the loader, and the separation
is the most important design decision in the project.

## Two concerns, kept apart

| Concern | What it does | Where it lives | Talks to Instagram? |
| --- | --- | --- | --- |
| Runtime loader | Fetches and serves Instagram's real frontend (HTML, JS, CSS, assets) from `https://www.instagram.com/` | `src/server.js`, `src/rewrite.js`, `src/cache.js`, `src/upstream.js` | Yes — that is its whole job |
| Application backend | Serves *our own* accounts and content from our own database | `src/backend/**` | No |

The backend never fabricates Instagram data, and the loader never reads the
backend's database. A feature that needs Instagram's authoritative data is
reported as unavailable rather than simulated.

## Request routing

`src/server.js` mounts the backend **before** its catch-all document handler:

```js
backendApp.mount(app);      // /__backend/*  → our API
app.get('/__ig/:host/*', …) // asset proxy
app.all('*', …)             // everything else → Instagram
```

The order is load-bearing. The loader ends with `app.all('*')`, so anything
registered after it is unreachable. Mounting the backend first is what lets
`/__backend/*` resolve locally while Instagram's own `/api/v1/*` and
`/graphql/query` keep flowing upstream to the real origin.

The backend is mounted at `/__backend` rather than at the root specifically so
it cannot shadow Instagram's real API paths.

## Layer map

```
src/backend/
  index.js            sub-app: body parser, request id, logging, auth, CSRF, 404, error handler
  config.js           environment-driven configuration (separate namespace from the loader)
  api/router.js       all HTTP routes, one place
  lib/
    errors.js         AppError types + the response envelope
    validate.js       field-by-field request validation
    pagination.js     opaque keyset cursors
    auth.js           session resolution, requireAuth, CSRF
    cookies.js        cookie parse/serialize for our own session cookies only
    passwords.js      scrypt hashing for OUR accounts
    ratelimit.js      fixed-window limiter, general + auth classes
    ids.js            ids, tokens, constant-time compare, token hashing
    logging.js        request id + redaction of secret keys
    async.js          rejected-promise → next(error) for Express 4
  services/
    users.js          accounts, authentication, declared upstream identity
    sessions.js       session lifecycle: create, resolve, rotate, revoke, purge
    posts.js          posts + likes
    social.js         comments, follows, saved, notifications, stories, messages, settings, feed
  db/
    index.js          node:sqlite open + migrate
    migrations.js     append-only versioned schema
```

## Database choice

`node:sqlite`, the SQLite binding built into Node 24.

- No native compilation and no extra dependency, so the backend deploys exactly
  the way the loader already does.
- Real transactions and foreign keys (`PRAGMA foreign_keys = ON`), which the
  service layer relies on for cross-entity integrity.
- A single file suits a single-process deployment.

The file lives at `.data/backend.db` (gitignored) and is created with its
migrations on first start.

## Source of truth, per entity

| Entity | Source of truth | Notes |
| --- | --- | --- |
| Accounts, sessions | This database | Not Instagram accounts |
| Posts, comments, likes | This database | Content created here |
| Follows, saved, collections | This database | |
| Notifications, messages, stories | This database | |
| Settings, privacy | This database | |
| Instagram profile, feed, DMs, followers | **Instagram** | Not available here; no endpoint claims otherwise |

`upstream_identity` records at most a username an operator *declared*. It stores
no token, and every read of it returns `authenticatedToInstagram: false`.

## Authentication model

Two ways to present a session:

1. `Authorization: Bearer <token>` — no ambient authority, so no CSRF concern.
2. The session cookie — ambient authority, so state-changing methods also
   require a matching `X-CSRF-Token` header (double submit).

Properties enforced by code and covered by tests:

- Passwords hashed with scrypt (N=2^15, r=8, p=1), per-user random salt.
- Session tokens are random 32-byte values; only their SHA-256 hash is stored.
- Sessions expire, can be revoked individually or wholesale, and rotate.
- Login failures are uniform (same message and comparable timing for unknown
  users) so account existence is not disclosed.
- The CSRF check accepts the header **only**. Accepting the cookie value would
  defeat it, because the browser attaches cookies to cross-site requests.
- Session cookie is HttpOnly and scoped to `/__backend`; the CSRF cookie is
  readable by script, which is the point.
- No endpoint accepts, stores, or logs an Instagram password, cookie, or token.

### What this authentication does not do

It authenticates a user to **this backend**. It does not authenticate anyone to
Instagram. There is no code path that logs into Instagram, and the CAPTCHA in
Instagram's login flow is never solved or bypassed.

## Data model highlights

- Every content table carries an owner (`author_id` / `owner_id`); services scope
  reads by that owner. Cross-user isolation is tested, not assumed.
- Private accounts: `follows.canView` gates profile bio, posts, and stories. A
  follow to a private account is `pending` until accepted.
- Stories carry `expires_at`; active lists filter on it.
- Deletes are soft where history matters (posts, comments, messages) and hard
  where it does not (stories, follows).

## Pagination

Keyset, not offset, so paging does not drift when rows are inserted mid-walk.
Cursors are base64 JSON, opaque to clients, and validated on decode — a
tampered cursor yields a 400, not a malformed query.

## Abuse protection

A fixed-window limiter keyed by client and route class. Credential routes
(`/auth/login`, `/auth/register`) use a much tighter window than general reads.
Responses carry `X-RateLimit-*`, and a limited request returns 429 with
`Retry-After`.

## Error handling

One envelope everywhere:

```json
{ "data": { … }, "meta": { "nextCursor": "…" } }
{ "error": { "code": "bad_request", "message": "…", "details": { "field": "password" }, "requestId": "req_…" } }
```

Only deliberate `AppError` messages reach the client. Anything else is reported
as a generic `internal_error` and logged server-side, so stack traces and
database text cannot leak. Every response carries a request id.

## Caching and privacy

All backend responses send `Cache-Control: no-store, private` and
`Vary: Cookie, Authorization`. This prevents an intermediary from serving one
user's authenticated response to another visitor of the public forwarded URL —
a real risk given the deployment exposes a public URL.
