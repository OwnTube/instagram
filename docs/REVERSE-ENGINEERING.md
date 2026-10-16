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
