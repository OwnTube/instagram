'use strict';

/**
 * HAR import (scripts/client-import-har.js) and building one revision from
 * several staging directories (scripts/client-snapshot.js build --acquired
 * A,B): only the client's public material is imported, and never anything of
 * the recording session; a build combines staging of one revision only.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { classify } = require('../scripts/client-import-har');
const { answerAt, sjs } = require('./snapshot-fixture');

const ROOT = path.join(__dirname, '..');
const SECRET = 'SESSION_SECRET_VALUE_42';

function entry(url, { status = 200, mimeType = 'application/x-javascript', text = 'x', encoding, method = 'GET', dest } = {}) {
  return {
    request: { method, url, headers: [{ name: 'cookie', value: `sessionid=${SECRET}` }, ...(dest ? [{ name: 'sec-fetch-dest', value: dest }] : [])] },
    response: { status, headers: [{ name: 'set-cookie', value: `sessionid=${SECRET}` }], content: { mimeType, text, ...(encoding ? { encoding } : {}) } },
  };
}

const doc = (rev) => `<!doctype html><html><body>${sjs({ require: [['Bootloader', 'handlePayload', null, [{ consistency: { rev }, rsrcMap: {}, compMap: {} }]]] })}</body></html>`;

test('classify takes the client material only, and only module names from a bootloader request', () => {
  assert.deepStrictEqual(classify(entry('https://static.cdninstagram.com/rsrc.php/v4/yA/r/abc.js')), { kind: 'asset', url: 'https://static.cdninstagram.com/rsrc.php/v4/yA/r/abc.js', contentType: 'application/x-javascript' });
  const boot = classify(entry(`https://www.instagram.com/ajax/bootloader-endpoint/?modules=A.react%2CB.react&__user=17841&fb_dtsg_ag=${SECRET}&jazoest=123&__rev=1`, { mimeType: 'text/javascript' }));
  assert.deepStrictEqual(boot, { kind: 'answer', modules: 'A.react,B.react', nbModules: '', contentType: 'text/javascript' });
  assert.ok(!JSON.stringify(boot).includes(SECRET) && !JSON.stringify(boot).includes('17841'));
  for (const e of [
    entry('https://www.instagram.com/api/v1/discover/web/explore_grid/', { mimeType: 'application/json' }),
    entry('https://www.instagram.com/graphql/query', { method: 'POST', mimeType: 'application/json' }),
    entry('https://scontent-ord5-1.cdninstagram.com/v/t51/photo.jpg', { mimeType: 'image/jpeg' }),
    entry('https://static.cdninstagram.com/rsrc.php/v4/yA/r/abc.js', { status: 304 }),
    entry('https://static.cdninstagram.com/rsrc.php/v4/yA/r/abc.js?_nc_x=1'),
    entry('https://evil.example/rsrc.php/v4/x.js'),
  ]) assert.strictEqual(classify(e).kind, 'ignored', e.request.url);
  assert.strictEqual(classify(entry('https://www.instagram.com/', { mimeType: 'text/html', dest: 'document' })).kind, 'document');
});

test('import, then build one revision from an acquisition and a HAR; refuse mixed revisions', (t) => {
  const tmp = fs.mkdtempSync(path.join(ROOT, '.scratch', 'import-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const env = {
    ...process.env,
    ASSET_CACHE_DIR: path.join(tmp, 'assets'),
    DOCUMENT_CACHE_DIR: path.join(tmp, 'documents'),
    BOOTLOADER_CACHE_DIR: path.join(tmp, 'bootloader'),
    ACQUIRED_DIR: path.join(tmp, 'acquired'),
    CLIENT_DIR: path.join(tmp, 'client'),
  };
  const js = 'https://static.cdninstagram.com/rsrc.php/v4/yA/r/abc.js';
  const har = {
    log: {
      entries: [
        entry(js, { text: Buffer.from('__d("A",[],function(){},1);').toString('base64'), encoding: 'base64' }),
        entry(`https://www.instagram.com/ajax/bootloader-endpoint/?modules=PolarisFeedRoot.react&__user=1&fb_dtsg_ag=${SECRET}`, { mimeType: 'text/javascript', text: answerAt(200, { rsrcMap: { h1: { type: 'js', src: js } }, allResources: ['h1'] }) }),
        entry('https://www.instagram.com/ajax/bootloader-endpoint/?modules=Old.react', { mimeType: 'text/javascript', text: answerAt(199) }),
        entry('https://www.instagram.com/api/v1/users/web_profile_info/?username=someone', { mimeType: 'application/json', text: `{"secret":"${SECRET}"}` }),
      ],
    },
  };
  const harFile = path.join(tmp, 'in.har');
  fs.writeFileSync(harFile, JSON.stringify(har));
  const run = (args) => spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8' });
  const imp = run([path.join(ROOT, 'scripts', 'client-import-har.js'), harFile]);
  assert.strictEqual(imp.status, 0, imp.stdout + imp.stderr);
  assert.match(imp.stdout, /static assets: 1 new/);
  assert.match(imp.stdout, /revision 200: 1 answers, 0 documents \(no root document/);
  assert.match(imp.stdout, /revision 199: 1 answers/);
  // Nothing of the session or of API responses was written anywhere.
  const all = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile());
  for (const f of all(tmp).filter((f) => f !== harFile)) assert.ok(!fs.readFileSync(f, 'utf8').includes(SECRET), `${path.relative(tmp, f)} holds session material`);
  const staged = fs.readdirSync(env.ACQUIRED_DIR);
  const har200 = path.join(env.ACQUIRED_DIR, staged.find((d) => d.endsWith('-rev200')));
  const har199 = path.join(env.ACQUIRED_DIR, staged.find((d) => d.endsWith('-rev199')));
  const prov = JSON.parse(fs.readFileSync(path.join(har200, 'provenance.json'), 'utf8'));
  assert.strictEqual(prov.source, 'har');
  assert.strictEqual(prov.complete, false);
  assert.deepStrictEqual(prov.requests.map((r) => r.key), ['PolarisFeedRoot.react|']);

  // The HAR alone cannot be built: no root document of its revision.
  const alone = run([path.join(ROOT, 'scripts', 'client-snapshot.js'), 'build', '--acquired', har200]);
  assert.notStrictEqual(alone.status, 0);
  assert.match(alone.stdout + alone.stderr, /no navigation document for \/ at revision 200/);

  // An acquisition of the same revision with the root document: built together.
  const { createAssetStore } = require('../src/assetStore');
  const pass = path.join(env.ACQUIRED_DIR, 'pass-rev200');
  fs.mkdirSync(pass, { recursive: true });
  fs.writeFileSync(path.join(pass, 'provenance.json'), JSON.stringify({ revision: '200', anonymous: true, requests: [], complete: false }));
  return createAssetStore(path.join(pass, 'documents'))
    .write('doc:https://www.instagram.com:nav:/', { body: Buffer.from(doc(200)), contentType: 'text/html; charset=utf-8' })
    .then(() => {
      const both = run([path.join(ROOT, 'scripts', 'client-snapshot.js'), 'build', '--acquired', `${pass},${har200}`]);
      assert.strictEqual(both.status, 0, both.stdout + both.stderr);
      assert.match(both.stdout, /revision 200/);
      assert.match(both.stdout, /answers 1/);
      // Staging of two revisions is refused.
      const mixed = run([path.join(ROOT, 'scripts', 'client-snapshot.js'), 'build', '--acquired', `${pass},${har199}`]);
      assert.notStrictEqual(mixed.status, 0);
      assert.match(mixed.stdout + mixed.stderr, /revision 199, not 200: staging of different revisions is not combined/);
    });
});
