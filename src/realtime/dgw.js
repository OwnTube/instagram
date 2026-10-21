'use strict';

/**
 * The DGW gateway framing the client's message stream uses (its codec is
 * DGWUtils/DGWCppBridge in the pinned snapshot; this is an independent
 * implementation of the same byte layout, checked against that codec in
 * test/realtime.test.js). Every multi-byte integer is little-endian.
 *
 *   ping 09 | pong 0a | empty 02 | deauth 04
 *   drain        03 len:u24 reason:u8
 *   establish    0f stream:u16 len:u24 params (JSON)
 *   data         0d stream:u16 len:u24 ack:u16 payload   (len counts ack + payload;
 *                                                         ack = 0x8000 when the
 *                                                         receiver must ack, | ack id)
 *   ack          0c stream:u16 len:u24 (=2) ackId:u16
 *   end of data  0e stream:u16
 */

const FRAME = { EMPTY: 2, DRAIN: 3, DEAUTH: 4, PING: 9, PONG: 10, ACK: 12, DATA: 13, END_OF_DATA: 14, ESTABLISH: 15 };
const REQUIRES_ACK = 0x8000;

class DgwError extends Error {}

function u24(buf, offset) {
  return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16);
}

function header(type, stream, length) {
  const b = Buffer.alloc(6);
  b[0] = type;
  b.writeUInt16LE(stream, 1);
  b.writeUIntLE(length, 3, 3);
  return b;
}

/** Split bytes into frames; a partial frame stays in `rest` for the next read. */
function decode(buf) {
  const frames = [];
  let o = 0;
  while (o < buf.length) {
    const type = buf[o];
    if (type === FRAME.PING || type === FRAME.PONG || type === FRAME.EMPTY || type === FRAME.DEAUTH) {
      frames.push({ type });
      o += 1;
    } else if (type === FRAME.END_OF_DATA) {
      if (o + 3 > buf.length) break;
      frames.push({ type, stream: buf.readUInt16LE(o + 1) });
      o += 3;
    } else if (type === FRAME.DRAIN) {
      if (o + 4 > buf.length) break;
      const len = u24(buf, o + 1);
      if (o + 4 + len > buf.length) break;
      frames.push({ type, reason: buf[o + 4] });
      o += 4 + len;
    } else if (type === FRAME.ESTABLISH || type === FRAME.DATA || type === FRAME.ACK) {
      if (o + 6 > buf.length) break;
      const stream = buf.readUInt16LE(o + 1);
      const len = u24(buf, o + 3);
      if (o + 6 + len > buf.length) break;
      const body = buf.subarray(o + 6, o + 6 + len);
      if (type === FRAME.ESTABLISH) frames.push({ type, stream, params: Buffer.from(body) });
      else {
        if (len < 2) throw new DgwError('short frame');
        const field = body.readUInt16LE(0);
        if (type === FRAME.ACK) frames.push({ type, stream, ackId: field });
        else frames.push({ type, stream, ackId: field & REQUIRES_ACK ? field & 0x7fff : null, payload: Buffer.from(body.subarray(2)) });
      }
      o += 6 + len;
    } else {
      throw new DgwError(`unknown frame type ${type}`);
    }
  }
  return { frames, rest: buf.subarray(o) };
}

const encode = {
  ping: () => Buffer.from([FRAME.PING]),
  pong: () => Buffer.from([FRAME.PONG]),
  establish(stream, params) {
    const body = Buffer.from(typeof params === 'string' ? params : JSON.stringify(params), 'utf8');
    return Buffer.concat([header(FRAME.ESTABLISH, stream, body.length), body]);
  },
  data(stream, payload, ackId = null) {
    const body = Buffer.from(payload);
    const field = Buffer.alloc(2);
    field.writeUInt16LE(ackId == null ? 0 : REQUIRES_ACK | (ackId & 0x7fff), 0);
    return Buffer.concat([header(FRAME.DATA, stream, body.length + 2), field, body]);
  },
  ack(stream, ackId) {
    const field = Buffer.alloc(2);
    field.writeUInt16LE(ackId, 0);
    return Buffer.concat([header(FRAME.ACK, stream, 2), field]);
  },
  endOfData(stream) {
    const b = Buffer.alloc(3);
    b[0] = FRAME.END_OF_DATA;
    b.writeUInt16LE(stream, 1);
    return b;
  },
};

module.exports = { FRAME, DgwError, decode, encode };
