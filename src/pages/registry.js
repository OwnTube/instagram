'use strict';

/**
 * The page registry: every web page of the pinned client's URL space, in one
 * table that acquisition (scripts/client-acquire.js), the snapshot builder
 * (scripts/client-snapshot.js), document dispatch (src/server.js) and
 * verification (scripts/route-audit.js, test/pages.test.js) all read.
 *
 * Sources, never invented:
 *  - URL patterns are the client's own route builders
 *    (`XPolaris*ControllerRouteBuilder` in the pinned bundles; each entry
 *    names its builder, and test/pages.test.js checks that every page builder
 *    in the active snapshot is listed here, as a page or as NOT_SERVED);
 *  - roots (entry point, root component, route config) are those the pinned
 *    client is served with today (src/shell/signedInRoute.js, each with its
 *    evidence there), or those recorded in a signed-in browser's route
 *    definitions (`har`: the operator-supplied HAR of revision 1051138993,
 *    structure only; .scratch/har-analysis/route_defs.py extracts it). A
 *    root recorded only at another revision is a target to acquire, not
 *    something the pinned revision is served with;
 *  - `root: null` means no route definition for the page has been observed.
 *    Its next step is recorded instead of a guessed module name.
 *
 * Fields:
 *   id         stable page name
 *   kind       'page' | 'redirect' (the server answers with another page's route)
 *   patterns   client route patterns ({name} required, {?name} optional segment)
 *   builder    the route builder module, or null for a literal URL
 *   access     'signed-in' (the app route for a signed-in viewer) or 'anonymous'
 *              (an anonymous document of the snapshot, served to everyone)
 *   served     the route spec builder name in src/shell/signedInRoute.js that
 *              serves the page now, or null
 *   har        the signed-in route definition recorded in the HAR, if any
 *   data       what local data the page shows ('local' or why there is none)
 *   next       the next concrete step while the page is not complete
 *   sample     how verification builds a URL for it from seeded fixtures
 *   expect     browser assertions (pageID of the served route; visible text)
 */

const HAR_REVISION = '1051138993';

const PAGES = [
  // --- Home and feed -------------------------------------------------------
  {
    id: 'home',
    kind: 'page',
    patterns: ['/'],
    builder: 'XPolarisFeedControllerRouteBuilder',
    access: 'signed-in',
    served: 'homeRoute',
    har: null,
    data: 'local',
    sample: () => '/',
    expect: { pageID: 'feedPage' },
  },

  // --- Explore and search --------------------------------------------------
  {
    id: 'explore',
    kind: 'page',
    patterns: ['/explore/'],
    builder: 'XPolarisExploreControllerRouteBuilder',
    access: 'signed-in',
    served: 'exploreRoute',
    har: { entryPoint: 'PolarisExploreRoot', root: 'PolarisExploreRoot', pageID: 'exploreLandingPage', tracePolicy: 'polaris.exploreLandingPage', params: ['variant'] },
    data: 'local (GET /api/v1/discover/web/explore_grid/, src/clone/routes/content.js)',
    next: 'acquire PolarisExploreRoot.entrypoint and PolarisExploreRoot.react at the snapshot revision',
    sample: () => '/explore/',
    expect: { pageID: 'exploreLandingPage' },
  },
  {
    id: 'explore_keyword_search',
    kind: 'page',
    patterns: ['/explore/search/keyword/'],
    builder: null,
    access: 'signed-in',
    served: null,
    har: { entryPoint: null, root: 'PolarisKeywordSearchExploreRoot', pageID: 'KeywordSearchExplorePage', tracePolicy: 'polaris.KeywordSearchExplorePage', params: [] },
    data: 'local search (src/clone/routes/content.js)',
    next: 'acquire PolarisKeywordSearchExploreRoot.react; its entry point was not recorded (the HAR has the route only as a redirect target)',
    sample: () => '/explore/search/keyword/?q=sunset',
    expect: { pageID: 'KeywordSearchExplorePage' },
  },
  {
    id: 'explore_tag',
    kind: 'redirect',
    patterns: ['/explore/tags/{tag_name}/{?tab_name}/'],
    builder: null,
    access: 'signed-in',
    served: null,
    // The recorded definition redirects to the keyword search page.
    har: { redirectTo: 'explore_keyword_search' },
    data: 'local hashtags in captions',
    next: 'serve as the keyword search route once that page is acquired',
    sample: () => '/explore/tags/sunset/',
    expect: { pageID: 'KeywordSearchExplorePage' },
  },
  {
    id: 'explore_location',
    kind: 'page',
    patterns: ['/explore/locations/{location_id}/{?slug}/{?tab_name}/'],
    builder: null,
    access: 'signed-in',
    served: null,
    har: { entryPoint: 'PolarisExploreLocationsTopRoot.next', root: 'PolarisExploreLocationsTopTabRoot.next', pageID: 'locationPage', tracePolicy: 'polaris.locationPage', params: ['location_id', 'slug', 'tab_name'] },
    data: 'none: posts here carry no locations',
    next: 'none until posts can carry a location',
    sample: null,
    expect: { pageID: 'locationPage' },
  },
  {
    id: 'explore_people',
    kind: 'page',
    patterns: ['/explore/people/'],
    builder: 'XPolarisExplorePeopleControllerRouteBuilder',
    access: 'signed-in',
    served: null,
    har: null,
    data: 'local suggestions (src/clone/homeOperations.js suggestions)',
    next: 'record its route definition (a signed-in HAR that opens /explore/people/)',
    sample: () => '/explore/people/',
    expect: {},
  },
  {
    id: 'explore_topic',
    kind: 'page',
    patterns: ['/explore/topics/{tid}/{?slug}/'],
    builder: 'XPolarisExploreTopicsControllerRouteBuilder',
    access: 'signed-in',
    served: null,
    har: null,
    data: 'none: no topics are kept here',
    next: 'none until topics exist',
    sample: null,
    expect: {},
  },

  // --- Reels ---------------------------------------------------------------
  {
    id: 'reels',
    kind: 'page',
    patterns: ['/reels/{?shortcode}/'],
    builder: 'XPolarisClipsTabControllerRouteBuilder',
    access: 'signed-in',
    served: 'reelsRoute',
    // The desktop page: its root is the container, its entry point the desktop root.
    har: { entryPoint: 'PolarisClipsTabDesktopRoot', root: 'PolarisClipsTabDesktopContainer', also: ['PolarisClipsTabDesktopRoot.react'], pageID: 'reelsTab', tracePolicy: 'polaris.reelsTab', params: ['shortcode', 'tab'] },
    data: 'local (video posts)',
    next: 'acquire PolarisClipsTabDesktopRoot.entrypoint, PolarisClipsTabDesktopRoot.react and PolarisClipsTabDesktopContainer.react; the pinned PolarisClipsTabRoot is the mobile viewer',
    sample: () => '/reels/',
    expect: { pageID: 'reelsTab' },
  },
  {
    id: 'reels_audio',
    kind: 'page',
    patterns: ['/reels/audio/{audio_id}/{?song_name}/'],
    builder: null,
    access: 'signed-in',
    served: null,
    har: { entryPoint: 'PolarisClipsAudioRoot', root: 'PolarisClipsAudioRoot', pageID: 'ClipsAudioPage', tracePolicy: 'polaris.ClipsAudioPage', params: ['audio_id', 'song_name'] },
    data: 'none: reels here carry no audio pages',
    next: 'none until reels carry audio',
    sample: null,
    expect: { pageID: 'ClipsAudioPage' },
  },

  // --- Posts ---------------------------------------------------------------
  {
    id: 'post',
    kind: 'page',
    patterns: ['/{permalink_key}/{shortcode}/{?slug}/'],
    builder: 'XPolarisPostControllerRouteBuilder',
    permalinkKeys: ['p', 'reel', 'tv'],
    access: 'signed-in',
    served: 'postRoute',
    har: { entryPoint: 'PolarisDesktopPostRoot', root: 'PolarisDesktopPostRoot', also: ['PolarisDesktopPostPage.react'], pageID: 'postPage', tracePolicy: 'polaris.postPage', params: ['permalink_key', 'shortcode', 'slug'] },
    data: 'local',
    next: 'acquire PolarisDesktopPostRoot.entrypoint (and the PolarisDesktopPostPage.react it loads); the pinned route is PolarisPostRoot with cr:2882 bound by inference',
    sample: (f) => `/p/${f.postCode}/`,
    expect: { pageID: 'postPage' },
  },
  {
    id: 'post_comment',
    kind: 'page',
    patterns: ['/{permalink_key}/{shortcode}/c/{comment_id}/'],
    builder: 'XPolarisPostHoistedCommentsControllerRouteBuilder',
    permalinkKeys: ['p', 'reel'],
    access: 'signed-in',
    served: null,
    har: null,
    data: 'local',
    next: 'record its route definition (a signed-in HAR that opens a comment link)',
    sample: null,
    expect: {},
  },

  // --- Profiles ------------------------------------------------------------
  // Tabs are the profile builder's {?tab}; each tab is its own server route.
  {
    id: 'profile',
    kind: 'page',
    // The builder's pattern is /{username}/{?tab}/{?view_type}/{?igshid}/; each tab is its own page below.
    patterns: ['/{username}/'],
    builder: 'XPolarisProfileControllerRouteBuilder',
    access: 'signed-in',
    served: 'profileRoute',
    har: { entryPoint: 'PolarisProfilePostsTabRoot', root: 'PolarisProfilePostsTabRoot', pageID: 'profilePage', tracePolicy: 'polaris.profilePage', params: ['username', 'tab', 'view_type', 'igshid'] },
    data: 'local',
    sample: (f) => `/${f.username}/`,
    expect: { pageID: 'profilePage' },
  },
  {
    id: 'profile_reels',
    kind: 'page',
    patterns: ['/{username}/reels/'],
    builder: 'XPolarisProfileControllerRouteBuilder',
    tab: 'reels',
    access: 'signed-in',
    served: null,
    har: { entryPoint: 'PolarisProfileReelsTabRoot', root: 'PolarisProfileReelsTabRoot', pageID: 'profilePage', tracePolicy: 'polaris.profilePage', params: ['username', 'tab'] },
    data: 'local (video posts)',
    next: 'acquire PolarisProfileReelsTabRoot.entrypoint and PolarisProfileReelsTabRoot.react',
    sample: (f) => `/${f.username}/reels/`,
    expect: { pageID: 'profilePage' },
  },
  {
    id: 'profile_tagged',
    kind: 'page',
    patterns: ['/{username}/tagged/'],
    builder: 'XPolarisProfileControllerRouteBuilder',
    tab: 'tagged',
    access: 'signed-in',
    served: null,
    har: null,
    data: 'local (people tags)',
    next: 'record its route definition (a signed-in HAR that opens a profile\'s Tagged tab)',
    sample: (f) => `/${f.username}/tagged/`,
    expect: { pageID: 'profilePage' },
  },
  {
    id: 'profile_saved',
    kind: 'page',
    patterns: ['/{username}/saved/', '/{username}/saved/{view_type}/', '/{username}/saved/{collection_name}/{collection_id}/'],
    builder: 'XPolarisProfileControllerRouteBuilder',
    tab: 'saved',
    access: 'signed-in',
    served: null,
    har: null,
    data: 'local (saved posts and collections, src/backend/services/social.js)',
    next: 'record its route definition (a signed-in HAR that opens Saved); the pinned client has PolarisProfileSavedTabEntryPointVariables but no root',
    sample: (f) => `/${f.username}/saved/`,
    expect: { pageID: 'profilePage' },
  },
  {
    id: 'profile_live',
    kind: 'page',
    patterns: ['/{username}/live/'],
    builder: 'XPolarisProfileLiveControllerRouteBuilder',
    access: 'signed-in',
    served: null,
    har: null,
    data: 'none: no live video here',
    next: 'none until live video exists',
    sample: null,
    expect: {},
  },

  // --- Stories -------------------------------------------------------------
  {
    id: 'stories',
    kind: 'page',
    patterns: ['/stories/{username}/{?initial_media_id}/'],
    builder: 'XPolarisStoriesMediaControllerRouteBuilder',
    access: 'signed-in',
    served: 'storiesRoute',
    har: { entryPoint: 'PolarisStoriesV3Root', root: 'PolarisStoriesV3Root', pageID: 'StoriesPage', tracePolicy: 'polaris.StoriesPage', params: ['username', 'initial_media_id'] },
    data: 'local',
    sample: (f) => `/stories/${f.storyOwner}/`,
    // The story viewer covers the window: no navigation chrome.
    expect: { pageID: 'StoriesPage', chrome: false },
  },
  {
    id: 'stories_highlight',
    kind: 'page',
    patterns: ['/stories/highlights/{highlight_reel_id}/'],
    builder: 'XPolarisStoriesHighlightsControllerRouteBuilder',
    access: 'signed-in',
    served: null,
    har: null,
    data: 'local (highlights)',
    next: 'record its route definition (a signed-in HAR that opens a highlight link)',
    sample: (f) => (f.highlightId ? `/stories/highlights/${f.highlightId}/` : null),
    expect: {},
  },
  {
    id: 'stories_archive_reel',
    kind: 'page',
    patterns: ['/stories/archive/{archive_reel_id}/'],
    builder: 'XPolarisStoriesArchiveControllerRouteBuilder',
    access: 'signed-in',
    served: null,
    har: null,
    data: 'local (story archive)',
    next: 'record its route definition (a signed-in HAR that opens an archived story)',
    sample: null,
    expect: {},
  },
  {
    id: 'archive',
    kind: 'page',
    patterns: ['/archive/stories/'],
    builder: 'XPolarisArchivePageControllerRouteBuilder',
    access: 'signed-in',
    served: null,
    har: null,
    data: 'local (story archive, src/backend/services/social.js)',
    next: 'record its route definition (a signed-in HAR that opens /archive/stories/)',
    sample: () => '/archive/stories/',
    expect: {},
  },

  // --- Direct --------------------------------------------------------------
  {
    id: 'direct_inbox',
    kind: 'page',
    patterns: ['/direct/inbox/'],
    builder: 'XPolarisDirectInboxControllerRouteBuilder',
    access: 'signed-in',
    served: 'directInboxRoute',
    har: { entryPoint: 'PolarisDirectInboxRoot', root: 'PolarisDirectInboxRoot', pageID: 'DirectInboxPage', tracePolicy: 'polaris.DirectInboxPage', params: ['thread_key', 'folder', 'subpage'] },
    data: 'local',
    sample: () => '/direct/inbox/',
    expect: { pageID: 'DirectInboxPage' },
  },
  {
    id: 'direct_thread',
    kind: 'page',
    // An extra URL of the inbox builder (jsExtraRouteBuilder).
    patterns: ['/direct/t/{?thread_key}/'],
    builder: 'XPolarisDirectInboxControllerRouteBuilder',
    access: 'signed-in',
    served: 'directInboxRoute',
    har: { entryPoint: 'PolarisDirectInboxRoot', root: 'PolarisDirectInboxRoot', pageID: 'DirectInboxPage', tracePolicy: 'polaris.DirectInboxPage', params: ['thread_key'] },
    data: 'local',
    sample: (f) => (f.threadId ? `/direct/t/${f.threadId}/` : null),
    expect: { pageID: 'DirectInboxPage' },
  },
  {
    id: 'direct_requests',
    kind: 'page',
    patterns: ['/direct/requests/{?subpage}/'],
    builder: 'XPolarisDirectMessageRequestControllerRouteBuilder',
    access: 'signed-in',
    served: null,
    har: null,
    data: 'local (message requests)',
    next: 'record its route definition (a signed-in HAR that opens /direct/requests/)',
    sample: () => '/direct/requests/',
    expect: {},
  },

  {
    id: 'direct_folder',
    kind: 'page',
    // The inbox builder's other extra URL (folders such as general/primary).
    patterns: ['/direct/{?subpage}/{?folder}/'],
    builder: 'XPolarisDirectInboxControllerRouteBuilder',
    access: 'signed-in',
    served: null,
    har: null,
    data: 'local (one inbox; no folders are kept here)',
    next: 'record its route definition (a signed-in HAR that opens an inbox folder)',
    sample: null,
    expect: {},
  },

  // --- Activity ------------------------------------------------------------
  {
    id: 'notifications',
    kind: 'page',
    patterns: ['/notifications/'],
    // The client redirects it to /notifications/ itself (usePolarisAccountActivityRedirect).
    aliases: ['/accounts/activity/'],
    builder: 'XPolarisActivityFeedControllerRouteBuilder',
    access: 'signed-in',
    served: 'activityRoute',
    har: null,
    data: 'local',
    sample: () => '/notifications/',
    expect: { pageID: 'ActivityFeedPage' },
  },

  // --- Settings ------------------------------------------------------------
  {
    id: 'accounts_edit',
    kind: 'page',
    patterns: ['/accounts/edit/'],
    builder: null,
    access: 'signed-in',
    served: null,
    har: null,
    data: 'local (profile form, src/clone/routes/accounts.js)',
    next: 'record its route definition (a signed-in HAR that opens Edit profile)',
    sample: () => '/accounts/edit/',
    expect: {},
  },
  {
    id: 'settings',
    kind: 'page',
    patterns: ['/accounts/settings/'],
    builder: 'XPolarisAccountSettingsControllerRouteBuilder',
    access: 'signed-in',
    served: null,
    har: null,
    data: 'local (account settings, src/backend/services/social.js)',
    next: 'record its route definition (a signed-in HAR that opens Settings)',
    sample: () => '/accounts/settings/',
    expect: {},
  },
  {
    id: 'settings_page',
    kind: 'page',
    patterns: ['/accounts/settings/v2/{settings_page_id}/'],
    builder: 'XPolarisSettingsRendererControllerRouteBuilder',
    access: 'signed-in',
    served: null,
    har: null,
    data: 'local (account settings, src/backend/services/social.js)',
    next: 'record its route definition (a signed-in HAR that opens a settings page)',
    sample: null,
    expect: {},
  },

  // --- Anonymous documents (served from the snapshot to everyone) ----------
  { id: 'login', kind: 'page', patterns: ['/accounts/login/'], builder: 'XPolarisLoginControllerRouteBuilder', access: 'anonymous', served: null, har: null, data: 'local', sample: () => '/accounts/login/', expect: { text: 'Log in' } },
  { id: 'signup', kind: 'page', patterns: ['/accounts/emailsignup/'], builder: 'XPolarisEmailSignupControllerRouteBuilder', access: 'anonymous', served: null, har: null, data: 'local', sample: () => '/accounts/emailsignup/', expect: { text: 'Get started on Instagram' } },
  { id: 'password_reset', kind: 'page', patterns: ['/accounts/password/reset/'], builder: 'XPolarisAccountRecoveryPasswordResetControllerRouteBuilder', access: 'anonymous', served: null, har: null, data: 'local', sample: () => '/accounts/password/reset/', expect: { text: 'Trouble logging in' } },
];

/**
 * Page route builders of the client that are not served, with the reason
 * (business, ads and account-center tools need Meta services that do not
 * exist here; API and embed builders are not pages).
 */
const NOT_SERVED = {
  XPolarisAccountInsightsControllerRouteBuilder: 'professional insights (Meta business service)',
  XPolarisAdInsightsControllerRouteBuilder: 'ads (Meta business service)',
  XPolarisAdToolsControllerRouteBuilder: 'ads (Meta business service)',
  XPolarisAdsLeadGenControllerRouteBuilder: 'ads (Meta business service)',
  XPolarisAutoClipControllerRouteBuilder: 'automatic reel creation (Meta service)',
  XPolarisBoostControllerRouteBuilder: 'boosting posts (Meta ads service)',
  XPolarisBoostMediaPickerControllerRouteBuilder: 'boosting posts (Meta ads service)',
  XPolarisBoostMusicPickerControllerRouteBuilder: 'boosting posts (Meta ads service)',
  XPolarisCAAIGProfileSelectionControllerRouteBuilder: 'Accounts Center profile selection (Meta service)',
  XPolarisCAAIGSaveProfileControllerRouteBuilder: 'Accounts Center saved profiles (Meta service)',
  XPolarisCASB976Phase2DayOfDialogControllerRouteBuilder: 'regional content notice (Meta compliance flow)',
  XPolarisCallControllerRouteBuilder: 'calls (no call service here)',
  XPolarisCampaignInsightsControllerRouteBuilder: 'ads (Meta business service)',
  XPolarisDeviceBasedLoginInvalidateNonceControllerRouteBuilder: 'not a page (device login endpoint)',
  XPolarisDirectPartnershipInboxControllerRouteBuilder: 'creator partnership inbox (professional accounts only)',
  XPolarisEditBoostedAdControllerRouteBuilder: 'boosting posts (Meta ads service)',
  XPolarisEmbedPostControllerRouteBuilder: 'not a page (embed for other sites)',
  XPolarisLoggedOutUpsellControllerRouteBuilder: 'app-install upsell for logged-out mobile visitors',
  XPolarisLoginActivityControllerRouteBuilder: 'login activity (Accounts Center)',
  XPolarisMediaInsightsControllerRouteBuilder: 'professional insights (Meta business service)',
  XPolarisMetaVerifiedControllerRouteBuilder: 'Meta Verified subscription (Meta service)',
  XPolarisMobileAllCommentsControllerRouteBuilder: 'mobile-only comments sheet (desktop shows comments on the post page)',
  XPolarisMobileFollowerListControllerRouteBuilder: 'mobile-only list page (desktop shows a dialog)',
  XPolarisMultiStepSignupControllerRouteBuilder: 'mobile multi-step signup (desktop uses /accounts/emailsignup/)',
  XPolarisNidoGraduationReviewSettingsControllerRouteBuilder: 'teen account settings review (Meta compliance flow)',
  XPolarisPopularSearchControllerRouteBuilder: 'logged-out SEO search pages',
  XPolarisRememberBrowserControllerRouteBuilder: 'two-factor login step (no two-factor login here)',
  XPolarisSupervisionControllerRouteBuilder: 'Family Center supervision (Meta service)',
  XPolarisSyncClientStoredUsersControllerRouteBuilder: 'not a page (device login endpoint)',
  XPolarisUsersNotifyGuardianCallControllerRouteBuilder: 'not a page (API endpoint)',
};

/** A client pattern as a RegExp with named groups ({x}: one segment, {?x}: optional segment). */
function compile(pattern) {
  let re = '^';
  const names = [];
  for (const part of pattern.split('/').filter(Boolean)) {
    const opt = /^\{\?(\w+)\}$/.exec(part);
    const req = /^\{(\w+)\}$/.exec(part);
    if (opt) {
      names.push(opt[1]);
      re += `(?:/(?<${opt[1]}>[^/]+))?`;
    } else if (req) {
      names.push(req[1]);
      re += `/(?<${req[1]}>[^/]+)`;
    } else {
      re += `/${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    }
  }
  return { re: new RegExp(`${re}/?$`), names };
}

for (const page of PAGES) page.compiled = [...page.patterns, ...(page.aliases || [])].map(compile);

// Matching order: patterns with more literal segments first (/stories/highlights/{id}/
// before /stories/{username}/), registry order otherwise.
const literals = (pattern) => pattern.split('/').filter((x) => x && !x.startsWith('{')).length;
const MATCH_ORDER = PAGES.flatMap((page) => [...page.patterns, ...(page.aliases || [])].map((pattern, i) => ({ page, compiled: page.compiled[i], n: literals(pattern) })))
  .map((x, i) => ({ ...x, i }))
  .sort((a, b) => b.n - a.n || a.i - b.i);

/** Usernames are what the client's profile URLs accept and what signup allows. */
const USERNAME = /^[A-Za-z0-9._]{1,30}$/;

// First path segments that are client or server routes, never usernames: every
// page pattern's literal first segment, plus server-owned paths.
const RESERVED_FIRST_SEGMENTS = new Set([
  ...PAGES.flatMap((p) => [...p.patterns, ...(p.aliases || [])].map((x) => x.split('/')[1]).filter((s) => s && !s.startsWith('{'))),
  ...PAGES.flatMap((p) => p.permalinkKeys || []),
  'about', 'legal', 'developer', 'api', 'graphql', 'create', 'professional_dashboard', 'insights', 'popular', 'your_activity',
  'ajax', 'static', 'rsrc.php', 'data', 'web', 'challenge', 'emails', 'oauth', 'privacy', 'session', 'ads', 'b', 'call', 'u',
  'storiesv3', '__ig', '__clone', '__media', '__backend', '__loader',
]);

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * The page a path is, with its route params, or null when it is no page of
 * the registry. Specific pages win over the profile pattern; a profile's
 * first segment must be a possible username and not a reserved segment.
 */
function matchPage(pathname) {
  const path = pathname === '' ? '/' : pathname;
  for (const { page, compiled } of MATCH_ORDER) {
    const m = compiled.re.exec(path);
    if (!m) continue;
    const params = {};
    let ok = true;
    for (const [k, v] of Object.entries(m.groups || {})) {
      if (v === undefined) {
        params[k] = null;
        continue;
      }
      const d = decode(v);
      if (d === null) ok = false;
      params[k] = d;
    }
    if (!ok) continue;
    if (page.permalinkKeys && !page.permalinkKeys.includes(params.permalink_key)) continue;
    if ('shortcode' in params && params.shortcode != null && !/^[A-Za-z0-9_-]{1,64}$/.test(params.shortcode)) continue;
    if ('username' in params) {
      if (!USERNAME.test(params.username)) continue;
      // A profile URL's first segment is the username; a route's own segment is never one.
      if (path.split('/')[1] === params.username && RESERVED_FIRST_SEGMENTS.has(params.username.toLowerCase())) continue;
    }
    if (page.tab) params.tab = page.tab;
    return { page, params };
  }
  return null;
}

const byId = Object.fromEntries(PAGES.map((p) => [p.id, p]));

// A spec of each served route with placeholder subjects, for its module names only.
const SAMPLE_SPECS = {
  homeRoute: (r) => r.homeRoute(),
  profileRoute: (r) => r.profileRoute({ pk: '0', username: 'x', display_name: null }),
  storiesRoute: (r) => r.storiesRoute({ pk: '0', username: 'x' }, {}),
  activityRoute: (r) => r.activityRoute(),
  directInboxRoute: (r) => r.directInboxRoute(),
  reelsRoute: (r) => r.reelsRoute(),
  exploreRoute: (r) => r.exploreRoute(),
  postRoute: (r) => r.postRoute({ pk: '0', authorPk: '0', code: 'x' }),
};

/** The bootloader answers (module names) the page's served route needs, or [] when it is not served. */
function servedAnswers(page) {
  if (!page.served) return [];
  return SAMPLE_SPECS[page.served](require('../shell/signedInRoute')).answers;
}

/** The modules of the page's recorded signed-in route definition (to acquire), or []. */
function targetModules(page) {
  const h = page.har;
  if (!h || !h.root) return [];
  return [...(h.entryPoint ? [`${h.entryPoint}.entrypoint`] : []), `${h.root}.react`, ...(h.also || [])];
}

/** The answers of the client's error route, which every unavailable page is served with. */
function errorAnswers() {
  return require('../shell/signedInRoute').errorRoute('/').answers;
}

/**
 * Coverage of every page against a snapshot's contents (`hasAnswer(moduleName)`,
 * `hasDocument(path)`): for each page, whether it is served, which of its
 * served answers (or, for an anonymous page, its document) are missing, and
 * which recorded target modules are not yet held.
 */
function coverage({ hasAnswer, hasDocument = () => true }) {
  return PAGES.map((page) => {
    const answers = servedAnswers(page);
    const missing = page.access === 'anonymous' ? (hasDocument(page.sample()) ? [] : [`document ${page.sample()}`]) : answers.filter((a) => !hasAnswer(a));
    const targetMissing = targetModules(page).filter((a) => !hasAnswer(a));
    let status;
    if (page.access === 'anonymous') status = missing.length ? 'missing-document' : 'document';
    else if (!page.served) status = 'not-served';
    else status = missing.length ? 'missing-answers' : 'served';
    return { id: page.id, access: page.access, status, served: page.served, answers, missing, targetMissing, recorded: Boolean(page.har && page.har.root), data: page.data, next: page.next || null };
  });
}

/** Every module set acquisition should ask for: served routes, recorded targets and the error route. */
function acquisitionModules() {
  // Pages with nothing local to show (no locations, audio pages, topics, live video) are not acquired.
  const shown = (p) => !/^none\b/.test(p.data || '');
  return [...new Set([...PAGES.filter(shown).flatMap((p) => [...servedAnswers(p), ...targetModules(p)]), ...errorAnswers()])];
}

/** The route builders the registry accounts for (as pages or as NOT_SERVED). */
function classifiedBuilders() {
  return new Set([...PAGES.map((p) => p.builder).filter(Boolean), ...Object.keys(NOT_SERVED)]);
}

module.exports = { PAGES, NOT_SERVED, HAR_REVISION, RESERVED_FIRST_SEGMENTS, matchPage, compile, byId, classifiedBuilders, servedAnswers, targetModules, errorAnswers, coverage, acquisitionModules };
