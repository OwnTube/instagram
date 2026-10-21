'use strict';

/**
 * MQTT 3.1 / 3.1.1 packet codec (the standard framing; nothing here is
 * specific to Instagram). The realtime endpoint (src/realtime/index.js)
 * speaks it over a WebSocket, as the client's own MqttProtocolCodec does.
 */

const TYPE = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PUBACK: 4,
  SUBSCRIBE: 8,
  SUBACK: 9,
  UNSUBSCRIBE: 10,
  UNSUBACK: 11,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
};

class MqttError extends Error {}

function readString(buf, offset) {
  if (offset + 2 > buf.length) throw new MqttError('truncated string');
  const len = buf.readUInt16BE(offset);
  if (offset + 2 + len > buf.length) throw new MqttError('truncated string');
  return { value: buf.toString('utf8', offset + 2, offset + 2 + len), next: offset + 2 + len };
}

function readBytes(buf, offset) {
  if (offset + 2 > buf.length) throw new MqttError('truncated field');
  const len = buf.readUInt16BE(offset);
  if (offset + 2 + len > buf.length) throw new MqttError('truncated field');
  return { value: buf.subarray(offset + 2, offset + 2 + len), next: offset + 2 + len };
}

function encodeString(s) {
  const b = Buffer.from(String(s), 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length, 0);
  return Buffer.concat([len, b]);
}

function encodeLength(n) {
  const out = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
}

function packet(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encodeLength(body.length), body]);
}

/**
 * Split a byte stream into packets. Returns the complete packets and the
 * unconsumed remainder (a partial packet waits for more bytes).
 */
function splitPackets(buf) {
  const packets = [];
  let offset = 0;
  while (offset < buf.length) {
    let multiplier = 1;
    let length = 0;
    let i = offset + 1;
    let complete = false;
    for (let n = 0; n < 4; n++, i++) {
      if (i >= buf.length) break;
      length += (buf[i] & 0x7f) * multiplier;
      multiplier *= 128;
      if ((buf[i] & 0x80) === 0) {
        complete = true;
        i += 1;
        break;
      }
      if (n === 3) throw new MqttError('malformed remaining length');
    }
    if (!complete || i + length > buf.length) break;
    packets.push({ type: buf[offset] >> 4, flags: buf[offset] & 0x0f, body: buf.subarray(i, i + length) });
    offset = i + length;
  }
  return { packets, rest: buf.subarray(offset) };
}

/** Decode one packet's fields (CONNECT, PUBLISH, PUBACK, SUBSCRIBE, UNSUBSCRIBE; others have no fields used here). */
function decode({ type, flags, body }) {
  if (type === TYPE.CONNECT) {
    let o = 0;
    const name = readString(body, o);
    o = name.next;
    const level = body[o];
    const connectFlags = body[o + 1];
    const keepAlive = body.readUInt16BE(o + 2);
    o += 4;
    const clientId = readString(body, o);
    o = clientId.next;
    const out = { type, protocol: name.value, level, keepAlive, clientId: clientId.value, username: null, password: null };
    if (connectFlags & 0x04) {
      const willTopic = readString(body, o);
      const willMessage = readBytes(body, willTopic.next);
      o = willMessage.next;
    }
    if (connectFlags & 0x80) {
      const u = readString(body, o);
      out.username = u.value;
      o = u.next;
    }
    if (connectFlags & 0x40) {
      const p = readBytes(body, o);
      out.password = p.value;
      o = p.next;
    }
    return out;
  }
  if (type === TYPE.PUBLISH) {
    const qos = (flags >> 1) & 3;
    const topic = readString(body, 0);
    let o = topic.next;
    let id = null;
    if (qos > 0) {
      id = body.readUInt16BE(o);
      o += 2;
    }
    return { type, qos, retain: Boolean(flags & 1), topic: topic.value, id, payload: body.subarray(o) };
  }
  if (type === TYPE.PUBACK) return { type, id: body.readUInt16BE(0) };
  if (type === TYPE.SUBSCRIBE || type === TYPE.UNSUBSCRIBE) {
    const id = body.readUInt16BE(0);
    const topics = [];
    let o = 2;
    while (o < body.length) {
      const t = readString(body, o);
      o = t.next;
      let qos = 0;
      if (type === TYPE.SUBSCRIBE) {
        qos = body[o] & 3;
        o += 1;
      }
      topics.push({ topic: t.value, qos });
    }
    return { type, id, topics };
  }
  return { type };
}

const encode = {
  connack(returnCode = 0, sessionPresent = false) {
    return packet(TYPE.CONNACK, 0, Buffer.from([sessionPresent ? 1 : 0, returnCode]));
  },
  publish(topic, payload, { qos = 0, id = 0 } = {}) {
    const parts = [encodeString(topic)];
    if (qos > 0) {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(id, 0);
      parts.push(b);
    }
    parts.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8'));
    return packet(TYPE.PUBLISH, qos << 1, Buffer.concat(parts));
  },
  puback(id) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(id, 0);
    return packet(TYPE.PUBACK, 0, b);
  },
  suback(id, qoses) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(id, 0);
    return packet(TYPE.SUBACK, 0, Buffer.concat([b, Buffer.from(qoses)]));
  },
  unsuback(id) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(id, 0);
    return packet(TYPE.UNSUBACK, 0, b);
  },
  pingresp() {
    return packet(TYPE.PINGRESP, 0, Buffer.alloc(0));
  },
};

module.exports = { TYPE, MqttError, splitPackets, decode, encode, encodeString };
