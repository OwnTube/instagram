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
 *  - PolarisUserActionLoadSULV2Query (the activity feed's "Suggested for
 *    you"): `ayml{more_available, groups[].items[]{user{..friendship_status},
 *    uuid, social_context}}`, the same suggestions;
 *  - the Direct inbox page (PolarisDirectInboxRoot entry point):
 *    PolarisDirectInboxQuery (the mailbox: `threads_by_folder`, the
 *    professional accounts' `threads_by_system_folder_and_ig_inbox_folder`,
 *    `pinned_threads_v2`), useIGDSystemFolderUnreadThreadCountQuery (one
 *    folder's threads newer than a time; `INBOX` or `PENDING`, and there are
 *    no pending requests locally), IGDThreadListHeaderAccountSwitcherOffMsysQuery
 *    (`viewer.xdt_user`), PolarisAutomaticPreviewsDisabledContextProviderQuery
 *    (no stored preference: not disabled), useFeatureLimitsOffMsysQuery (no
 *    messaging limits), PolarisDirectInboxQPInterstitialQuery (no
 *    promotions) and IGDInboxTrayQuery (notes: none can be created here);
 *  - PolarisClipsHomeRootQuery (Reels tab): `xdt_api__v1__clips__home__
 *    connection_v2`; empty, as local accounts publish photos only;
 *  - one thread (`get_slide_thread_nullable`, by `thread_fbid`): the thread
 *    page's IGDInboxHeaderOffMsysQuery and IGDThreadDetailQuery, and the chat
 *    tab's IGDChatTabRootOffMsysQuery; text messages are SlideMessageText
 *    with content_type `TEXT`; useIGDMarkThreadAsReadMutation (opening a
 *    thread marks it seen) and its ...ValidationMutation;
 *  - IGDirectTextSendMutation: the thread composer's send, stored as a
 *    messages row;
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
const { stories, messages } = require('../backend/services/social');
const present = require('./present');
const { unauthorized, badRequest } = require('../backend/lib/errors');

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
 * the order of Direct's thread item lists). `senders` maps a member's pk to
 * the SlideUser shown beside their messages (name, avatar).
 */
function slideMessages(db, conversationId, first, threadPk, senders = new Map()) {
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
      sender: senders.get(String(m.sender_pk)) || null,
      timestamp_ms: ms(m.created_at),
      igd_snippet: m.body,
      text_body: m.body,
      content_type: 'TEXT',
      content: { __typename: 'SlideMessageText', text_body: m.body },
      message_id: String(m.pk),
      thread_fbid: String(threadPk),
      is_reported: false,
      is_ai_generated: false,
      igd_is_forwarded: false,
      reactions: [],
      msg_reactions: [],
      mentions: [],
    },
    cursor: String(m.pk),
  }));
  return { edges, page_info: { end_cursor: edges.length ? edges[edges.length - 1].cursor : null, has_next_page: rows.length > first } };
}

const THREAD_COLUMNS = `c.id, c.pk, c.created_at,
  (SELECT MAX(created_at) FROM messages WHERE conversation_id = c.id AND deleted_at IS NULL) AS last_message_at`;

/** The viewer's conversations as SlideThread nodes (newest activity first). */
function mailboxThreads(db, viewer, limit, options = {}) {
  const rows = db
    .prepare(
      `SELECT ${THREAD_COLUMNS}
       FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
       WHERE m.user_id = ? ORDER BY COALESCE(last_message_at, c.created_at) DESC LIMIT ?`
    )
    .all(viewer.id, limit);
  return rows.map((c) => threadEdge(db, viewer, c, options));
}

/** One of the viewer's conversations by its thread key (pk), as a SlideThread edge; null when the viewer is not in it. */
function viewerThread(db, viewer, threadKey, options = {}) {
  if (!/^\d{1,30}$/.test(String(threadKey ?? ''))) return null;
  const c = db
    .prepare(
      `SELECT ${THREAD_COLUMNS}
       FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
       WHERE c.pk = ? AND m.user_id = ?`
    )
    .get(String(threadKey), viewer.id);
  return c ? threadEdge(db, viewer, c, options) : null;
}

/** The viewer's conversation with this thread key (pk): {id, pk}, or null. */
function viewerConversation(db, viewer, threadKey) {
  if (!/^\d{1,30}$/.test(String(threadKey ?? ''))) return null;
  return db.prepare('SELECT c.id, c.pk FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id WHERE c.pk = ? AND m.user_id = ?').get(String(threadKey), viewer.id) || null;
}

function threadEdge(db, viewer, c, { messages = 0 } = {}) {
  const viewerUser = present.user(db, users.getById(db, viewer.id), null, { withFriendship: false });
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
    // Every local thread is in the inbox: there are no message requests,
    // spam or other folders here.
    folder: 'INBOX',
    system_folder: 'INBOX',
    // The thread list items require each member's friendship_status
    // (blocking, is_restricted), relative to the viewer.
    users: others.map((u) => ({ ...present.user(db, u, viewer.id), interop_messaging_user_fbid: String(u.pk) })),
    usersWithoutViewer: others.map((u) => ({ id: String(u.pk), is_internal_user: false })),
    is_group: others.length > 1,
    thread_id: String(c.pk),
    thread_fbid: String(c.pk),
    nicknames: [],
    is_pin: false,
    // String names of MessagingThreadSubtype: a one-to-one thread is
    // IG_ONLY_ONE_TO_ONE (isIGDOneToOneThread); groups are IGD_GROUP. The
    // thread composer requires a subtype (nullthrows).
    thread_subtype: others.length > 1 ? 'IGD_GROUP' : 'IG_ONLY_ONE_TO_ONE',
    viewer: { id: viewerUser.id, username: viewerUser.username, full_name: viewerUser.full_name, interop_messaging_user_fbid: String(viewer.pk), profile_pic_url: viewerUser.profile_pic_url },
    is_muted: false,
  };
  if (messages > 0) {
    const senders = new Map(
      members.map((u) => {
        const dict = { ...present.user(db, u, viewer.id), interop_messaging_user_fbid: String(u.pk), ai_agent_type: null };
        return [String(u.pk), { __typename: 'SlideUser', id: String(u.pk), igid: String(u.pk), name: u.display_name || u.username, user_dict: dict }];
      })
    );
    thread.slide_messages = slideMessages(db, c.id, messages, c.pk, senders);
  }
  return { node: { __typename: 'SlideThread', id: `slide_thread:${c.pk}`, as_ig_direct_thread: thread }, cursor: String(c.pk) };
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

  function slideThread(vars, ctx) {
    const viewer = viewerOf(ctx);
    const first = Number(vars.__relay_internal__pv__IGDInitialMessagePageCountrelayprovider);
    const edge = viewerThread(db, viewer, vars.thread_fbid, { messages: Number.isInteger(first) && first > 0 ? Math.min(first, 100) : 20 });
    if (!edge) return { get_slide_thread_nullable: null };
    // No admins, pinned messages or event chats locally.
    Object.assign(edge.node.as_ig_direct_thread, { admin_user_ids: [], pinned_messages: [], pinned_messages_metadata: [] });
    return { get_slide_thread_nullable: edge.node };
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

    // The story viewer marks each item seen (PolarisAPIReelSeen):
    // `xdt_mark_story_reel_seen(reelMediaId, ...)`, an XDTMarkSeenResponse
    // with no fields the client reads. Recorded like POST
    // /api/v1/media/seen/ (the viewer must be able to see the story).
    PolarisAPIReelSeenMutation(vars, ctx) {
      const viewer = viewerOf(ctx);
      const pk = String(vars.reelMediaId ?? '').split('_')[0];
      if (!/^\d{1,30}$/.test(pk)) throw badRequest('Invalid story id');
      stories.markSeen(db, pk, viewer.id);
      return { xdt_mark_story_reel_seen: { __typename: 'XDTMarkSeenResponse' } };
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

    // The activity feed's suggestions: the same list, all of it in one page.
    PolarisUserActionLoadSULV2Query(vars, ctx) {
      const { ayml } = operations.PolarisSuggestedUserListQuery(vars, ctx);
      return { ayml: { ...ayml, more_available: false } };
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

    // The Direct inbox page's thread list. Professional accounts read the same
    // threads by system and inbox folder (primary); there are none locally,
    // but the connection is the same list for any reader.
    PolarisDirectInboxQuery(vars, ctx) {
      const first = Number(vars.__relay_internal__pv__IGDMaxUnreadMessagesCountrelayprovider);
      const out = mailbox(vars, ctx, { messages: Number.isInteger(first) && first > 0 ? Math.min(first, 50) : 20 });
      const box = out.get_slide_mailbox_for_iris_subscription;
      box.threads_by_system_folder_and_ig_inbox_folder = { edges: box.threads_by_folder.edges, page_info: EMPTY_PAGE };
      return out;
    },

    useIGDSystemFolderUnreadThreadCountQuery(vars, ctx) {
      const viewer = viewerOf(ctx);
      const since = Number(vars.newer_than_timestamp_ms) || 0;
      const edges = String(vars.folder || 'INBOX') === 'INBOX' ? mailboxThreads(db, viewer, 50).filter((e) => Number(e.node.as_ig_direct_thread.last_activity_timestamp_ms) >= since) : [];
      return {
        get_slide_mailbox_for_iris_subscription: {
          __typename: 'SlideMailbox',
          id: `slide_mailbox:${viewer.pk}`,
          threads_by_folder: { edges, page_info: EMPTY_PAGE },
        },
      };
    },

    IGDThreadListHeaderAccountSwitcherOffMsysQuery(vars, ctx) {
      const me = present.user(db, users.getById(db, viewerOf(ctx).id), null, { withFriendship: false });
      return { viewer: { xdt_user: { id: me.id, username: me.username, is_verified: false } } };
    },

    PolarisAutomaticPreviewsDisabledContextProviderQuery(vars, ctx) {
      viewerOf(ctx);
      return { xdt_get_igd_automatic_previews_disabled: { disabled: false } };
    },

    useFeatureLimitsOffMsysQuery(vars, ctx) {
      viewerOf(ctx);
      return { xfb_ix_ig_account_status_web: { profile_wording_enabled: false }, xfb_feature_limits: { limits: [] } };
    },

    PolarisDirectInboxQPInterstitialQuery(vars, ctx) {
      viewerOf(ctx);
      return { xfb_viewer: { eligible_promotions: { nodes: [] } } };
    },

    IGDInboxTrayQuery(vars, ctx) {
      viewerOf(ctx);
      return { response: { inbox_tray_items: [] } };
    },

    // One thread of the viewer's (header, thread view, chat tab), by
    // thread_fbid (the thread key); null for a thread the viewer is not in.
    // Messages: newest first, up to the client's IGDInitialMessagePageCount.
    IGDInboxHeaderOffMsysQuery: slideThread,
    IGDThreadDetailQuery: slideThread,
    IGDChatTabRootOffMsysQuery: slideThread,

    // Opening a thread marks it read up to now for the viewer (the same as
    // the v1 "seen" endpoint); the answer is the viewer's new read receipt.
    useIGDMarkThreadAsReadMutation(vars, ctx) {
      const viewer = viewerOf(ctx);
      const c = viewerConversation(db, viewer, vars.metadata && vars.metadata.ig_thread_igid);
      if (!c) throw badRequest('Unknown thread');
      messages.markSeen(db, c.id, viewer.id);
      const row = db.prepare('SELECT last_seen_at FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(c.id, viewer.id);
      return {
        xig_direct_item_seen_mutation_with_slide_messaging_response: { __typename: 'XFBSlideReadReceipt', participant_eimu_id: String(viewer.pk), watermark_timestamp_ms: ms(row.last_seen_at) },
      };
    },

    // The thread composer's send (IGDTextPublisher): flat variables
    // (ig_thread_igid, text {sensitive_string_value}, offline_threading_id,
    // ..; IGDMAPISendTextMessage; the operation builds its `data` argument
    // from them); the reply is the stored message
    // (SlideMessage {message_id, timestamp_ms}). A repeated
    // offline_threading_id returns the original message.
    IGDirectTextSendMutation(vars, ctx) {
      const viewer = viewerOf(ctx);
      const data = vars;
      const c = viewerConversation(db, viewer, data.ig_thread_igid);
      if (!c) throw badRequest('Unknown thread');
      const text = String((data.text && data.text.sensitive_string_value) ?? '').trim();
      if (!text) throw badRequest('Message cannot be empty.');
      if (text.length > 5000) throw badRequest('Message is too long.');
      const clientContext = data.offline_threading_id != null ? String(data.offline_threading_id).slice(0, 64) : undefined;
      const msg = messages.send(db, c.id, viewer.id, text, { clientContext });
      return {
        xig_direct_text_send_with_slide_messaging_response: { __typename: 'SlideMessage', id: String(msg.pk), message_id: String(msg.pk), timestamp_ms: ms(msg.createdAt) },
      };
    },

    // Whether the message the client marked read is one of that thread's.
    useIGDMarkThreadAsReadValidationMutation(vars, ctx) {
      const viewer = viewerOf(ctx);
      const c = viewerConversation(db, viewer, vars.metadata && vars.metadata.ig_thread_igid);
      const id = String((vars.data && vars.data.message_id) ?? '');
      const found = c && /^\d{1,30}$/.test(id) ? db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND pk = ? AND deleted_at IS NULL').get(c.id, id) : null;
      return { xig_direct_mark_read_id_validation: Boolean(found) };
    },

    // The Reels tab's clips. Reels are videos and local accounts can only
    // publish photos, so no clip exists here: the connection is empty.
    PolarisClipsHomeRootQuery(vars, ctx) {
      viewerOf(ctx);
      return { xdt_api__v1__clips__home__connection_v2: { edges: [], gating: null, page_info: { end_cursor: null, has_next_page: false, has_previous_page: false, start_cursor: null } } };
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
