'use strict';

/**
 * The Node.js version this project needs, checked before anything else loads.
 *
 * The backend's database is node:sqlite (DatabaseSync), built into Node and
 * available without a flag from 22.13.0 (it was added behind
 * --experimental-sqlite in 22.5.0). Older versions fail with an opaque
 * ERR_UNKNOWN_BUILTIN_MODULE deep in the require graph; this says what to do
 * instead. Kept free of newer syntax so it runs, and explains, on old Node.
 */

var MINIMUM = '22.13.0';

function parse(version) {
  return String(version).replace(/^v/, '').split('.').map(function (n) { return parseInt(n, 10) || 0; });
}

function atLeast(version, minimum) {
  var a = parse(version);
  var b = parse(minimum);
  for (var i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

/** null when supported, otherwise the message to print. */
function unsupportedReason(version, hasSqlite) {
  if (!atLeast(version, MINIMUM)) {
    return 'Node.js ' + MINIMUM + ' or newer is required (this is ' + version + '). The backend uses the built-in node:sqlite module. Install a current Node.js LTS (22.13+ or 24) and run the command again.';
  }
  if (!hasSqlite) {
    return 'This Node.js ' + version + ' has no node:sqlite module, which the backend needs. Use an official Node.js build, ' + MINIMUM + ' or newer.';
  }
  return null;
}

function sqliteAvailable() {
  try {
    require('node:sqlite');
    return true;
  } catch (e) {
    return false;
  }
}

/** Exit with a readable message (status 1) when this Node cannot run the server. */
function assertSupportedNode() {
  var reason = unsupportedReason(process.version, atLeast(process.version, MINIMUM) ? sqliteAvailable() : false);
  if (reason) {
    process.stderr.write('[loader] ' + reason + '\n');
    process.exit(1);
  }
}

module.exports = { MINIMUM: MINIMUM, atLeast: atLeast, unsupportedReason: unsupportedReason, assertSupportedNode: assertSupportedNode };
