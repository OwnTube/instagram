'use strict';

/**
 * Live Direct messages: the realtime endpoint (src/realtime/) that the
 * client's gateway socket reaches through the runtime. Frame bytes here were
 * produced by the pinned client's own DGW codec (DGWCppBridge) and decoded by
 * its own LS decoder (WmiLsResponseDecoder), so these vectors are the
 * client's, not ours.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { startCloneServer, Browser } = require('./clone-helpers');
const dgw = require('../src/realtime/dgw');
const ls = require('../src/realtime/lightspeed');

const LS_PATH = '/__clone/realtime/gateway.instagram.com/ws/lightspeed?x-dgw-appid=936619743392459&x-dgw-version=5';

/** A minimal WebSocket client (masked frames, binary messages) for the tests. */
function openSocket(base, path, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), ...(cookie ? { Cookie: cookie } : {}) },
    });
    req.on('response', (res) => resolve({ status: res.statusCode }));
    req.on('error', reject);
    req.on('upgrade', (res, socket, head) => {
      const messages = [];
      const waiters = [];
      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          let len = buf[1] & 0x7f;
          let o = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            o = 4;
          } else if (len === 127) {
            if (buf.length < 10) return;
            len = Number(buf.readBigUInt64BE(2));
            o = 10;
          }
          if (buf.length < o + len) return;
          const opcode = buf[0] & 0x0f;
          const payload = buf.subarray(o, o + len);
          buf = buf.subarray(o + len);
          if (opcode === 2) {
            for (const f of dgw.decode(Buffer.from(payload)).frames) {
              messages.push(f);
              for (const w of waiters.splice(0)) w();
            }
          }
        }
      };
      // Frames that arrived with the 101 response come in `head`.
      if (head && head.length) onData(head);
      socket.on('data', onData);
      const send = (bytes) => {
        const mask = crypto.randomBytes(4);
        const body = Buffer.from(bytes);
        for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
        const head = body.length < 126 ? Buffer.from([0x82, 0x80 | body.length]) : Buffer.from([0x82, 0x80 | 126, body.length >> 8, body.length & 0xff]);
        socket.write(Buffer.concat([head, mask, body]));
      };
      /** The next frame matching `pred` (waiting up to `ms`), or null. */
      const next = async (pred, ms = 2000) => {
        const end = Date.now() + ms;
        for (;;) {
          const i = messages.findIndex(pred);
          if (i >= 0) return messages.splice(i, 1)[0];
          if (Date.now() > end) return null;
          await new Promise((r) => {
            waiters.push(r);
            setTimeout(r, 50);
          });
        }
      };
      resolve({ status: 101, send, next, messages, close: () => socket.destroy() });
    });
    req.end();
  });
}

/** Open a sync stream the way WmiDGWLightspeedStream does: establish, then the LS request as data needing an ack. */
async function subscribe(ws, requestId = 4) {
  const request = { app_id: '936619743392459', device_id: 'test-device', request_id: requestId, type: 2, payload: JSON.stringify({ database: 223, epoch_id: 0, failure_count: 0, last_applied_cursor: JSON.stringify({ seq_id: 0 }), version: -3 }) };
  ws.send(Buffer.concat([dgw.encode.establish(0, {}), dgw.encode.data(0, Buffer.from(JSON.stringify(request)), 0)]));
}

/** The JSON deltas in an LS response data frame: each operation's mutations. */
function lsOperations(frame) {
  const msg = JSON.parse(frame.payload.toString('utf8'));
  return { msg, ops: decodeLsResponse(Buffer.from(msg.payload, 'base64')) };
}

// A small protobuf reader for LSResponse (operations = 2; subscribe = 1 {2, 3}; delta = 3 {2: string}).
function readVarint(b, o) {
  let v = 0n;
  let shift = 0n;
  for (;;) {
    const x = b[o++];
    v |= BigInt(x & 0x7f) << shift;
    if (!(x & 0x80)) return [v, o];
    shift += 7n;
  }
}
function fields(b) {
  const out = [];
  let o = 0;
  while (o < b.length) {
    let key;
    [key, o] = readVarint(b, o);
    const num = Number(key >> 3n);
    if ((key & 7n) === 0n) {
      let v;
      [v, o] = readVarint(b, o);
      out.push([num, v]);
    } else {
      let len;
      [len, o] = readVarint(b, o);
      out.push([num, b.subarray(o, o + Number(len))]);
      o += Number(len);
    }
  }
  return out;
}
function decodeLsResponse(bytes) {
  return fields(bytes)
    .filter(([n]) => n === 2)
    .map(([, op]) => {
      const [[kind, body]] = fields(op);
      if (kind === 1) return { subscribe: Object.fromEntries(fields(body).map(([n, v]) => [n === 2 ? 'subscribedSeqId' : 'latestSeqId', String(v)])) };
      if (kind === 3) return { delta: JSON.parse(Buffer.from(fields(body).find(([n]) => n === 2)[1]).toString('utf8')) };
      return { other: kind };
    });
}

test('DGW frames match the client codec byte for byte', () => {
  const pl = Buffer.from('{"x":1}');
  assert.strictEqual(dgw.encode.data(3, pl, 7).toString('hex'), '0d030009000007807b2278223a317d');
  assert.strictEqual(dgw.encode.data(3, pl).toString('hex'), '0d030009000000007b2278223a317d');
  assert.strictEqual(dgw.encode.ack(2, 9).toString('hex'), '0c02000200000900');
  assert.strictEqual(dgw.encode.establish(1, { code: 200 }).toString('hex'), '0f01000c00007b22636f6465223a3230307d');
  assert.strictEqual(dgw.encode.endOfData(5).toString('hex'), '0e0500');
  assert.strictEqual(dgw.encode.pong().toString('hex'), '0a');
  // The client's own frames (ping, establish, data needing ack 5, ack 1), concatenated in one message.
  const theirs = Buffer.from('090f02000200007b7d0d020009000005807b2278223a317d0c02000200000100', 'hex');
  const { frames, rest } = dgw.decode(theirs);
  assert.strictEqual(rest.length, 0);
  assert.deepStrictEqual(
    frames.map((f) => [f.type, f.stream, f.ackId, f.params && f.params.toString(), f.payload && f.payload.toString()]),
    [[9, undefined, undefined, undefined, undefined], [15, 2, undefined, '{}', undefined], [13, 2, 5, undefined, '{"x":1}'], [12, 2, 1, undefined, undefined]]
  );
  // A partial frame waits for the rest.
  const partial = dgw.decode(theirs.subarray(0, 12));
  assert.strictEqual(partial.frames.length, 2);
  assert.strictEqual(partial.rest.length, 3);
});

test('LS responses carry the protobuf the client decodes', () => {
  const msg = JSON.parse(ls.response([ls.operation.subscribe(1792590582548), ls.operation.delta([{ __typename: 'SlideUQPPNewMessage', uq_seq_id: '1792590582549' }])], 4).toString());
  assert.strictEqual(msg.request_id, 4);
  assert.strictEqual(msg.error_code, 0);
  // Bytes checked against WmiLsResponseDecoder.decodeLsResponse.
  assert.strictEqual(msg.payload.slice(0, 24), 'EhAKDhCUpub1lTQYlKbm9ZU0');
  const ops = decodeLsResponse(Buffer.from(msg.payload, 'base64'));
  assert.deepStrictEqual(ops[0], { subscribe: { subscribedSeqId: '1792590582548', latestSeqId: '1792590582548' } });
  assert.deepStrictEqual(ops[1], { delta: [{ data: { slide_delta_processor: [{ __typename: 'SlideUQPPNewMessage', uq_seq_id: '1792590582549' }] } }] });
  assert.strictEqual(ls.parseRequest(Buffer.from('{"type":2,"request_id":4}')).request_id, 4);
  assert.strictEqual(ls.parseRequest(Buffer.from('not json')), null);
  const a = ls.nextSeqId();
  assert.ok(ls.nextSeqId() > a, 'sequence ids increase');
});

test('live Direct messages over the gateway', async (t) => {
  const server = await startCloneServer();
  t.after(() => server.close());
  const A = new Browser(server.base);
  const a = await A.signup(server, { username: 'rt_ann' });
  const B = new Browser(server.base);
  const b = await B.signup(server, { username: 'rt_bob' });
  const C = new Browser(server.base);
  await C.signup(server, { username: 'rt_cat' });
  const first = await A.post('/api/v1/direct_v2/threads/broadcast/text/', { recipient_users: JSON.stringify([[String(b.pk)]]), text: 'hi bob', client_context: 'a-1' });
  const threadId = String(first.body.payload.thread_id);
  const sockets = [];
  t.after(() => sockets.forEach((s) => s.close && s.close()));

  await t.test('a signed-out browser is refused', async () => {
    assert.strictEqual((await openSocket(server.base, LS_PATH)).status, 401);
  });

  let wsA;
  let wsB;
  let wsC;
  await t.test('the gateway opens with a pong, accepts the stream and acks the sync request', async () => {
    wsA = await openSocket(server.base, LS_PATH, A.header());
    sockets.push(wsA);
    assert.strictEqual(wsA.status, 101);
    assert.ok(await wsA.next((f) => f.type === dgw.FRAME.PONG), 'pong first');
    await subscribe(wsA, 4);
    const est = await wsA.next((f) => f.type === dgw.FRAME.ESTABLISH);
    assert.deepStrictEqual(JSON.parse(est.params.toString()), { code: 200 });
    assert.strictEqual((await wsA.next((f) => f.type === dgw.FRAME.ACK)).ackId, 0);
    const { msg, ops } = lsOperations(await wsA.next((f) => f.type === dgw.FRAME.DATA));
    assert.strictEqual(msg.request_id, 4);
    assert.ok(Number(ops[0].subscribe.latestSeqId) > 0);
    wsA.send(dgw.encode.ping());
    assert.ok(await wsA.next((f) => f.type === dgw.FRAME.PONG), 'pings are answered');
    wsB = await openSocket(server.base, LS_PATH, B.header());
    wsC = await openSocket(server.base, LS_PATH, C.header());
    sockets.push(wsB, wsC);
    for (const ws of [wsB, wsC]) {
      await subscribe(ws);
      await ws.next((f) => f.type === dgw.FRAME.DATA);
    }
  });

  await t.test("a new message reaches every member's open stream, and no one else's", async () => {
    await B.post('/api/v1/direct_v2/threads/broadcast/text/', { thread_ids: JSON.stringify([threadId]), text: 'hello live', client_context: 'b-1' });
    const [mutation] = lsOperations(await wsA.next((f) => f.type === dgw.FRAME.DATA)).ops[0].delta[0].data.slide_delta_processor;
    assert.strictEqual(mutation.__typename, 'SlideUQPPNewMessage');
    assert.strictEqual(mutation.thread_read_state_effect, 'KEEP_AS_IS');
    assert.ok(Number(mutation.uq_seq_id) > 0);
    const m = mutation.message;
    assert.deepStrictEqual([m.__typename, m.text_body, m.content_type, m.thread_fbid, m.sender_fbid, m.offline_threading_id, m.igd_snippet], ['SlideMessage', 'hello live', 'TEXT', threadId, String(b.pk), 'b-1', 'hello live']);
    assert.strictEqual(m.sender.__typename, 'SlideUser');
    // The sender's own stream gets it too (their other tabs).
    const own = lsOperations(await wsB.next((f) => f.type === dgw.FRAME.DATA)).ops[0].delta[0].data.slide_delta_processor[0];
    assert.strictEqual(own.message.message_id, m.message_id);
    assert.strictEqual(await wsC.next((f) => f.type === dgw.FRAME.DATA, 300), null, 'not a member: nothing');
  });

  await t.test("reading the thread updates the other member's Seen", async () => {
    await A.post(`/api/v1/direct_v2/threads/${threadId}/items/0/seen/`, {});
    const r = lsOperations(await wsB.next((f) => f.type === dgw.FRAME.DATA)).ops[0].delta[0].data.slide_delta_processor[0];
    assert.strictEqual(r.__typename, 'SlideUQPPReadReceipt');
    assert.strictEqual(r.thread_fbid, threadId);
    assert.strictEqual(r.read_receipt.participant_fbid, String(a.pk));
    assert.ok(Number(r.read_receipt.watermark_timestamp_ms) > 0);
    assert.strictEqual(await wsC.next((f) => f.type === dgw.FRAME.DATA, 300), null);
  });

  await t.test('a stream whose session ended is closed instead of served', async () => {
    await C.post('/api/v1/web/accounts/logout/ajax/', {});
    const dropped = await openSocket(server.base, LS_PATH, C.header());
    assert.strictEqual(dropped.status, 401);
  });

  await t.test('the thread the delta names can be fetched (inbox row update)', async () => {
    const res = await A.post('/api/graphql', { doc_id: '1', fb_api_req_friendly_name: 'IGDSlideAsyncFetchAndInsertIGDViewerThreadQuery', variables: { thread_fbid: threadId, min_uq_seq_id: '1' } });
    const thread = res.body.data.get_slide_thread_nullable.as_ig_direct_thread;
    assert.strictEqual(thread.thread_key, threadId);
    assert.strictEqual(thread.slide_messages.edges[0].node.text_body, 'hello live');
  });

  await t.test('the mailbox is keyed the way the client looks it up (SlideMailbox:<EIMU>)', async () => {
    const res = await A.post('/api/graphql', { doc_id: '1', fb_api_req_friendly_name: 'PolarisDirectInboxQuery', variables: {} });
    const box = res.body.data.get_slide_mailbox_for_iris_subscription;
    assert.strictEqual(box.__typename, 'SlideMailbox');
    assert.strictEqual(box.id, String(a.pk));
  });

  await t.test('edge-chat MQTT sockets are accepted and acknowledged', async () => {
    const mq = await openSocket(server.base, '/__clone/realtime/edge-chat.instagram.com/chat?sid=1&cid=x', A.header());
    sockets.push(mq);
    assert.strictEqual(mq.status, 101);
  });

  assert.deepStrictEqual(server.upstream, []);
});

test("the runtime points the client's realtime sockets at this server, keeping path and query", async (t) => {
  const server = await startCloneServer();
  t.after(() => server.close());
  const source = (await new Browser(server.base).get('/__clone/runtime.js')).text;
  const opened = [];
  function FakeSocket(url) {
    opened.push(url);
  }
  const window = { WebSocket: FakeSocket, fetch: () => Promise.resolve(), location: new URL('http://127.0.0.1:9/direct/inbox/') };
  const sandbox = { window, location: window.location, XMLHttpRequest: function () {}, navigator: {}, document: { cookie: '' }, URL, Object, Response: function () {}, Request: function () {}, Promise };
  sandbox.XMLHttpRequest.prototype = { open() {} };
  sandbox.Element = function () {};
  sandbox.Element.prototype = { setAttribute() {} };
  sandbox.Document = function () {};
  Object.defineProperty(sandbox.Document.prototype, 'cookie', { configurable: true, get: () => '', set() {} });
  sandbox.window.document = sandbox.document;
  vm.runInNewContext(source, sandbox);
  new window.WebSocket('wss://gateway.instagram.com/ws/lightspeed?x-dgw-appid=1');
  new window.WebSocket('wss://edge-chat.instagram.com/chat?sid=2');
  new window.WebSocket('ws://127.0.0.1:9/other');
  assert.deepStrictEqual(opened, [
    'ws://127.0.0.1:9/__clone/realtime/gateway.instagram.com/ws/lightspeed?x-dgw-appid=1',
    'ws://127.0.0.1:9/__clone/realtime/edge-chat.instagram.com/chat?sid=2',
    'ws://127.0.0.1:9/other',
  ]);
});

test('the DGW gateway patch resolves the instagram.com gateway on this origin', () => {
  const { createPatcher, PATCHES } = require('../src/shell/bundlePatches');
  const patch = PATCHES.find((p) => p.id === 'dgw-gateway-for-this-origin');
  const bundle = `__d("DGWEnvUtil",[],(function(){var t=new URI(href),n=t.getDomain(),o=m(n,t.getPath()),a=o.authToken}),98);__d("Other",[],(function(){o=m(n,t.getPath())}),1);`;
  const out = createPatcher([patch]).apply(bundle);
  assert.deepStrictEqual(out.applied, ['dgw-gateway-for-this-origin']);
  assert.ok(out.source.includes('o=m("www.instagram.com",t.getPath())'));
  assert.ok(out.source.endsWith('__d("Other",[],(function(){o=m(n,t.getPath())}),1);'), 'other modules untouched');
});
