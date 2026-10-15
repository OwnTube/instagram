'use strict';

/**
 * Keyset (cursor) pagination.
 *
 * Offset pagination drifts when rows are inserted during paging, so a keyset
 * cursor is used instead: the cursor carries the sort key of the last row seen.
 * Cursors are opaque to clients (base64 JSON) and are validated on decode, so a
 * tampered cursor produces a 400 rather than a malformed query.
 */

const { badRequest } = require('./errors');

function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    return parsed;
  } catch {
    throw badRequest('Invalid pagination cursor', { field: 'cursor' });
  }
}

/**
 * Page a query. `fetch` receives (limit, cursor) and must return up to limit+1
 * rows sorted by the cursor key descending. Returns items plus the next cursor.
 */
function paginate({ limit, cursor }, fetch, cursorFrom) {
  const decoded = decodeCursor(cursor);
  const rows = fetch(limit + 1, decoded);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && items.length ? encodeCursor(cursorFrom(items[items.length - 1])) : null;
  return { items, nextCursor, hasMore };
}

module.exports = { encodeCursor, decodeCursor, paginate };
