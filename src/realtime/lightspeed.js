'use strict';

/**
 * The client's message sync ("LS") over the DGW gateway's lightspeed stream
 * (WmiLsSubscription in the pinned snapshot). The client sends one request,
 * JSON {app_id, device_id, request_id, type: 2, payload: JSON {database,
 * last_applied_cursor, sync_params, ..}}; every server message is JSON
 * {request_id, error_code, payload}, where payload is base64 of the protobuf
 * LSResponse (MDCoreSyncProtobuf.pb):
 *
 *   LSResponse    { operations = 2: repeated Operation }
 *   Operation     oneof { subscribe = 1: OnIrisSubscribe, delta = 3: OnMailboxDelta, .. }
 *   OnIrisSubscribe { subscribedSeqId = 2: int64, latestSeqId = 3: int64 }
 *   OnMailboxDelta  { delta = 2: string }
 *
 * A delta string is what the client's IGD delta parser
 * (WmiIgdParseDeltaPayload) reads: JSON [{data: {slide_delta_processor:
 * [mutation, ..]}}], each mutation a Slide UQPP mutation with a uq_seq_id the
 * client applies only when it is not lower than the last one it saw.
 */

function varint(value) {
  let n = BigInt(value);
  const out = [];
  while (n > 0x7fn) {
    out.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}

function field(number, wireType, body) {
  const key = varint((number << 3) | wireType);
  if (wireType === 0) return Buffer.concat([key, varint(body)]);
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  return Buffer.concat([key, varint(bytes.length), bytes]);
}

const operation = {
  subscribe: (seqId) => field(1, 2, Buffer.concat([field(2, 0, seqId), field(3, 0, seqId)])),
  delta: (mutations) => field(3, 2, field(2, 2, JSON.stringify([{ data: { slide_delta_processor: mutations } }]))),
};

/** One LS response message (the bytes of a DGW data frame). */
function response(operations, requestId = null) {
  const payload = Buffer.concat(operations.map((op) => field(2, 2, op))).toString('base64');
  return Buffer.from(JSON.stringify({ request_id: requestId, error_code: 0, payload }), 'utf8');
}

/** The client's LS request, or null when the bytes are not one. */
function parseRequest(bytes) {
  try {
    const req = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return req && req.type === 2 && req.request_id != null ? req : null;
  } catch {
    return null;
  }
}

// Sequence ids for deltas: increasing within the process, and above any the
// client could already hold (it starts from 0, the mailbox's unset
// iris_inactive_subscription_uq_seq_id).
let lastSeq = 0;
function nextSeqId() {
  lastSeq = Math.max(lastSeq + 1, Date.now());
  return lastSeq;
}
function currentSeqId() {
  return Math.max(lastSeq, Date.now());
}

module.exports = { operation, response, parseRequest, nextSeqId, currentSeqId, varint };
