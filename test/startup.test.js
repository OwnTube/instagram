'use strict';

/**
 * Startup errors an operator can act on: an unsupported Node version, and a
 * port that is already taken (the second server exits with a message; the
 * first keeps serving).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { atLeast, unsupportedReason, MINIMUM } = require('../src/nodeVersion');
const { scratchDir } = require('./paths');
const pkg = require('../package.json');

test('node version gate', () => {
  assert.strictEqual(pkg.engines.node, `>=${MINIMUM}`);
  assert.ok(atLeast(process.version, MINIMUM), `tests run on a supported Node (${process.version})`);
  for (const v of ['v20.20.0', 'v21.7.3', 'v22.12.0']) assert.match(unsupportedReason(v, false), new RegExp(`Node.js ${MINIMUM.replace(/\./g, '\\.')} or newer is required \\(this is ${v.replace(/\./g, '\\.')}\\)`));
  for (const v of ['v22.13.0', 'v22.22.0', 'v24.1.0']) assert.strictEqual(unsupportedReason(v, true), null);
  assert.match(unsupportedReason('v24.0.0', false), /no node:sqlite/);
});

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function run(port, dir) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', BACKEND_DB: path.join(dir, 'db.sqlite'), CLONE_DATA_DIR: dir, VERBOSE: '0', BACKEND_VERBOSE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exited, output: () => out };
}

test('a second server on a taken port exits with a message; the first keeps serving', async (t) => {
  const port = await freePort();
  const dir = scratchDir(`startup-${process.pid}`);
  const first = run(port, dir);
  t.after(() => first.child.kill('SIGKILL'));
  for (let i = 0; i < 100 && !/listening on/.test(first.output()); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(first.output(), /listening on/);
  const second = run(port, dir);
  const code = await second.exited;
  assert.strictEqual(code, 1);
  assert.match(second.output(), new RegExp(`cannot start: port ${port} on 127\\.0\\.0\\.1 is already in use.*PORT=${port + 1} npm start`));
  const res = await fetch(`http://127.0.0.1:${port}/__loader/health`);
  assert.strictEqual(res.status, 200);
});

test('other listen errors are not disguised', () => {
  const { listenErrorMessage } = require('../src/server');
  assert.match(listenErrorMessage({ code: 'EADDRINUSE' }, { host: '0.0.0.0', port: 12000 }), /PORT=12001/);
  assert.match(listenErrorMessage({ code: 'EACCES' }, { host: '0.0.0.0', port: 80 }), /not permitted/);
  assert.strictEqual(listenErrorMessage({ code: 'EMFILE' }, { host: '0.0.0.0', port: 12000 }), null);
});
