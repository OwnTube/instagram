# How the genuine Instagram web client starts and loads code

Evidence-backed notes. Every claim names where it was read: a module in the
stored public bundles (`.cache/assets`, indexed by `src/runtime/moduleIndex.js`),
a stored anonymous document (`.cache/documents`) or a stored bootloader answer
(`.cache/bootloader`). Hypotheses are marked as such.

## 1. Bootstrap payloads in the document

The HTML carries `<script type="application/json" data-sjs>` blocks processed by
`ServerJSPayloadListener` (inline `requireLazy(["ServerJSPayloadListener"],…)`).
Each block holds `define` tuples `[name, deps, exports, id]` (config modules such
as `CurrentUserInitialData`, `BootloaderConfig`, `PolarisViewer`, `cr:NNN`
component replacements) and `require` tuples `[module, method, deps, args]`.

Support data arrives as require calls (stored `/` document):

- `["HasteSupportData","handle",null,[{clpData,gkxData,ixData,metaconfigData,qexData,qplData,justknobxData}]]`
  (gatekeepers, experiments, image sprites);
- `["Bootloader","handlePayload",null,[{consistency,rsrcMap,compMap,indexUpgrades}]]`
  (resource map hash -> {type, src}; component map component -> resources).

## 2. Route selection and initialisation

`["CometPlatformRootClient","initialize",…,[args]]` (module
`CometPlatformRootClient` -> `CometPlatformRouterRootClientRenderer.initialize`
-> `CometPlatformBaseClientRootRenderer.initClientRender`) receives:

- `initialRouteInfo.route`: `actorID`, `rootView` / `hostableView`
  (`{allResources, resource, props, entryPoint}` as `__dr` references),
  `tracePolicy`, `canonicalRouteName`, `polarisRouteConfig`, `params`, `url`;
- `expectedPreloaders`: `[{actorID, preloaderID, queryID, variables, queryName}]`
  handed to `CometPreloaderInit.initPreloaders`;
- `ssrEnabled` (server-rendered markup is hydrated), `additional_roots`.

On the anonymous `/` the root is `CAAIGLoginHomepageRoot` with preloader
`CAAFetaIGLoginHomepageQuery`, all under `actorID: "0"`. The route is chosen by
the server; nothing in the client derives it from `CurrentUserInitialData.USER_ID`.
That is why editing `USER_ID` alone never produced a signed-in page.

The signed-in home is `PolarisFeedRoot.entrypoint`
(`getPreloadProps` names `PolarisFeedTimelineRootV2Query`, the stories tray
query and, gated, `PolarisSuggestedUserListQuery`; `root` is
`JSResourceForInteraction("PolarisFeedRoot.react")`).

## 3. Module loading (Bootloader)

Read from the `Bootloader` module:

- `loadModules(ms)` proceeds only if `j(ms)`: every component is in the
  component map `T` and every hash in its `r`/`rdfds.r`/`rds.r` is in the
  resource map `D`. Otherwise it is queued and retried only when a later payload
  adds component-map entries. An unknown component waits silently (no error,
  no request). This is why forcing `PolarisFeedRoot` into the anonymous
  document stalled: the anonymous page carries no entry for it.
- Exception: with `BootloaderConfig.fastPathForAlreadyRequired` (true in the
  stored documents) a request whose modules are all already defined resolves
  immediately (`pe(e)` = `ifRequireable`).
- Components flagged `be` in the component map are loaded through
  `BootloaderEndpoint` (`/ajax/bootloader-endpoint/?modules=…`).

`HasteResponse.handle(answer)` applies an endpoint answer
`{allResources, tieredResources, hsrp:{hsdp,hblp}, jsmods}`:
`HasteSupportData.handle(hsdp)`, `Bootloader.handlePayload(hblp)`, then loads
`allResources` (tiered loading is off: `tieredLoadingFromTier: 100`), then
`new ServerJS().handle(jsmods)`.

## 4. Where the signed-in feed root's code comes from

The anonymous pages' resource maps do not contain `PolarisFeedRoot.react`.
Instagram's bootloader endpoint, asked anonymously
(`/ajax/bootloader-endpoint/?modules=PolarisFeedRoot.react&__a=1&__rev=1050596935`,
one request, HTTP 200, 428 KB, stored in `.cache/bootloader`), answers with:
`allResources` (29 hashes), a 518-entry `rsrcMap`, 160 `compMap` entries for the
lazily loaded parts, support data, 412 `define`s and 69 `require`s (the modules
the feed needs eagerly: `PolarisFeedPage.react`, `PolarisStoriesV3TrayContainer.react`,
`PolarisNotificationsNavBadge.react`, ...).

After storing every public file that answer names (`npm run cache:warm`):
`PolarisFeedRoot.react` is defined locally, and its static dependency closure
(3,323 modules) resolves with **0 missing**. The login root's closure (1,782)
also resolves fully. This is public code metadata obtained without any
account; nothing was invented.

## 5. CSS loading

`CSSLoader` / `CSSPoller`: stylesheets present in the document are watched by
polling `link.sheet.cssRules` every 20 ms until rules are readable (same-origin
sheets from `/__ig` are readable), with a `CSSLoaderConfig.timeout` deadline.

## 6. Payload processing: `data-content-len` (root cause of the "tamper check")

`ServerJSPayloadListener.process()` (module of the same name) walks
`script[data-sjs]:not([data-processed])` and handles a block only if
`textContent.length === data-content-len`; otherwise it leaves the block
unprocessed, silently (a completeness check for streamed HTML). Each block is
followed by its own `requireLazy(["ServerJSPayloadListener"], m => m.process())`
trigger. A nonce mismatch only warns (`Env.sjsNonceEnforce: false`).

Consequences, all previously misread:

- Editing `CurrentUserInitialData.USER_ID`, the csrf token or the LSD token
  changed their block's length, so the block (with all its defines) was never
  processed and the client never mounted. There is no tamper check.
- The encryption-key swap appeared "safe" only because our key has the same
  length as Instagram's.
- Rewriting the logo sprite URL in `ixData` broke boot for the same reason.

`src/shell/sjs.js` (`withContentLength`) now rewrites `data-content-len` for
every edited block; `test/sjs-fidelity.test.js` covers it.

## 7. The signed-in home route, built from verified parts

With correct block lengths, the signed-in route works offline from the
anonymous `/` document plus the stored bootloader answer
(`src/shell/signedInRoute.js`, `SHELL_SIGNED_IN_HOME=1`):

1. the `initialize` tuple is switched to `PolarisFeedRoot.entrypoint` under the
   viewer's actor (no expected preloaders, `ssrEnabled: false`) and moved after
   the page's own payload blocks, because the feed entry point evaluates
   support data at initialisation (`getPolarisFeedInitialPageSize` reads gkx
   `8953`, which the anonymous page delivers in block 29 of 39, after its own
   initialize in block 11);
2. before it: the answer's `allResources` as tags with `data-bootloader-hash`,
   then one block applying the answer as `HasteResponse.handle` does
   (`HasteSupportData.handle`, `Bootloader.handlePayload`, `jsmods`), then
   `RequireDeferredReference.unblock([root modules], "sd"|"css")`, the same
   "delivered" signals the anonymous page sends for its own root
   (`RequireDeferredFactoryEvent` = `SUPPORT_DATA` "sd", `CSS` "css");
3. a copy of the page's own process trigger.

Observed (offline Chromium, synthetic local user): the genuine signed-in shell
mounts (left navigation, the signed-in "Turn on Notifications" prompt), requests
carry `__user=<local pk>`, and the client issues `PolarisFeedTimelineRootV2Query`
(answered locally), `PolarisStoriesV3TrayContainerQuery`,
`PolarisSuggestedUserListQuery`, `usePolarisNotificationsNavItemQuery`,
`IGDBadgeCountOffMsysQuery`, `QuickPromotionSupportIGSchemaBatchFetchQuery`, ...
The remaining operations are the next work list.

## 8. What the home feed's answer must contain (Relay contract)

The client normalises a GraphQL answer with its compiled operation
(`<Operation>.graphql`, `operation.selections`). Read from the stored bundles
(`relay-runtime/store/*`, `PolarisFeedPage.react`, `PolarisVirtualFeed.react`,
`polarisFeedDedupeIdsResolver`) and confirmed in the browser's Relay store:

- A server field missing from the answer is left missing in the store (not
  null). Readers that need it then report missing data, so the answer is
  completed to the operation's selection set with explicit nulls
  (`src/runtime/graphqlContract.js`).
- Not server data, never written: `__id` (the record's client id; a null there
  breaks `ClientID`/`RelayResponseNormalizer`, "reading 'indexOf'"),
  `ClientExtension` selections (client schema, e.g. `is_hidden`,
  `show_translation`, `unfollowed_users`; RelayReader does not count them as
  missing), and client resolver fields themselves (`client__feedDedupedIds`).
- `RelayResolver` nodes carry the resolver's root `fragment`; the server fields
  a resolver reads may be selected only there. `ResolverFragments.readFragment`
  throws a missing-data sentinel if any is absent, and the resolver yields
  nothing.
- The feed list: `PolarisFeedPage.react` takes
  `xdt_api__v1__feed__timeline__connection.client__feedDedupedIds.dedupedItems`
  (the resolver drops edges whose author is in `unfollowed_users` and de-duplicates
  by media id), and `PolarisVirtualFeed.react` calls `setShowEmptyFeed(true)` when
  the list is empty, which shows `PolarisFeedEmptySULWrapper` (suggested users).
  So with `media.view_state_item_type` / `media.brs_severity` absent, a feed answer
  with posts still rendered as an empty feed.
- The connection is stored under the handle key
  `__PolarisFeedPage__xdt_api__v1__feed__timeline__connection_connection(_variant:"home")`
  (`page_info` with `end_cursor`/`has_next_page`, `edges[].cursor`, `edges[].node`).

Reproduce: `npm run verify:genuine-feed` (strict offline; docs/IMPLEMENTATION-STATUS.md).

## 9. Viewer-specific component bindings (`cr:NNNN`)

An endpoint answer's `jsmods.define` carries `cr:NNNN` entries: component
replacements the server chooses per viewer. Bound, an entry names a module;
unbound, it is `["cr:N",[],{"__rc":[null,null]},-1]` (same answer, other slots).
The feed root's answer is fetched anonymously, so it carries the logged-out
choices. Read in the stored bundles:

- `PolarisShellHeader` renders `cr:2696` whenever it is bound;
  `PolarisFeedRoot` never passes `hideHeader`. `cr:2696` -> `PolarisDesktopNav`,
  which renders `cr:4477` -> `PolarisDesktopNavLoggedOutContainer` ("Log In",
  "Sign Up"). Unbound, the header falls back to
  `PolarisFeedMobileTopNavigation`, which has its own logged-in branch.
- `cr:7457` is gated in the client by `useHasLoggedOutMobileTopNav`, `cr:4197`
  by `useShouldShowLoggedOutCallToAction`; they need no edit.

`src/shell/signedInRoute.js` (`LOGGED_OUT_ONLY`) unbinds `cr:2696` and
`cr:4477` for a signed-in viewer. Nothing is hidden with CSS and no state is
hardcoded: the client renders its own signed-in header.

## 10. Home operations and revision consistency

Contracts: `node scripts/graphql-contract.js <Operation>` prints the response
tree of the client's compiled operation. The answers are in
`src/clone/homeOperations.js` (contract notes at the top of that file). Two
client rules decide what is "truthful" there:

- Direct unread state (`XFBIGDirectViewerThreadIsUnreadResolver`): unread when
  `marked_as_unread`, or when the read receipt for `CurrentUser.getEIMU()`
  (`CurrentUserInitialData.IG_USER_EIMU`, set by the shell to the viewer's pk)
  has a `watermark_timestamp_ms` older than `last_activity_timestamp_ms`.
- The ads GraphQL endpoint (`/ads/igwww_ads_graphql/`) is called by a network
  layer that sends no CSRF token; only `PolarisStoriesV3AdsPoolWWWQuery` is
  answered there (empty), every other operation gets 404.

Revision consistency (`ClientConsistency`): an endpoint answer carries
`consistency.rev`; when it differs from the page's and its modules overlap the
loaded ones, the client asks for a soft or hard refresh. Offline, that reload
gets the same stale page. So the page documents and every bootloader answer
must share one revision: `scripts/refresh-client.js` re-stores them together
(anonymous requests, one each, stops at the first non-200, backs up first).
Bootloader answers are keyed by `modules|nb_modules|__rev`; the client
sometimes combines a blocking and a non-blocking module in one request, which
is a separate key.

## 11. Comet SSR on the signed-in route (React #418), route definitions

The anonymous `/` document is server-rendered: `CometSSRClientInjector.ssrInit`
(`enabled: true`, `eid: mount_0_0_*`, `disabled_status: "fail_ssr_disabled"`)
and `onPayloadReceived` passes (`FIRST`, `LAST`) for the logged-out login
homepage. `CometSSRStateManager` is a state machine: with SSR enabled,
`onRootComponentLoaded` after the payloads leads to `HYDRATION`/`SSR_SUCCESS`
and `hydrateRoot(mount, root)`; with `ssrInit({enabled:false})`, `ssrInit`
calls `disableSSRInFlight` (state `SSRDisabled`) and the root component goes to
`CLIENT_RENDER`, `CometClientRootRendererUtils.initReactRender` (createRoot);
payloads arriving in that state change nothing. Our signed-in route replaced
the root but left SSR enabled, so React hydrated the logged-out markup with the
feed tree: #418 ("server rendered HTML didn't match"), then a client-render
fallback. Fix: the signed-in route's document carries `enabled: false`
(`disableAnonymousSSR` in `src/shell/signedInRoute.js`).

REA check (REA 6.5.0, `rea analyze-javascript-application` over the three
modules extracted from the stored bundle at rev 1050627067; evidence id
`ev_6fc1ad03b16d9c2f62c5c86acee5561e05e2880bf8228a748f9aa18223a2eb98`): the
semantic graph's call sites (each with its enclosing function node) put
`ReactDOM.hydrateRoot` in `CometSSRStateManager` (the `$7` hydration helper)
and in `CometSSRMergedContentInjector`; `initReactRender` in the state
manager's client-render helper `$9` and in the merged-content injector;
`onSSRInit` and `disableSSRInFlight` in `CometSSRClientInjector.ssrInit`. That
matches the reading above. Reproduce: extract the modules (each `__d("Name"`
up to the next `__d(`) into a directory with a `package.json`, run the command
with `--format json`, and filter `semantic_graph.nodes` of kind `call-site`.
REA was used only on locally stored public bundles.

Route definitions: `fetchAnonymousCometRoute` accepts an answer only if it has
both `payloads` and `sr_payload` (else `mustfixThrow("Routing payload
expected...")`). Our local answer lacked `sr_payload`. Each URL entry with
`error` is read by `parseCometRouteFetchPayload` as "unavailable" (no route
definition), and the router loads that URL as a page.

Facebook cross-site probe: `PolarisLoggedInFBUserProvider` fetches
`PolarisSiteData.cross_site_request_url` with facebook.com credentials and skips
the probe when that is null. This origin has no Facebook session, so the shell
sets it to null.
