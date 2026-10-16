'use strict';

/**
 * GraphQL operations the signed-in home page asks for besides the feed:
 * stories tray, suggested users, the notifications and Direct badges, and
 * quick promotions. Each answer is built from our database in the shape of the
 * client's own compiled operation (`node scripts/graphql-contract.js <Op>`
 * prints it); fields not produced here are completed to explicit nulls by
 * src/runtime/graphqlContract.js. Nothing is invented: with no local content the
 * answer is the operation's empty state (empty tray, no suggestions, zero
 * counts, no promotions).
 *
 * Contracts and consumers (stored bundles):
 *  - PolarisStoriesV3TrayContainerQuery: `xdt_api__v1__feed__reels_tray
 *    {tray[], broadcasts[]}` + `xdt_viewer.user` (the viewer's own avatar);
 *  - PolarisSuggestedUserListQuery: `ayml.groups[].items[]{user, uuid,
 *    social_context}`;
 *  - usePolarisNotificationsNavItemQuery: `xdt_notification_badge.badge_count
 *    {total_count, activity_badge_counts{comments, likes, relationships,
 *    usertags}}`;
 *  - IGDBadgeCountOffMsysQuery / IGDChatTabsJewelOffMsysQuery:
 *    `get_slide_mailbox_for_iris_subscription.threads_by_folder` edges of
 *    SlideThread -> XFBIGDirectViewerThread. A thread is unread for the
 *    client (XFBIGDirectViewerThreadIsUnreadResolver) when `marked_as_unread`
 *    or the viewer's read receipt watermark (keyed by `CurrentUser.getEIMU()`,
 *    which the shell sets to the viewer's pk) is older than
 *    `last_activity_timestamp_ms`;
 *  - PolarisStoriesV3AdsPoolQuery (asked once the tray has reels):
 *    `xdt_injected_story_units.ad_media_items[]`; there are no ads locally;
 *  - IGDOmniPickerNullStateListQuery (Direct "new message" picker, before any
 *    search): `get_paginated_share_sheet_ranked_items.ranked_items[]`, a union
 *    of ShareSheetUser and ShareSheetThread; answered with the viewer's group
 *    threads and the accounts the viewer follows, most recent Direct activity
 *    first;
 *  - PolarisStoriesV3AdsPoolWWWQuery: same contract as the ads pool, sent to
 *    /ads/igwww_ads_graphql/;
 *  - IGDChatTabsContentOffMsysQuery (the opened chat tab): the same mailbox,
 *    each thread with `slide_messages` (newest first, SlideMessageText);
 *  - PolarisSuggestedUserListRefetchQuery: the suggestions list's refetch
 *    (the empty feed), same response tree as PolarisSuggestedUserListQuery;
 *  - IGPresenceUnifiedSetupQuery `xdt_api__v1__get__presence__disabled
 *    {disabled}` and PolarisViewerSettingsQuery `viewer.user
 *    {is_reduce_motion_setting_enabled}`;
 *  - QuickPromotionSupportIGSchemaBatchFetchQuery: one
 *    `ig_quick_promotion_batch_fetch_root` entry per requested surface, with
 *    its `eligible_promotions` connection.
 */

const crypto = require('node:crypto');
const users = require('../backend/services/users');
const { stories } = require('../backend/services/social');
const present = require('./present');
const { unauthorized } = require('../backend/lib/errors');

const RELATIONSHIP_KINDS = new Set(['follow', 'follow_request', 'follow_accepted']);
const EMPTY_PAGE = { end_cursor: null, has_next_page: false };

function viewerOf(ctx) {
  if (!ctx.viewer) throw unauthorized();
  return ctx.viewer;
}

function ms(iso) {
  return iso ? String(Date.parse(iso)) : '0';
}

/**
 * Local "accounts you may know": users the viewer neither follows nor has
 * requested, ranked by how many of the accounts the viewer follows follow them,
 * then by follower count, then newest.
 */
function suggestions(db, viewerId, limit) {
  return db
    .prepare(
      `SELECT u.*,
         (SELECT COUNT(*) FROM follows f JOIN follows mine ON mine.followee_id = f.follower_id
            WHERE f.followee_id = u.id AND f.state = 'accepted' AND mine.follower_id = ? AND mine.state = 'accepted') AS mutuals,
         (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id AND f.state = 'accepted') AS followers
       FROM users u
       WHERE u.id != ? AND u.id NOT IN (SELECT followee_id FROM follows WHERE follower_id = ?)
       ORDER BY mutuals DESC, followers DESC, u.created_at DESC
       LIMIT ?`
    )
    .all(viewerId, viewerId, viewerId, limit);
}

/** One account the viewer follows that follows `userId` (for "Followed by ..."). */
function mutualName(db, viewerId, userId) {
  const row = db
    .prepare(
      `SELECT u.username FROM follows f JOIN follows mine ON mine.followee_id = f.follower_id JOIN users u ON u.id = f.follower_id
       WHERE f.followee_id = ? AND f.state = 'accepted' AND mine.follower_id = ? AND mine.state = 'accepted'
       ORDER BY f.created_at DESC LIMIT 1`
    )
    .get(userId, viewerId);
  return row ? row.username : null;
}

/**
 * A conversation's newest messages as a SlideMessage connection (newest first,
 * the order of Direct's thread item lists).
 */
function slideMessages(db, conversationId, first) {
  const rows = db
    .prepare(
      `SELECT m.pk, m.body, m.created_at, u.pk AS sender_pk FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at DESC, m.pk DESC LIMIT ?`
    )
    .all(conversationId, first + 1);
  const edges = rows.slice(0, first).map((m) => ({
    node: {
      __typename: 'SlideMessage',
      id: String(m.pk),
      sender_fbid: String(m.sender_pk),
      timestamp_ms: ms(m.created_at),
      igd_snippet: m.body,
      text_body: m.body,
      content: { __typename: 'SlideMessageText', text_body: m.body },
    },
    cursor: String(m.pk),
  }));
  return { edges, page_info: { end_cursor: edges.length ? edges[edges.length - 1].cursor : null, has_next_page: rows.length > first } };
}

/** The viewer's conversations as SlideThread nodes (newest activity first). */
function mailboxThreads(db, viewer, limit, { messages = 0 } = {}) {
  const rows = db
    .prepare(
      `SELECT c.id, c.pk, c.created_at,
         (SELECT MAX(created_at) FROM messages WHERE conversation_id = c.id AND deleted_at IS NULL) AS last_message_at
       FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
       WHERE m.user_id = ? ORDER BY COALESCE(last_message_at, c.created_at) DESC LIMIT ?`
    )
    .all(viewer.id, limit);
  const viewerUser = present.user(db, users.getById(db, viewer.id), null, { withFriendship: false });
  return rows.map((c) => {
    const members = db
      .prepare(
        `SELECT u.*, cm.last_seen_at,
           (SELECT MAX(created_at) FROM messages WHERE conversation_id = cm.conversation_id AND sender_id = u.id AND deleted_at IS NULL) AS last_sent_at
         FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ?`
      )
      .all(c.id);
    const others = members.filter((u) => u.id !== viewer.id);
    // A member has read up to the later of what they last opened and what they last sent.
    const receipts = members.map((u) => ({
      participant_fbid: String(u.pk),
      watermark_timestamp_ms: ms([u.last_seen_at, u.last_sent_at].filter(Boolean).sort().pop()),
    }));
    const thread = {
      __typename: 'XFBIGDirectViewerThread',
      id: String(c.pk),
      thread_key: String(c.pk),
      marked_as_unread: false,
      last_activity_timestamp_ms: ms(c.last_message_at || c.created_at),
      slide_read_receipts: receipts,
      thread_title: others.map((u) => u.username).join(', '),
      thread_image_url: null,
      viewer_id: String(viewer.pk),
      users: others.map((u) => ({ ...present.user(db, u, null, { withFriendship: false }), interop_messaging_user_fbid: String(u.pk) })),
      usersWithoutViewer: others.map((u) => ({ id: String(u.pk), is_internal_user: false })),
      is_group: others.length > 1,
      thread_id: String(c.pk),
      thread_fbid: String(c.pk),
      nicknames: [],
      is_pin: false,
      thread_subtype: null,
      viewer: { id: viewerUser.id, interop_messaging_user_fbid: String(viewer.pk), profile_pic_url: viewerUser.profile_pic_url },
      is_muted: false,
    };
    if (messages > 0) thread.slide_messages = slideMessages(db, c.id, messages);
    return { node: { __typename: 'SlideThread', id: `slide_thread:${c.pk}`, as_ig_direct_thread: thread }, cursor: String(c.pk) };
  });
}

/** Ranked share-sheet items for the Direct picker's null state. */
function shareSheetItems(db, viewer, limit) {
  const people = db
    .prepare(
      `SELECT u.*,
         (SELECT MAX(m.created_at) FROM messages m JOIN conversation_members a ON a.conversation_id = m.conversation_id
            JOIN conversation_members b ON b.conversation_id = m.conversation_id
            WHERE a.user_id = ? AND b.user_id = u.id AND m.deleted_at IS NULL) AS last_dm
       FROM follows f JOIN users u ON u.id = f.followee_id
       WHERE f.follower_id = ? AND f.state = 'accepted'
       ORDER BY last_dm IS NULL, last_dm DESC, f.created_at DESC LIMIT ?`
    )
    .all(viewer.id, viewer.id, limit);
  const groups = mailboxThreads(db, viewer, limit)
    .map((e) => e.node.as_ig_direct_thread)
    .filter((t) => t.users.length > 1);
  const asUser = (u) => ({
    __typename: 'ShareSheetUser',
    share_sheet_item_id: String(u.pk),
    is_meta_ai_bot: false,
    full_name: u.display_name || '',
    pk: String(u.pk),
    profile_pic_url: present.user(db, u, null, { withFriendship: false }).profile_pic_url,
    is_verified: false,
    username: u.username,
    interop_messaging_user_fbid: String(u.pk),
  });
  return [
    ...groups.map((t) => ({
      __typename: 'ShareSheetThread',
      share_sheet_item_id: t.thread_key,
      thread_id: t.thread_key,
      thread_title: t.thread_title,
      thread_image_url: null,
      users: t.users.map((u) => ({ profile_pic_url: u.profile_pic_url })),
    })),
    ...people.map(asUser),
  ].slice(0, limit);
}

function createHomeOperations(db) {
  function mailbox(vars, ctx, options) {
    const viewer = viewerOf(ctx);
    return {
      get_slide_mailbox_for_iris_subscription: {
        __typename: 'SlideMailbox',
        id: `slide_mailbox:${viewer.pk}`,
        iris_inactive_subscription_uq_seq_id: null,
        threads_by_folder: { edges: mailboxThreads(db, viewer, 50, options), page_info: EMPTY_PAGE },
        pinned_threads_v2: [],
      },
    };
  }

  const operations = {
    PolarisStoriesV3TrayContainerQuery(vars, ctx) {
      const viewer = viewerOf(ctx);
      const tray = stories.tray(db, viewer.id).map((t) => present.reel(db, users.getById(db, t.authorId), t.items, viewer.id));
      const me = present.user(db, users.getById(db, viewer.id), null, { withFriendship: false });
      return {
        xdt_api__v1__feed__reels_tray: { tray, broadcasts: [] },
        xdt_viewer: { user: { username: me.username, id: me.id, profile_pic_url: me.profile_pic_url } },
      };
    },

    PolarisSuggestedUserListQuery(vars, ctx) {
      const viewer = viewerOf(ctx);
      const data = vars.data && typeof vars.data === 'object' ? vars.data : {};
      const requested = Number(data.max_number_to_display ?? data.count ?? 30);
      const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 50) : 30;
      const items = suggestions(db, viewer.id, limit).map((row) => {
        const mutual = row.mutuals > 0 ? mutualName(db, viewer.id, row.id) : null;
        const context = mutual ? `Followed by ${mutual}` : null;
        return {
          user: { ...present.user(db, row, viewer.id), social_context: context, mutual_followers_count: row.mutuals },
          uuid: crypto.randomUUID(),
          social_context: context,
          social_context_facepile_users: [],
        };
      });
      return { ayml: { groups: items.length ? [{ items }] : [] } };
    },

    usePolarisNotificationsNavItemQuery(vars, ctx) {
      const viewer = viewerOf(ctx);
      const rows = db.prepare('SELECT kind, COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL GROUP BY kind').all(viewer.id);
      const counts = { comments: 0, likes: 0, relationships: 0, usertags: 0 };
      for (const r of rows) {
        if (r.kind === 'like') counts.likes += r.n;
        else if (r.kind === 'comment') counts.comments += r.n;
        else if (RELATIONSHIP_KINDS.has(r.kind)) counts.relationships += r.n;
      }
      const total = rows.reduce((n, r) => n + r.n, 0);
      return { xdt_notification_badge: { badge_count: { total_count: total, activity_badge_counts: counts } } };
    },

    // The empty feed's suggestions refetch the same fragment (identical response tree).
    PolarisSuggestedUserListRefetchQuery(vars, ctx) {
      return operations.PolarisSuggestedUserListQuery(vars, ctx);
    },

    PolarisStoriesV3AdsPoolQuery(vars, ctx) {
      viewerOf(ctx);
      return { xdt_injected_story_units: { ad_media_items: [] } };
    },

    PolarisStoriesV3AdsPoolWWWQuery(vars, ctx) {
      viewerOf(ctx);
      return { xdt_injected_story_units: { ad_media_items: [] } };
    },

    IGDOmniPickerNullStateListQuery(vars, ctx) {
      const viewer = viewerOf(ctx);
      return { get_paginated_share_sheet_ranked_items: { ranked_items: shareSheetItems(db, viewer, 30) } };
    },

    IGDBadgeCountOffMsysQuery: mailbox,
    IGDChatTabsJewelOffMsysQuery: mailbox,

    // The open chat tab's thread list, with each thread's newest messages (up to
    // the client's IGDMaxUnreadMessagesCount provider value). Nothing is pinned locally.
    IGDChatTabsContentOffMsysQuery(vars, ctx) {
      const first = Number(vars.__relay_internal__pv__IGDMaxUnreadMessagesCountrelayprovider);
      return mailbox(vars, ctx, { messages: Number.isInteger(first) && first > 0 ? Math.min(first, 50) : 20 });
    },

    // Activity status is on for every local account (the accounts API reports
    // presence_disabled: false as well).
    IGPresenceUnifiedSetupQuery(vars, ctx) {
      viewerOf(ctx);
      return { xdt_api__v1__get__presence__disabled: { disabled: false } };
    },

    // The only viewer setting this operation reads; there is no local
    // reduce-motion preference, so it is the default (off).
    PolarisViewerSettingsQuery(vars, ctx) {
      const viewer = viewerOf(ctx);
      return { viewer: { user: { id: String(viewer.pk), is_reduce_motion_setting_enabled: false } } };
    },

    QuickPromotionSupportIGSchemaBatchFetchQuery(vars) {
      // No promotions exist locally: every requested surface answers with none eligible.
      const surfaces = Array.isArray(vars.surface_nux_ids) ? vars.surface_nux_ids : [];
      return {
        ig_quick_promotion_batch_fetch_root: surfaces.map((id) => ({ surface_nux_id: String(id), eligible_promotions: { edges: [] } })),
      };
    },
  };
  return operations;
}

module.exports = { createHomeOperations, suggestions, mailboxThreads, shareSheetItems };
