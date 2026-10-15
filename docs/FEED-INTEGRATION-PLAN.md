# Feed integration: Phase 1 findings and handoff

Status: **investigation complete, implementation not started.** Nothing in this
document claims a working feed. It records what was measured against the live
origin so the next implementation phase starts from evidence rather than
assumption.

Method: raw HTTP (`curl`) plus headless Chromium over CDP against
`https://www.instagram.com/` and against the loader at `http://localhost:12000/`.
Every claim below has a command behind it; the commands are in the
"Reproducing" section.

## 1. Why the logged-out client shows no feed

### The route is chosen by the server from the session, not by the client

The document carries the route the server decided to render:

| Document | `ef_page` | `PolarisFeedRoot` | feed data embedded |
| --- | --- | --- | --- |
| anonymous `GET /` | `PolarisCAAIGLoginHomepageRoute` | 0 | no |
| authenticated `GET /` | `PolarisFeedRoute` | 16 | no |

Anonymous visitors are served the **login route**. The feed route is never
mounted, so the feed's data request is never issued. This is not a client-side
gate that can be opened with a header.

Tested and rejected: Fetch Metadata variants. `sec-fetch-site: none`,
`same-origin` and `cross-site` all yield `PolarisCAAIGLoginHomepageRoute` with
`PolarisFeedRoot=0`. There is no anonymous document variant that contains the
feed.

### The feed's code is not shipped to anonymous clients

`PolarisFeedRoot.react` and `PolarisFeedRoot.entrypoint` appear 0 times in the
anonymous document and 9/7 times in the authenticated one. The anonymous shell
does not reference the feed module at all.

The feed bundles *are* publicly fetchable from the CDN — `static.cdninstagram.com`
serves them to anonymous requests with HTTP 200 — but the anonymous shell never
references four of the eight authenticated-only bundles, so nothing loads them.
Fetchability is not the obstacle; reachability from the anonymous shell is.

### Feed data is fetched at runtime, not embedded

The authenticated shell embeds the viewer object and the route bootstrap, but
**zero feed items**: `feed_items`, `edge_media`, `like_count`, `taken_at` and
`media_type` all appear 0 times. The feed arrives at runtime via
`POST /graphql/query` with `doc_id 28805668309050001`
(`PolarisFeedTimelineRootV2Query`), returning
`data.xdt_api__v1__feed__timeline__connection` with `edges[].node`.

### Instagram's data APIs reject anonymous callers

| Endpoint | Anonymous result |
| --- | --- |
| `POST /graphql/query` (feed doc_id) | 403 |
| `GET /api/v1/feed/timeline/` | 302 |
| `GET /api/v1/discover/ayml/` | 302 |
| `GET /ajax/bootloader-endpoint/` | 404 |
| `GET /btmanifest/1050469598/instagram/main` | 404 |

So the authenticated feed cannot be activated without Instagram credentials.
Obtaining them is out of scope and forbidden by the standing requirements.

**Conclusion: `PolarisFeedRoot` is not a viable reuse target for an anonymous
clone.** Reaching it would require either Instagram auth or shipping
authenticated bundles and hand-building the route bootstrap the server
withholds. Both are rejected.

## 2. The viable reuse target: the logged-out popular/explore surface

Instagram serves a **genuine, anonymous, server-rendered media grid** on several
public routes:

| Route | `ef_page` | media images in HTML |
| --- | --- | --- |
| `/explore/` | `PolarisLoggedOutPopularSearchHomeRoute` | SSR keyword list |
| `/popular/<keyword>/` | `PolarisLoggedOutPopularSearchRoute` | 49 |
| `/explore/tags/<tag>/` | `PolarisLoggedOutPopularSearchRoute` | 48 |

These return 200 to anonymous requests and render a real Instagram grid
component with real media. They are the smallest viable integration: a genuine
Instagram component, available without credentials.

### The data contract, exactly

The page embeds a Relay prefetch under the key:

```
adp_PolarisLoggedOutPopularSearchPageQueryRelayPreloader_<hash>
```

whose result is:

```json
{"data": {
  "xig_logged_out_popular_search_media_info": {
    "edges": [ { "node": { ... }, "cursor": "AQHT…" } ],
    "page_info": { "start_cursor": "…", "end_cursor": "…", "has_next_page": true }
  }
}}
```

Media node shape (verified by parsing the embedded JSON):

```json
{
  "__typename": "XIGPolarisVideoMedia",   // or "XIGPolarisMedia"
  "code": "DdhnWJpt77z",                  // shortcode
  "pk": "3990643790832975603",
  "id": "POLARIS_3990643790832975603",
  "__isXIGPolarisMedia": "XIGPolarisVideoMedia",
  "user": { "pk": "…", "id": "…", "username": "…",
            "is_verified": true, "profile_pic_url": "…" },
  "caption": { "text": "…" },
  "display_uri": "…",                     // image URL
  "play_count": 5439301,
  "video_versions": [ { "url": "…" } ]
}
```

### Pagination contract

Triggered by scrolling. Request is form-encoded `POST /api/graphql`:

| Field | Value |
| --- | --- |
| `doc_id` | `28866543699699030` |
| `fb_api_req_friendly_name` | `PolarisLoggedOutPopularSearchPagePaginationQuery` |
| `fb_api_caller_class` | `RelayModern` |
| `variables` | `{"after":"<end_cursor>","debug":null,"include_reel_experience_fields":true,"keyword":"psg","media_count":8}` |
| `server_timestamps` | `true` |
| `__a` / `__user` | `1` / `0` |

Response: `Content-Type: text/javascript`, body
`{"data":{"xig_logged_out_popular_search_media_info":{"edges":[…],"page_info":{…}}},"extensions":{…}}`.
No `for(;;);` prefix was observed on `/api/graphql` responses in the browser.

A sibling operation, `PolarisLoggedOutPopularSearchPageRelatedKeywordsPaginationQuery`
(`doc_id 27713006471707159`), pages the keyword list with
`{"keyword","related_keywords_count":10,"related_keywords_cursor":"<n>"}`.

### A server-rendering caveat worth knowing

`GET /explore/` returns **different content depending on request headers**:
627 KB without browser-like headers (content not in the HTML), 1,017 KB with
them (content in the HTML). Any fetch of these routes must send browser-like
`Accept`, `User-Agent` and Fetch Metadata headers or it will receive the reduced
document. The loader already relays these; the point is not to test with bare
`curl` and conclude the route is empty.

## 3. Recommended implementation shape

Reuse the real component; patch the data layer at the transport boundary. Do not
rebuild the grid.

1. **Reuse** `PolarisLoggedOutPopularSearchRoute` — a genuine Instagram grid
   component that runs anonymously. Keep its markup, styles and interaction code.
2. **Translate** our database into the contract above. Our `posts` table already
   has the needed fields; map `posts.toPublic` → the media-node shape
   (`media_url`→`display_uri`, `caption`→`caption.text`, author→`user`,
   like/comment counts into whatever the grid reads).
3. **Patch two seams, not the bundles:**
   - the **SSR prefetch**: when serving `/popular/*` and `/explore/tags/*`,
     replace the `adp_…RelayPreloader` payload with our own data for that
     keyword/tag;
   - the **pagination transport**: answer `POST /api/graphql` (and
     `/graphql/query`) when `fb_api_req_friendly_name` is
     `PolarisLoggedOutPopularSearchPagePaginationQuery`, reading `after` and
     `keyword` from `variables` and returning the same envelope.
   The client's API paths already resolve to our origin, so this is an
   interception at a boundary we control, not a bundle rewrite.
4. **Auth for the clone.** The backend session cookie is currently scoped
   `path=/__backend` (`src/backend/lib/cookies.js`), so it is not sent on `/` or
   on `/api/graphql`. Widen the path (or dual-set a second cookie) so the loader
   can identify the viewer for the app shell and for the graphql handler.
   "Feed" authorization should come from our `follows`/`users.is_private` rules,
   which `src/backend/services/social.js` already implements.
5. **Reuse existing backend endpoints** where they fit: `GET /feed`
   (requireAuth), `GET /explore` (optional auth), plus posts, likes, comments,
   follows and users. No new data model is needed for the first slice.

### What must not be done

- Do not fabricate feed items or return plausible-looking success envelopes to
  make the UI appear to work.
- Do not patch bundles by regex; the bundles are served byte-for-byte.
- Do not collect or replay Instagram credentials.
- Do not claim the authenticated `PolarisFeedRoot` feed works; it is
  server-gated and out of reach anonymously.

## 4. Reproducing the findings

```bash
# The gate: anonymous vs authenticated route
curl -s https://www.instagram.com/ | grep -o '"ef_page":"[^"]*"'
#   -> PolarisCAAIGLoginHomepageRoute

# The viable target, with browser-like headers (note the size difference)
curl -s -H 'user-agent: Mozilla/5.0 … Chrome/141.0.0.0' \
     -H 'sec-fetch-site: same-origin' -H 'sec-fetch-dest: document' \
     https://www.instagram.com/popular/psg/ -o explore.html
#   -> SSR grid; parse the adp_…RelayPreloader payload for the media contract

# Anonymous data APIs are gated
curl -s -o /dev/null -w '%{http_code}\n' https://www.instagram.com/api/v1/feed/timeline/
#   -> 302

# Live request capture (headless Chromium over CDP)
node scripts/diagnostics/capture-scroll.js http://localhost:12000/popular/psg/ 6
node scripts/diagnostics/capture-bodies.js http://localhost:12000/popular/psg/ 3
```

The diagnostics live in `scripts/diagnostics/` and are tracked:
`list-requests.js` (every request a page makes), `capture-graphql.js`
(GraphQL request bodies), `capture-scroll.js` (pagination after scrolling),
`capture-bodies.js` (GraphQL response envelopes). They need a running server
and a local Chromium; `scripts/lib/browser.js` launches it.
