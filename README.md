# Instagram Runtime Loader

Serves a **pinned snapshot of the original Instagram web client** (the real
anonymous HTML documents, JavaScript bundles, stylesheets, images and
bootloader answers of ONE client revision) together with a local
compatibility backend that answers the client's own API calls. The server
serves the snapshot installed in `.cache/client/`; `client/` is the packaged
copy that `npm run client:setup` installs from, offline (see
[Fresh install and upgrade](#fresh-install-and-upgrade)).

**Client serving is pinned-only.** The server never fetches, refreshes or
substitutes the client at runtime: there is no live mode, no fallback to
Instagram on a miss, a stale entry, a validation error or a startup failure,
and no background refresh. A resource the active snapshot does not hold is an
explicit error naming the snapshot and its revision (404; a request for
another revision is a 409, a hash mismatch a 500, no valid snapshot a 503),
counted at `/__loader/health` -> `client.missingRequests`. `src/server.js`
does not load `src/upstream.js`; the tests run with every non-local request
refused and assert none was attempted (`test/pinned-client.test.js`).

The served client changes only through operator commands:

| Command | What it does |
| --- | --- |
| `npm run client:acquire` | The ONLY command that contacts Instagram: one bounded, anonymous pass for the documents, bootloader answers and public assets of one revision; stops at the first 429 or failure; records provenance in `.cache/acquired/<stamp>/`. Never touches the active snapshot. |
| `npm run client:build -- [--acquired DIR]` | Builds a candidate snapshot from local material of ONE revision (mismatched documents/answers are rejected and listed); records hashes, routes, known-missing, patch results. |
| `npm run client:verify -- <id> --browser` | Deep integrity check, then the genuine browser checks against the candidate with the upstream guard on. Core checks (login, signup, feed, engage) must pass to become `verified`; create/profile are recorded as the snapshot's scope. |
| `npm run client:activate -- <id>` | Serves a verified snapshot (re-checks every hash); the previous one is kept for rollback. |
| `npm run client:rollback` | Re-activates the previous snapshot that still validates. |
| `npm run client:status` | Active snapshot, history, routes, scope, integrity. |
| `npm run client:setup [-- --activate]` | Installs the packaged snapshot in `client/` into `.cache/client/` without any network access: re-hashes every blob, activates it when no valid snapshot is active (keeps a valid active one unless `--activate`). Idempotent. |
| `npm run client:bundle [-- <id>]` | Writes the active (or named verified) snapshot to `client/`, replacing the previous bundle: its manifest byte for byte, its blobs, `bundle.json`. |
| `npm run client:bundle-check` | Validates `client/` without installing it. |

Snapshots: `.cache/client/` (`blobs/` content-addressed by sha256,
`snapshots/<id>/manifest.json`, `state.json`); format in `src/clientSnapshot.js`.
Sections below this point that describe document proxying, document caches or
`ALLOW_VIEWER_SESSIONS` record earlier designs and are kept as history.

Upstream origin: `https://www.instagram.com/`

---

## 1. What was inspected

The repository was **empty** — a freshly initialised `git` repository on branch
`master` with no commits and no files. There was no framework, server entry
point, routing system, proxy logic or deployment configuration to reuse, so the
smallest viable implementation was built from scratch rather than replacing an
existing application.

The upstream was inspected before writing code, which determined the design:

| Observation | Consequence for the implementation |
| --- | --- |
| `https://www.instagram.com/` returns a ~370–590 KB HTML document (HTTP 200) | The document itself must be fetched, not assembled |
| All static assets live on `static.cdninstagram.com` under `/rsrc.php/...` | Those absolute URLs must be rewritten to a local path |
| Asset filenames are opaque content hashes (e.g. `v4/yy/r/xWy1A0hSva6.js`) that change between deployments | Assets must be discovered from the fetched document at runtime; filenames cannot be hardcoded |
| Several `<script>` tags are inline `data:...;base64` payloads containing further asset URLs, and the page also ships large inline JSON (`requireLazy` module map) | The initial HTML is not the whole frontend; bundles are referenced dynamically after boot |
| `<link rel="alternate" hreflang=...>` appears 76 times pointing at the site itself | These are page links, not static assets, and must not be pushed through the asset proxy |
| The document variant depends on the `sec-fetch-site` request header (see §5) | The loader relays the browser's Fetch Metadata hints faithfully |

---

## 2. Architecture

```
browser ──▶ loader (this project) ──▶ https://www.instagram.com/ + static.cdninstagram.com
   ▲                                        │
   └──── rewritten HTML / proxied assets ◀──┘
```

```
src/config.js    configuration (env-overridable)
src/cache.js     in-memory cache with HTTP validators + LRU eviction
src/upstream.js  upstream HTTP client (redirects, timeouts, method + body)
src/rewrite.js   URL rewriting (HTML attributes and CSS url() only)
src/server.js    Express app: document proxy, asset proxy, diagnostics
scripts/verify.js         asset-loading verification against live upstream
scripts/browser-check.js  headless Chromium check (network + console + DOM)
```

### Request flow

1. **Document requests** (`GET /` and any other path) are forwarded to
   `https://www.instagram.com/<path>` with the browser's own `User-Agent`,
   `Accept-Language` and Fetch Metadata hints. The HTML response is rewritten and
   returned. Redirects are followed; the final URL is reported in
   `x-loader-final-url`.
2. **Asset requests** (`/__ig/<host>/<path>`) are forwarded to
   `https://<host>/<path>` after re-validating `<host>` against the allow-list.
   CSS responses are rewritten so that any `url(...)` they contain also routes
   through the loader.
3. **Other methods** (e.g. the client's `POST /ajax/bz`) are forwarded verbatim,
   including the request body and `x-ig-app-id`, so same-origin calls reach
   Instagram instead of 404-ing against this server.

### Rewriting scope

Only URL-bearing attributes in HTML and `url(...)` values in CSS are rewritten:

- `<script src>`, `<link href>`, `<img src>`, `<source src>`, `<video src/poster>`,
  `<use href>`, `srcset`, and `og:image`-style meta content.
- References to `instagram.com` itself become **root-relative** paths so they flow
  back through the document handler (correct for both pages and API paths).
- References to CDN hosts become `/__ig/<host>/<path>`.

Deliberately **not** done:

- No JavaScript source is modified. `<script>` bodies, inline JSON and bundles are
  passed through byte-for-byte. There are no regex substitutions inside bundles.
- Relative URLs are left alone; the browser resolves them against this origin, so
  navigation already flows back through the loader.
- No API responses are invented, mocked or stubbed.

---

## 3. Configuration

All settings are environment variables with sensible defaults (`src/config.js`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLIENT_DIR` | `.cache/client` | Snapshot store the server serves from |
| `CLIENT_SNAPSHOT_ID` | (the active one) | Serve this snapshot instead of the active one (used by `client:verify`) |
| `ALLOWED_ASSET_HOSTS` | `static.cdninstagram.com,www.instagram.com,instagram.com,scontent.cdninstagram.com` | Hosts whose `/__ig/<host>/...` paths are looked up in the snapshot (anything else is 403) |
| `HOST` / `PORT` | `0.0.0.0` / `12000` | Listen address |
| `CACHE_TTL_MS` | `300000` | Browser max-age for pinned static assets |
| `VERBOSE` | `true` | Log recorded failures |
| `UPSTREAM_ORIGIN`, `MAX_RETRIES`, `RETRY_BASE_MS` / `RETRY_MAX_MS`, `REQUEST_TIMEOUT_MS`, `USER_AGENT`, `UPSTREAM_COOLDOWN_MS` | | Used only by the operator acquisition commands (`client:acquire`, `cache:warm`), never by the server |

Removed with live serving: `CLIENT_MODE`, `LOADER_PREFER_CACHE`, `DOCUMENT_CACHE_TTL_MS`,
`DOCUMENT_STALE_MS`, `DOCUMENT_CACHE_DIR`/`BOOTLOADER_CACHE_DIR` (server side),
`CACHE_MAX_ENTRIES`, `CACHE_MAX_BODY_BYTES`. `ALLOW_VIEWER_SESSIONS` has no effect.

### Identity and viewer isolation

By default the loader is an **anonymous mirror**: every viewer receives the same
logged-out document, containing no account identity. This is what makes the
shared document cache legitimate — the content genuinely does not vary by viewer.

`ALLOW_VIEWER_SESSIONS=1` enables **per-viewer** personalisation. A viewer who
already holds an Instagram `sessionid` in their own browser sees their own
account; every other viewer stays anonymous.

```bash
ALLOW_VIEWER_SESSIONS=1 node src/server.js
curl -s localhost:12000/__loader/health | jq .viewerSessions   # { "enabled": true }
```

This is not authentication. The loader has no login and no accounts; it only
passes through a session the viewer already holds, and it never stores one.

| Guarantee | Mechanism |
| --- | --- |
| One viewer never sees another | Personalised documents are never cached at all |
| A session never reaches asset hosts | The `/__ig` route sends no cookies |
| Unrelated cookies never leak upstream | Only `sessionid`/`ds_user_id`/`csrftoken` are relayed |
| A session never reaches the browser | `set-cookie` is stripped from upstream responses |
| Anonymous stays anonymous | A `csrftoken` alone does not count as a session |

An earlier revision injected a single configured `IG_SESSIONID` for all
visitors, which made every viewer receive one account's feed. That is removed.

**The backend is not yet connected to the frontend.** The loader serves
Instagram's genuine client, but the client is not wired to our own API: the
logged-out client issues no data requests at all, and the signed-in client
consumes Instagram-specific GraphQL contracts. See
[`docs/IDENTITY-AND-ISOLATION.md`](docs/IDENTITY-AND-ISOLATION.md) for the
measurements and the recommended feature-by-feature path.

### Backend configuration (`src/backend/config.js`)

The backend has its own namespace, so a loader setting can never silently change
backend behaviour. It is off only when `BACKEND_ENABLED=0`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BACKEND_ENABLED` | `1` | Set to `0` to run the loader without the backend |
| `BACKEND_PREFIX` | `/__backend` | Mount point for the API |
| `BACKEND_DB` | `.data/backend.db` | SQLite file (created with migrations on start) |
| `BACKEND_COOKIE` / `BACKEND_CSRF_COOKIE` | `igloader_session` / `igloader_csrf` | Our own cookies, scoped to the prefix |
| `BACKEND_SECURE_COOKIES` | `false` | Set `1` when serving over HTTPS |
| `SESSION_TTL_MS` / `SESSION_ROTATE_MS` | `604800000` / `3600000` | Session lifetime and rotation age |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | `60000` / `300` | General limiter |
| `AUTH_RATE_LIMIT_MAX` | `20` | Tighter limiter for `/auth/login` and `/auth/register` |
| `MAX_PAGE_SIZE` / `DEFAULT_PAGE_SIZE` | `100` / `20` | Pagination bounds |
| `SCRYPT_COST` | `32768` | scrypt N |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For` for client identity |
| `BACKEND_VERBOSE` | `true` | Log backend requests |

## 4. Running it

### Fresh install and upgrade

```bash
git clone https://github.com/vibecodeforever/instagram.git && cd instagram
npm ci                    # the four npm dependencies
npm run client:setup      # offline: client/ -> .cache/client/, every hash checked, activated
npm start                 # http://localhost:12000
```

`client:setup` reads only `client/` (layout in `client/README.md`): it checks
`bundle.json` against the manifest and every blob against its sha256, copies
what `.cache/client/` lacks, and activates the bundled snapshot if no valid
snapshot is active. It never contacts Instagram (any network attempt fails
the command), never falls back to fetching, and fails with the reason and the
fix if the bundle is missing or altered. Running it again changes nothing.

Upgrading to a newer packaged client:

```bash
git pull
npm ci
npm run client:setup -- --activate   # install the new bundled snapshot and serve it
npm run client:status                # active snapshot, previous ones kept for rollback
npm run client:rollback              # only if the new one misbehaves
```

Without `--activate`, a valid snapshot you already serve stays active and the
bundled one is installed alongside it (`npm run client:activate -- <id>` later).

Producing a new bundle (maintainers): `client:acquire` -> `client:build --
--acquired <dir>` -> `client:verify -- <id> --browser` -> `client:activate --
<id>` -> `npm run client:bundle` -> commit `client/`.

Then open `http://localhost:12000/`: the pinned client is served from
`.cache/client/`; nothing is fetched from Instagram.

Health and diagnostics:

```bash
curl -s http://localhost:12000/__loader/health | jq          # loader
curl -s http://localhost:12000/__backend/api/v1/health | jq  # backend
curl -s http://localhost:12000/__backend/api/v1/readiness | jq
```

The loader health report includes a `backend` field showing whether the backend
mounted and where. It reports cache statistics (hits / misses / revalidations /
evictions) and the most recent resource-loading failures with their causes.

### Tests

```bash
npm test              # all 75 tests
npm run test:backend  # migrations, auth/CSRF/isolation, API, crypto
npm run test:loader   # loader rewriting + cache regression
```

Tests use `node:test` (no test-framework dependency) and start the real Express
stack on an ephemeral port against a throwaway database under `.scratch/test/`.
They make no upstream requests.

### Checks and which ones contact Instagram

| Command | Contacts Instagram? | Purpose |
| --- | --- | --- |
| `npm test` | **No** | Backend and loader regression suites |
| `npm run validate` | **No** | Inventory schema, counts, duplicates, README-vs-JSON consistency |
| `node --check` | **No** | Syntax checks |
| `curl /__loader/health` | **No** | Loader cache and failure diagnostics |
| `npm run sweep` | **Yes, only for routes without evidence** | Route inventory; already-known routes are carried forward without a request |
| `npm run sweep:retry` | **Yes** | Re-requests throttled routes; run only when throttling has subsided |
| `npm run verify` | **Yes** | Asset-loading regression against the live upstream |
| `npm run verify:browser` | **Yes** | Headless Chromium network/console/DOM regression |

Run the local-only checks first. A plain `npm run sweep` makes no upstream
requests at all once every route has evidence, which is the normal steady state.

---

## 5. Verified results

Tested against the live upstream on 2026-10-15.

### Asset loading (`npm run verify`)

```
=== 1. Document fetch ===
  status 200, 369237 bytes, content-type text/html; charset=utf-8
  rewritten refs: 17 unique asset URLs

=== 3. Summary by content-type ===
    9 x application/x-javascript     6480804B failed=0
    6 x image/webp                     19980B failed=0
    1 x image/x-icon                    2214B failed=0
    1 x text/css                      783505B failed=0

=== 5. Allow-list guard ===
  GET /__ig/evil.example.com/x.js -> 403 (expected 403)

=== RESULT: 17/17 assets loaded, 0 failed ===
```

The JavaScript bundle is ~4.5 MB uncompressed, confirming that the initial HTML
does not contain the whole frontend: the modules are fetched afterwards, and the
loader follows them.

### Headless browser (`npm run verify:browser`)

Real Chromium, no third-party dependency (driven over the DevTools Protocol):

```
title             : Instagram
script tags       : 114
inline script bytes: 231122
react mount roots : 1
requireLazy()     : true
Polaris/comet refs: true
mount root html   : 38112 bytes
forms / inputs    : 1 forms
buttons / anchors : 2 buttons, 19 anchors, 3 svg
visible text      : "Log into Instagram Mobile number, username or email Password
                     Log in Forgot password? Log in with Facebook Create new
                     account Meta About Blog Jobs Help API Privacy ..."
```

The genuine Instagram client bootstraps and renders its real login page. The
`requireLazy` bootstrap, the `Polaris`/comet module names and the React mount root
are markers of the authentic client, not of anything recreated here.

### Cache behaviour

```
/__ig/static.cdninstagram.com/rsrc.php/v4/yy/r/xWy1A0hSva6.js
  first  x-loader-cache = miss
  second x-loader-cache = hit
```

Unchanged assets are served from memory; expired entries are revalidated with
`If-None-Match` / `If-Modified-Since` rather than re-downloaded.

---

## 6. Route inventory

Verified through the mirror with `node scripts/sweep-pages.js`. Evidence is saved
to `.scratch/route-inventory.json`.

### Three verification levels, kept separate

A route is not "working" just because its document returned HTTP 200. The sweep
records three independent levels, and a route is only claimed at the level it was
actually measured:

1. **Document delivery** — the origin's HTML reached the browser (status, content
   type, delivered bytes, challenge or not).
2. **Client rendering** — the genuine client bootstrapped and rendered
   (`reactRoots`, `requireLazy`, rendered bytes, visible text).
3. **Interaction** — the page's features actually work end to end.

Level 3 is **not** measured by the sweep. Every row carries
`interactionVerified: false`. That is deliberate: nothing in this project claims
a route's features work, only that its document and client were delivered.

### Corrected counts

An earlier revision of this document was internally inconsistent: it said "11
working" while listing 12 rows, said "13 inconclusive" while listing 14, and
reported a total of 26 against category counts that omitted `/reels/` entirely.
Those errors were corrected, and a validation script now enforces consistency
(see below).

| Outcome | Count |
| --- | --- |
| working | 17 |
| authentication-required | 1 |
| inconclusive (throttled) | 17 |
| **total** | **35** |

| Category | Count |
| --- | --- |
| public | 21 |
| auth-flow | 3 |
| auth-only | 7 |
| non-page | 3 |
| unknown | 1 |
| **total** | **35** |

The earlier discrepancy had two causes, both fixed: `/reels/` had been dropped
from `scripts/lib/routes.js` during a rewrite (so the sweep stopped emitting it),
and `documentDelivery.bytes` was storing the *rendered DOM* size rather than the
delivered document size, conflating levels 1 and 2. Delivered bytes are now
measured from the network layer; carried-forward rows record `null` rather than a
number that was never measured.

`npm run validate` checks all of this locally, without touching the network:
duplicate routes, duplicate patterns, category and outcome sums, registry-versus-
inventory agreement, user-verified routes not recorded as broken, and the README
table row counts against the JSON.

### Verified working (17 automated)

| Route | Category | Delivered | Rendered | Interaction |
| --- | --- | --- | --- | --- |
| `/` | public | 200 | login form | not measured |
| `/accounts/emailsignup/` | public | 200 | sign-up form | not measured |
| `/accounts/password/reset/` | auth-flow | 403 + challenge | reset form | not measured |
| `/accounts/password/reset/confirm/` | auth-flow | 200 | reset confirm | not measured |
| `/explore/` | public | 200 | Popular grid | not measured |
| `/explore/tags/travel/` | public | 200 | hashtag page | not measured |
| `/explore/?hl=de` | public | 200 | localised Popular page | not measured |
| `/explore/?hl=es` | public | 200 | localised Popular page | not measured |
| `/popular/` | public | 200 | Popular page (real hashtags/posts) | not measured |
| `/legal/privacy/` | public | 200 | privacy policy | not measured |
| `/legal/privacy/health_privacy_policy/` | public | 200 | health privacy policy | not measured |
| `/legal/terms/` | public | 200 | terms of use | not measured |
| `/legal/cookies/` | public | 200 | cookies policy | not measured |
| `/web/lite/` | public | 200 | Instagram Lite download page | not measured |
| `/developer/` | public | 200 → markdown doc | platform docs | not measured |
| `/robots.txt` | non-page | 200 | plain text (no client expected) | n/a |
| `/data/manifest.json` | non-page | 200 | JSON manifest | n/a |

### User-verified (operator-confirmed, never downgraded)

| Route | Note |
| --- | --- |
| `/explore/` | Popular page — confirmed by the operator, and also passes automated rendering |
| `/instagram/` | Public profile — confirmed by the operator; the automated request is currently throttled (429), so it is recorded `inconclusive`, **not** downgraded to broken |

`/instagram/` is why the automated and operator views differ by one: 17 routes
pass automated verification, and 18 are known to work once the operator's
confirmation of `/instagram/` is counted. The automated row is left as
`inconclusive` because that is what the measurement actually showed — a 429 — and
the operator's confirmation is recorded alongside it rather than overwriting it.

`/popular/` independently corroborates the Popular page: fetched fresh through the
mirror it rendered "See what's popular on Instagram" with real hashtag post counts.

`/developer/` now redirects upstream to `developers.facebook.com/documentation/instagram-platform`,
which serves markdown rather than an HTML app, so it is relayed through the asset
path instead of the document cache. The document still reaches the browser; there
is no Instagram client to render.

### Authentication-required (1)

| Route | Evidence |
| --- | --- |
| `/reels/` | 200, client booted, but rendered only a "Log In / Sign Up" gate |

### Inconclusive — throttled, NOT broken (17)

These returned **HTTP 429** from Instagram. A 429 is refused before Instagram
evaluates the request, so it is **not** evidence that the page is missing,
broken, or requires login.

| Route | Category |
| --- | --- |
| `/accounts/login/` | public |
| `/accounts/login/?next=%2F&source=mobile_nav` | public |
| `/instagram/` | public (user-verified; see note) |
| `/accounts/meta_verified/` | public |
| `/web/` | public |
| `/legal/accessibility/` | public |
| `/about/` | public |
| `/accounts/two_factor_authentication/` | auth-flow |
| `/manifest.json` | non-page |
| `/api/` | unknown |
| `/direct/inbox/` | auth-only |
| `/accounts/edit/` | auth-only |
| `/accounts/activity/` | auth-only |
| `/your_activity/` | auth-only |
| `/accounts/saved/` | auth-only |
| `/emails/settings/` | auth-only |
| `/session/login_activity/` | auth-only |

**Why these are inconclusive.** Instagram rate-limited this environment after the
volume of testing in earlier steps. The throttle has not fully decayed. The
loader's retry-with-backoff is active (`MAX_RETRIES`, exponential backoff
honouring `Retry-After`), but a sustained IP-level throttle outlasts it.
Re-requesting throttled routes is opt-in (`RETRY_INCONCLUSIVE=1`) and is not done
by default, so a normal sweep adds no load for routes already known to be throttled.

**Why a throttle redirect must not be read as "needs login".** `/instagram/`
returned `302 → /accounts/login/?next=...&is_from_rle`. The `is_from_rle` marker
is a rate-limit indicator: that redirect was a *throttle artifact*, not proof
that profile pages require a session. Since the operator has confirmed public
profiles render through the mirror, the redirect is explained by throttling, not
by an access requirement.

### URL patterns with identifier segments

These patterns cannot be fetched with a made-up identifier — the identifier must
come from real content. The registry in `scripts/lib/routes.js` records each
pattern, how it is known, whether a real example was requested, and the outcome
at each verification level. The full machine-readable form is in
`.scratch/route-inventory.json`.

| Pattern | Category | Tested example | Requested | Delivered | Rendered |
| --- | --- | --- | --- | --- | --- |
| `/p/<shortcode>/` | public | none | no | — | — |
| `/reel/<shortcode>/` | public | none | no | — | — |
| `/reels/` | public | `/reels/` | yes | yes | yes (login gate) |
| `/stories/<username>/<story_id>/` | auth-only | none | no | — | — |
| `/stories/highlights/<highlight_id>/` | public | none | no | — | — |
| `/<username>/` | public | `/instagram/` | yes | yes | yes |
| `/<username>/tagged/` | public | none | no | — | — |
| `/<username>/reels/` | public | none | no | — | — |
| `/explore/tags/<tag>/` | public | `/explore/tags/travel/` | yes | yes | yes |
| `/explore/locations/<location_id>/` | public | none | no | — | — |
| `/places/c/<id>/` | public | none | no | — | — |
| `/<path>?hl=<lang>` | public | `/explore/?hl=de` | yes | yes | yes |
| `/direct/t/<thread_id>/` | auth-only | none | no | — | — |
| `/sitemap/<file>.xml.gz` | non-page | `/sitemap/ig_places_sitemap.xml.gz` | yes | **403** | n/a |

No interactions are marked verified anywhere. The sweep does not claim that any
route's features work, only that its document and client were delivered.

#### On the empty shortcode mapping

The anonymous Explore payload ships `post_shortcode_to_uri_mapping: {}`. That is
**one data point**. It shows that this particular SSR payload carried no
shortcodes. It does **not** establish that public post or reel pages require
authentication. Post and reel detail are therefore recorded as **untested**, not
auth-required. A pattern is only classified auth-required when there is positive
evidence of a login gate.

#### Evidence sources used

Every example above came from evidence already in the project or from the
origin's own public responses — never from an invented identifier:

- `/instagram/`, `/explore/` — operator-confirmed.
- `/explore/tags/travel/` — existing project evidence.
- `/explore/?hl=de` — language links in the app-shell footer.
- `/popular/`, `/web/lite/`, `/legal/privacy/health_privacy_policy/` — internal
  links in the cached `/explore/` document.
- `/sitemap/*.xml.gz` — `Sitemap:` entries in the origin's `robots.txt`.
- `/places/c/` — `Allow:` entry in `robots.txt`.

The `/explore/locations/` link in the cached markup is an **id-less template**, so
no location id was available and the pattern is left untested rather than probed
with a guessed number.

### Remaining untested routes

- **Content detail**: `/p/<shortcode>/`, `/reel/<shortcode>/` — need a real shortcode.
- **Profile sub-tabs**: `/<username>/tagged/`, `/<username>/reels/` — need a username that renders anonymously.
- **Location and place pages**: `/explore/locations/<location_id>/`, `/places/c/<id>/` — need a numeric id.
- **Story highlights**: `/stories/highlights/<highlight_id>/` — need a numeric highlight id.
- **Stories and direct threads**: auth-only by design.
- **Sitemaps**: `/sitemap/*.xml.gz` — returned 403; the robots-advertised source of real identifiers, worth retrying when access permits.
- **Additional non-page assets**: `/favicon.ico`, `/apple-touch-icon.png`.

The sitemaps are the key blocker for the rest: they are Instagram's own published
list of real usernames and location ids. Until they can be read, post, reel,
profile sub-tab and location patterns cannot be given tested examples without
guessing identifiers, which this project does not do.

### Retrying the inconclusive routes

When throttling has subsided, opt in explicitly. Working and user-verified routes
are still carried forward, so only the throttled routes are re-requested:

```bash
RETRY_INCONCLUSIVE=1 BETWEEN_MS=20000 node scripts/sweep-pages.js
```


## 7. Limitations and origin-dependent functionality

The document and its assets load successfully. That is a **different claim** from
"the application is fully functional", and the distinction matters:

**Successfully fetched:** the HTML document, all JavaScript bundles, stylesheets,
favicons and touch icons referenced by the document — verified byte counts and
HTTP 200 for every one.

**Requires Instagram's own services (not resolved here):**

- **Same-origin API calls.** The client calls endpoints such as
  `/ajax/bz`, `/ajax/bulk-route-definitions/` and `/ajax/qm/`. These are
  forwarded faithfully, but the origin rejects them for an anonymous client. In
  the headless run they returned **HTTP 429** (upstream rate limiting) and **404**,
  relayed unchanged. The loader does not fabricate responses to make the UI appear
  functional.
- **Cross-origin calls to `www.facebook.com`** (`/ig_xsite_user_info/`,
  `/ig_xsite_user_obid/`) fail with CORS errors. These are third-party origins
  outside the allow-list; proxying them would be an access-control bypass and is
  deliberately not done.
- **WebAuthn / passkey login.** The console reports
  *"The relying party ID is not a registrable domain suffix of, nor equal to the
  current domain"* — Instagram's passkey RP ID is tied to `instagram.com`, so
  passkeys cannot work from a different origin.
- **Authentication and sessions.** No session cookie is forwarded upstream and no
  Instagram cookie is captured or exposed. The loader therefore serves the
  **logged-out** experience only. Logged-in flows additionally require Instagram's
  own session, CSRF token, and anti-bot protections.
- **Origin-bound security mechanisms.** Content-Security-Policy,
  `X-Frame-Options` and `Strict-Transport-Security` from upstream are not
  replayed, because they are scoped to Instagram's origin and would break
  resources served from this one. The client's own domain-bound checks (CSRF
  tokens, app-id attestation, passkeys) remain in force and are not circumvented.

**Would require separate backend implementations** (not attempted, and out of
scope): authentication, feed/media APIs, direct messaging, and any other
server-side data service the client expects. These are Instagram's services;
re-implementing them would mean inventing API responses, which this project
explicitly does not do.

### Rate limiting and the anti-bot challenge

Instagram applies two independent protections that shaped the route inventory:

- **IP-level rate limiting (HTTP 429).** Triggered by the volume of testing in
  this environment. It returns an empty body with no `Retry-After`, so it cannot
  be waited out from inside the loader. A 429 means the request was refused
  before Instagram evaluated it, so it is **not** evidence that a page is missing
  or requires login. The loader retries transient statuses with exponential
  backoff for idempotent requests only, and serves a previously cached good
  document (`x-loader-cache: stale`) instead of a dead error page — but a
  sustained throttle outlasts the retries.
- **The anti-bot challenge (HTTP 403).** The response body is a real HTML page
  containing a script that POSTs a verification request back to the origin and
  then reloads. Two deliberate choices follow:
  - The loader **passes the challenge page through and rewrites it like any other
    document** rather than replacing it with synthetic text. Replacing it would
    strip the mechanism and guarantee the page never loads.
  - The loader **does not solve the challenge server-side.** Solving it would
    mean defeating an anti-bot control, which this project does not do. In a real
    browser the page's own script performs the verification legitimately, and the
    page then loads — `/accounts/password/reset/` was verified working this way.

### Other operational notes

- Instagram serves **different document variants based on client fingerprinting**.
  A request carrying `sec-fetch-site: none|same-origin` (what a top-level
  navigation sends) receives the full app shell (~371 KB, containing
  `PolarisLogin` and `og:title`); an absent or `cross-site` hint receives a reduced
  document (~590 KB without those markers). The loader relays the browser's own
  hints and defaults to what a real navigation sends — a faithful relay, not an
  attempt to spoof a privileged client.
- Asset filenames change between Instagram deployments. Because references are
  read from the fetched document each time, the loader adapts automatically; the
  cache is keyed by full URL, so a new hash is simply a cache miss.
- The cache is in-memory and per-process. Restarting the server empties it.
- **Documents are cached for a shorter window than assets, and revalidation is
  mostly impossible.** Documents use `DOCUMENT_CACHE_TTL_MS` (60 s). When a cached
  document expires the loader attempts a conditional request (`If-None-Match` /
  `If-Modified-Since`) so an unchanged page costs a cheap `304` instead of a full
  re-download. In practice Instagram's document origins send **no `ETag` and no
  `Last-Modified`** and instead declare `cache-control: private, no-cache,
  no-store, must-revalidate`, so there is nothing to revalidate against and the
  document is re-fetched. This was measured directly against
  `help.instagram.com`. The conditional path is therefore correct but rarely
  exercised; the practical saving comes from the TTL, not from `304`s.
- **`/developer/` is no longer an Instagram HTML page.** Upstream it now `301`s to
  `developers.facebook.com/documentation/instagram-platform`, which serves
  `text/markdown`. The loader relays it through the asset path; there is no
  Instagram client to render. It is listed as working at the delivery level only.

---

## 8. Security posture

- The asset proxy is restricted to an explicit host allow-list; any other host
  returns `403`. It is not an open proxy.
- `Cookie` and `Authorization` request headers are never forwarded upstream, and
  `Set-Cookie` is never returned downstream. No session cookies, passwords or
  authentication tokens are collected or exposed.
- No access controls or security protections are bypassed. Requests are relayed
  as the anonymous client they are.
- Request and response bodies are relayed byte-for-byte; nothing is parsed and
  re-encoded.

---

## 9. Application backend

Alongside the loader there is a real, database-backed backend for **this
application's own** accounts and content. It is deliberately not an Instagram
backend, and the separation is the most important design decision here.

| Concern | Talks to Instagram? |
| --- | --- |
| Runtime loader (sections 1–8) | Yes — it serves Instagram's real frontend |
| Application backend (this section) | **No** — it serves our own data from our own database |

Full detail: [`docs/BACKEND.md`](docs/BACKEND.md). Machine-readable
endpoint-to-frontend-dependency inventory:
[`docs/api-compatibility.json`](docs/api-compatibility.json).

### How it is mounted

`src/server.js` mounts the backend **before** the loader's catch-all:

```js
backendApp.mount(app);      // /__backend/*  → our API
app.get('/__ig/:host/*', …) // asset proxy
app.all('*', …)             // everything else → Instagram
```

The order matters. The loader ends with `app.all('*')`, so anything registered
after it is unreachable. Mounting first is what lets `/__backend/*` resolve
locally while Instagram's own `/api/v1/*` and `/graphql/query` keep flowing
upstream. Verified: `GET /api/v1/web/accounts/edit/` returns
`x-loader-upstream: https://www.instagram.com/api/v1/web/accounts/edit/`, i.e.
Instagram's path, not ours.

### Database and migrations

SQLite via `node:sqlite` (built into Node 24, no native build, no dependency).
The file `.data/backend.db` is created and migrated on first start; migrations
are append-only and recorded in `schema_migrations`.

### API

Versioned under `/__backend/api/v1`. Auth via `Authorization: Bearer <token>` or
the session cookie; cookie writes also need `X-CSRF-Token`. Everything else is
in the inventory. Selected routes:

```
POST   /auth/register, /auth/login, /auth/logout, /auth/session/rotate
GET    /users/me, /users/:id, /users/:id/posts, /users/:id/stories
POST   /posts            GET/PATCH/DELETE /posts/:id
POST   /posts/:id/likes  POST/GET /posts/:id/comments
POST   /users/:id/follow POST /users/:id/follow/accept|reject
GET/PUT/DELETE /users/me/saved/…       POST/GET /users/me/collections
GET    /users/me/notifications         POST /notifications/:id/read
POST   /stories          GET/DELETE /stories/:id
GET/POST /conversations  GET/POST /conversations/:id/messages
GET/PATCH /users/me/settings           GET /feed, /explore
```

### Authentication model and its limits

scrypt password hashing, hashed session tokens, expiry, revocation, rotation,
CSRF double submit, uniform login failures, and `no-store` on every response.
See `docs/BACKEND.md` for the full list.

**It authenticates a user to this backend, not to Instagram.** No endpoint
accepts, stores, or logs an Instagram password, cookie, or token. Instagram's
login CAPTCHA is never solved or bypassed. Every read of
`/users/me/upstream-identity` returns `authenticatedToInstagram: false`.

### What works, and what is blocked

Verified locally (75 automated tests, all passing) against the real HTTP stack:
accounts and sessions; profiles and privacy; posts, likes, comments; follows
including private-account requests; saved posts and collections; notifications;
stories with expiry; conversations and messages with membership checks; settings;
home feed and public explore. Cross-user isolation, CSRF, session expiry and
revocation, pagination and rate limiting are all covered by tests.

Blocked, and reported as blocked rather than faked: anything requiring
Instagram's authoritative data — Instagram profile, feed, followers, direct
messages — needs Instagram authorization this project does not have and does not
attempt to obtain. Instagram's own API dependencies observed in its bundles
(`/graphql/query`, `/api/graphql`, `/api/v1/web/accounts/edit/`,
`/api/v1/media/configure_to_story/`, `/api/v1/bloks/apps/`,
`/api/v1/web/linkshim/link/`, the `/ajax/*` endpoints) are listed in the
inventory with evidence, confidence, and the reason each stays upstream. None is
proxied or emulated.

### Status vocabulary

Used consistently, and never upgraded without evidence:

- **Implemented** — the route exists.
- **Locally verified** — automated tests pass against the real HTTP stack.
- **Upstream verified** — genuine upstream behaviour was confirmed.
- **End-to-end verified** — the real Instagram frontend completed the
  interaction. No backend feature is at this level, and none claims to be.

## 10. Files

| File | Role |
| --- | --- |
| `package.json` | Project metadata, dependencies, `start` / `verify` scripts |
| `src/config.js` | Environment-driven configuration |
| `src/cache.js` | In-memory response cache with validators and LRU eviction |
| `src/cookies.js` | Anonymous upstream cookie jar (no auth cookies stored or relayed) |
| `src/upstream.js` | Upstream HTTP client (redirects, timeouts, methods, bodies, retries) |
| `src/rewrite.js` | HTML/CSS URL rewriting and allow-list checks |
| `src/server.js` | Express app: document proxy, asset proxy, health endpoint |
| `scripts/verify.js` | Asset-loading verification against the live upstream |
| `scripts/browser-check.js` | Headless Chromium verification (network, console, DOM) |
| `scripts/sweep-pages.js` | Runtime route inventory sweep with evidence capture |
| `scripts/validate-inventory.js` | Local-only inventory/README consistency validation |
| `scripts/lib/browser.js` | Shared CDP driver used by both browser scripts |
| `scripts/lib/routes.js` | Route inventory definition (categories, expectations) |
| `src/backend/index.js` | Backend sub-app: parsing, request id, auth, CSRF, 404, error handler |
| `src/backend/config.js` | Backend configuration (separate namespace from the loader) |
| `src/backend/api/router.js` | All API v1 routes |
| `src/backend/lib/errors.js` | `AppError` types and the response envelope |
| `src/backend/lib/validate.js` | Request field validation |
| `src/backend/lib/pagination.js` | Opaque keyset cursors |
| `src/backend/lib/auth.js` | Session resolution, `requireAuth`, CSRF |
| `src/backend/lib/cookies.js` | Cookie parse/serialize for our own session cookies |
| `src/backend/lib/passwords.js` | scrypt hashing for this application's accounts |
| `src/backend/lib/ratelimit.js` | Fixed-window limiter (general + auth classes) |
| `src/backend/lib/ids.js` | Ids, tokens, constant-time compare, token hashing |
| `src/backend/lib/logging.js` | Request id and secret redaction |
| `src/backend/lib/async.js` | Rejected-promise forwarding for Express 4 |
| `src/backend/services/users.js` | Accounts, authentication, declared upstream identity |
| `src/backend/services/sessions.js` | Session create/resolve/rotate/revoke/purge |
| `src/backend/services/posts.js` | Posts and likes |
| `src/backend/services/social.js` | Comments, follows, saved, notifications, stories, messages, settings, feed |
| `src/backend/db/index.js` | SQLite open + migration runner |
| `src/backend/db/migrations.js` | Append-only versioned schema |
| `test/*.test.js` | `node:test` suites (backend + loader regression) |
| `test/helpers.js` | Test server/client harness |
| `docs/BACKEND.md` | Backend architecture |
| `docs/api-compatibility.json` | Machine-readable endpoint/compatibility inventory |
| `.gitignore` | Excludes `node_modules/`, `.data/`, `.scratch/` |
