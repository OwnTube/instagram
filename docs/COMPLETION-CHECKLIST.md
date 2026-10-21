# Completion checklist

This is the working definition of "done" for the Instagram Runtime Loader. It
is updated as features are implemented and verified. Each feature records
four things:
- **Src**: implemented in source;
- **Test**: automated regression test;
- **Browser**: checked in a real browser against the pinned client, with the
  screenshot under `test-artifacts/screenshots/`;
- **Blocked**: what is missing upstream or needs outside authorisation.

A route returning HTTP 200 does not count as working.

Active client: `rev1050722040-20261017T170808Z` (revision 1050722040).

## P0. Complete the pinned pages and fix desktop Reels

Owner priority, 2026-10-21: most expected pages are missing, and the Reels
video fills the page instead of using the proper desktop layout. Finish page
coverage and sizing before adding unrelated features. Implement the minimum
local API contracts each page needs to load and behave correctly as part of
that work. A missing captured module is an acquisition task with a concrete
next step, not evidence that the page cannot exist.

Source review baseline: `9b8285b81ca32dba4d9402058484ff1ee72b6363`.
These are pending tasks; this review does not mark any page fixed.

### Why page coverage currently falls through the gaps

| Evidence in the current source | Consequence |
| --- | --- |
| `scripts/client-acquire.js` has four anonymous `DOCUMENTS`; its default module sets start from the snapshot builder's `ROUTES` | New page roots and signed-in page bootstrap data are not comprehensively acquired. Previously captured answers and explicit `--modules` / `--set` can add coverage, but there is no complete required-page inventory driving the pass. |
| `scripts/client-snapshot.js` defines only `home` and `profile` in `ROUTES` | The manifest cannot comprehensively report whether Direct, stories, notifications, Reels, settings, saved posts and other expected routes have their required resources. |
| The committed manifest reports `knownMissing: []` and `scope.complete: true` for six browser checks | Those values describe the narrow registered scope; they do not establish that all pages exist. |
| `src/server.js` dispatches some routes separately; `src/shell/templates.js` recognizes only a subset of URL patterns | Acquisition, manifest coverage and runtime navigation can disagree. Profile subpages and some content deep links have no matching signed-in dispatch. |
| `scripts/route-audit.js` exits based only on upstream attempts; `scripts/route-screens.js` exits based only on upstream/external requests | Broken documents, wrong pages, browser errors and failed resources can be reported while the audit command still succeeds. |

### Task order

- [x] **1. Make one page registry drive acquisition, building, dispatch and verification.**
  Done: `src/pages/registry.js` lists 33 pages (patterns from the client's
  own route builders; roots from the pinned routes or the HAR's recorded
  signed-in route definitions; `root: null` plus a next step where none was
  recorded) and `NOT_SERVED` with a reason for every other page builder.
  It drives:
  - acquisition: anonymous documents and the module sets of every page;
  - the snapshot manifest: the `pages` coverage section;
  - document dispatch: `src/server.js` `canonicalDocPath`/`signedInRouteFor`. A signed-in page
    the server cannot serve is now the client's error route, HTTP 501 with
    `x-clone-page-unavailable`, never the anonymous login page;
  - verification: `scripts/route-audit.js`, `scripts/route-screens.js`, `npm run pages`.

  `test/pages.test.js` fails if a route builder of the active snapshot is
  missing from the registry. Current coverage (`npm run pages`, rev
  1050722040): 7 served, 2 anonymous documents, 1 missing answer (post: no
  `PolarisDesktopPostRoot.react`), 1 missing document
  (`/accounts/password/reset/`), 20 not served. The route audit
  (`node scripts/route-audit.js`) exits 1 until they are.
  Record each observed web route pattern, aliases, access requirements, genuine
  entry point/root, props, parameter extraction, component bindings, bootloader
  answers, required scripts/styles, data operations and browser assertions.
  Populate it from the client's real route definitions and navigation links.
  Cover home, Explore/search, profiles and their available tabs, post/reel
  links, desktop Reels, stories/highlights, Direct/thread URLs, notifications,
  edit profile/settings, saved pages, archive/activity and authentication
  pages exposed by the captured web client. Distinguish pages, overlays and
  intentional external links. Record any mobile-only or unavailable surface
  with evidence instead of inventing a web page.

- [ ] **2. Add a local HAR/capture import path and finish the capture.**
  Import path done: `node scripts/client-import-har.js <file.har>` takes only
  static bundles (URL-keyed; a stored URL is never overwritten; differing
  bytes are reported), bootloader answers (keyed by `modules|nb_modules`
  only) and navigation documents, staged per revision under
  `.cache/acquired/har-<stamp>-rev<rev>/`. It never reads API responses,
  headers or cookies, and never copies the HAR. `client-snapshot.js build
  --acquired A,B` combines staging of one revision and refuses mixed
  revisions (`test/client-import.test.js`).

  Supplied HAR imported: 44 new static bundles, 13 already stored with
  identical bytes, 9 answers of revision 1051138993, no documents (the build
  refuses it alone).

  Capture status, 2026-10-21: one anonymous pass at 14:52Z found Instagram
  serving revision 1051138993, the HAR's own revision. It staged `/`, then
  `/accounts/login/` answered 429 as the pass's 2nd request; the pass sent
  nothing more. Acquisition now fetches `/accounts/login/` and
  `/accounts/password/reset/` (throttled or refused in earlier passes) after
  the answers and assets, so a 429 there no longer costs the rest.

  Next: after the cooldown, one pass for revision 1051138993 (or whatever
  revision is current then). Then build it with the HAR staging if the
  revisions match.
  Import actual HTML, JavaScript, CSS and bootloader response bodies, decoding
  HAR base64 where needed, into a staged candidate with provenance and hashes.
  The existing `scripts/capture-authenticated.js` produces response shapes;
  it is not a full page/module acquisition pipeline. Capture the missing
  navigation documents and route/bootstrap answers as well as lazy resources.
  Keep account state out of reusable client artifacts and bind local viewer
  state through the existing personalization layer. Do not commit the raw HAR.
  Group material by verified revision and reject cross-revision combinations.

  Useful supplied evidence: `m.har` has 680 requests and contains
  `PolarisClipsTabDesktopRoot.react`, `PolarisClipsTabDesktopContainer.react`
  and `PolarisExploreRoot.react`. Its nine bootloader responses identify
  revision `1051138993`, whereas the current pin is `1050722040`.
  It contains no main Instagram HTML navigation response. Use it to recover
  module/operation evidence and start a new candidate; it is not a complete
  replacement snapshot and must not be spliced into the existing revision.

- [ ] **3. Complete each page's resource closure before activation.**
  Extend the existing module index (`src/runtime/moduleIndex.js`) to report
  missing entry points, named dependencies, resource/component map entries,
  deferred modules and `cr:` bindings per page. Include the corresponding
  styles and exact bootloader request sets. Have the manifest list every
  required page and its actual missing resources, including pages for which
  no root has been captured yet. Finish capture/build/verify on a staged
  revision, then activate it. Preserve explicit misses and revision checks.

- [ ] **4. Fix URL dispatch and preserve route parameters.**
  In `src/shell/templates.js` and `src/server.js`, add the observed routes and
  aliases from the shared registry. Currently `profileRoute()` always chooses
  the posts tab, multi-segment profile tabs are not recognized as profiles,
  `reelsRoute()` always sets `shortcode: null`, and the plural
  `/reels/<shortcode>/` has no signed-in route dispatch even though its
  document is canonicalized to `/`. Story URLs accept a numeric story suffix,
  but `storiesRoute()` always sets `initial_media_id: null`.
  Progress, 2026-10-21:
  - `/stories/<user>/<media id>/` keeps its id: `storiesRoute()` passes the
    URL's `initial_media_id` (a media pk, as `initStoryPage` reads it through
    `getReelIndexByMediaId`). Browser: the viewer opens at that story
    (`test-artifacts/screenshots/deeplink-story-*.png`).
  - `/reels/<shortcode>/` signed in: the Reels tab with `shortcode` set
    (404 not-found route for a code that names no reel). The pinned entry
    point sends it as `data.chaining_media_id`, and
    `PolarisClipsHomeRootQuery` now starts its first page with that reel when
    the viewer may see it (`test/reels.test.js`, `test/signed-in-route.test.js`).
    Browser: `/reels/<older>/` opens at the older reel, the tab at the newer
    one (`deeplink-reel-*.png`).
  - Browser journey `npm run journey:deeplinks` (`scripts/deeplink-journey.js`):
    story tray click from home, back, `/reels/`, a reel link, a story item
    link, refresh, back, back, forward, refresh, forward. Every step keeps
    its URL and shows the expected reel or story; 0 upstream requests
    (`history-*.png`). The Reels tab replaces `/reels/` with the shown reel's
    URL, as the client does.
  - Still open: profile tab dispatch (the tab roots are not in the pinned
    revision).
  Preserve tab, shortcode, initial story/highlight and query parameters using
  the actual client contracts. Verify direct load, refresh, in-app navigation
  and back/forward navigation. A missing route must not look like a successful
  home/login page.

- [ ] **5. Restore the genuine desktop Reels page and its data operations.**
  The current `reelsRoute()` selects `PolarisClipsTabRoot` with empty props;
  the existing checklist records that this produces the mobile viewer.
  Trace the supplied desktop root's route/bootstrap contract, dependencies,
  component bindings and feature providers in its own revision. Its root
  defers `PolarisClipsTabDesktopPage.react`; its desktop container depends on
  `PolarisClipsTabDesktopContainerImpl.react` and desktop Relay fragments.
  Acquire that full dependency chain and its styles instead of swapping a
  root name in isolation.

  The HAR records `PolarisClipsTabDesktopContainerQuery` and
  `PolarisClipsTabDesktopPaginationQuery`. Neither is registered in the
  current source, which implements `PolarisClipsHomeRootQuery` instead.
  Implement the desktop operations with their own captured input/output
  contracts against the existing local clip store, including pagination and
  an empty feed. Check any seed-media operation required by a deep link.

  Match the genuine desktop frame: bound the visible video by the available
  viewport height, preserve its media aspect ratio, leave the navigation and
  action controls usable, and retain the proper gutters. Check portrait and
  landscape media, resizing, fullscreen exit and the mobile breakpoint.
  Establish the native page/layout first; apply only a scoped style fix if
  a measured mismatch remains.

- [ ] **6. Connect the missing pages to functionality already implemented.**
  Reuse `src/clone/routes/accounts.js` for profile form data and saving edits;
  `src/clone/routes/content.js` already exposes an Explore grid endpoint;
  `src/backend/services/social.js` already implements saved posts, story
  archive data and settings. Capture the operations the actual page selects
  and bridge those contracts. This avoids adding unrelated backend features
  while the existing functionality has no reachable genuine page.
  Include the missing home-feed save module, post options, Notes menus and
  profile tabs in the page dependency inventory.

- [ ] **7. Make page coverage and layout real release gates.**
  Derive required browser checks from the page registry instead of only
  `CORE_CHECKS = [login, signup, feed, engage]`. Report integrity, page/resource
  coverage and browser verification separately. Do not label the overall
  client complete while required pages are absent, skipped or untested.
  Make route-audit and route-screens return failure for unexpected document
  errors, the wrong page/root, visible login fallback for a signed-in viewer,
  required resource/API failures, browser exceptions and failed page assertions.
  Use seeded local accounts/content and test both empty and populated states.
  Retain the existing offline/upstream checks.

  Add a genuine Reels browser check: record the video frame's bounding box,
  aspect ratio, control visibility and horizontal overflow. Capture milestone
  screenshots at 1366x768, 1440x900, 1920x1080 and a mobile viewport such as
  390x844. Compare against the corresponding captured native layout; a
  screenshot or a successful media API test alone does not prove correct sizing.

Done for this priority means every required page is listed, captured at the
chosen revision, served by the correct native route, usable through direct
and in-app navigation, and verified in the browser; desktop Reels must also
pass its layout checks. Existing distribution work remains in section A.
Live messaging remains a later task, after these page/layout priorities.

## A. Installation and distribution

| Item | Src | Test | Verified | Notes |
| --- | --- | --- | --- | --- |
| Fresh clone `npm ci` + `npm test` | yes | `npm test` in a clean clone (364/364 at `0dbc5f9`) | clean clone `.scratch/accept` | |
| Pinned artifact download + per-blob verification + atomic install | yes | `test/client-artifact.test.js` | clean clone, local host stand-in | |
| Corrupt or interrupted artifact never replaces a valid install | yes | same | clean clone | |
| Artifact published at an authorised location | no | - | - | **Blocked on the owner's distribution decision**: the file is Instagram's proprietary client. See `client/README.md` "Publishing" |
| Node version check, port-in-use message | yes | `test/startup.test.js` | Node 20/21, two instances | |
| License | - | - | - | **Owner decision pending**: no license chosen |

## B. Core client flows

| Flow | Src | Test | Browser | Blocked / notes |
| --- | --- | --- | --- | --- |
| Signup, login, logout | yes | auth suites | genuine-signup/login checks | |
| Home feed, empty feed, post rendering | yes | feed suites | genuine-feed check | |
| Likes, comments, persistence | yes | `engage-operations` | genuine-engage check; post modal like (`probe-post-liked`, `probe-post-like-after-reload`) | In the post modal opened from a profile grid, the heart fills at once but the count text updates on the next load. This is the client's own behaviour: `PolarisAPILikePostMutation` selects only `id` and `has_liked`, and the profile grid's Relay-to-Redux sync (`syncPolarisRelayProfileUserTimeline`) copies the grid's earlier `like_count` back |
| Comment likes, replies | yes | `engage-operations` | yes (`probe-sweep-comment-reply`, `probe-comment-liked-after-reload`) | A comment like notifies the comment's author |
| Profile, grid, follow lists | yes | profile suites | genuine-profile check | |
| Profile photo change/remove | yes | `profile-picture` | yes (`3786953`) | |
| Profile Message button | yes | `profile-message` | yes (`2932deb`) | |
| Search | yes | search suites | genuine-search check | |
| Explore `/explore/` | no | - | - | **Blocked**: the client never names its root module; no genuine route definition is stored |
| Notifications | yes | activity suites | genuine-activity check | |
| Direct inbox, threads, send | yes | direct suites | yes | — |
| Live Direct (no refresh): a new message appears in the open thread, in the sender's other tabs and in the inbox row (unread dot, Direct badge); "Seen" updates live | yes (`src/realtime/`: DGW gateway + LS sync deltas; `DGWEnvUtil` patch so the gateway opens on this origin) | `test/realtime.test.js` (frame and LS bytes checked against the client's own codec and decoder; members-only delivery; session end closes the stream) | yes (`probe-live-message-thread`, `probe-live-inbox-row`, `probe-live-inbox-page`, `probe-live-seen`; video `test-artifacts/videos/live-direct-messages.mp4`) | Typing indicators and presence are acknowledged but not sent. Emoji in messages render as broken images (separate bug) |
| Share a post to Direct (share sheet Send), shared-post card, open from the thread | yes | `test/direct-share.test.js` | yes (`probe-sweep-share2`, `probe-share-thread`, `probe-share-open-post`) | A shared post the viewer can no longer see reads as a placeholder |
| Notes: share, tray, audience | yes | `test/notes.test.js` | yes (`probe-notes-after-reload`, `probe-notes-mutual`) | |
| Notes: delete from the tray | yes (server) | `test/notes.test.js` | no | The tray popover module `PolarisInboxTrayItemPopover.react` is not in the snapshot; queued for the next acquisition pass |
| Stories, story viewer, highlights | yes | stories/highlights suites | yes | |
| Story archive page `/archive/stories/` | no | - | - | **Blocked**: its root module is not named in the client bundles |
| Saved posts tab `/<user>/saved/` | no | - | - | **Blocked**: its tab entry point is not named in the bundles (only `PolarisProfileSavedTabEntryPointVariables` is). Saving and unsaving posts works (row below) |
| Save button on home feed posts | no | - | no | The feed's save button is the client's `cr:5226` slot (it renders `PolarisSaveButtonWithPopover`, whose fragment the client passes it); that module is not in the snapshot. Queued for the next acquisition pass. Saving from the post view works |
| Save / unsave a post, collection picker | yes | `test/saved-posts.test.js` | yes (`probe-post-save-after`, `probe-post-saved-after-reload`) | Collections cannot be created from the web client in this snapshot; the picker lists existing ones |
| Close-friends stories | n/a | - | - | Not creatable on web: the story upload (`PolarisAPICreationFinalizeStory`) sends no audience. Close Friends on web covers Notes (done) and the list itself (done) |
| Notes audience picker | no | - | no | `PolarisInboxTrayComposerAudienceMenu.react` not in the snapshot; queued for the next acquisition pass. Default audience (mutual follows) works |
| Post archive | n/a | - | - | Not a web feature: the genuine post menu (`PolarisPostOptionsPopover.next.react`) has no archive item. Its own-post items are delete, edit, hide from grid, commenting and like count |
| Own-post options menu | partial | - | no | `PolarisPostFastOptionsModal.react` not in the snapshot; queued for the next acquisition pass |
| `/p/<code>/` direct load | yes (route, gated on the snapshot) | `signed-in-route.test.js` | not yet | Needs `PolarisDesktopPostRoot.react` (bound to `cr:2882`) and `PolarisDesktopPostPage.react`. The page module is not in the snapshot; the next acquisition pass will request both. The pass on 2026-10-17 22:14Z hit a 429 (cooldown until 23:18Z) |
| Post modal inside the app | yes | - | yes | |
| Reels upload, feed playback, profile grid | yes | `reels.test.js` | yes (`3a5a485`) | |
| Reels tab `/reels/` layout | partial | - | yes (`probe-reels-before`) | **Blocked**: the route renders the client's mobile viewer, which fills the width. The desktop vertical layout (`PolarisClipsTabDesktopContainerImpl`) is only reachable through the in-app immersive modal. The signed-in desktop Reels-tab root is not in the snapshot |
| Create post (photo, video) | yes | upload suites | genuine-create check | |
| Password reset | yes | auth suites | yes | |
| Edit profile `/accounts/edit/` | no | - | - | **Blocked**: the page document is served only to signed-in accounts; getting it would need a personal session (not allowed) |

## C. Runtime and reliability

| Item | Status |
| --- | --- |
| Pinned-only serving, no upstream fallback | `test/pinned-client.test.js`, `upstream-leak` |
| Integrity, activation, rollback, restart | `client:verify`, `client:activate`, `client:rollback` and the snapshot tests |
| Normal browsing contacts no Instagram/Meta host | every browser probe reports `external 0 upstream 0` |
