'use strict';

/**
 * Emoji images (src/emoji.js): the client's emoji service URLs are answered
 * here with an SVG of the emoji, from the URL's code points alone.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { parseEmojiPath, emojiSvg } = require('../src/emoji');
const { startCloneServer } = require('./clone-helpers');

test('emoji paths name their code points and size', () => {
  assert.deepStrictEqual(parseEmojiPath('/images/emoji.php/v9/tce/1/16/1f600.png'), { text: '😀', size: 16 });
  assert.deepStrictEqual(parseEmojiPath('/images/emoji.php/v9/t79/2/32/1f44d_1f3fd.png'), { text: '👍🏽', size: 32 });
  assert.deepStrictEqual(parseEmojiPath('/images/emoji.php/v9/t76/1.5/16/1f1ef_1f1f5.png'), { text: '🇯🇵', size: 16 });
  for (const bad of ['/images/emoji.php/v9/tce/1/16/d800.png', '/images/emoji.php/v9/tce/1/16/110000.png', '/images/emoji.php/v9/tce/1/16/0a.png', '/images/emoji.php/v9/tce/1/4/1f600.png', '/images/emoji.php/v9/tce/1/16/1f600.gif', '/images/emoji.php/v9/tce/1/16/x.png', '/images/other/1f600.png']) {
    assert.strictEqual(parseEmojiPath(bad), null, bad);
  }
  // Markup characters are escaped.
  assert.ok(emojiSvg(parseEmojiPath('/images/emoji.php/v9/t/1/16/3c_26.png')).includes('&lt;&amp;'));
});

test('the server draws emoji images without asking upstream', async (t) => {
  const s = await startCloneServer({});
  t.after(() => s.close());
  const res = await fetch(`${s.base}/__ig/static.cdninstagram.com/images/emoji.php/v9/tce/1/16/1f600.png`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /^image\/svg\+xml/);
  assert.match(await res.text(), /^<svg [^>]*width="16" height="16"[^>]*>.*😀<\/text><\/svg>$/);
  // Not an emoji path: the pinned asset route (not in the snapshot here).
  assert.notStrictEqual((await fetch(`${s.base}/__ig/static.cdninstagram.com/images/emoji.php/v9/tce/1/16/zz.png`)).status, 200);
  assert.deepStrictEqual(s.upstream, []);
});
