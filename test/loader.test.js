'use strict';

/**
 * Regression tests for the runtime loader.
 *
 * These lock in the loader behaviour that must not change while the backend is
 * developed: URL rewriting, the asset allow-list, the proxy-target resolver, and
 * cache semantics. They are pure-function tests and make no upstream requests.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { mapUrl, rewriteHtml, rewriteCss, isAllowedUpstreamUrl, resolveProxyTarget, ALLOWED_HOSTS } = require('../src/rewrite');

test('loader: asset URL rewriting', async (t) => {
  await t.test('an allow-listed CDN asset is mapped onto the proxy path', () => {
    const mapped = mapUrl('https://static.cdninstagram.com/rsrc.php/v4/yC/r/abc.js');
    assert.strictEqual(mapped, '/__ig/static.cdninstagram.com/rsrc.php/v4/yC/r/abc.js');
  });

  await t.test('a link to the site itself becomes root-relative, not proxied', () => {
    assert.strictEqual(mapUrl('https://www.instagram.com/explore/tags/cats/'), '/explore/tags/cats/');
    assert.strictEqual(mapUrl('https://instagram.com/about/'), '/about/');
  });

  await t.test('a host outside the allow-list is left untouched', () => {
    const evil = 'https://evil.example.com/tracker.js';
    assert.strictEqual(mapUrl(evil), evil);
  });

  await t.test('non-fetchable schemes are left untouched', () => {
    for (const value of ['data:image/png;base64,AAA', 'blob:https://x/y', 'javascript:void(0)', '#top']) {
      assert.strictEqual(mapUrl(value), value);
    }
  });

  await t.test('the allow-list check rejects a look-alike host', () => {
    assert.strictEqual(isAllowedUpstreamUrl('https://static.cdninstagram.com.evil.com/x.js'), false);
    assert.strictEqual(isAllowedUpstreamUrl('https://static.cdninstagram.com/x.js'), true);
  });

  await t.test('rewriteHtml rewrites src/href but leaves inline JSON alone', () => {
    const html = [
      '<script src="https://static.cdninstagram.com/a.js"></script>',
      '<link href="https://static.cdninstagram.com/a.css" rel="stylesheet">',
      '<img src="https://static.cdninstagram.com/a.webp">',
      '<script type="application/json">{"u":"https://static.cdninstagram.com/a.js"}</script>',
    ].join('');
    const out = rewriteHtml(html);
    assert.ok(out.includes('/__ig/static.cdninstagram.com/a.js'));
    assert.ok(out.includes('/__ig/static.cdninstagram.com/a.css'));
    assert.ok(out.includes('/__ig/static.cdninstagram.com/a.webp'));
    // The bare URL inside the JSON body is not an attribute value, so it stays.
    assert.ok(out.includes('{"u":"https://static.cdninstagram.com/a.js"}'));
  });

  await t.test('rewriteHtml does not rewrite JavaScript source text', () => {
    const html = '<script>var url="https://static.cdninstagram.com/x.js";</script>';
    assert.strictEqual(rewriteHtml(html), html);
  });

  await t.test('rewriteCss maps url() references', () => {
    const css = 'body{background:url("https://static.cdninstagram.com/a.png")}';
    assert.strictEqual(rewriteCss(css), 'body{background:url("/__ig/static.cdninstagram.com/a.png")}');
  });

  await t.test('resolveProxyTarget refuses a host outside the allow-list', () => {
    assert.strictEqual(resolveProxyTarget('evil.example.com', '/x.js'), null);
    assert.strictEqual(resolveProxyTarget('static.cdninstagram.com', '/x.js'), 'https://static.cdninstagram.com/x.js');
    assert.strictEqual(resolveProxyTarget('static.cdninstagram.com', 'no-slash'), null);
  });

  await t.test('the allow-list contains the expected origins', () => {
    for (const host of ['static.cdninstagram.com', 'www.instagram.com']) {
      assert.ok(ALLOWED_HOSTS.has(host), `expected ${host} in allow-list`);
    }
  });
});
