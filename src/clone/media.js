'use strict';

/**
 * Media storage for uploads (posts, stories, profile pictures).
 *
 * Files live under MEDIA_DIR with random names; the `media` table is the only
 * index. A file is accepted only when its bytes are a JPEG, PNG, GIF or WebP
 * image (checked from the magic number, never from the client's declared
 * type), and its dimensions are read from the header.
 *
 * Serving enforces the same visibility rule as the content it belongs to: a
 * private account's photo is served only to its accepted followers, and an
 * upload not yet attached to anything only to its owner.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { newId, nowIso, randomToken } = require('../backend/lib/ids');
const { badRequest, notFound } = require('../backend/lib/errors');
const { canView } = require('../backend/services/visibility');

const MAX_BYTES = 15 * 1024 * 1024;
const URL_PREFIX = '/__media';

function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { type: 'image/png', ext: 'png' };
  }
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return { type: 'image/gif', ext: 'gif' };
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { type: 'image/webp', ext: 'webp' };
  }
  return null;
}

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function dimensions(buf, type) {
  try {
    if (type === 'image/png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (type === 'image/gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (type === 'image/jpeg') return jpegSize(buf);
    if (type === 'image/webp') {
      const chunk = buf.subarray(12, 16).toString('latin1');
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
  } catch {
    /* fall through */
  }
  return null;
}

function createMediaStore({ db, dir }) {
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });

  function save(ownerId, buffer, { uploadId, purpose = 'post' } = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw badRequest('Empty upload');
    if (buffer.length > MAX_BYTES) throw badRequest('Upload is too large');
    const kind = sniff(buffer);
    if (!kind) throw badRequest('Only JPEG, PNG, GIF and WebP images are supported');
    const dims = dimensions(buffer, kind.type) || { width: null, height: null };
    const id = newId('med');
    const key = `${randomToken(18)}.${kind.ext}`;
    const upload = uploadId && /^[0-9]{1,25}$/.test(String(uploadId)) ? String(uploadId) : String(Date.now()) + crypto.randomInt(1000, 9999);
    if (db.prepare('SELECT 1 FROM media WHERE upload_id = ?').get(upload)) throw badRequest('upload_id already used');
    fs.writeFileSync(path.join(root, key), buffer, { flag: 'wx' });
    db.prepare(
      `INSERT INTO media (id, upload_id, owner_id, storage_key, content_type, byte_size, width, height, sha256, purpose, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      upload,
      ownerId,
      key,
      kind.type,
      buffer.length,
      dims.width,
      dims.height,
      crypto.createHash('sha256').update(buffer).digest('hex'),
      purpose,
      nowIso()
    );
    return getById(id);
  }

  function getById(id) {
    const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
    return row ? { ...row, url: `${URL_PREFIX}/${row.storage_key}` } : null;
  }

  /** An unattached upload owned by this user, ready to be configured into a post or story. */
  function claimUpload(ownerId, uploadId) {
    const row = db.prepare('SELECT * FROM media WHERE upload_id = ? AND owner_id = ?').get(String(uploadId), ownerId);
    if (!row) throw notFound('Upload not found');
    if (row.attached_at) throw badRequest('This upload has already been used');
    return { ...row, url: `${URL_PREFIX}/${row.storage_key}` };
  }

  /** Claim an upload as the owner's profile picture: an avatar, servable to anyone once attached. */
  function claimAvatar(ownerId, uploadId) {
    const upload = claimUpload(ownerId, uploadId);
    db.prepare("UPDATE media SET purpose = 'avatar', attached_at = ? WHERE id = ?").run(nowIso(), upload.id);
    return upload;
  }

  function markAttached(id) {
    db.prepare('UPDATE media SET attached_at = ? WHERE id = ? AND attached_at IS NULL').run(nowIso(), id);
  }

  /** Who may fetch this file: follows the owning content's visibility. */
  function canServe(row, viewerId) {
    if (row.owner_id === viewerId) return true;
    if (row.purpose === 'avatar') return Boolean(row.attached_at);
    const post = db.prepare('SELECT author_id FROM posts WHERE media_id = ? AND deleted_at IS NULL').get(row.id);
    if (post) return canView(db, viewerId, post.author_id);
    const story = db.prepare('SELECT author_id, expires_at FROM stories WHERE media_id = ?').get(row.id);
    if (story) return Date.parse(story.expires_at) > Date.now() && canView(db, viewerId, story.author_id);
    return false;
  }

  function handler(req, res) {
    const key = req.params.key;
    if (!/^[A-Za-z0-9_-]{10,64}\.(jpg|png|gif|webp)$/.test(key)) return res.status(404).end();
    const row = db.prepare('SELECT * FROM media WHERE storage_key = ?').get(key);
    if (!row || !canServe(row, req.viewer?.id ?? null)) return res.status(404).end();
    res.setHeader('content-type', row.content_type);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'none'; sandbox");
    res.setHeader('cache-control', 'private, max-age=3600');
    res.setHeader('vary', 'Cookie');
    res.sendFile(path.join(root, row.storage_key));
  }

  return { save, getById, claimUpload, claimAvatar, markAttached, canServe, handler, root };
}

module.exports = { createMediaStore, sniff, dimensions, URL_PREFIX, MAX_BYTES };
