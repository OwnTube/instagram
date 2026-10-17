'use strict';

/**
 * Route kinds of the client's URL space: which app screen a path is.
 *
 * (This module once also stored signed-in "templates": pages saved from an
 * operator's own signed-in browser. They were documents outside the pinned
 * snapshot, with no revision or hash, so they were removed: every document
 * the server sends now comes from the active snapshot.)
 */

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

module.exports = { routeKind, RESERVED_FIRST_SEGMENTS };
