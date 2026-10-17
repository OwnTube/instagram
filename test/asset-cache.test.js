'use strict';

/**
 * The asset manifest (scripts/asset-cache.js) must name every public file a
 * stored page or bootloader answer may load, so `cache:warm` can store it for
 * offline use. Image data (`ixData`) comes sprited (`spi`) or as a plain
 * image (`{sprited: 0, uri}`), e.g. the empty feed's illustration.
 */

const { tempDir } = require('./paths');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('the manifest collects sprited and plain ixData images from bootloader answers', () => {
  const dir = tempDir('asset-cache-');
  const boot = path.join(dir, 'bootloader');
  fs.mkdirSync(boot);
  const answer = {
    hrp: {
      hsrp: {
        hblp: { rsrcMap: { a: { type: 'js', src: 'https://static.cdninstagram.com/rsrc.php/v4/a.js' } } },
        hsdp: {
          ixData: {
            1: { sprited: 0, uri: 'https://static.cdninstagram.com/rsrc.php/yI/r/plain.webp', width: 96, height: 96 },
            2: { sprited: 1, spriteCssClass: 'sx_1', spi: 'https://static.cdninstagram.com/rsrc.php/v4/sprite.png' },
          },
        },
      },
    },
  };
  fs.writeFileSync(path.join(boot, 'x.body'), `for (;;);${JSON.stringify(answer)}`);
  const saved = { DOCUMENT_CACHE_DIR: process.env.DOCUMENT_CACHE_DIR, BOOTLOADER_CACHE_DIR: process.env.BOOTLOADER_CACHE_DIR };
  process.env.DOCUMENT_CACHE_DIR = path.join(dir, 'none');
  process.env.BOOTLOADER_CACHE_DIR = boot;
  try {
    delete require.cache[require.resolve('../scripts/asset-cache')];
    const { collectReferences } = require('../scripts/asset-cache');
    const refs = collectReferences(new Set());
    const urls = [...refs.keys()].sort();
    assert.deepStrictEqual(urls, [
      'https://static.cdninstagram.com/rsrc.php/v4/a.js',
      'https://static.cdninstagram.com/rsrc.php/v4/sprite.png',
      'https://static.cdninstagram.com/rsrc.php/yI/r/plain.webp',
    ]);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    delete require.cache[require.resolve('../scripts/asset-cache')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
