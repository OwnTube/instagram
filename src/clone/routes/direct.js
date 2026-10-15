'use strict';

/**
 * Direct messaging over the v1 `direct_v2` REST contract.
 *
 * Instagram's current web client also uses a realtime MQTT channel for live
 * delivery; that channel is not reproduced (see docs/IMPLEMENTATION-STATUS.md).
 * Everything here is persisted and membership-checked on every call.
 */

const users = require('../../backend/services/users');
const { messages } = require('../../backend/services/social');
const { badRequest, notFound } = require('../../backend/lib/errors');
const { isPk } = require('../../backend/lib/ids');
const { igOk } = require('../respond');
const present = require('../present');
const { page } = require('./content');

function jsonList(value, field) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw badRequest(`${field} must be a JSON list`);
  }
}

function register(router, ctx) {
  const { db, requireViewer } = ctx;

  function conversationOrThrow(ref, viewerId) {
    const id = messages.resolveConversation(db, ref);
    if (!id) throw notFound('Thread not found');
    messages.requireMembership(db, id, viewerId);
    return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  }

  function shapedThread(conv, viewer, { limit = 20, cursor } = {}) {
    const result = messages.listMessages(db, conv.id, viewer.id, { limit, cursor });
    const conversation = { id: conv.id, pk: conv.pk, updatedAt: conv.updated_at };
    return present.thread(db, conversation, viewer, {
      members: messages.members(db, conv.id),
      items: result.items,
      hasOlder: Boolean(result.nextCursor),
      oldestCursor: result.nextCursor,
    });
  }

  function recipientIds(raw, viewer) {
    const flat = jsonList(raw, 'recipient_users').flat(2).map(String);
    if (!flat.length || flat.length > 32 || !flat.every(isPk)) throw badRequest('recipient_users must list user ids');
    return flat.map((pk) => {
      const row = users.getByPk(db, pk);
      if (!row) throw notFound('User not found');
      return row.id;
    }).filter((id) => id !== viewer.id);
  }

  router.get('/api/v1/direct_v2/inbox/', requireViewer, (req, res) => {
    const convs = messages.listConversations(db, req.viewer.id);
    const threads = convs.slice(0, 50).map((c) => shapedThread(db.prepare('SELECT * FROM conversations WHERE id = ?').get(c.id), req.viewer, { limit: 1 }));
    return igOk(res, {
      viewer: present.user(db, req.viewer, null),
      inbox: { threads, has_older: false, oldest_cursor: null, unseen_count: messages.unseenCount(db, req.viewer.id), unseen_count_ts: Date.now() * 1000 },
      pending_requests_total: 0,
      seq_id: 0,
    });
  });

  router.get('/api/v1/direct_v2/threads/:id/', requireViewer, (req, res) => {
    const conv = conversationOrThrow(req.params.id, req.viewer.id);
    const { limit, cursor } = page(req, { fallback: 20, max: 100 });
    const cursorParam = req.params_.cursor ? String(req.params_.cursor) : cursor;
    return igOk(res, { thread: shapedThread(conv, req.viewer, { limit, cursor: cursorParam }) });
  });

  router.get('/api/v1/direct_v2/threads/get_by_participants/', requireViewer, (req, res) => {
    const ids = recipientIds(req.params_.recipient_users, req.viewer);
    if (ids.length !== 1) return igOk(res, { thread: null });
    const existing = db
      .prepare(
        `SELECT c.* FROM conversations c
         WHERE (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id) = 2
           AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = ?)
           AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = ?)`
      )
      .get(req.viewer.id, ids[0]);
    return igOk(res, { thread: existing ? shapedThread(existing, req.viewer) : null });
  });

  router.post('/api/v1/direct_v2/create_group_thread/', requireViewer, (req, res) => {
    const ids = recipientIds(req.params_.recipient_users, req.viewer);
    const created = messages.createConversation(db, req.viewer.id, ids);
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(created.id);
    return igOk(res, shapedThread(conv, req.viewer));
  });

  router.post('/api/v1/direct_v2/threads/broadcast/text/', requireViewer, (req, res) => {
    const text = String(req.params_.text ?? '').trim();
    if (!text) throw badRequest('Message cannot be empty.');
    if (text.length > 5000) throw badRequest('Message is too long.');
    const clientContext = req.params_.client_context ? String(req.params_.client_context).slice(0, 64) : undefined;
    const threadIds = jsonList(req.params_.thread_ids, 'thread_ids').map(String);
    let conversationId;
    if (threadIds.length) {
      if (threadIds.length !== 1) throw badRequest('Send to one thread at a time');
      conversationId = conversationOrThrow(threadIds[0], req.viewer.id).id;
    } else {
      const ids = recipientIds(req.params_.recipient_users, req.viewer);
      conversationId = ids.length === 1 ? messages.findOrCreateDirect(db, req.viewer.id, ids[0]).id : messages.createConversation(db, req.viewer.id, ids).id;
    }
    const msg = messages.send(db, conversationId, req.viewer.id, text, { clientContext });
    const conv = db.prepare('SELECT pk FROM conversations WHERE id = ?').get(conversationId);
    return igOk(res, {
      action: 'item_ack',
      status_code: '200',
      payload: { client_context: msg.clientContext, item_id: msg.pk, thread_id: conv.pk, timestamp: present.micros(msg.createdAt) },
    });
  });

  router.post('/api/v1/direct_v2/threads/:id/items/:item/seen/', requireViewer, (req, res) => {
    const conv = conversationOrThrow(req.params.id, req.viewer.id);
    messages.markSeen(db, conv.id, req.viewer.id);
    return igOk(res, { action: 'mark_seen', status_code: '200' });
  });

  router.post('/api/v1/direct_v2/threads/:id/items/:item/delete/', requireViewer, (req, res) => {
    conversationOrThrow(req.params.id, req.viewer.id);
    messages.remove(db, String(req.params.item), req.viewer.id);
    return igOk(res, {});
  });

  router.get('/api/v1/direct_v2/get_badge_count/', requireViewer, (req, res) =>
    igOk(res, { badge_count: messages.unseenCount(db, req.viewer.id), seq_id: 0 })
  );
  router.get('/api/v1/direct_v2/get_presence/', requireViewer, (req, res) => igOk(res, { user_presence: {} }));
}

module.exports = { register };
