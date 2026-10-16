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

  await t.test('a live page leaves the tamper-checked csrf/LSD token and USER_ID untouched', () => {
    // Instagram validates these and refuses to mount if they change, so the
    // shell (identity off, the default for an upstream page) must not touch them.
    const out = personalize(anonymousPage(), { viewer: viewer(), csrfToken: 'clone-csrf', encryption: OURS });
    const text = leaves(out);
    assert.ok(text.includes('upstream-csrf') && out.includes('upstream-lsd'), 'the bootstrap token is preserved');
    assert.ok(!text.includes('clone-csrf'), 'the clone token is not written into the bootstrap');
    assert.match(out, /"USER_ID":"0"/, 'USER_ID is left as the page had it');
    assert.ok(!out.includes('viewer_one'), 'identity is not written into a live page');
  });

  await t.test('a template (identity on) gets the viewer and only that viewer', () => {
    const one = personalize(anonymousPage(), { viewer: viewer(), csrfToken: 'tok-one', encryption: OURS, identity: true });
    const two = personalize(anonymousPage(), { viewer: viewer({ pk: '222', username: 'viewer_two', display_name: 'Viewer Two' }), encryption: OURS, identity: true });
    assert.match(one, /"USER_ID":"111"/);
    assert.ok(leaves(one).includes('"viewerId":"111"'));
    assert.ok(!one.includes('viewer_two'), "one viewer's page never names another");
    assert.ok(!two.includes('viewer_one'));
    assert.match(personalize(anonymousPage(), { encryption: OURS, identity: true }), /"USER_ID":"0"/);
  });

  await t.test('markup in a display name cannot break out of a JSON block', () => {
    const name = '</script><img src=x onerror=alert(1)>';
    const out = personalize(anonymousPage(), { viewer: viewer({ display_name: name }), csrfToken: 'x', encryption: OURS, identity: true });
    const blocks = out.match(/<script type="application\/json"[^>]*>[\s\S]*?<\/script>/g);
    for (const b of blocks) assert.ok(!b.slice(0, -'</script>'.length).includes('</script'), 'no closing tag inside a block');
    assert.ok(!out.includes('<img src=x'));
    assert.ok(leaves(out).includes(name), 'the name itself survives as data');
  });

  await t.test('placeholders in markup are HTML-escaped', () => {
    const html = page([], '<p>__CLONE_VIEWER_FULL_NAME__</p>');
    const out = personalize(html, { viewer: viewer({ display_name: '<b>"x"</b>' }), csrfToken: 'x', encryption: OURS, identity: true });
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

test('several patches on one module all apply, in order', () => {
  const bundle = '__d("ModA",[],function(){return [1,2]+"x";},1);__d("ModB",[],function(){return [1,2];},1);';
  const patcher = createPatcher([
    { id: 'one', module: 'ModA', find: '[1,2]', replace: '[2]', why: 'test' },
    { id: 'two', module: 'ModA', find: '"x"', replace: '"y"', why: 'test' },
  ]);
  const { source, applied } = patcher.apply(bundle);
  assert.deepStrictEqual(applied, ['one', 'two']);
  assert.ok(source.startsWith('__d("ModA",[],function(){return [2]+"y";},1);'));
  assert.ok(source.endsWith('__d("ModB",[],function(){return [1,2];},1);'));
});

test('the registered sign-up patches each name one module and say why', () => {
  const { PATCHES } = require('../src/shell/bundlePatches');
  const ids = PATCHES.map((p) => p.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  for (const p of PATCHES) assert.ok(p.module && p.find && p.why, p.id);
});

test('experimental signed-in home route switches the whole route and applies the feed root answer', () => {
  const init = ['CometPlatformRootClient', 'initialize', [], [{
    expectedPreloaders: [{ actorID: '0', preloaderID: 'adp_X', queryName: 'CAAFetaIGLoginHomepageQuery' }],
    additional_roots: [{ __dr: 'CAAIGLoginHomepageRoot.react' }],
    initialRouteInfo: { route: { actorID: '0', routePath: '/', url: '/', rootView: { resource: { __dr: 'CAAIGLoginHomepageRoot.react' } } } },
    ssrEnabled: true,
  }]];
  const html = page([{ define: [['CurrentUserInitialData', [], { USER_ID: '0', ACCOUNT_ID: '0', NAME: '', SHORT_NAME: null }, 1], ['PolarisViewer', [], { data: null, id: null }, 2]] }, { require: [init] }]);
  const answer = {
    allResources: ['h1', 'h2', 'gone'],
    hsrp: { hsdp: { gkxData: { 1: { result: true } } }, hblp: { rsrcMap: { h1: { type: 'js', src: 'https://static.cdninstagram.com/rsrc.php/a.js' }, h2: { type: 'css', src: 'https://static.cdninstagram.com/rsrc.php/b.css' } }, compMap: {} } },
    jsmods: { define: [['PolarisViewer', [], { data: null }, 9], ['cr:1', [], {}, -1]], require: [['PolarisFeedRoot.react']] },
  };
  const toLocal = (u) => u.replace('https://static.cdninstagram.com/', '/__ig/static.cdninstagram.com/');
  const off = personalize(html, { viewer: viewer(), encryption: OURS });
  assert.ok(off.includes('CAAIGLoginHomepageRoot.react') && /"USER_ID":"0"/.test(off), 'off by default');
  assert.ok(personalize(html, { viewer: null, encryption: OURS, signedInHome: true, feedRoot: answer }).includes('"actorID":"0"'), 'no viewer, no switch');
  assert.ok(personalize(html, { viewer: viewer(), encryption: OURS, signedInHome: true }).includes('"actorID":"0"'), 'no stored answer, no switch');
  const stats = {};
  const on = personalize(html, { viewer: viewer(), encryption: OURS, signedInHome: true, feedRoot: answer, toLocal, stats });
  const blocks = [...on.matchAll(/<script type="application\/json"[^>]*data-sjs>(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  const args = blocks.find((b) => b.require && b.require[0] && b.require[0][0] === 'CometPlatformRootClient').require[0][3][0];
  assert.strictEqual(args.initialRouteInfo.route.actorID, '111');
  assert.strictEqual(args.initialRouteInfo.route.rootView.resource.__dr, 'PolarisFeedRoot.react');
  assert.deepStrictEqual(args.expectedPreloaders, []);
  assert.strictEqual(args.ssrEnabled, false);
  assert.match(on, /"USER_ID":"111"/);
  // The answer's resources, its support data and jsmods precede the initialize block.
  const initAt = on.indexOf('"CometPlatformRootClient","initialize"');
  assert.ok(on.indexOf('<script src="/__ig/static.cdninstagram.com/rsrc.php/a.js" data-bootloader-hash="h1"') < initAt);
  assert.ok(on.indexOf('<link rel="stylesheet" href="/__ig/static.cdninstagram.com/rsrc.php/b.css" data-bootloader-hash="h2"') < initAt);
  const support = blocks.find((b) => b.require && b.require.some((r) => r[0] === 'Bootloader' && r[1] === 'handlePayload'));
  assert.ok(support, 'support block present');
  assert.deepStrictEqual(support.require[0], ['HasteSupportData', 'handle', null, [answer.hsrp.hsdp]]);
  assert.deepStrictEqual(support.define.map((d) => d[0]), ['cr:1'], "the page's own PolarisViewer wins over the answer's");
  assert.strictEqual(stats.feedRootResources, 2);
  assert.strictEqual(stats.feedRootUnmapped, 1, 'a hash with no resource-map entry is reported, not invented');
});

test('a signed-in viewer does not get the logged-out desktop top navigation bindings', () => {
  const { insertFeedRoot } = require('../src/shell/signedInRoute');
  const answer = {
    allResources: [],
    hsrp: { hblp: { rsrcMap: {}, compMap: {} } },
    jsmods: {
      define: [
        ['cr:2696', ['PolarisDesktopNav.react'], { __rc: ['PolarisDesktopNav.react', null] }, -1],
        ['cr:4477', ['PolarisDesktopNavLoggedOutContainer.react'], { __rc: ['PolarisDesktopNavLoggedOutContainer.react', null] }, -1],
        ['cr:7457', ['PolarisMobileTopNavLoggedOut.react'], { __rc: ['PolarisMobileTopNavLoggedOut.react', null] }, -1],
      ],
      require: [],
    },
  };
  const html = "<html><body><script type=\"application/json\" data-sjs>{}</script><div id='has-finished-comet-page'></div></body></html>";
  const out = insertFeedRoot(html, answer, new Set(), (u) => u, null).html;
  const block = [...out.matchAll(/data-sjs>(.*?)<\/script>/g)].map((m) => JSON.parse(m[1])).find((b) => b.define);
  const byId = Object.fromEntries(block.define.map((d) => [d[0], d]));
  assert.deepStrictEqual(byId['cr:2696'], ['cr:2696', [], { __rc: [null, null] }, -1]);
  assert.deepStrictEqual(byId['cr:4477'], ['cr:4477', [], { __rc: [null, null] }, -1]);
  // Gated by the client itself (useHasLoggedOutMobileTopNav): delivered as is.
  assert.deepStrictEqual(byId['cr:7457'][2], { __rc: ['PolarisMobileTopNavLoggedOut.react', null] });
});
