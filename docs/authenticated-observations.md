# Authenticated runtime observations

Verified against a real authenticated session by driving headless Chromium over
CDP (`scripts/capture-authenticated.js`). Raw HTTP (`curl`/`fetch`) with the same
cookie returns **302 to the homepage**, so a real browser is required; the
observations below are from the browser, not from raw requests.

All routes reported `authenticated=True` (the logged-out marker was absent and
the authenticated nav rendered). The account identifier is redacted; the session
cookie is not recorded anywhere.

Reported data is deliberately shape-only: paths have their query strings
stripped, and no cookie value, response value, caption, media URL or username
appears below.

## The central finding

**Instagram's own frontend does not call `/__backend`, or any part of this
project.** In the captured traffic there were **0** references to `__backend` and
**0** to the local loader origin. Instagram's client talks to Instagram.

This project therefore has **no** frontend-compatibility integration and does not
claim one. `/__backend` is a separate application backend; it is not a backend
that Instagram's client consumes. Nothing here changes that.

## Observed request inventory

Every entry was observed live, authenticated, and returned 200.

### GraphQL — persisted, `doc_id`-based

Instagram does not send raw GraphQL queries. It POSTs a `doc_id` referring to a
server-side persisted query, form-encoded, with `__a=1` and `__d=www`.

| Method | Path | Status | Operation |
| --- | --- | --- | --- |
| POST | `/graphql/query` | 200 | `PolarisFeedTimelineRootV2Query` (doc_id 28805668309050001) |
| POST | `/graphql/query` | 200 | `PolarisStoriesV3AdsPoolQuery` (doc_id 28678424071792947) |
| POST | `/api/graphql` | 200 | second GraphQL entry point |

Response envelope: `{ data, extensions, status }` with `status: "ok"`.
Timeline variables observed: `after`, `before`, `data`, `first`, `last`,
`variant`, plus `__relay_internal__pv__…` feature flags — i.e. Relay-style cursor
pagination, matching the keyset pagination this project's backend already uses.

### REST (`/api/v1/...`)

| Method | Path | Status | Response shape |
| --- | --- | --- | --- |
| GET | `/api/v1/accounts/edit/web_form_data/` | 200 | `{ form_data, status }` |
| GET | `/api/v1/web/get_profile_pic_props/<username>/` | 200 | `{ show_profile_pic_sync_reminders, show_change_profile_pic_confirm_dialog, remove_profile_pic_*, … }` |
| POST | `/api/v1/web/fxcal/ig_sso_users/` | 200 | `{ status }` |

### Internal transport (`/ajax/...`), `/sync/`, telemetry, manifests

| Method | Path | Status | Notes |
| --- | --- | --- | --- |
| GET | `/ajax/bootloader-endpoint/` | 200 | JS module bootloader |
| POST | `/ajax/bulk-route-definitions/` | 200 | route definitions |
| POST | `/ajax/bz` | 200 | telemetry |
| POST | `/ajax/qm/` | 200 | telemetry |
| POST | `/sync/instagram/` | 200 | client sync |
| POST | `/logging_client_events` | 200 | returns client logging config |
| GET | `/btmanifest/1050469598/instagram/main` | 200 | 238 KB JS bundle manifest |
| GET | `/data/manifest.json` | 200 | PWA manifest |

### Static assets

`/rsrc.php/v4*/…js`, `/rsrc.php/v5/*.css`, `/rsrc.php/v4i*` concatenated
locale bundles, `scontent-*.cdninstagram.com` media. All 200. These already flow
through the public loader's asset proxy, which is unchanged.

## Compatibility conclusion

Two separate things are true, and conflating them would be the easy mistake:

1. **The public loader works** — it serves Instagram's real frontend, including
   these authenticated pages, because the browser fetches assets from
   `static.cdninstagram.com` through `/__ig/`. That is unaffected by this work.

2. **The application backend is not wired into Instagram's frontend.** Instagram's
   client calls `/graphql/query` with persisted `doc_id` values it obtains from
   its own bundles, and `/api/v1/*` on its own origin. To make Instagram's
   frontend talk to `/__backend` would require rewriting its JavaScript to
   redirect those calls — which this project explicitly forbids ("do not
   arbitrarily modify JavaScript bundles"), and which would break on the next
   bundle rotation anyway.

So the "compatibility layer" is a **documented mapping**, not an integration:
the table above records what Instagram's frontend actually needs, and
`docs/api-compatibility.json` records which of those this backend can serve
(none) and which it deliberately does not attempt.

## What would be needed to go further

Serving these calls from `/__backend` would require Instagram's session
credentials to be replayed server-side and its persisted-query semantics
reimplemented — i.e. building a credentialed Instagram client proxy. That is out
of scope here: it would mean collecting and replaying session cookies, which the
requirements forbid, and it would break whenever Instagram rotates its doc_ids.
