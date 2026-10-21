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
 *    promotions) and IGDInboxTrayQuery (the notes the viewer may see, see
 *    inboxTrayItem);
 *  - PolarisClipsHomeRootQuery (Reels tab): `xdt_api__v1__clips__home__
 *    connection_v2`, the reels the viewer may see, newest first;
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
const posts = require('../backend/services/posts');
const { stories, messages } = require('../backend/services/social');
const { notes } = require('../backend/services/notes');
const present = require('./present');
const { unauthorized, badRequest, notFound } = require('../backend/lib/errors');

const RELATIONSHIP_KINDS = new Set(['follow', 'follow_request', 'follow_accepted']);
const EMPTY_PAGE = { end_cursor: null, has_next_page: false };

function viewerOf(ctx) {
  if (!ctx.viewer) throw unauthorized();
  return ctx.viewer;
}

const NOTE_STYLE_TEXT = 0; // PolarisNotesTypes NoteStyle.TEXT

/** A note as an inbox tray item (IGDInboxTrayQuery / the create mutation). */
function inboxTrayItem(db, note) {
  const author = present.user(db, present.userRow(db, note.authorId), null, { withFriendship: false });
  return {
    inbox_tray_item_id: String(note.pk),
    inbox_tray_item_type: 'note',
    pog_info: {
      pog_style: 'user',
      pog_users: [{ id: author.id, profile_pic_url: author.profile_pic_url, profile_pic_url_hd: author.profile_pic_url, username: author.username, full_name: author.full_name, interop_messaging_user_fbid: null }],
    },
    note_dict: {
      note_style: NOTE_STYLE_TEXT,
      note_response_info: null,
      custom_theme: null,
      text: note.text,
      is_emoji_only: /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u.test(note.text) && /\p{Extended_Pictographic}/u.test(note.text),
      audience: note.audience,
      author_id: author.id,
      created_at: Math.floor(Date.parse(note.createdAt) / 1000),
    },
  };
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
 * A shared post as the message's XMA content. The client's own mapping of a
 * shared post (mapToLSAttachment, item_type media_share) is a single-layout
 * share with the author as header, the image as preview and the caption as
 * title: SlideMessageStandardXMA. Pressing it opens the client's Direct post
 * modal from target_id (the media id) and the shortcode it reads from the
 * last segment of target_url (getIGDShortCodeFromMediaDeeplinkUrl); the URL
 * is this origin's own post path. A post the viewer can no longer see is a
 * placeholder XMA.
 */
function sharedPostContent(db, postId, viewerId) {
  const post = present.sharedPost(db, postId, viewerId);
  if (!post) return { __typename: 'SlideMessageXMAContent', xma_text_body: null, xma: { __typename: 'SlideMessagePlaceholderXMA', title_text: null, caption_body_text: null } };
  const m = present.media(db, post, viewerId);
  const still = m.image_versions2.candidates[0] || null;
  return {
    __typename: 'SlideMessageXMAContent',
    xma_text_body: null,
    xma: {
      __typename: 'SlideMessageStandardXMA',
      header_title_text: m.user.username,
      header_icon: { url: m.user.profile_pic_url },
      header_subtitle_text: null,
      title_text: post.caption || null,
      caption_body_text: null,
      preview_image: still ? { url: still.url, fallback_url: null, width: still.width, height: still.height, preview_image_decoration_type: null } : null,
      target_id: m.id,
      target_url: `/p/${post.code}/`,
      // The client draws the preview only for a SINGLE (or grid) layout; its
      // REST mapping of a shared post uses MNLSXMALayoutType.SINGLE.
      preview_layout_type: still ? 'SINGLE' : null,
      cta_buttons: [],
    },
  };
}

const MESSAGE_SELECT = `SELECT m.pk, m.body, m.shared_post_id, m.client_context, m.created_at, u.pk AS sender_pk, u.username AS sender_username
  FROM messages m JOIN users u ON u.id = m.sender_id`;

/** One stored message as a SlideMessage node, as `viewer` sees it. */
function slideMessage(db, m, threadPk, senders, viewer) {
  let snippet = m.body;
  let content = { __typename: 'SlideMessageText', text_body: m.body };
  if (m.shared_post_id) {
    content = sharedPostContent(db, m.shared_post_id, viewer && viewer.id);
    const author = content.xma.header_title_text;
    const mine = viewer && String(viewer.pk) === String(m.sender_pk);
    snippet = author ? `${mine ? 'You' : m.sender_username} sent a post by ${author}.` : `${mine ? 'You' : m.sender_username} sent an attachment.`;
  }
  return {
    __typename: 'SlideMessage',
    id: String(m.pk),
    sender_fbid: String(m.sender_pk),
    sender: senders.get(String(m.sender_pk)) || null,
    timestamp_ms: ms(m.created_at),
    igd_snippet: snippet,
    text_body: m.shared_post_id ? null : m.body,
    // SlideMessage content types the client names are TEXT and a few
    // XMA kinds; none names a post share, so a share has none.
    content_type: m.shared_post_id ? null : 'TEXT',
    content,
    message_id: String(m.pk),
    // The sending client's own id for the message (its optimistic copy is
    // keyed by it), when it gave one.
    offline_threading_id: m.client_context ?? null,
    thread_fbid: String(threadPk),
    is_reported: false,
    is_ai_generated: false,
    igd_is_forwarded: false,
    reactions: [],
    msg_reactions: [],
    mentions: [],
  };
}

/**
 * A conversation's newest messages as a SlideMessage connection (newest first,
 * the order of Direct's thread item lists). `senders` maps a member's pk to
 * the SlideUser shown beside their messages (name, avatar). A shared post's
 * snippet is the client's own wording ("You sent a post by {author}.").
 */
function slideMessages(db, conversationId, first, threadPk, senders = new Map(), viewer = null) {
  const rows = db
    .prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at DESC, m.pk DESC LIMIT ?`)
    .all(conversationId, first + 1);
  const edges = rows.slice(0, first).map((m) => ({ node: slideMessage(db, m, threadPk, senders, viewer), cursor: String(m.pk) }));
  return { edges, page_info: { end_cursor: edges.length ? edges[edges.length - 1].cursor : null, has_next_page: rows.length > first } };
}

/** The SlideUser for each member, keyed by pk, as `viewer` sees them. */
function threadSenders(db, viewer, members) {
  return new Map(
    members.map((u) => {
      const dict = { ...present.user(db, u, viewer.id), interop_messaging_user_fbid: String(u.pk), ai_agent_type: null };
      return [String(u.pk), { __typename: 'SlideUser', id: String(u.pk), igid: String(u.pk), name: u.display_name || u.username, user_dict: dict }];
    })
  );
}

/**
 * One message (by id) as a SlideMessage node for `viewer`, a member of its
 * conversation; null otherwise. The realtime endpoint sends it in a new-message
 * delta, the same node a thread's message list holds.
 */
function slideMessageNode(db, viewer, messageId) {
  const m = db.prepare(`${MESSAGE_SELECT.replace('SELECT ', 'SELECT m.conversation_id, ')} WHERE m.id = ? AND m.deleted_at IS NULL`).get(messageId);
  if (!m) return null;
  const c = db
    .prepare('SELECT c.pk FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id WHERE c.id = ? AND cm.user_id = ?')
    .get(m.conversation_id, viewer.id);
  if (!c) return null;
  const members = db.prepare('SELECT u.* FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ?').all(m.conversation_id);
  return slideMessage(db, m, c.pk, threadSenders(db, viewer, members), viewer);
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
  if (messages > 0) thread.slide_messages = slideMessages(db, c.id, messages, c.pk, threadSenders(db, viewer, members), viewer);
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
        // The client keys the mailbox "SlideMailbox:" + its EIMU (the viewer pk;
        // IGDGetSlideMailbox), so the id is the pk.
        id: String(viewer.pk),
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

  function likeStory(vars, ctx, liked) {
    const viewer = viewerOf(ctx);
    const pk = String((vars.input && vars.input.media_id) ?? '').split('_')[0];
    if (!/^\d{1,30}$/.test(pk)) throw badRequest('Invalid story id');
    stories.setLike(db, pk, viewer.id, liked);
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

    // The story viewer's heart (usePolarisStoryLikes): input {media_id}, the
    // story's "<pk>_<author pk>" id. The reply payloads have no fields the
    // client reads; the liked state comes back as the item's has_liked.
    usePolarisStoryLikesLikeMutation(vars, ctx) {
      likeStory(vars, ctx, true);
      return { xig_send_story_like: { __typename: 'XIGSendStoryLikeResponsePayload' } };
    },

    usePolarisStoryLikesUnlikeMutation(vars, ctx) {
      likeStory(vars, ctx, false);
      return { xig_unsend_story_like: { __typename: 'XIGUnsendStoryLikeResponsePayload' } };
    },

    // The More menu's Ads Manager item, shown only with an entry-point URL:
    // there is no Ads Manager locally.
    PolarisAdsManagerMenuItemQuery() {
      return { xig_ig_web_ads_manager_entrypoint_root_query: { ads_manager_entrypoint_url: null } };
    },

    // Whether the account is eligible for Meta-account ("feta") flows; local
    // accounts are not Meta accounts.
    PolarisMoreContextMenuIsFetaQuery() {
      return { xfb_is_feta_account_eligible_for_flow: false };
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
        if (r.kind === 'like' || r.kind === 'comment_like') counts.likes += r.n;
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

    // A post's share sheet (paper plane), before any search: the same ranked
    // people and group threads, each person with the sheet's own friendship
    // status (nobody is blocked locally; reachability is not modelled: null).
    PolarisShareSheetV3NullStateQuery(vars, ctx) {
      const viewer = viewerOf(ctx);
      const ranked = shareSheetItems(db, viewer, 30).map((item) =>
        item.__typename === 'ShareSheetUser' ? { ...item, friendship_status: { blocking: false, reachability_status: null } } : item
      );
      return { get_paginated_share_sheet_ranked_items: { ranked_items: ranked } };
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
          // The client keys the mailbox "SlideMailbox:" + its EIMU (the viewer pk;
        // IGDGetSlideMailbox), so the id is the pk.
        id: String(viewer.pk),
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

    // Notes in the inbox tray. IGDInboxTray.react shows items with
    // inbox_tray_item_type `note` and pog_info.pog_style `user`, the author
    // being pog_users[0] (the viewer's own note is found by that id).
    IGDInboxTrayQuery(vars, ctx) {
      const viewer = viewerOf(ctx);
      return { response: { inbox_tray_items: notes.visibleTo(db, viewer.id).map((n) => inboxTrayItem(db, n)) } };
    },

    // usePolarisCreateInboxTrayItemSubmit: input {inbox_tray_item_type: 'note',
    // audience (PolarisNotesTypes MUTUAL_FOLLOWS 0 / BESTIES 1),
    // additional_params.note_create_params {text, note_style}}. Music notes
    // (note_style MUSIC) are not supported: there is no music catalogue here.
    usePolarisCreateInboxTrayItemSubmitMutation(vars, ctx) {
      const viewer = viewerOf(ctx);
      const input = vars.input || {};
      if (input.inbox_tray_item_type !== 'note') throw badRequest('Only notes can be shared');
      const params = (input.additional_params && input.additional_params.note_create_params) || {};
      if (params.note_style != null && Number(params.note_style) !== NOTE_STYLE_TEXT) throw badRequest('Only text notes are supported');
      const note = notes.create(db, viewer.id, { text: params.text, audience: input.audience ?? 0 });
      return { xdt_create_inbox_tray_item: { inbox_tray_item: inboxTrayItem(db, note) } };
    },

    // usePolarisDeleteInboxTrayItemSubmit: {inbox_tray_item_id} (the note's pk).
    usePolarisDeleteInboxTrayItemSubmitMutation(vars, ctx) {
      const viewer = viewerOf(ctx);
      notes.remove(db, vars.inbox_tray_item_id, viewer.id);
      return { xdt_delete_inbox_tray_item: { success: true } };
    },

    // One thread of the viewer's (header, thread view, chat tab), by
    // thread_fbid (the thread key); null for a thread the viewer is not in.
    // Messages: newest first, up to the client's IGDInitialMessagePageCount.
    IGDInboxHeaderOffMsysQuery: slideThread,
    IGDThreadDetailQuery: slideThread,
    IGDChatTabRootOffMsysQuery: slideThread,
    // A thread a live new-message delta names (src/realtime/), fetched to
    // update the inbox row (IGDHandleWithFetchThreadFallback).
    IGDSlideAsyncFetchAndInsertIGDViewerThreadQuery: slideThread,

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

    // The share sheet's Send (IGDMAPISendMediaShare): data {media_id} and
    // send_data {thread_id} or {recipient_users: a JSON list of account pks},
    // with offline_threading_id. One recipient shares into the existing
    // conversation with them; several start a group. A repeated
    // offline_threading_id returns the original message.
    IGDirectMediaShareMutation(vars, ctx) {
      const viewer = viewerOf(ctx);
      const send = vars.send_data || {};
      const postId = posts.resolveId(db, String((vars.data && vars.data.media_id) ?? ''));
      if (!postId) throw notFound('Post not found');
      let conversationId;
      if (send.thread_id != null) {
        const c = viewerConversation(db, viewer, send.thread_id);
        if (!c) throw badRequest('Unknown thread');
        conversationId = c.id;
      } else {
        let pks;
        try {
          pks = JSON.parse(String(send.recipient_users ?? ''));
        } catch {
          pks = null;
        }
        if (!Array.isArray(pks) || !pks.length || pks.length > 32 || !pks.every((pk) => /^\d{1,30}$/.test(String(pk)))) throw badRequest('recipient_users must list user ids');
        const ids = pks.map((pk) => {
          const row = users.getByPk(db, String(pk));
          if (!row) throw notFound('User not found');
          return row.id;
        }).filter((id) => id !== viewer.id);
        if (!ids.length) throw badRequest('recipient_users must list user ids');
        conversationId = ids.length === 1 ? messages.findOrCreateDirect(db, viewer.id, ids[0]).id : messages.createConversation(db, viewer.id, ids).id;
      }
      const clientContext = send.offline_threading_id != null ? String(send.offline_threading_id).slice(0, 64) : undefined;
      const msg = messages.send(db, conversationId, viewer.id, '', { clientContext, sharedPostId: postId });
      return {
        direct_media_share_with_slide_response: { __typename: 'SlideMessage', id: String(msg.pk), message_id: String(msg.pk), timestamp_ms: ms(msg.createdAt) },
      };
    },

    // The "New message" dialog's Chat with someone the viewer has no thread
    // with: the client opens an optimistic thread (/direct/t/<fbid>/) and
    // reads the recipient by their messaging id, which is the account pk here
    // (interop_messaging_user_fbid). Unknown ids are null.
    useIGDCreateOptimisticThreadUserQuery(vars, ctx) {
      const viewer = viewerOf(ctx);
      const fbid = String(vars.messaging_user_fbid ?? '');
      const row = /^\d{1,30}$/.test(fbid) ? users.getByPk(db, fbid) : null;
      if (!row) return { xig_user_from_messaging_user_fbid: null };
      const u = present.user(db, row, viewer.id);
      return {
        xig_user_from_messaging_user_fbid: {
          id: u.id,
          username: u.username,
          full_name: u.full_name,
          profile_pic_url: u.profile_pic_url,
          is_verified: u.is_verified,
          interop_messaging_user_fbid: String(row.pk),
          friendship_status: { blocking: Boolean(u.friendship_status && u.friendship_status.blocking), is_restricted: Boolean(u.friendship_status && u.friendship_status.is_restricted) },
        },
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

    // The Reels tab's clips: the reels (video posts) the viewer may see,
    // newest first (no recommendation ranking here); edges are
    // XDTClipsItemDict nodes holding the media.
    PolarisClipsHomeRootQuery(vars, ctx) {
      const viewer = viewerOf(ctx);
      const first = Math.min(Math.max(Number(vars.first) || 10, 1), 30);
      const page = posts.listClips(db, viewer.id, { limit: first, cursor: vars.after || null });
      const edges = page.items.map((p) => ({ cursor: p.id, node: { __typename: 'XDTClipsItemDict', media: present.media(db, p, viewer.id) } }));
      return {
        xdt_api__v1__clips__home__connection_v2: {
          edges,
          gating: null,
          page_info: { end_cursor: page.nextCursor, has_next_page: Boolean(page.nextCursor), has_previous_page: false, start_cursor: edges[0]?.cursor ?? null },
        },
      };
    },

    // Ads injected between reels: this server serves no ads.
    PolarisClipsAdsPoolQuery(vars, ctx) {
      viewerOf(ctx);
      return { xdt_injected_reels_units: { ad_media_items: [] } };
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

module.exports = { createHomeOperations, suggestions, mailboxThreads, shareSheetItems, slideMessageNode };
