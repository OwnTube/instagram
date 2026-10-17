'use strict';

/**
 * Strict offline for the genuine-client checks. The server serves the active snapshot and must not contact
 * Instagram at all; the upstream guard records and fails any attempt, and the
 * checks assert it saw none.
 * Call before src/server.js is required.
 */

const { installUpstreamGuard } = require('./upstream-guard');

function strictOffline() {
  return installUpstreamGuard();
}

module.exports = { strictOffline };
