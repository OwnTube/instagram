'use strict';

/**
 * The original client's GraphQL transport (POST /graphql/query, /api/graphql).
 *
 * The client sends persisted queries: a `doc_id`, JSON `variables`, and the
 * operation's name in `fb_api_req_friendly_name`. We cannot run Instagram's
 * persisted documents, so each supported operation is a resolver keyed by that
 * name that returns the same `data` tree the document would select, built from
 * our database. doc_ids rotate with every client release; names are stable, so
 * dispatch is by name.
 *
 * An operation without a resolver gets an explicit GraphQL error with HTTP 501
 * and is recorded in `unsupported` (exposed on /__clone/health), which is the
 * work list for extending this file. It is never forwarded to Instagram.
 */

const users = require('../backend/services/users');
const posts = require('../backend/services/posts');
const { feed, stories, follows, comments } = require('../backend/services/social');
const { badRequest, notFound, unauthorized } = require('../backend/lib/errors');
const { isPk, pkFromShortcode } = require('../backend/lib/ids');
const present = require('./present');
const { createCaaRegistration, safeNext } = require('./caaRegistration');
const { createHomeOperations } = require('./homeOperations');
const { createSearchOperations } = require('./searchOperations');
const { completeToContract } = require('../runtime/graphqlContract');

function connection(items, nextCursor, toNode) {
  return {
    edges: items.map((item) => ({ node: toNode(item), cursor: item.pk })),
    page_info: { end_cursor: nextCursor, has_next_page: Boolean(nextCursor), has_previous_page: false, start_cursor: null },
  };
}

function limitOf(vars, fallback = 12) {
  const n = Number(vars.first ?? vars.count ?? vars.media_count ?? fallback);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 50) : fallback;
}

const AUTH_OPERATIONS = new Set(['useCDSWebLoginMutation', 'useCAARegistrationFormSubmitMutation']);

function createGraphql({ db, contracts = null }) {
  const unsupported = new Map();
  // Answered operations by name (counts only, never variables), for health.
  const answered = new Map();
  let loginCore = null;
  let signupCore = null;

  function needViewer(ctx) {
    if (!ctx.viewer) throw unauthorized();
    return ctx.viewer;
  }

  function userFromVars(vars) {
    if (vars.username) return users.getByUsername(db, String(vars.username));
    const id = vars.id ?? vars.user_id ?? vars.target_user_id;
    return id && isPk(String(id)) ? users.getByPk(db, String(id)) : null;
  }

  /** Set the viewer's like on the post `vars.input.media_id` names; its media id and has_liked. */
  function likeMedia(vars, ctx, liked) {
    const viewer = needViewer(ctx);
    const id = posts.resolveId(db, String((vars.input && vars.input.media_id) || ''));
    if (!id) throw notFound('Media not found');
    const post = posts.setLike(db, id, viewer.id, liked);
    return { id: present.mediaId(post), has_liked: Boolean(post.likedByViewer) };
  }

  const resolvers = {
    PolarisFeedTimelineRootV2Query(vars, ctx) {
      const viewer = needViewer(ctx);
      const result = feed.home(db, viewer.id, { limit: limitOf(vars), cursor: vars.after || undefined });
      return {
        xdt_api__v1__feed__timeline__connection: connection(result.items, result.nextCursor, (p) => ({
          __typename: 'XDTFeedItem',
          media: present.media(db, p, viewer.id),
          ad: null,
          end_of_feed_demarcator: null,
          explore_story: null,
          suggested_users: null,
          stories_netego: null,
        })),
      };
    },

    PolarisProfilePostsQuery(vars, ctx) {
      const row = userFromVars(vars);
      if (!row) throw notFound('User not found');
      const viewerId = ctx.viewer?.id ?? null;
      const result = posts.listByAuthor(db, row.id, { limit: limitOf(vars), cursor: vars.after || undefined }, { viewerId });
      return {
        xdt_api__v1__feed__user_timeline_graphql_connection: connection(result.items, result.nextCursor, (p) => present.media(db, p, viewerId)),
        // The operation also selects the viewer (`xdt_viewer.user.id`); the
        // profile grid reads it unconditionally when signed in.
        xdt_viewer: ctx.viewer ? { user: { id: String(ctx.viewer.pk) } } : null,
      };
    },

    PolarisProfilePageContentQuery(vars, ctx) {
      const row = userFromVars(vars);
      if (!row) throw notFound('User not found');
      // The operation also selects the viewer: local accounts are not
      // professional accounts (no insights) and none is supervised.
      const viewer = ctx.viewer ? { user: { pk: String(ctx.viewer.pk), id: String(ctx.viewer.pk), can_see_organic_insights: false, supervision_info: null } } : null;
      return { user: present.userInfo(db, row, ctx.viewer?.id ?? null), viewer };
    },

    // Follow and unfollow from the profile header and its "Following" menu
    // (`xdt_create_friendship` / `xdt_destroy_friendship`: the target user with
    // the viewer's resulting friendship status). Same rules as the REST routes:
    // following twice or unfollowing someone not followed is not an error.
    // Like and unlike (usePolarisLikeMedia): input {media_id, container_module,
    // tracking_token}; the answer selects the media's id and has_liked.
    usePolarisLikeMediaXIGLikeMutation(vars, ctx) {
      return { xig_media_like: { media: likeMedia(vars, ctx, true) } };
    },

    usePolarisLikeMediaXIGUnlikeMutation(vars, ctx) {
      return { xig_media_unlike: { media: likeMedia(vars, ctx, false) } };
    },

    // The post view's like button (PolarisAPILikePost / PolarisAPIUnlikePost):
    // the same contract, input {media_id}.
    PolarisAPILikePostMutation(vars, ctx) {
      return { xig_media_like: { media: likeMedia(vars, ctx, true) } };
    },

    PolarisAPIUnlikePostMutation(vars, ctx) {
      return { xig_media_unlike: { media: likeMedia(vars, ctx, false) } };
    },

    // Comment from the post's comment field (usePolarisCommentCreate): data
    // {comment_text, media_id, replied_to_comment_fbid?, tracking_token}.
    usePolarisCommentCreateMutation(vars, ctx) {
      const viewer = needViewer(ctx);
      const data = vars.data || {};
      const id = posts.resolveId(db, String(data.media_id || ''));
      if (!id) throw notFound('Media not found');
      const post = posts.get(db, id, { viewerId: viewer.id });
      const text = String(data.comment_text ?? '').trim();
      if (!text) throw badRequest('Comment cannot be empty.');
      if (text.length > 2200) throw badRequest('Comment is too long.');
      const parentRef = data.replied_to_comment_fbid;
      const parentId = parentRef ? comments.resolveId(db, String(parentRef)) : undefined;
      if (parentRef && !parentId) throw notFound('Comment not found');
      const c = present.comment(db, comments.create(db, post.id, viewer.id, { body: text, parentId }), present.mediaId(post));
      const { pk, username, full_name, profile_pic_url, is_verified } = c.user;
      return {
        xig_comment_create: {
          __typename: 'XIGCommentCreateMutationSuccessResponse',
          // Local accounts have no Facebook id (fbid_v2).
          comment_dict: { created_at: c.created_at, pk: c.pk, text: c.text, user: { pk, id: pk, username, full_name, profile_pic_url, is_verified, fbid_v2: null } },
        },
      };
    },

    usePolarisFollowMutation(vars, ctx) {
      const viewer = needViewer(ctx);
      const row = userFromVars({ id: vars.target_user_id });
      if (!row) throw notFound('User not found');
      try {
        follows.follow(db, viewer.id, row.id);
      } catch (error) {
        if (error.status !== 409) throw error;
      }
      return { xdt_create_friendship: { id: String(row.pk), username: row.username, friendship_status: present.friendshipStatus(db, viewer.id, row) } };
    },

    usePolarisUnfollowMutation(vars, ctx) {
      const viewer = needViewer(ctx);
      const row = userFromVars({ id: vars.target_user_id });
      if (!row) throw notFound('User not found');
      try {
        follows.unfollow(db, viewer.id, row.id);
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      return { xdt_destroy_friendship: { id: String(row.pk), username: row.username, friendship_status: present.friendshipStatus(db, viewer.id, row) } };
    },

    // The profile header's school-partner badge (`xig_user_by_igid_v2
    // .school_partner`): there is no school partner programme locally.
    PolarisSchoolPartnerProfileBadgeQuery(vars) {
      const row = userFromVars({ id: vars.igid });
      if (!row) throw notFound('User not found');
      return { xig_user_by_igid_v2: { id: String(row.pk), school_partner: null } };
    },

    // Creation dialog: linked Threads / Facebook accounts. Local accounts have
    // none: no linked profile, no crossposting service result (the client's
    // fetchFBCrosspostingMetadata then rejects by design, reported via promiseDone).
    fetchThreadsCrosspostingMetadataQuery(vars, ctx) {
      return {
        xcxp_fetch_linked_threads_profile: null,
        viewer: ctx.viewer ? { user: { id: String(ctx.viewer.pk), cxp_crosspost_settings: null } } : null,
      };
    },

    fetchFBCrosspostingMetadataQuery() {
      return { fx_service_cache: { services: [] } };
    },

    // Creation and sharing: no COPPA enforcement state exists for local accounts.
    usePolarisCoppaEnforcementStatusViewerQuery(vars, ctx) {
      return { xdt_viewer: ctx.viewer ? { user: { id: String(ctx.viewer.pk), is_coppa_enforced: false } } : null };
    },

    PolarisPostRootQuery(vars, ctx) {
      const pk = vars.shortcode ? pkFromShortcode(String(vars.shortcode)) : vars.media_id ? String(vars.media_id).split('_')[0] : null;
      const id = pk && posts.resolveId(db, pk);
      if (!id) throw notFound('Media not found');
      const post = posts.get(db, id, { viewerId: ctx.viewer?.id ?? null });
      return { xdt_api__v1__media__shortcode__web_info: { items: [present.media(db, post, ctx.viewer?.id ?? null)] } };
    },

    PolarisStoriesV3TrayQuery(vars, ctx) {
      const viewer = needViewer(ctx);
      const tray = stories.tray(db, viewer.id).map((t) => present.reel(db, users.getById(db, t.authorId), t.items, viewer.id));
      return { xdt_api__v1__feed__reels_tray: { tray } };
    },

    /**
     * The logged-out popular/explore grid. Its contract was verified against
     * the live client (docs/FEED-INTEGRATION-PLAN.md section 2): edges of
     * XIGPolarisMedia nodes under xig_logged_out_popular_search_media_info.
     */
    PolarisLoggedOutPopularSearchPagePaginationQuery(vars, ctx) {
      const keyword = String(vars.keyword || '').trim().toLowerCase();
      const limit = limitOf(vars, 8);
      // Scan whole pages so the returned cursor never skips an unexamined post.
      const items = [];
      let cursor = vars.after || undefined;
      for (let scanned = 0; scanned < 5 && items.length < limit; scanned += 1) {
        const result = feed.explore(db, ctx.viewer?.id ?? null, { limit, cursor });
        items.push(...(keyword ? result.items.filter((p) => (p.caption || '').toLowerCase().includes(keyword)) : result.items));
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return {
        xig_logged_out_popular_search_media_info: connection(items, cursor || null, (p) => ({
          __typename: 'XIGPolarisMedia',
          __isXIGPolarisMedia: 'XIGPolarisMedia',
          code: p.code,
          pk: p.pk,
          id: `POLARIS_${p.pk}`,
          user: {
            pk: p.authorPk,
            id: p.authorPk,
            username: p.authorUsername,
            is_verified: false,
            profile_pic_url: present.user(db, present.userRow(db, p.authorId), null).profile_pic_url,
          },
          caption: p.caption ? { text: p.caption } : null,
          display_uri: p.mediaUrl,
          play_count: null,
          video_versions: null,
        })),
      };
    },
  };

  const str = (v) => (typeof v === 'string' && v ? v : null);
  const sensitive = (v) => str(v) || (v && typeof v === 'object' ? str(v.sensitive_string_value) : null);

  /** Every scalar the client's selection reads, null unless set. */
  function loginPayload(fields) {
    return {
      error_code: null, error_message: null, error_style: null, redirect_uri: null, two_factor_result: null,
      reg_nta_context: null, is_3pl: false, is_xapp_login: false, recaptcha_needed: false, is_ig_login_recaptcha: false,
      should_show_profile_selector: false, should_show_save_password_dialog: false, captcha_persist_data: null,
      crypted_uid: null, ig_trusted_device_nonce_refresh: null, stop_deletion_payload: null, ig_authenticated: false,
      should_show_google_oauth_after_failure: false, google_oauth_uri: null, lara_recovery_redirect_uri: null,
      lara_recovery_captcha_persist_data: null, lara_recovery_captcha_cipher: null, lara_recovery_method: null,
      lara_recovery_cuid: null, ig_nonce_refresh: null, ig_login_upsell_ar: null,
      ...fields,
    };
  }

  function loginError(code, text) {
    return loginPayload({
      error_code: code,
      error_style: 'GENERIC_BANNER',
      error_message: { __typename: 'TextWithEntities', text, ranges: [], inline_style_ranges: [], image_ranges: [], color_ranges: [] },
    });
  }

  /**
   * The login form's mutation. The contract is read from the client's own
   * useCDSWebLoginMutation module: variables `{input: {identifier,
   * enc_password: {sensitive_string_value}, password: {...}, next}}`, answer
   * `caa_login_web`, where a string `redirect_uri` means success and
   * `error_message.text` is shown otherwise. Authentication is the REST
   * login route's: same decryption, same local session cookies.
   */
  resolvers.useCDSWebLoginMutation = async (vars, ctx) => {
    if (!loginCore) throw new Error('login is not wired');
    const input = vars.input && typeof vars.input === 'object' ? vars.input : {};
    const identifier = str(input.identifier);
    const secret = sensitive(input.enc_password) || sensitive(input.password);
    if (!identifier || !secret) return { caa_login_web: loginError('missing_credentials', 'Please enter your username and password.') };
    let user;
    try {
      const password = loginCore.readPassword(secret.startsWith('#PWD_') ? { enc_password: secret } : { password: secret });
      user = await loginCore.authenticateAndIssue(ctx.req, ctx.res, { username: identifier, password });
    } catch (error) {
      // An unreadable password is the page's problem (stale key), not a bad login.
      if (error && error.status === 400) return { caa_login_web: loginError('password_unreadable', error.message) };
      throw error;
    }
    if (!user) {
      // One answer whether or not the account exists.
      return { caa_login_web: loginError('invalid_credentials', 'Sorry, your username or password was incorrect. Please double-check and try again.') };
    }
    return { caa_login_web: loginPayload({ ig_authenticated: true, crypted_uid: user.pk, redirect_uri: safeNext(input.next) }) };
  };

  Object.assign(resolvers, createCaaRegistration(() => signupCore));
  Object.assign(resolvers, createHomeOperations(db));
  Object.assign(resolvers, createSearchOperations(db));

  function parseVariables(raw) {
    if (raw === undefined || raw === null || raw === '') return {};
    if (typeof raw === 'object') return raw;
    try {
      const parsed = JSON.parse(String(raw));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      throw badRequest('variables must be JSON');
    }
  }

  async function handler(req, res, next) {
    const p = req.params_;
    const name = String(p.fb_api_req_friendly_name || req.get('x-fb-friendly-name') || '');
    const docId = String(p.doc_id || p.query_hash || '');
    let vars;
    try {
      vars = parseVariables(p.variables);
    } catch (error) {
      return next(error);
    }
    const resolver = resolvers[name];
    if (!resolver) {
      const key = name || `doc_id:${docId}`;
      const entry = unsupported.get(key) || { name: name || null, docId, count: 0, lastSeen: null, variableKeys: [] };
      entry.count += 1;
      entry.lastSeen = new Date().toISOString();
      entry.variableKeys = Object.keys(vars).slice(0, 30);
      unsupported.set(key, entry);
      return res.status(501).json({
        data: null,
        errors: [{ message: `GraphQL operation ${name || docId || '(unnamed)'} is not implemented by this server`, severity: 'CRITICAL', code: 501 }],
        status: 'fail',
      });
    }
    answered.set(name, (answered.get(name) || 0) + 1);
    try {
      const data = await resolver(vars, { viewer: req.viewer || null, req, res });
      // Fill fields the resolver does not produce with explicit nulls, as the
      // client's own compiled operation selects them (src/runtime/graphqlContract).
      const tree = contracts && contracts.tree(name);
      if (tree && data) completeToContract(tree, data, (key) => contracts.possibleTypes(key));
      return res.status(200).json({ data, extensions: { is_final: true }, status: 'ok' });
    } catch (error) {
      if (error && error.status && error.status < 500) {
        return res.status(error.status).json({
          data: null,
          errors: [{ message: error.message, severity: 'CRITICAL', code: error.status }],
          status: 'fail',
        });
      }
      return next(error);
    }
  }

  return {
    handler,
    /** Operations that check credentials share the login rate limiter. */
    isAuthOperation: (p) => AUTH_OPERATIONS.has(String((p && p.fb_api_req_friendly_name) || '')),
    setLoginCore(core) { loginCore = core; },
    setSignupCore(core) { signupCore = core; },
    supported: () => Object.keys(resolvers),
    unsupported: () => [...unsupported.values()].sort((a, b) => b.count - a.count),
    answered: () => Object.fromEntries(answered),
  };
}

module.exports = { createGraphql };
