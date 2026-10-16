'use strict';

/**
 * Byte fidelity of bootstrap JSON editing. A parse/stringify round trip is
 * lossy for this data and broke the client's module bootstrap; values the
 * visitor leaves alone must come back exactly as they arrived.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { editJsonBlocks, editJsonText, REMOVE } = require('../src/shell/sjs');
const { personalize } = require('../src/shell/personalize');

const BS = String.fromCharCode(92);

// Everything a JSON.parse/JSON.stringify round trip would alter.
const SUPPORT = [
  '{"clpData":{"1744178":{"r":1},"636":{"r":2}},',
  '"big":12345678901234567890,',
  '"floats":[1.0,1e3,-0],',
  `"path":"a${BS}/b",`,
  `"name":"Zo${BS}u00eb",`,
  '"dup":1,"dup":2,',
  ' "spaced" : [ 1 , 2 ] }',
].join('');

const block = (text) => `<script type="application/json" data-sjs>${text}</script>`;

test('JSON editing preserves bytes', async (t) => {
  await t.test('the support fixture really is lossy under a round trip', () => {
    assert.notStrictEqual(JSON.stringify(JSON.parse(SUPPORT)), SUPPORT);
  });

  await t.test('a visitor that changes nothing returns the exact text', () => {
    const out = editJsonText(SUPPORT, () => undefined);
    assert.strictEqual(out, SUPPORT);
  });

  await t.test('rewriting a value to itself returns the exact text', () => {
    const out = editJsonText(SUPPORT, (node) => {
      if (node && typeof node === 'object' && 'path' in node) node.path = 'a/b';
      return undefined;
    });
    assert.strictEqual(out, SUPPORT);
  });

  await t.test('editing one field changes only that field', () => {
    const text = '{"config":{"csrf_token":"old"},"support":' + SUPPORT + '}';
    const out = editJsonText(text, (node) => {
      if (node && typeof node === 'object' && typeof node.csrf_token === 'string') node.csrf_token = 'new';
      return undefined;
    });
    assert.strictEqual(out, text.replace('"csrf_token":"old"', '"csrf_token":"new"'));
  });

  await t.test('removing a prefetch leaves its neighbours byte for byte', () => {
    const text = '{"require":[["A",1.0],["RelayPrefetchedStreamCache","next",[],["k",{}]],["B",12345678901234567890]]}';
    const out = editJsonText(text, (node) => (Array.isArray(node) && node[0] === 'RelayPrefetchedStreamCache' ? REMOVE : undefined));
    assert.strictEqual(out, '{"require":[["A",1.0],["B",12345678901234567890]]}');
  });

  await t.test('an edit inside JSON-in-a-string keeps the rest of that string', () => {
    const inner = '{"csrf_token":"old","n":1.0}';
    const text = JSON.stringify({ raw: inner, other: 1 }).replace('"other":1', '"other":1.0');
    const out = editJsonText(text, (node) => {
      if (node && typeof node === 'object' && typeof node.csrf_token === 'string') node.csrf_token = 'new';
      return undefined;
    });
    assert.strictEqual(JSON.parse(out).raw, '{"csrf_token":"new","n":1.0}');
    assert.ok(out.endsWith('"other":1.0}'));
  });

  await t.test('a block the shell does not need to touch is returned unchanged by personalize', () => {
    const html = `<html><head></head><body>${block(SUPPORT)}${block('{"config":{"csrf_token":"up"}}')}</body></html>`;
    const out = personalize(html, { csrfToken: 'ours', encryption: { key_id: '1', public_key: 'b'.repeat(64), version: '10' } });
    assert.ok(out.includes(block(SUPPORT)), 'the support block must be byte-identical');
    assert.ok(out.includes('"csrf_token":"ours"'));
  });

  await t.test('new values are still safe inside a script element', () => {
    const { html } = editJsonBlocks(block('{"a":"x"}'), (node) => {
      if (node && typeof node === 'object' && 'a' in node) node.a = '</script><b>';
      return undefined;
    });
    const body = html.slice(html.indexOf('>') + 1, html.lastIndexOf('</script>'));
    assert.ok(!body.includes('</script') && !body.includes('<b>'));
    assert.strictEqual(JSON.parse(body).a, '</script><b>');
  });

  await t.test('malformed JSON is left untouched', () => {
    assert.strictEqual(editJsonText('{"a":', () => 'x'), '{"a":');
  });
});
