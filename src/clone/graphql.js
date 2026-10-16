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
const { feed, stories } = require('../backend/services/social');
const { badRequest, notFound, unauthorized } = require('../backend/lib/errors');
const { isPk, pkFromShortcode } = require('../backend/lib/ids');
const present = require('./present');

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

function createGraphql({ db }) {
  const unsupported = new Map();
  let loginCore = null;

  function needViewer(ctx) {
    if (!ctx.viewer) throw unauthorized();
    return ctx.viewer;
  }

  function userFromVars(vars) {
    if (vars.username) return users.getByUsername(db, String(vars.username));
    const id = vars.id ?? vars.user_id ?? vars.target_user_id;
    return id && isPk(String(id)) ? users.getByPk(db, String(id)) : null;
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
      };
    },

    PolarisProfilePageContentQuery(vars, ctx) {
      const row = userFromVars(vars);
      if (!row) throw notFound('User not found');
      return { user: present.userInfo(db, row, ctx.viewer?.id ?? null) };
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

  /** First string found under any of `keys`, searching nested variables. */
  function findString(node, keys, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 4) return null;
    for (const key of keys) if (typeof node[key] === 'string' && node[key]) return node[key];
    for (const value of Object.values(node)) {
      const found = findString(value, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }

  /**
   * The login form's mutation. It authenticates exactly like the REST login
   * route (same password decryption, same session cookies) and answers
   * `authenticated: false` for wrong credentials.
   */
  resolvers.useCDSWebLoginMutation = async (vars, ctx) => {
    if (!loginCore) throw new Error('login is not wired');
    const username = findString(vars, ['username', 'user_name', 'login']);
    if (!username) throw badRequest('Please enter your username.');
    const secret = findString(vars, ['enc_password', 'encPassword', 'encrypted_password', 'password']);
    if (!secret) throw badRequest('Password is required');
    const sealed = secret.startsWith('#PWD_');
    const password = loginCore.readPassword(sealed ? { enc_password: secret } : { password: secret });
    const user = await loginCore.authenticateAndIssue(ctx.req, ctx.res, { username, password });
    const body = user
      ? { authenticated: true, user: true, userId: user.pk, oneTapPrompt: false, reactivated: false }
      : { authenticated: false, user: true };
    return { xdt_login: body, ...body };
  };

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
    try {
      const data = await resolver(vars, { viewer: req.viewer || null, req, res });
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
    isAuthOperation: (p) => String((p && p.fb_api_req_friendly_name) || '') === 'useCDSWebLoginMutation',
    setLoginCore(core) { loginCore = core; },
    supported: () => Object.keys(resolvers),
    unsupported: () => [...unsupported.values()].sort((a, b) => b.count - a.count),
  };
}

module.exports = { createGraphql };
