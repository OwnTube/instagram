'use strict';

/**
 * Reserved first path segments (never usernames), from the page registry
 * (src/pages/registry.js), which now decides which page a path is.
 *
 * (This module once also stored signed-in "templates": pages saved from an
 * operator's own signed-in browser. They were documents outside the pinned
 * snapshot, with no revision or hash, so they were removed: every document
 * the server sends now comes from the active snapshot.)
 */

const { RESERVED_FIRST_SEGMENTS } = require('../pages/registry');

module.exports = { RESERVED_FIRST_SEGMENTS };
