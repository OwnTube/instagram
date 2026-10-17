'use strict';

/**
 * GraphQL operations of the genuine search panel (PolarisSearchBoxContainer),
 * answered from our accounts. Contracts (compiled operations in the pinned
 * snapshot; `node scripts/graphql-contract.js <Op>` prints them):
 *
 *  - PolarisSearchBoxContainerQuery: the panel's first load, with
 *    `hasQuery: false`, so the topsearch field is skipped (`@include(if:
 *    $hasQuery)`);
 *  - PolarisSearchBoxRefetchableQuery: each typed query refetches
 *    `xdt_api__v1__fbsearch__topsearch_connection(data: {context, query,
 *    rank_token, search_session_id, search_surface, include_reel})` with
 *    `hasQuery: true`: `users[] {position, user}`, `hashtags[]`, `places[]`,
 *    `see_more`, `inform_module`, `rank_token`;
 *  - PolarisSearchBoxNonProfiledRefetchableQuery: the non-personalised
 *    variant, `xdt_api__v1__fbsearch__non_profiled_serp(query) {users[]}`;
 *  - PolarisSearchNullStateQuery: `xig_recent_searches.recent_searches[]`.
 *    Recent searches are not recorded locally, so the list is empty;
 *  - PolarisFeedEmptySULSearchUsersQuery / ...RefetchQuery: the search box of
 *    a new account's empty home feed ("Find friends and accounts you like"),
 *    `searchQuery: XDTTopsearchResponse {users[] {user {..., friendship_status}}}`
 *    with variables `{query}` (`searchQuery` is the operation's alias).
 *
 * Only accounts exist here: hashtags and places are empty lists, there is no
 * keyword "see more" and no inform module. Fields not produced are completed
 * to explicit nulls by src/runtime/graphqlContract.js.
 */

const { search } = require('../backend/services/social');
const present = require('./present');
const { unauthorized } = require('../backend/lib/errors');

const LIMIT = 30;

function viewerOf(ctx) {
  if (!ctx.viewer) throw unauthorized();
  return ctx.viewer;
}

/** XDTUserDict as the search results select it. */
function searchUser(db, row, viewerId) {
  const u = present.user(db, row, viewerId, { withFriendship: false });
  return {
    __typename: 'XDTUserDict',
    id: u.id,
    pk: u.pk,
    username: u.username,
    full_name: u.full_name,
    is_verified: u.is_verified,
    profile_pic_url: u.profile_pic_url,
    hd_profile_pic_url_info: { url: u.profile_pic_url },
    search_social_context: null,
    unseen_count: 0,
    is_unpublished: false,
  };
}

function createSearchOperations(db) {
  function topsearch(vars, ctx) {
    const viewer = viewerOf(ctx);
    if (vars.hasQuery !== true) return {};
    const data = vars.data && typeof vars.data === 'object' ? vars.data : {};
    const found = search.users(db, String(data.query ?? '').slice(0, 100), { limit: LIMIT });
    return {
      xdt_api__v1__fbsearch__topsearch_connection: {
        users: found.map((row, position) => ({ position, user: searchUser(db, row, viewer.id) })),
        hashtags: [],
        places: [],
        see_more: null,
        inform_module: null,
        rank_token: typeof data.rank_token === 'string' ? data.rank_token : null,
      },
    };
  }

  function emptyFeedSearch(vars, ctx) {
    const viewer = viewerOf(ctx);
    const found = search.users(db, String(vars.query ?? '').slice(0, 100), { limit: LIMIT }).filter((row) => row.id !== viewer.id);
    return {
      searchQuery: {
        users: found.map((row, position) => ({
          position,
          user: { ...searchUser(db, row, viewer.id), friendship_status: present.user(db, row, viewer.id).friendship_status, social_context: null },
        })),
      },
    };
  }

  return {
    PolarisFeedEmptySULSearchUsersQuery: emptyFeedSearch,
    PolarisFeedEmptySULSearchRefetchQuery: emptyFeedSearch,
    PolarisSearchBoxContainerQuery: topsearch,
    PolarisSearchBoxRefetchableQuery: topsearch,

    PolarisSearchBoxNonProfiledRefetchableQuery(vars, ctx) {
      const viewer = viewerOf(ctx);
      if (vars.hasQuery !== true) return {};
      const found = search.users(db, String(vars.query ?? '').slice(0, 100), { limit: LIMIT });
      return { xdt_api__v1__fbsearch__non_profiled_serp: { users: found.map((row) => searchUser(db, row, viewer.id)), inform_module: null } };
    },

    PolarisSearchNullStateQuery(vars, ctx) {
      viewerOf(ctx);
      return { xig_recent_searches: { recent_searches: [] } };
    },
  };
}

module.exports = { createSearchOperations };
