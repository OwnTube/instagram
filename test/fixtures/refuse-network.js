'use strict';
// Preloaded (node -r) into a child process under test: any attempt to reach a
// non-local host is reported on stderr and fails.
const { installUpstreamGuard } = require('../../scripts/lib/upstream-guard');
const guard = installUpstreamGuard();
process.on('exit', () => {
  if (guard.attempts.length) process.stderr.write(`network attempt: ${guard.attempts.map((a) => a.url).join(', ')}\n`);
});
