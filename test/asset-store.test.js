'use strict';

const { tempDir } = require('./paths');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createAssetStore } = require('../src/assetStore');

test('asset store round-trips an entry with its validators and keeps urls apart', async () => {
  const dir = tempDir('assets-');
  try {
    const store = createAssetStore(dir);
    const entry = { body: Buffer.from([0, 1, 2, 255]), contentType: 'application/javascript', etag: '"abc"', lastModified: 'x' };
    await store.write('https://static.cdninstagram.com/a.js', entry);
    const back = await store.read('https://static.cdninstagram.com/a.js');
    assert.deepStrictEqual(back.body, entry.body);
    assert.strictEqual(back.etag, '"abc"');
    assert.strictEqual(back.contentType, 'application/javascript');
    assert.ok(back.storedAt <= Date.now());
    assert.strictEqual(await store.read('https://static.cdninstagram.com/b.js'), undefined);
    assert.strictEqual(createAssetStore(''), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
