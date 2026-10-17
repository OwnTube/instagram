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
| Likes, comments, persistence | yes | `engage-operations` | genuine-engage check | |
| Profile, grid, follow lists | yes | profile suites | genuine-profile check | |
| Profile photo change/remove | yes | `profile-picture` | yes (`3786953`) | |
| Profile Message button | yes | `profile-message` | yes (`2932deb`) | |
| Search | yes | search suites | genuine-search check | |
| Explore `/explore/` | no | - | - | **Blocked**: the client never names its root module; no genuine route definition is stored |
| Notifications | yes | activity suites | genuine-activity check | |
| Direct inbox, threads, send | yes | direct suites | yes | Not live: the realtime transport is not reproduced, so new messages need a reload (task: do last, per user) |
| Notes: share, tray, audience | yes | `test/notes.test.js` | yes (`probe-notes-after-reload`, `probe-notes-mutual`) | |
| Notes: delete from the tray | yes (server) | `test/notes.test.js` | no | The tray popover module `PolarisInboxTrayItemPopover.react` is not in the snapshot; queued for the next acquisition pass |
| Stories, story viewer, highlights | yes | stories/highlights suites | yes | |
| Story archive page `/archive/stories/` | no | - | - | **Blocked**: its root module is not named in the client bundles |
| Saved posts tab `/<user>/saved/` | no | - | - | **Blocked**: its tab entry point is not named in the bundles (only `PolarisProfileSavedTabEntryPointVariables` is). Saving and unsaving posts works |
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
