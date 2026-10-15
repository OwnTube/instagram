'use strict';

/**
 * Signed-in shell templates: served personalised to signed-in clone viewers
 * only; the snapshot CLI writes them.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startCloneServer, Browser } = require('./clone-helpers');

const ROOT = path.join(__dirname, '..');
fs.mkdirSync(path.join(ROOT, '.scratch'), { recursive: true });

const TEMPLATE =
  '<!DOCTYPE html><html><head><title>t</title></head><body>' +
  '<script type="application/json">{"define":[["CurrentUserInitialData",[],{"USER_ID":"__CLONE_VIEWER_PK__","SHORT_NAME":"__CLONE_VIEWER_USERNAME__"},1]]}</script>' +
  '<p id="who">__CLONE_VIEWER_USERNAME__</p><p id="name">__CLONE_VIEWER_FULL_NAME__</p></body></html>';

test('signed-in templates', async (t) => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.scratch', 'tmpl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'home.html'), TEMPLATE);
  fs.writeFileSync(path.join(dir, 'profile.html'), TEMPLATE);
  const s = await startCloneServer({ SHELL_TEMPLATE_DIR: dir });
  t.after(() => s.close());

  const ann = new Browser(s.base);
  const annPk = (await ann.signup(s, { username: 'ann_t', fullName: '<i>Ann</i>' })).pk;
  const ben = new Browser(s.base);
  await ben.signup(s, { username: 'ben_t' });

  await t.test('a signed-in viewer gets the template, personalised, with no upstream fetch', async () => {
    const before = s.upstream.length;
    const res = await ann.visit('/');
    assert.strictEqual(res.headers.get('x-clone-shell'), 'template:home');
    assert.strictEqual(s.upstream.length, before);
    assert.ok(res.text.includes(`"USER_ID":"${annPk}"`));
    assert.ok(res.text.includes('<p id="who">ann_t</p>'));
    assert.ok(res.text.includes('&#60;i&#62;Ann&#60;/i&#62;'), 'the display name is escaped in markup');
    assert.ok(!res.text.includes('__CLONE_'), 'no placeholder survives');
    assert.strictEqual(res.headers.get('cache-control'), 'private, no-store, max-age=0');
  });

  await t.test('each viewer gets their own personalisation', async () => {
    const res = await ben.visit('/ann_t/');
    assert.strictEqual(res.headers.get('x-clone-shell'), 'template:profile');
    assert.ok(res.text.includes('<p id="who">ben_t</p>') && !res.text.includes('ann_t'));
  });

  await t.test('anonymous visitors never get a template', async () => {
    const res = await new Browser(s.base).visit('/');
    assert.strictEqual(res.headers.get('x-clone-shell'), null);
    assert.ok(res.text.includes('upstream document'));
  });

  await t.test('templates are listed on the loader health page', async () => {
    const health = await (await fetch(`${s.base}/__loader/health`)).json();
    assert.deepStrictEqual(health.shell.templates, ['home', 'profile']);
  });
});

test('snapshot-shell CLI writes a scrubbed template', () => {
  const work = fs.mkdtempSync(path.join(ROOT, '.scratch', 'snap-'));
  try {
    const saved = path.join(work, 'saved.html');
    fs.writeFileSync(saved, '<html><body><a href="/cli_owner/">cli_owner</a> 4440003332</body></html>');
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'snapshot-shell.js'), '--kind', 'home', '--file', saved, '--user-id', '4440003332', '--username', 'cli_owner'], {
      env: { ...process.env, SHELL_TEMPLATE_DIR: path.join(work, 'shell') },
      encoding: 'utf8',
    });
    assert.match(out, /wrote/);
    const written = fs.readFileSync(path.join(work, 'shell', 'home.html'), 'utf8');
    assert.ok(!written.includes('cli_owner') && !written.includes('4440003332'));
    assert.strictEqual(fs.statSync(path.join(work, 'shell', 'home.html')).mode & 0o077, 0);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
