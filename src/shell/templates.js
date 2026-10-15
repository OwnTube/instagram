'use strict';

/**
 * Authenticated app-shell templates.
 *
 * Instagram renders the signed-in app (feed, inbox, settings...) only for a
 * signed-in Instagram session; the anonymous document is the login page and
 * does not reference the feed's modules at all (docs/FEED-INTEGRATION-PLAN.md).
 * A clone user has no Instagram session, so their signed-in shell comes from a
 * template: an operator saves the page once from their own browser, and
 * scripts/snapshot-shell.js scrubs it with scrubTemplate() below. Templates live
 * in SHELL_TEMPLATE_DIR (default .cache/shell, gitignored) and are never
 * committed, like Meowcord never commits Discord's client.
 *
 * At request time the template is personalised for the clone viewer
 * (src/shell/personalize.js), so no Instagram session is ever used to serve a
 * clone user.
 */

const fs = require('node:fs');
const path = require('node:path');
const { editJsonBlocks, prefetchKey, isDefineTuple, looksLikeJson, REMOVE } = require('./sjs');

const RESERVED_FIRST_SEGMENTS = new Set([
  'accounts', 'explore', 'direct', 'p', 'reel', 'reels', 'stories', 'tv', 'about', 'legal', 'developer', 'api', 'graphql',
  'ajax', 'static', 'rsrc.php', 'data', 'web', 'challenge', 'emails', 'oauth', 'privacy', 'session', '__ig', '__clone',
  '__media', '__backend', '__loader',
]);

/** Which signed-in screen a path is, or null when it is not an app route. */
function routeKind(pathname) {
  if (pathname === '/' || pathname === '') return 'home';
  if (/^\/explore\/?$/.test(pathname)) return 'explore';
  if (/^\/direct(\/|$)/.test(pathname)) return 'direct';
  if (/^\/accounts\/edit\/?$/.test(pathname)) return 'accounts_edit';
  if (/^\/accounts\/activity\/?$/.test(pathname)) return 'activity';
  if (/^\/p\/[A-Za-z0-9_-]+\/?$/.test(pathname)) return 'post';
  if (/^\/stories\/[A-Za-z0-9._]+(\/\d+)?\/?$/.test(pathname)) return 'stories';
  const m = /^\/([A-Za-z0-9._]{1,30})\/?$/.exec(pathname);
  if (m && !RESERVED_FIRST_SEGMENTS.has(m[1].toLowerCase())) return 'profile';
  return null;
}

function createTemplateStore({ dir }) {
  const root = path.resolve(dir);
  const cache = new Map();

  function load(kind) {
    if (!kind || !/^[a-z_]+$/.test(kind)) return null;
    const file = path.join(root, `${kind}.html`);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    const hit = cache.get(kind);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.html;
    const html = fs.readFileSync(file, 'utf8');
    cache.set(kind, { html, mtimeMs: stat.mtimeMs });
    return html;
  }

  function available() {
    try {
      return fs.readdirSync(root).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5)).sort();
    } catch {
      return [];
    }
  }

  return { load, available, dir: root };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TOKEN_MODULE = /dtsg|lsd|token|csrf|session/i;

/**
 * Remove the capturing account from a saved page.
 *
 * identity: { userId, username, fullName? }. Returns { html, report }. Throws if
 * any identity string survives, so a template that still names its source
 * account is never written.
 */
function scrubTemplate(html, identity) {
  const userId = String(identity.userId || '');
  const username = String(identity.username || '');
  const fullName = identity.fullName ? String(identity.fullName) : '';
  if (!/^\d{3,}$/.test(userId) || !/^[A-Za-z0-9._]{1,30}$/.test(username)) {
    throw new Error('scrubTemplate needs the capturing account\'s numeric userId and username');
  }
  const report = { prefetchesRemoved: 0, tokensReplaced: 0, identityReplaced: 0 };

  const swaps = [
    [new RegExp(`(?<![0-9])${escapeRegExp(userId)}(?![0-9])`, 'g'), '__CLONE_VIEWER_PK__'],
    [new RegExp(`(?<![A-Za-z0-9._])${escapeRegExp(username)}(?![A-Za-z0-9._])`, 'gi'), '__CLONE_VIEWER_USERNAME__'],
  ];
  if (fullName.length >= 2) {
    const variants = new Set([
      fullName,
      JSON.stringify(fullName).slice(1, -1),
      fullName.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`),
      fullName.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
    ]);
    for (const variant of variants) swaps.push([new RegExp(escapeRegExp(variant), 'gi'), '__CLONE_VIEWER_FULL_NAME__']);
  }
  const swap = (text) => {
    let out = text;
    for (const [re, marker] of swaps) {
      out = out.replace(re, () => {
        report.identityReplaced += 1;
        return marker;
      });
    }
    return out;
  };

  // Structural pass: decoded JSON leaves, so no escaping variant can hide a value.
  const { html: structural } = editJsonBlocks(html, (node) => {
    if (typeof node === 'string') {
      if (looksLikeJson(node)) return undefined;
      const swapped = swap(node);
      return swapped === node ? undefined : swapped;
    }
    if (prefetchKey(node)) {
      report.prefetchesRemoved += 1;
      return REMOVE;
    }
    if (isDefineTuple(node) && TOKEN_MODULE.test(node[0])) {
      for (const key of Object.keys(node[2])) {
        if (typeof node[2][key] === 'string' && /token|dtsg|secret/i.test(key)) {
          node[2][key] = '__CLONE_CSRF__';
          report.tokensReplaced += 1;
        }
      }
      return undefined;
    }
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const key of ['csrf_token', 'fb_dtsg', 'dtsg', 'lsd']) {
        if (typeof node[key] === 'string') {
          node[key] = '__CLONE_CSRF__';
          report.tokensReplaced += 1;
        }
      }
      if (typeof node.username === 'string' && node.username.toLowerCase() === username.toLowerCase()) {
        for (const key of Object.keys(node)) {
          if (/profile_pic/.test(key) && typeof node[key] === 'string') node[key] = '__CLONE_VIEWER_PROFILE_PIC__';
        }
      }
    }
    return undefined;
  });

  // Markup pass: everything outside the JSON blocks.
  const out = swap(structural);

  // Residual check over both the raw text and every decoded JSON leaf.
  const hit = (text) =>
    swaps.some(([re]) => {
      re.lastIndex = 0;
      return re.test(text);
    });
  let residual = hit(out);
  editJsonBlocks(out, (node) => {
    if (typeof node === 'string' && !looksLikeJson(node) && hit(node)) residual = true;
    return undefined;
  });
  if (residual) throw new Error('identity still present after scrubbing; template not written');
  return { html: out, report };
}

module.exports = { routeKind, createTemplateStore, scrubTemplate, RESERVED_FIRST_SEGMENTS };
