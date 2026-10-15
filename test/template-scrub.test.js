'use strict';

/** Template scrubbing: the source account must not survive into a template. */

const { test } = require('node:test');
const assert = require('node:assert');
const { scrubTemplate } = require('../src/shell/templates');
const { editJsonBlocks } = require('../src/shell/sjs');

const ID = '9876543210';
const NAME = 'sample_owner';
const FULL = 'Zoë Sample';

function fixture() {
  const block = (o) => `<script type="application/json">${JSON.stringify(o)}</script>`;
  const nested = JSON.stringify({ owner: { username: NAME, full_name: FULL, profile_pic_url: 'https://cdn.example/pic.jpg' } });
  return [
    '<html><head><title>Zoë Sample</title></head><body>',
    block({ define: [['CurrentUserInitialData', [], { USER_ID: ID, NAME: FULL, SHORT_NAME: NAME }, 1]] }),
    block({ define: [['DTSGInitialData', [], { token: 'tmpl-token-a' }, 2]] }),
    block({ config: { csrf_token: 'tmpl-token-b' }, raw: nested }),
    // Escaped forms as a server might emit them: \u00eb in JSON, and again
    // inside a JSON string field (double-escaped).
    '<script type="application/json">{"a":"Zo\\u00eb Sample","b":"{\\"n\\":\\"Zo\\\\u00eb Sample\\"}"}</script>',
    block({ require: [['RelayPrefetchedStreamCache', 'next', [], ['adp_FeedQueryRelayPreloader_1', { items: ['owner feed item'] }]]] }),
    `<a href="/${NAME}/">${NAME}</a> id ${ID}`,
    '</body></html>',
  ].join('');
}

function decoded(html) {
  const out = [html];
  editJsonBlocks(html, (n) => {
    if (typeof n === 'string') out.push(n);
    return undefined;
  });
  return out.join('\n');
}

test('scrubTemplate removes the source account', async (t) => {
  const { html, report } = scrubTemplate(fixture(), { userId: ID, username: NAME, fullName: FULL });
  const all = decoded(html);

  await t.test('no id, username or name remains, in markup or decoded JSON', () => {
    for (const value of [ID, NAME, FULL]) assert.ok(!all.toLowerCase().includes(value.toLowerCase()), value);
    assert.ok(html.includes('__CLONE_VIEWER_PK__') && html.includes('__CLONE_VIEWER_USERNAME__') && html.includes('__CLONE_VIEWER_FULL_NAME__'));
  });

  await t.test('a non-ASCII name escaped as \\u00eb, even double-escaped, is still found', () => {
    assert.ok(fixture().includes('Zo\\u00eb Sample') && fixture().includes('Zo\\\\u00eb Sample'), 'the fixture has both forms');
    assert.ok(!html.toLowerCase().includes('zo\\u00eb') && !html.includes('Zoë'));
  });

  await t.test('prefetched data, tokens and the profile picture are removed', () => {
    assert.ok(!all.includes('owner feed item'));
    assert.ok(!all.includes('tmpl-token-a') && !all.includes('tmpl-token-b'));
    assert.ok(!all.includes('cdn.example/pic.jpg'));
    assert.ok(report.prefetchesRemoved >= 1 && report.tokensReplaced >= 2);
  });

  await t.test('unrelated numbers containing the id are left alone', () => {
    const { html: out } = scrubTemplate(`<p>${ID}5 x${ID}</p>`, { userId: ID, username: NAME });
    assert.ok(out.includes(`${ID}5`), 'a longer number is not the id');
  });

  await t.test('bad identity input is refused', () => {
    assert.throws(() => scrubTemplate(fixture(), { userId: 'abc', username: NAME }));
    assert.throws(() => scrubTemplate(fixture(), { userId: ID, username: 'bad name!' }));
  });
});
