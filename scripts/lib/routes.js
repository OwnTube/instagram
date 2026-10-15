'use strict';

/**
 * Inventory of Instagram routes to verify through the runtime mirror.
 *
 * Each entry records what the route is, whether it should be reachable without
 * a session, and what to expect. This is the checklist the sweep works through;
 * the sweep records the *actual* result, which may differ from expectation.
 *
 * Categories:
 *   public          - expected to render for an anonymous visitor
 *   auth-only       - expected to require a logged-in session
 *   auth-flow       - part of an anonymous authentication flow (reset, 2FA)
 *   non-page        - not an HTML page (API/asset/robots endpoint)
 *   unknown         - existence uncertain; verify rather than assume
 *
 * `userVerified: true` marks a route the operator has personally confirmed
 * works through the mirror. Automated results never downgrade these: a
 * rate-limited request is inconclusive, not a failure.
 */

const routes = [
  // ---- public: pages that should render without a session -------------------
  { path: '/', category: 'public', expect: 'Landing page; shows login form when logged out' },
  { path: '/accounts/login/', category: 'public', expect: 'Login form' },
  { path: '/accounts/login/?next=%2F&source=mobile_nav', category: 'public', expect: 'Login form with next/source params' },
  { path: '/accounts/emailsignup/', category: 'public', expect: 'Sign-up form' },
  { path: '/explore/', category: 'public', userVerified: true, expect: 'Explore / Popular grid' },
  { path: '/explore/tags/travel/', category: 'public', expect: 'Hashtag page (public)' },
  { path: '/explore/?hl=de', category: 'public', expect: 'Localised Popular page (German)' },
  { path: '/explore/?hl=es', category: 'public', expect: 'Localised Popular page (Spanish)' },
  { path: '/instagram/', category: 'public', userVerified: true, expect: 'Public profile for the @instagram account' },
  { path: '/reels/', category: 'public', expect: 'Reels viewer (anonymous visitor is expected to see a login gate)' },
  { path: '/accounts/meta_verified/', category: 'public', expect: 'Meta Verified info page (linked from footer)' },
  { path: '/web/', category: 'public', expect: 'Route referenced in the app shell' },
  { path: '/legal/privacy/', category: 'public', expect: 'Privacy policy' },
  { path: '/legal/privacy/health_privacy_policy/', category: 'public', expect: 'Health privacy policy (linked from app-shell footer)' },
  { path: '/legal/terms/', category: 'public', expect: 'Terms of use' },
  { path: '/legal/cookies/', category: 'public', expect: 'Cookies policy' },
  { path: '/legal/accessibility/', category: 'public', expect: 'Accessibility statement' },
  { path: '/popular/', category: 'public', expect: 'Popular page (linked from app-shell footer)' },
  { path: '/web/lite/', category: 'public', expect: 'Lite web route (linked from app-shell footer)' },
  { path: '/developer/', category: 'public', expect: 'Platform docs' },
  { path: '/about/', category: 'public', expect: 'About page (may redirect)' },

  // ---- auth-flow: anonymous flows that must work without a session ---------
  { path: '/accounts/password/reset/', category: 'auth-flow', expect: 'Password reset request form' },
  { path: '/accounts/password/reset/confirm/', category: 'auth-flow', expect: 'Reset confirm (needs a token to be useful)' },
  { path: '/accounts/two_factor_authentication/', category: 'auth-flow', expect: '2FA prompt (needs a login in progress)' },

  // ---- non-page: endpoints that are not HTML pages -------------------------
  { path: '/robots.txt', category: 'non-page', expect: 'Plain text, not HTML' },
  { path: '/manifest.json', category: 'non-page', expect: 'JSON web manifest' },
  { path: '/data/manifest.json', category: 'non-page', expect: 'JSON web manifest (as linked from the page)' },
  { path: '/api/', category: 'unknown', expect: 'Not a user-facing page; likely 404/429' },

  // ---- auth-only: expected to require a session ----------------------------
  { path: '/direct/inbox/', category: 'auth-only', expect: 'Direct messages inbox' },
  { path: '/accounts/edit/', category: 'auth-only', expect: 'Edit profile' },
  { path: '/accounts/activity/', category: 'auth-only', expect: 'Activity / notifications' },
  { path: '/your_activity/', category: 'auth-only', expect: 'Your activity' },
  { path: '/accounts/saved/', category: 'auth-only', expect: 'Saved posts' },
  { path: '/emails/settings/', category: 'auth-only', expect: 'Email settings' },
  { path: '/session/login_activity/', category: 'auth-only', expect: 'Login activity' },
];

/**
 * URL patterns whose concrete form contains an identifier (a post shortcode, a
 * username, a location id). They cannot be fetched with a made-up identifier:
 * the identifier must come from real content, so each entry records whether a
 * real example was actually obtained and requested.
 *
 * Per-pattern fields:
 *   pattern        - the URL shape
 *   category       - public | auth-only
 *   example        - a real, tested example, or null
 *   exampleSource  - where the example came from (required when example is set)
 *   knownFrom      - how the pattern itself is known (required always)
 *   requested      - whether an example was actually requested upstream
 *   delivered      - document reached the browser (true/false/null unknown)
 *   rendered       - genuine client rendered route content (true/false/null)
 *   interactions   - relevant interactions were tested end to end
 *   dependency     - what the route depends on
 *   evidenceDate   - when the evidence was gathered
 *   blocker        - why it is untested, when example is null
 *
 * On the empty shortcode mapping: the anonymous Explore payload ships
 * `post_shortcode_to_uri_mapping: {}`. That is ONE data point. It does NOT
 * establish that public post or reel pages require authentication — it only
 * shows that this particular SSR payload carried no shortcodes. The honest
 * classification is therefore "untested", not "auth-required".
 */

const EVIDENCE_DATE = '2026-10-15';

const patterns = [
  {
    pattern: '/p/<shortcode>/',
    category: 'public',
    example: null,
    exampleSource: null,
    knownFrom: 'observed upstream markup (PolarisSEO payload references post shortcodes)',
    requested: false,
    delivered: null,
    rendered: null,
    interactions: false,
    dependency: 'a real post shortcode',
    evidenceDate: EVIDENCE_DATE,
    blocker:
      'No shortcode in available evidence. The anonymous Explore payload carried an empty ' +
      'post_shortcode_to_uri_mapping, which shows only that this payload had none — it does ' +
      'not prove the route requires authentication. Needs a shortcode from real content or the operator.',
  },
  {
    pattern: '/reel/<shortcode>/',
    category: 'public',
    example: null,
    exampleSource: null,
    knownFrom: 'observed upstream markup (same shortcode space as posts)',
    requested: false,
    delivered: null,
    rendered: null,
    interactions: false,
    dependency: 'a real reel shortcode',
    evidenceDate: EVIDENCE_DATE,
    blocker: 'Same as post detail: no reel shortcode available in existing evidence.',
  },
  {
    pattern: '/reels/',
    category: 'public',
    example: '/reels/',
    exampleSource: 'existing project evidence',
    knownFrom: 'existing project evidence',
    requested: true,
    delivered: true,
    rendered: true,
    interactions: false,
    dependency: 'none for delivery; anonymous visitor sees a login gate',
    evidenceDate: EVIDENCE_DATE,
    blocker: null,
  },
  {
    pattern: '/stories/<username>/<story_id>/',
    category: 'auth-only',
    example: null,
    exampleSource: null,
    knownFrom: 'upstream route name',
    requested: false,
    delivered: null,
    rendered: null,
    interactions: false,
    dependency: 'a session and a live story id',
    evidenceDate: EVIDENCE_DATE,
    blocker: 'Stories require a session; no anonymous story ids are exposed in existing evidence.',
  },
  {
    pattern: '/stories/highlights/<highlight_id>/',
    category: 'public',
    example: null,
    exampleSource: null,
    knownFrom: 'upstream route name',
    requested: false,
    delivered: null,
    rendered: null,
    interactions: false,
    dependency: 'a numeric highlight id',
    evidenceDate: EVIDENCE_DATE,
    blocker:
      'No highlight id in existing evidence. A numeric id was observed in unrelated inbound ' +
      'traffic to the public URL; it was not originated by this project and is not used as a verified example.',
  },
  {
    pattern: '/<username>/',
    category: 'public',
    example: '/instagram/',
    exampleSource: 'user-verified',
    knownFrom: 'user-verified',
    requested: true,
    delivered: true,
    rendered: true,
    interactions: false,
    dependency: 'a username',
    evidenceDate: EVIDENCE_DATE,
    blocker: null,
  },
  {
    pattern: '/<username>/tagged/',
    category: 'public',
    example: null,
    exampleSource: null,
    knownFrom: 'observed upstream markup (profile tab links)',
    requested: false,
    delivered: null,
    rendered: null,
    interactions: false,
    dependency: 'a username whose tagged tab renders anonymously',
    evidenceDate: EVIDENCE_DATE,
    blocker: 'No username with a confirmed anonymous tagged tab in existing evidence.',
  },
  {
    pattern: '/<username>/reels/',
    category: 'public',
    example: null,
    exampleSource: null,
    knownFrom: 'observed upstream markup (profile tab links)',
    requested: false,
    delivered: null,
    rendered: null,
    interactions: false,
    dependency: 'a username whose reels tab renders anonymously',
    evidenceDate: EVIDENCE_DATE,
    blocker: 'No username with a confirmed anonymous reels tab in existing evidence.',
  },
  {
    pattern: '/explore/tags/<tag>/',
    category: 'public',
    example: '/explore/tags/travel/',
    exampleSource: 'existing project evidence',
    knownFrom: 'existing project evidence',
    requested: true,
    delivered: true,
    rendered: true,
    interactions: false,
    dependency: 'a tag slug',
    evidenceDate: EVIDENCE_DATE,
    blocker: null,
  },
  {
    pattern: '/explore/locations/<location_id>/',
    category: 'public',
    example: null,
    exampleSource: null,
    knownFrom: 'observed upstream markup (an id-less /explore/locations/ link is present)',
    requested: false,
    delivered: null,
    rendered: null,
    interactions: false,
    dependency: 'a numeric location id',
    evidenceDate: EVIDENCE_DATE,
    blocker:
      'The cached Explore markup contains only an id-less template link /explore/locations/, ' +
      'so no location id was available to test.',
  },
  {
    pattern: '/places/c/<id>/',
    category: 'public',
    example: null,
    exampleSource: null,
    knownFrom: 'robots.txt (Allow: /places/c/)',
    requested: false,
    delivered: null,
    rendered: null,
    interactions: false,
    dependency: 'a numeric place id',
    evidenceDate: EVIDENCE_DATE,
    blocker: 'Robots advertises the prefix but no place id is available in existing evidence.',
  },
  {
    pattern: '/<path>?hl=<lang>',
    category: 'public',
    example: '/explore/?hl=de',
    exampleSource: 'app-shell footer links',
    knownFrom: 'app-shell footer links',
    requested: true,
    delivered: true,
    rendered: true,
    interactions: false,
    dependency: 'a language code',
    evidenceDate: EVIDENCE_DATE,
    blocker: null,
  },
  {
    pattern: '/direct/t/<thread_id>/',
    category: 'auth-only',
    example: null,
    exampleSource: null,
    knownFrom: 'upstream route name',
    requested: false,
    delivered: null,
    rendered: null,
    interactions: false,
    dependency: 'a session',
    evidenceDate: EVIDENCE_DATE,
    blocker: 'Requires a session.',
  },
  {
    pattern: '/sitemap/<file>.xml.gz',
    category: 'non-page',
    example: '/sitemap/ig_places_sitemap.xml.gz',
    exampleSource: 'robots.txt Sitemap entries',
    knownFrom: 'robots.txt Sitemap entries',
    requested: true,
    delivered: false,
    rendered: null,
    interactions: false,
    dependency: 'upstream access to the sitemap files',
    evidenceDate: EVIDENCE_DATE,
    blocker:
      'Requested and returned HTTP 403 with an empty body — the same rejection signature as ' +
      'throttling. This is the legitimate, robots-advertised source of real usernames and ' +
      'location ids; retry when access permits rather than probing repeatedly.',
  },
];

module.exports = { routes, patterns };

