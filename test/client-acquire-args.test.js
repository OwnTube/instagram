'use strict';

/**
 * scripts/client-acquire.js is the one command that contacts Instagram, so a
 * mistyped or unknown argument must stop it before any request (it once read
 * `--help` as "run a pass"). The child runs with networking refused by the
 * upstream guard preloaded; no staging directory may appear.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ACQUIRED = path.join(ROOT, '.cache', 'acquired');
const stagings = () => (fs.existsSync(ACQUIRED) ? fs.readdirSync(ACQUIRED).sort() : []);
const run = (...args) =>
  spawnSync(process.execPath, ['-r', path.join(__dirname, 'fixtures', 'refuse-network.js'), path.join(ROOT, 'scripts', 'client-acquire.js'), ...args], { encoding: 'utf8', env: { ...process.env, NODE_USE_ENV_PROXY: '' } });

test('client-acquire: --help prints usage and requests nothing', () => {
  const before = stagings();
  const r = run('--help');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /^usage:/);
  assert.deepStrictEqual(stagings(), before);
});

test('client-acquire: unknown arguments and missing values stop it before any request', () => {
  const before = stagings();
  for (const args of [['--hlep'], ['extra'], ['--modules'], ['--dry-run', '--max-assets']]) {
    const r = run(...args);
    assert.strictEqual(r.status, 2, args.join(' '));
    assert.match(r.stderr, /nothing was requested/, args.join(' '));
    assert.doesNotMatch(r.stderr + r.stdout, /network attempt/);
  }
  assert.deepStrictEqual(stagings(), before);
});
