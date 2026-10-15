# Identity and viewer isolation

This document records what the loader does with identity, why, and what is still
not solved. It replaces an earlier version that described a `IG_SESSIONID`
"authenticated mode".

## What went wrong before

An earlier revision let the operator set `IG_SESSIONID`, which the loader
attached to upstream requests. The effect was that **every visitor** received
the signed-in document of whichever account that cookie belonged to — that
account's username, avatar, inbox and notifications.

Two independent viewers received byte-identical personalised HTML, because the
authenticated responses were held in a single cache keyed only by path. The
"isolation" that existed (private cache headers, a separate cache instance) was
real but insufficient: the session was global, so there was nothing to isolate.

That mechanism has been removed. There is no `IG_SESSIONID`, no `authMode`, and
no server-side Instagram account anywhere in the codebase.

## What the loader does now

### Default: an anonymous mirror

With no configuration, the loader is a logged-out mirror. Every viewer receives
the same document, fetched without any Instagram credential.

Verified: two viewers — one sending no cookies, one sending unrelated cookies —
receive byte-identical 369,249-byte documents, containing no account username,
avatar, or `viewerId`. The only `ds_user_id` present is Instagram's logged-out
sentinel.

This is what makes the shared document cache legitimate: the content genuinely
does not vary by viewer.

### Optional: per-viewer pass-through

`ALLOW_VIEWER_SESSIONS=1` (default off) enables personalisation that is
**per-viewer**. If a viewer's own request carries an Instagram `sessionid`, the
loader relays that viewer's own session cookies upstream for that viewer's own
request. Each viewer then sees their own account.

This is not authentication. The loader has no login, no accounts, and no
password handling. It does not create, obtain, or store a session; it only
passes through a session the viewer already holds. If the viewer has no session,
they get the anonymous document.

Properties, each covered by a test in `test/viewer-isolation.test.js`:

| Property | How it is enforced |
| --- | --- |
| One viewer never sees another | Personalised documents are **never cached**. There is no per-viewer cache to collide. |
| A session never reaches asset hosts | The `/__ig` asset route calls `fetchUpstream` without a cookie. Assets are public and need none. |
| Unrelated cookies never leak upstream | Only `sessionid`, `ds_user_id`, `csrftoken` are relayed, never the whole header, so our own backend cookie cannot reach Instagram. |
| A session never reaches the browser | `set-cookie` is stripped from upstream responses. Nothing is ever set on the viewer's browser. |
| Nothing is stored | The session exists only as a local variable for the life of one request. No jar, no disk, no log. |
| Anonymous stays anonymous | A `csrftoken` alone does not make a viewer personalised; Instagram issues it to logged-out visitors. |

Personalised responses are served `Cache-Control: private, no-store` with
`Vary: Cookie, Authorization` and marked `x-loader-personalized: true`, so the
distinction is visible in the response rather than implied.

## The unsolved part: the client is not wired to our backend

The loader serves Instagram's real frontend. It does **not** yet make that
frontend operate on our own backend and database. This is the honest status.

### What was investigated

The client's initial state arrives as ServerJS `__bbox` payloads embedded in the
HTML. Inspecting them answers the central feasibility question:

- There is **no API host override** in the bootstrap. No `api_url`, no
  `graphql_url`, no absolute API origin. The client issues **relative** paths,
  which resolve against the page origin — which is *our* server.

That is the good news: interception is architecturally possible without patching
bundle internals, because every API call the client makes already lands on us.

### What was measured

Driving a real headless Chromium at the loader and recording its network
activity:

```
same-origin requests: 33, of which API-like: 13
  POST /ajax/bz                      -> 200  (bootloader telemetry)
  POST /ajax/qm/                     -> 200  (bootloader telemetry)
  POST /ajax/bulk-route-definitions/ -> 429  (route metadata)
```

The logged-out client makes **zero data-API calls**. It does not request a feed,
a profile, or messages, because it has no viewer. The requests it does make are
Facebook *bootloader* endpoints for code-splitting metadata and telemetry, not
application data.

### What actually renders

The same run, inspecting the DOM afterwards, confirms the genuine client boots:

```
title              : Instagram
script tags        : 106   (inline script bytes: 229,113)
react mount roots  : 1     (mount root html: 38,112 bytes)
requireLazy()      : true
Polaris/comet refs : true
anti-bot challenge : false
visible text       : "Log into Instagram  Mobile number, username or email
                      Password  Log in  Forgot password?  Log in with Facebook
                      Create new account ..."
```

That is Instagram's real login page, rendered by Instagram's real bundles, served
from our origin. Network totals from the same run:

| Origin | Requests | Failed |
| --- | --- | --- |
| `localhost:12000` (loader) | 33 | 9 |
| `static.cdninstagram.com` (via `/__ig`) | 10 | 0 |
| `www.facebook.com` | 6 | 6 |

The asset proxy is working: all 10 CDN asset requests succeeded.

### Known failures and their causes

Both failure classes were reproduced and diagnosed, not guessed:

**1. `429 Too Many Requests` from `/ajax/bulk-route-definitions/` (9 of 33).**
Instagram rate-limits this route-metadata endpoint per client IP. The loader
forwards these POSTs, but the origin refuses them. Cause: upstream throttling of
an endpoint that returns route/chunk metadata the client uses to preload code.
It is not a rewriting bug. The client degrades (some route preloading is skipped)
rather than failing to boot, which is why the page still renders.

**2. CORS failures to `www.facebook.com` (6 of 6).**
The client calls `https://www.facebook.com/ig_xsite_user_info/` and
`.../ig_xsite_user_obid/`. Those URLs are **not in the HTML** — they come from a
ServerJS config block the origin itself serves:

```json
"cross_site_request_url":"https:\/\/www.facebook.com\/ig_xsite_user_info\/"
```

The browser blocks them because our origin is `localhost:12000` and Facebook
sends no `Access-Control-Allow-Origin`. Cause: the client is configured by
Instagram's own servers to call a Facebook origin that expects Instagram to be
its sibling domain. Relaying these would mean proxying a non-Instagram host and
fabricating the CORS relationship; the loader does neither. Consequence: the
"remember me on this device" behaviour that depends on these calls does not
function. Everything else on the login page does.

### What this means

Two conclusions, both of which constrain the next step:

1. **There is nothing to serve from our database yet.** A compatibility layer
   cannot be validated against a client that never asks for data. The
   `/__backend` API already implements users, posts, likes, comments, follows,
   saved items and notifications — but the logged-out client never requests any
   of it, so nothing exercises it.

2. **The client's data contract is Instagram-specific.** The signed-in client
   issues `POST /graphql/query` with `fb_api_req_friendly_name` and
   `doc_id`-style parameters, and consumes deeply nested `data` envelopes. A
   compatibility layer must reproduce those operation names and response shapes
   for each feature, one at a time, verified against the real client. Inventing
   responses that merely look plausible would produce a client that appears to
   work and does not.

The `x-ig-app-id` and `x-csrftoken` headers the client sends are already relayed
through, which is the hook a compatibility layer would build on.

### What is deliberately not done

- No fabricated API responses, no mock data presented as real.
- No login flow, no password collection, no session minting.
- No anti-bot or access-control bypass. When the origin returns a challenge page,
  it is passed through unchanged, because that page carries the mechanism that
  lets a legitimate browser proceed.
- No patching of JavaScript bundles by broad regex. The bundles are served
  byte-for-byte, because a bundle patched by pattern matching breaks in ways that
  are invisible until a specific feature is used.

## Recommendation

The correct next step is a **feature-by-feature compatibility layer**, not a
broad rewrite: pick one client operation (the feed is the natural first),
capture its exact request and response contract from the real client, implement
that one operation against our backend, and verify the real UI renders it. Each
subsequent feature repeats the pattern. Until that is done, the honest
description of this project is: *it serves Instagram's genuine frontend, and its
backend is not yet connected to it.*
