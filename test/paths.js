'use strict';

/**
 * Project-local scratch space for tests. Everything a test writes lives under
 * .scratch/test/ (gitignored), never in the system temp directory; the
 * directories are created on first use, so a fresh checkout needs no
 * preparation.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TEST_ROOT = path.join(ROOT, '.scratch', 'test');

/** A project-local directory (created if needed), e.g. scratchDir('codec-1'). */
function scratchDir(...parts) {
  const dir = path.join(TEST_ROOT, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A new, empty, uniquely named directory under .scratch/test/. */
function tempDir(prefix) {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TEST_ROOT, prefix));
}

module.exports = { ROOT, TEST_ROOT, scratchDir, tempDir };
