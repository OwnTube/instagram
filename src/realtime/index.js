'use strict';

/**
 * The local realtime endpoint. The pinned client opens its realtime sockets to
 * Instagram's hosts; the runtime (src/shell/runtime.js) points them here
 * instead, at /__clone/realtime/<host><path>?<query>:
 *
 *  - gateway.instagram.com/ws/lightspeed: the DGW gateway (src/realtime/dgw.js)
 *    carrying the client's message sync (src/realtime/lightspeed.js). This is
 *    how Direct shows new messages without a refresh: when a message is
 *    stored, every member's open sync stream gets a new-message delta, and
 *    when a member reads the thread, a read-receipt delta ("Seen").
 *  - gateway.instagram.com/ws/streamcontroller: the gateway's request streams
 *    (typing indicators, presence). They are accepted and acknowledged; no
 *    events are sent on them.
 *  - edge-chat.*: MQTT (src/realtime/mqtt.js) for calls and the request-stream
 *    bridge. Packets are acknowledged; nothing is published to the client.
 *
 * Only signed-in browsers are accepted (the session cookie travels with the
 * upgrade request, as with every same-origin request), and each delta is built
 * for, and checked against, the receiving viewer.
 */

const { acceptWebSocket } = require('./websocket');
const mqtt = require('./mqtt');
const dgw = require('./dgw');
const ls = require('./lightspeed');
const events = require('../backend/lib/events');
const { slideMessageNode } = require('../clone/homeOperations');

const PREFIX = '/__clone/realtime/';

/** A request-like view of an upgrade request, for resolveSession. */
function requestView(req) {
  return { headers: req.headers, get: (name) => req.headers[String(name).toLowerCase()] };
}

function shapeOf(value, depth = 0) {
  if (depth > 3) return '…';
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0], depth + 1)] : [];
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).slice(0, 30)) out[k] = shapeOf(value[k], depth + 1);
    return out;
  }
  return typeof value;
}

/** A structure-only description of a payload (JSON key shape, never values), for debug traces. */
function describePayload(buf) {
  try {
    return JSON.stringify(shapeOf(JSON.parse(buf.toString('utf8')))).slice(0, 400);
  } catch {
    return `bytes[${buf.length}]`;
  }
}

function createRealtime({ db, viewerFor, debug = false, log = console.log } = {}) {
  const trace = debug ? (...args) => log('[realtime]', ...args) : () => {};
  /** Open sync streams: { view (the upgrade request), userId, send(bytes), close() }. */
  const syncStreams = new Set();

  function deliver(event, mutationFor) {
    if (event.db !== db) return;
    const members = new Set(db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(event.conversationId).map((r) => r.user_id));
    for (const s of syncStreams) {
      if (!members.has(s.userId)) continue;
      // The session may have ended since the socket opened.
      const found = viewerFor(s.view);
      if (!found || found.user.id !== s.userId) {
        s.close();
        continue;
      }
      const mutation = mutationFor(found.user);
      if (mutation) {
        trace('delta', mutation.__typename, 'to user stream');
        s.send(ls.response([ls.operation.delta([mutation])]));
      }
    }
  }

  const onMessage = (event) =>
    deliver(event, (viewer) => {
      const message = slideMessageNode(db, viewer, event.messageId);
      if (!message) return null;
      return {
        __typename: 'SlideUQPPNewMessage',
        uq_seq_id: String(ls.nextSeqId()),
        // Sending does not change the receiver's read state.
        thread_read_state_effect: 'KEEP_AS_IS',
        message,
      };
    });
  // A member read the thread: everyone's "Seen" (and the reader's other tabs) updates.
  const onSeen = (event) =>
    deliver(event, () => {
      const row = db
        .prepare(
          `SELECT c.pk, u.pk AS reader_pk, cm.last_seen_at FROM conversations c
           JOIN conversation_members cm ON cm.conversation_id = c.id JOIN users u ON u.id = cm.user_id
           WHERE c.id = ? AND cm.user_id = ?`
        )
        .get(event.conversationId, event.userId);
      if (!row || !row.last_seen_at) return null;
      return {
        __typename: 'SlideUQPPReadReceipt',
        uq_seq_id: String(ls.nextSeqId()),
        thread_fbid: String(row.pk),
        read_receipt: { participant_fbid: String(row.reader_pk), watermark_timestamp_ms: String(Date.parse(row.last_seen_at)) },
      };
    });
  if (db) {
    events.on('message', onMessage);
    events.on('seen', onSeen);
  }

  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://local');
    if (!url.pathname.startsWith(PREFIX)) return false;
    const target = url.pathname.slice(PREFIX.length);
    const view = requestView(req);
    const found = viewerFor(view);
    if (!found) {
      trace('refused (signed out):', target);
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return true;
    }
    const conn = acceptWebSocket(req, socket, head);
    if (!conn) return true;
    trace('open', target);
    if (/^gateway\.instagram\.com\/ws\//.test(target)) serveGateway(conn, view, found.user, target.endsWith('/lightspeed'));
    else serveMqtt(conn);
    conn.on('close', () => trace('closed', target));
    return true;
  }

  /** The DGW gateway: grouped streams over one socket. */
  function serveGateway(conn, view, user, isSync) {
    let pending = Buffer.alloc(0);
    const open = new Map();
    // The client counts the transport as up on the server's first frame.
    conn.send(dgw.encode.pong());
    conn.on('message', (data, binary) => {
      if (!binary) return conn.close(1002);
      pending = Buffer.concat([pending, data]);
      let split;
      try {
        split = dgw.decode(pending);
      } catch (error) {
        trace('gateway: unparseable stream:', error.message);
        return conn.close(4005);
      }
      pending = Buffer.from(split.rest);
      for (const f of split.frames) {
        if (f.type === dgw.FRAME.PING) conn.send(dgw.encode.pong());
        else if (f.type === dgw.FRAME.ESTABLISH) {
          open.set(f.stream, null);
          conn.send(dgw.encode.establish(f.stream, { code: 200 }));
        } else if (f.type === dgw.FRAME.DATA && open.has(f.stream)) {
          if (f.ackId != null) conn.send(dgw.encode.ack(f.stream, f.ackId));
          const request = isSync && open.get(f.stream) == null ? ls.parseRequest(f.payload) : null;
          if (request) {
            trace('gateway: sync request on stream', f.stream, describePayload(f.payload));
            const sub = {
              view,
              userId: user.id,
              send: (bytes) => conn.send(dgw.encode.data(f.stream, bytes)),
              close: () => conn.close(4003),
            };
            open.set(f.stream, sub);
            syncStreams.add(sub);
            sub.send(ls.response([ls.operation.subscribe(ls.currentSeqId())], request.request_id));
          }
        } else if (f.type === dgw.FRAME.END_OF_DATA) {
          syncStreams.delete(open.get(f.stream));
          open.delete(f.stream);
          conn.send(dgw.encode.endOfData(f.stream));
        }
      }
      return undefined;
    });
    conn.on('close', () => {
      for (const sub of open.values()) syncStreams.delete(sub);
    });
  }

  /** MQTT on edge-chat: accept and acknowledge; nothing is published to the client. */
  function serveMqtt(conn) {
    let pending = Buffer.alloc(0);
    conn.on('message', (data, binary) => {
      if (!binary) return conn.close(1002);
      pending = Buffer.concat([pending, data]);
      let split;
      try {
        split = mqtt.splitPackets(pending);
      } catch (error) {
        trace('mqtt: unparseable stream:', error.message);
        return conn.close(1002);
      }
      pending = Buffer.from(split.rest);
      for (const p of split.packets) {
        let packet;
        try {
          packet = mqtt.decode(p);
        } catch {
          continue;
        }
        if (packet.type === mqtt.TYPE.CONNECT) conn.send(mqtt.encode.connack(0));
        else if (packet.type === mqtt.TYPE.SUBSCRIBE) conn.send(mqtt.encode.suback(packet.id, packet.topics.map((t) => t.qos)));
        else if (packet.type === mqtt.TYPE.UNSUBSCRIBE) conn.send(mqtt.encode.unsuback(packet.id));
        else if (packet.type === mqtt.TYPE.PUBLISH && packet.qos > 0) conn.send(mqtt.encode.puback(packet.id));
        else if (packet.type === mqtt.TYPE.PINGREQ) conn.send(mqtt.encode.pingresp());
        else if (packet.type === mqtt.TYPE.DISCONNECT) conn.close();
      }
      return undefined;
    });
  }

  return {
    handleUpgrade,
    /** Open sync streams (for tests). */
    get syncStreamCount() {
      return syncStreams.size;
    },
    close() {
      events.off('message', onMessage);
      events.off('seen', onSeen);
    },
  };
}

module.exports = { createRealtime, PREFIX };
