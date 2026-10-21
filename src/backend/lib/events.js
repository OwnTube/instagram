'use strict';

/**
 * In-process change events, emitted after a write commits, so listeners (the
 * realtime endpoint, src/realtime/) can tell connected browsers. Each event
 * carries the database it was written to; a listener ignores other databases.
 *
 *   'message' { db, conversationId, messageId, senderId }
 *   'seen'    { db, conversationId, userId }
 */

const { EventEmitter } = require('node:events');

const events = new EventEmitter();
events.setMaxListeners(0);

module.exports = events;
