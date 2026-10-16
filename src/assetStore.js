'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * Disk copy of the PUBLIC static assets the asset proxy fetches (script and
 * style bundles, fonts, images), so a restart or an upstream throttle does not
 * leave the page without them. Keyed by upstream URL; only the asset route
 * writes here, never documents or API responses, so nothing viewer-specific
 * can land on disk. Entries keep their validators and original fetch time, so
 * the in-memory cache's revalidation and serve-stale rules apply unchanged.
 */
function createAssetStore(dir) {
  if (!dir) return null;
  const file = (key) => path.join(dir, crypto.createHash('sha256').update(key).digest('hex'));

  return {
    async read(key) {
      try {
        const [metaText, body] = await Promise.all([fs.readFile(`${file(key)}.json`, 'utf8'), fs.readFile(`${file(key)}.body`)]);
        const meta = JSON.parse(metaText);
        if (meta.key !== key) return undefined;
        return { ...meta.entry, body, storedAt: meta.storedAt };
      } catch {
        return undefined;
      }
    },
    async write(key, entry) {
      try {
        await fs.mkdir(dir, { recursive: true });
        const base = file(key);
        const { body, ...rest } = entry;
        const tmp = `${base}.${process.pid}.tmp`;
        await fs.writeFile(tmp, body);
        await fs.rename(tmp, `${base}.body`);
        await fs.writeFile(`${base}.json`, JSON.stringify({ key, storedAt: Date.now(), entry: rest }));
      } catch {
        /* the disk copy is an optimisation; never fail a request over it */
      }
    },
  };
}

module.exports = { createAssetStore };
