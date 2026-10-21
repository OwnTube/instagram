'use strict';

/**
 * A minimal WebSocket server (RFC 6455) on Node's own http upgrade event, for
 * the client's realtime connection (see src/realtime/index.js). It handles
 * the opening handshake, masked client frames of any length, fragmented
 * messages, ping/pong and the close handshake. There is no extension support
 * (permessage-deflate is not negotiated, so the client never compresses).
 */

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 4 * 1024 * 1024;

const OP = { CONTINUATION: 0, TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 };

function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

class WebSocketConnection extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.fragments = null;
    this.fragmentOpcode = 0;
    this.closed = false;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
    if (this.buffer.length) setImmediate(() => this.drain());
  }

  drain() {
    while (!this.closed) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.fail(1009);
        len = Number(big);
        offset = 10;
      }
      // Client frames must be masked (RFC 6455 5.1).
      if (!masked) return this.fail(1002);
      if (b.length < offset + 4 + len) return;
      const mask = b.subarray(offset, offset + 4);
      const payload = Buffer.from(b.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = b.subarray(offset + 4 + len);
      this.handle(fin, opcode, payload);
    }
  }

  handle(fin, opcode, payload) {
    if (opcode === OP.PING) return this.write(frame(OP.PONG, payload));
    if (opcode === OP.PONG) return undefined;
    if (opcode === OP.CLOSE) {
      this.write(frame(OP.CLOSE, payload.subarray(0, 2)));
      return this.finish();
    }
    if (opcode === OP.CONTINUATION) {
      if (!this.fragments) return this.fail(1002);
      this.fragments.push(payload);
    } else if (opcode === OP.TEXT || opcode === OP.BINARY) {
      if (this.fragments) return this.fail(1002);
      this.fragments = [payload];
      this.fragmentOpcode = opcode;
    } else {
      return this.fail(1002);
    }
    const size = this.fragments.reduce((n, p) => n + p.length, 0);
    if (size > MAX_MESSAGE) return this.fail(1009);
    if (!fin) return undefined;
    const message = Buffer.concat(this.fragments);
    const binary = this.fragmentOpcode === OP.BINARY;
    this.fragments = null;
    this.emit('message', binary ? message : message.toString('utf8'), binary);
    return undefined;
  }

  write(buf) {
    if (!this.closed && this.socket.writable) this.socket.write(buf);
  }

  /** Send a binary message (Buffer) or a text message (string). */
  send(data) {
    if (typeof data === 'string') this.write(frame(OP.TEXT, Buffer.from(data, 'utf8')));
    else this.write(frame(OP.BINARY, Buffer.from(data)));
  }

  close(code = 1000) {
    if (this.closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.write(frame(OP.CLOSE, payload));
    this.finish();
  }

  fail(code) {
    this.close(code);
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.socket.end();
    this.emit('close');
  }
}

/**
 * Complete the opening handshake for an upgrade request; returns the
 * connection, or null after answering 400 when the request is not a valid
 * WebSocket upgrade. `protocols` lists the subprotocols this endpoint speaks;
 * the first one the client also offers is selected.
 */
function acceptWebSocket(req, socket, head, { protocols = [] } = {}) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (upgrade !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return null;
  }
  const offered = String(req.headers['sec-websocket-protocol'] || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const protocol = protocols.find((p) => offered.includes(p));
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`];
  if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  const conn = new WebSocketConnection(socket, head);
  conn.protocol = protocol || null;
  return conn;
}

module.exports = { acceptWebSocket, WebSocketConnection };
