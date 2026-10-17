'use strict';

/**
 * Presenters: our database rows in the object shapes the original client reads.
 *
 * Field names follow Instagram's v1 REST objects, which the web client's
 * `xdt_api__v1__*` GraphQL types mirror. Only data that exists in our database
 * is emitted; features we do not have (ads, music, translations, paid
 * partnerships) are present with their neutral "absent" value rather than
 * invented content, so components that read them take their empty path.
 *
 * The shapes are derived from Instagram's public v1 contract. Fields the
 * client turns out to need that are missing here should be added in this one
 * file, so every endpoint picks them up.
 */

const { epochSeconds } = require('../backend/lib/ids');
const { follows } = require('../backend/services/social');
const posts = require('../backend/services/posts');

const DEFAULT_AVATAR = '/__clone/static/default-avatar.svg';
const DEFAULT_MEDIA_SIZE = 1080;

const MEDIA_TYPE = { image: 1, video: 2, carousel: 8 };

function avatarOf(row) {
  return row.avatar_url || row.avatarUrl || DEFAULT_AVATAR;
}

function friendshipStatus(db, viewerId, target) {
  const s = follows.status(db, viewerId, target.id);
  return {
    following: s.following,
    followed_by: s.followedBy,
    blocking: false,
    muting: false,
    is_private: Boolean(target.is_private ?? target.isPrivate),
    incoming_request: s.incomingRequest,
    outgoing_request: s.outgoingRequest,
    is_bestie: false,
    is_restricted: false,
    is_feed_favorite: false,
  };
}

/** Compact user ("UserDict"), as embedded in media, comments and lists. */
function user(db, row, viewerId = null, { withFriendship = true } = {}) {
  if (!row) return null;
  const pk = String(row.pk);
  const out = {
    pk,
    pk_id: pk,
    id: pk,
    strong_id__: pk,
    username: row.username,
    full_name: row.display_name ?? row.displayName ?? '',
    is_private: Boolean(row.is_private ?? row.isPrivate),
    is_verified: false,
    profile_pic_url: avatarOf(row),
    has_anonymous_profile_picture: !(row.avatar_url || row.avatarUrl),
  };
  if (withFriendship && viewerId && viewerId !== row.id) out.friendship_status = friendshipStatus(db, viewerId, row);
  return out;
}

/** Full user ("info"), as returned for a profile. */
function userInfo(db, row, viewerId = null) {
  const counts = follows.counts(db, row.id);
  return {
    ...user(db, row, viewerId),
    biography: row.bio ?? '',
    external_url: row.external_url ?? '',
    follower_count: counts.followers,
    following_count: counts.following,
    media_count: posts.countByAuthor(db, row.id),
    is_business: false,
    account_type: 1,
    hd_profile_pic_url_info: { url: avatarOf(row), width: 320, height: 320 },
  };
}

function userRow(db, id) {
  return db.prepare('SELECT id, pk, username, display_name, avatar_url, is_private, bio, external_url FROM users WHERE id = ?').get(id);
}

function mediaId(post) {
  return `${post.pk}_${post.authorPk}`;
}

/** A post as a v1 media object ("XDTMediaDict"). */
function media(db, post, viewerId = null) {
  const author = userRow(db, post.authorId);
  const authorUser = user(db, author, viewerId);
  const takenAt = epochSeconds(post.createdAt);
  const width = post.mediaWidth || DEFAULT_MEDIA_SIZE;
  const height = post.mediaHeight || DEFAULT_MEDIA_SIZE;
  const id = mediaId(post);
  return {
    __typename: 'XDTMediaDict',
    id,
    pk: post.pk,
    strong_id__: id,
    code: post.code,
    taken_at: takenAt,
    media_type: MEDIA_TYPE[post.mediaType] || 1,
    product_type: 'feed',
    filter_type: 0,
    caption: post.caption
      ? {
          pk: `${post.pk}1`,
          text: post.caption,
          created_at: takenAt,
          created_at_utc: takenAt,
          user_id: author.pk,
          user: authorUser,
          media_id: id,
          type: 1,
          status: 'Active',
          has_translation: false,
        }
      : null,
    caption_is_edited: post.updatedAt !== post.createdAt,
    like_count: post.likeCount,
    comment_count: post.commentCount,
    has_liked: post.likedByViewer,
    has_viewer_saved: post.savedByViewer,
    can_viewer_save: Boolean(viewerId),
    can_viewer_reshare: false,
    comments_disabled: post.commentsDisabled,
    commenting_disabled_for_viewer: !viewerId || post.commentsDisabled,
    like_and_view_counts_disabled: false,
    image_versions2: { candidates: post.mediaUrl ? [{ url: post.mediaUrl, width, height }] : [] },
    original_width: width,
    original_height: height,
    display_uri: post.mediaUrl || null,
    user: authorUser,
    owner: authorUser,
    location: post.location ? { pk: '0', name: post.location, short_name: post.location } : null,
    usertags: { in: [] },
    carousel_media: null,
    carousel_media_count: null,
    video_versions: null,
    is_paid_partnership: false,
    sponsor_tags: null,
    clips_metadata: null,
    preview_comments: [],
    top_likers: [],
    facepile_top_likers: [],
    organic_tracking_token: '',
    inventory_source: null,
    is_dash_eligible: null,
  };
}

function comment(db, c, postPkWithAuthor) {
  const created = epochSeconds(c.createdAt);
  return {
    pk: c.pk,
    id: c.pk,
    text: c.body,
    created_at: created,
    created_at_utc: created,
    user_id: c.authorPk,
    user: {
      pk: c.authorPk,
      pk_id: c.authorPk,
      id: c.authorPk,
      username: c.authorUsername,
      full_name: c.authorDisplayName ?? '',
      profile_pic_url: c.authorAvatarUrl || DEFAULT_AVATAR,
      is_verified: false,
      is_private: false,
    },
    media_id: postPkWithAuthor,
    type: c.parentId ? 2 : 0,
    status: 'Active',
    parent_comment_id: c.parentPk ?? null,
    comment_like_count: 0,
    has_liked_comment: false,
    child_comment_count: 0,
  };
}

function storyItem(db, story, authorUser) {
  const takenAt = epochSeconds(story.createdAt);
  const id = `${story.pk}_${story.authorPk}`;
  return {
    id,
    pk: story.pk,
    strong_id__: id,
    taken_at: takenAt,
    expiring_at: epochSeconds(story.expiresAt),
    media_type: 1,
    product_type: 'story',
    image_versions2: {
      candidates: story.mediaUrl
        ? [{ url: story.mediaUrl, width: story.mediaWidth || 1080, height: story.mediaHeight || 1920 }]
        : [],
    },
    original_width: story.mediaWidth || 1080,
    original_height: story.mediaHeight || 1920,
    caption: story.caption ? { text: story.caption } : null,
    user: authorUser,
    can_reply: true,
    can_reshare: false,
    story_cta: null,
  };
}

/** A user's reel (their active stories) as the tray and the viewer read it. */
function reel(db, authorRow, items, viewerId) {
  const authorUser = user(db, authorRow, viewerId);
  const storyItems = items.map((s) => storyItem(db, s, authorUser));
  const latest = storyItems.reduce((m, s) => Math.max(m, s.taken_at), 0);
  const seenUpTo = items.filter((s) => s.seenByViewer).reduce((m, s) => Math.max(m, epochSeconds(s.createdAt)), 0);
  return {
    id: authorUser.pk,
    strong_id__: authorUser.pk,
    latest_reel_media: latest,
    expiring_at: storyItems.reduce((m, s) => Math.max(m, s.expiring_at), 0),
    seen: seenUpTo,
    can_reply: true,
    can_reshare: false,
    reel_type: 'user_reel',
    user: authorUser,
    items: storyItems,
    media_count: storyItems.length,
    media_ids: storyItems.map((s) => s.pk),
    prefetch_count: 0,
  };
}

function micros(iso) {
  return `${Date.parse(iso)}000`;
}

function threadItem(m) {
  return {
    item_id: m.pk,
    user_id: m.senderPk,
    timestamp: micros(m.createdAt),
    item_type: 'text',
    text: m.body,
    client_context: m.clientContext ?? undefined,
    is_sent_by_viewer: undefined,
  };
}

function thread(db, conv, viewer, { members, items, hasOlder, oldestCursor }) {
  const others = members.filter((m) => m.id !== viewer.id);
  const lastSeen = {};
  for (const m of members) if (m.last_seen_at) lastSeen[m.pk] = { timestamp: micros(m.last_seen_at), item_id: null };
  return {
    thread_id: conv.pk,
    thread_v2_id: conv.pk,
    users: others.map((m) => user(db, m, viewer.id)),
    viewer_id: viewer.pk,
    inviter: user(db, members[0], viewer.id, { withFriendship: false }),
    items: items.map((m) => ({ ...threadItem(m), is_sent_by_viewer: m.senderId === viewer.id })),
    last_activity_at: Number(micros(conv.updatedAt)),
    muted: false,
    is_group: members.length > 2,
    named: false,
    thread_title: others.map((m) => m.username).join(', '),
    pending: false,
    archived: false,
    thread_type: 'private',
    read_state: 0,
    last_seen_at: lastSeen,
    has_older: Boolean(hasOlder),
    has_newer: false,
    oldest_cursor: oldestCursor ?? null,
    newest_cursor: items[0]?.pk ?? null,
  };
}

/**
 * Activity ("news inbox") stories. story_type values follow the v1 activity
 * feed: 101 follow, 60 like, 12 comment, 75 follow request, 13 accepted.
 */
const ACTIVITY_TYPE = { follow: 101, like: 60, comment: 12, follow_request: 75, follow_accepted: 13 };

function activity(db, n) {
  const ts = epochSeconds(n.createdAt);
  const args = {
    text: `${n.actorUsername || 'Someone'} ${n.body || ''}`.trim(),
    profile_id: n.actorPk,
    profile_name: n.actorUsername,
    profile_image: n.actorAvatarUrl || DEFAULT_AVATAR,
    timestamp: ts,
    tuuid: n.id,
  };
  // A comment notification keeps the comment's text as its body; the story
  // reads "<name> commented: <text>" and shows the commented post.
  let postId = n.subjectType === 'post' ? n.subjectId : null;
  if (n.kind === 'comment') {
    args.text = `${n.actorUsername || 'Someone'} commented: ${n.body || ''}`.trim();
    const c = n.subjectType === 'comment' && n.subjectId ? db.prepare('SELECT post_id FROM comments WHERE id = ?').get(n.subjectId) : null;
    postId = c ? c.post_id : null;
  }
  if (postId) {
    const p = db.prepare('SELECT pk, media_url, code FROM posts WHERE id = ?').get(postId);
    if (p) args.media = [{ id: p.pk, image: p.media_url, shortcode: p.code }];
  }
  return { story_type: ACTIVITY_TYPE[n.kind] ?? 0, pk: n.id, type: 1, args, read: n.read };
}

module.exports = {
  DEFAULT_AVATAR,
  user,
  userInfo,
  userRow,
  friendshipStatus,
  media,
  mediaId,
  comment,
  reel,
  storyItem,
  thread,
  threadItem,
  activity,
  micros,
};
