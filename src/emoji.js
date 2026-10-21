'use strict';

/**
 * Emoji images. The client draws emoji in messages, captions and comments as
 * images from its emoji service:
 *
 *   https://static.cdninstagram.com/images/emoji.php/v9/<key>/<scale>/<size>/<codepoints>.png
 *
 * where <codepoints> is the emoji's code points in hex joined by `_` (e.g.
 * `1f44d_1f3fd` for a thumbs up with a skin tone). That service is
 * Instagram's, so this server never asks it; it answers the same URL with
 * an SVG image of the emoji drawn in the viewer's own emoji font. It is not
 * Instagram's artwork, and needs nothing from upstream.
 */

const EMOJI_PATH = /^\/images\/emoji\.php\/v\d{1,3}\/[A-Za-z0-9_-]{1,40}\/(\d(?:\.\d)?)\/(\d{1,3})\/([0-9a-f]{1,6}(?:_[0-9a-f]{1,6}){0,11})\.png$/i;
// The hosts the client loads emoji images from.
const EMOJI_HOSTS = new Set(['static.cdninstagram.com', 'static.xx.fbcdn.net']);
const FONTS = "'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji','Twemoji Mozilla',sans-serif";

/** The emoji a path names, as text with its displayed size, or null. */
function parseEmojiPath(pathname) {
  const m = EMOJI_PATH.exec(pathname);
  if (!m) return null;
  const size = Number(m[2]);
  if (size < 8 || size > 256) return null;
  const points = m[3].split('_').map((h) => parseInt(h, 16));
  // Characters only: no controls, no surrogate halves, nothing past Unicode.
  if (points.some((p) => p < 0x20 || (p >= 0xd800 && p <= 0xdfff) || p > 0x10ffff)) return null;
  return { text: String.fromCodePoint(...points), size };
}

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** An SVG image of the emoji, `size` CSS pixels square. */
function emojiSvg({ text, size }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><text x="32" y="32" dy=".35em" font-size="52" text-anchor="middle" font-family="${FONTS}">${escapeXml(text)}</text></svg>`;
}

module.exports = { EMOJI_HOSTS, parseEmojiPath, emojiSvg };
