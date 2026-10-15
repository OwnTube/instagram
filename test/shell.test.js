'use strict';

/**
 * src/shell unit tests. Fixtures are small synthetic pages built in the shape
 * of Meta's bootstrap JSON (define tuples, prefetch tuples, JSON inside string
 * fields). They prove the transformations; whether the live page uses exactly
 * these keys can only be confirmed against the live client.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { personalize, RUNTIME_TAG } = require('../src/shell/personalize');
const { routeKind } = require('../src/shell/templates');
const { createPatcher } = require('../src/shell/bundlePatches');
const { editJsonBlocks } = require('../src/shell/sjs');

const json = (obj) => `<script type="application/json" data-sjs>${JSON.stringify(obj)}</script>`;
const OURS = { key_id: '7', public_key: 'b'.repeat(64), version: '10' };

function page(blocks, body = '') {
  return `<!DOCTYPE html><html><head><title>t</title></head><body>${blocks.map(json).join('')}${body}</body></html>`;
}

function anonymousPage() {
  return page([
    { define: [['CurrentUserInitialData', [], { USER_ID: '0', ACCOUNT_ID: '0', NAME: '', SHORT_NAME: null }, 1], ['LSD', [], { token: 'upstream-lsd' }, 2]] },
    { raw: JSON.stringify({ config: { csrf_token: 'upstream-csrf', viewer: null, viewerId: null }, encryption: { key_id: '1', public_key: 'a'.repeat(64), version: '10' } }) },
    { other: { keyId: 3, publicKey: 'c'.repeat(64) } },
    { require: [['RelayPrefetchedStreamCache', 'next', [], ['adp_SomeQueryRelayPreloader_x', { data: { note: 'upstream data' } }]]] },
  ]);
}

/** Every decoded string leaf in the page's JSON blocks, nested JSON included. */
function leaves(html) {
  const out = [];
  editJsonBlocks(html, (node) => {
    if (typeof node === 'string') out.push(node);
    return undefined;
  });
  return out.join('\n');
}

const viewer = (overrides = {}) => ({ pk: '111', username: 'viewer_one', display_name: 'Viewer One', avatar_url: null, ...overrides });

test('personalize', async (t) => {
  await t.test('our encryption key replaces the page key in every naming style', () => {
    const out = personalize(anonymousPage(), { csrfToken: 'clone-csrf', encryption: OURS });
    const text = leaves(out);
    assert.ok(!text.includes('a'.repeat(64)), 'snake_case key replaced inside nested JSON');
    assert.ok(!out.includes('c'.repeat(64)), 'camelCase key replaced');
    assert.ok(text.includes(OURS.public_key));
    assert.match(out, /"keyId":7/, 'a numeric key id stays numeric');
  });

  await t.test('CSRF fields and the LSD token become the clone token', () => {
    const out = personalize(anonymousPage(), { csrfToken: 'clone-csrf', encryption: OURS });
    const text = leaves(out);
    assert.ok(!text.includes('upstream-csrf') && !out.includes('upstream-lsd'));
    assert.ok(text.includes('clone-csrf'));
  });

  await t.test('anonymous and signed-in viewers get their own identity, and only theirs', () => {
    const anon = personalize(anonymousPage(), { csrfToken: 'x', encryption: OURS });
    assert.match(anon, /"USER_ID":"0"/);
    const one = personalize(anonymousPage(), { viewer: viewer(), csrfToken: 'tok-one', encryption: OURS });
    const two = personalize(anonymousPage(), { viewer: viewer({ pk: '222', username: 'viewer_two', display_name: 'Viewer Two' }), csrfToken: 'tok-two', encryption: OURS });
    assert.match(one, /"USER_ID":"111"/);
    assert.ok(leaves(one).includes('"viewerId":"111"'));
    assert.ok(!one.includes('viewer_two') && !one.includes('tok-two'), "one viewer's page never names another");
    assert.ok(!two.includes('viewer_one') && !two.includes('tok-one'));
  });

  await t.test('markup in a display name cannot break out of a JSON block', () => {
    const name = '</script><img src=x onerror=alert(1)>';
    const out = personalize(anonymousPage(), { viewer: viewer({ display_name: name }), csrfToken: 'x', encryption: OURS });
    const blocks = out.match(/<script type="application\/json"[^>]*>[\s\S]*?<\/script>/g);
    for (const b of blocks) assert.ok(!b.slice(0, -'</script>'.length).includes('</script'), 'no closing tag inside a block');
    assert.ok(!out.includes('<img src=x'));
    assert.ok(leaves(out).includes(name), 'the name itself survives as data');
  });

  await t.test('placeholders in markup are HTML-escaped', () => {
    const html = page([], '<p>__CLONE_VIEWER_FULL_NAME__</p>');
    const out = personalize(html, { viewer: viewer({ display_name: '<b>"x"</b>' }), csrfToken: 'x', encryption: OURS });
    assert.ok(out.includes('<p>&#60;b&#62;&#34;x&#34;&#60;/b&#62;</p>'));
  });

  await t.test('upstream prefetched data is dropped only when asked', () => {
    assert.ok(personalize(anonymousPage(), { encryption: OURS }).includes('upstream data'));
    const dropped = personalize(anonymousPage(), { encryption: OURS, dropPrefetches: true });
    assert.ok(!dropped.includes('upstream data') && !dropped.includes('RelayPrefetchedStreamCache'));
  });

  await t.test('the runtime is the first script and unparseable blocks are untouched', () => {
    const broken = '<script type="application/json">{not json</script>';
    const out = personalize(page([], broken), { encryption: OURS });
    assert.ok(out.startsWith(`<!DOCTYPE html><html><head>${RUNTIME_TAG}`));
    assert.ok(out.includes(broken));
  });
});

test('routeKind', () => {
  const cases = {
    '/': 'home',
    '/explore/': 'explore',
    '/direct/inbox/': 'direct',
    '/accounts/edit/': 'accounts_edit',
    '/p/AbC_-1/': 'post',
    '/stories/someone/': 'stories',
    '/someone/': 'profile',
    '/some.one_2': 'profile',
    '/accounts/login/': null,
    '/static/x.js': null,
    '/__clone/health': null,
  };
  for (const [path, kind] of Object.entries(cases)) assert.strictEqual(routeKind(path), kind, path);
});

test('bundle patcher edits only the named module', () => {
  const bundle = '__d("ModA",[],function(){return "needle";},1);__d("ModB",[],function(){return "needle";},1);';
  const patcher = createPatcher([
    { id: 'a', module: 'ModA', find: '"needle"', replace: '"patched"', why: 'test' },
    { id: 'missing', module: 'ModA', find: 'not there', replace: 'x', why: 'test' },
  ]);
  const { source, applied } = patcher.apply(bundle);
  assert.deepStrictEqual(applied, ['a']);
  assert.ok(source.includes('__d("ModA",[],function(){return "patched";}'));
  assert.ok(source.includes('__d("ModB",[],function(){return "needle";}'), 'another module with the same text is untouched');
  const report = Object.fromEntries(patcher.report().map((r) => [r.id, r]));
  assert.strictEqual(report.a.applied, 1);
  assert.strictEqual(report.missing.missedFind, 1);
  assert.deepStrictEqual(createPatcher([]).apply(bundle), { source: bundle, applied: [] });
});
