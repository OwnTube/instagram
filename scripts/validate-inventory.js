'use strict';

/**
 * Local-only inventory validation. Makes no network requests.
 *
 *   node scripts/validate-inventory.js
 *
 * Checks:
 *   - the route registry has no duplicate paths
 *   - the pattern registry has no duplicate patterns
 *   - every pattern with a claimed example has exampleSource set (an example is
 *     never asserted without recording where it came from)
 *   - the saved inventory's category counts equal its row count
 *   - the saved inventory's outcome counts equal its row count
 *   - every route in the registry appears in the saved inventory and vice versa
 *   - the README's stated totals match the inventory
 *   - the README's per-section table row counts match their headings
 *
 * Exit code is non-zero if any check fails.
 */

const fs = require('node:fs');
const path = require('node:path');
const { routes, patterns } = require('./lib/routes');

const ROOT = path.join(__dirname, '..');
const INVENTORY = path.join(ROOT, '.scratch', 'route-inventory.json');
const README = path.join(ROOT, 'README.md');

const failures = [];
const notes = [];
function check(ok, message) {
  if (ok) notes.push(`  ok   ${message}`);
  else failures.push(`  FAIL ${message}`);
}

// ---- registry checks --------------------------------------------------------
const routePaths = routes.map((r) => r.path);
check(new Set(routePaths).size === routePaths.length, `route registry has no duplicate paths (${routePaths.length} routes)`);

const patternKeys = patterns.map((p) => p.pattern);
check(new Set(patternKeys).size === patternKeys.length, `pattern registry has no duplicate patterns (${patternKeys.length} patterns)`);

const badExample = patterns.filter((p) => p.example && !p.exampleSource);
check(badExample.length === 0, `every tested pattern records its example source${badExample.length ? ` (missing: ${badExample.map((p) => p.pattern).join(', ')})` : ''}`);

const untested = patterns.filter((p) => !p.example);
check(untested.every((p) => p.blocker), `every untested pattern records a blocker (${untested.length} untested)`);

const noKnownFrom = patterns.filter((p) => !p.knownFrom);
check(noKnownFrom.length === 0, `every pattern records how it is known`);

const badShape = patterns.filter((p) => typeof p.requested !== 'boolean' || typeof p.interactions !== 'boolean');
check(badShape.length === 0, `every pattern records requested/interactions flags`);

// A pattern claiming a delivered example must also record a delivery date.
const missingDate = patterns.filter((p) => p.example && !p.evidenceDate);
check(missingDate.length === 0, `every tested pattern records an evidence date`);

// ---- inventory checks -------------------------------------------------------
if (!fs.existsSync(INVENTORY)) {
  failures.push('  FAIL saved inventory exists (.scratch/route-inventory.json)');
} else {
  const data = JSON.parse(fs.readFileSync(INVENTORY, 'utf8'));
  const rows = data.rows;

  const byCategory = {};
  const byOutcome = {};
  for (const r of rows) {
    byCategory[r.category] = (byCategory[r.category] || 0) + 1;
    byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;
  }
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  check(sum(byCategory) === rows.length, `category counts sum to row count (${sum(byCategory)} == ${rows.length})`);
  check(sum(byOutcome) === rows.length, `outcome counts sum to row count (${sum(byOutcome)} == ${rows.length})`);

  const invPaths = new Set(rows.map((r) => r.path));
  const missing = routePaths.filter((p) => !invPaths.has(p));
  const extra = [...invPaths].filter((p) => !routePaths.includes(p));
  check(missing.length === 0, `every registry route is in the inventory${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
  check(extra.length === 0, `inventory has no routes absent from the registry${extra.length ? ` (extra: ${extra.join(', ')})` : ''}`);

  const dupRows = rows.map((r) => r.path).filter((p, i, a) => a.indexOf(p) !== i);
  check(dupRows.length === 0, `inventory has no duplicate rows${dupRows.length ? ` (${dupRows.join(', ')})` : ''}`);

  // Carried-forward rows cannot know delivered bytes; they must not claim a number.
  const carriedWithBytes = rows.filter((r) => r.carriedForward && r.documentDelivery?.bytes != null);
  check(carriedWithBytes.length === 0, `carried-forward rows do not claim delivered bytes`);

  // User-verified routes must never be recorded as broken.
  const downgraded = rows.filter((r) => r.userVerified && ['unavailable', 'untested'].includes(r.outcome));
  check(downgraded.length === 0, `user-verified routes are not recorded as broken${downgraded.length ? ` (${downgraded.map((r) => r.path).join(', ')})` : ''}`);

  // ---- README consistency ---------------------------------------------------
  const readme = fs.readFileSync(README, 'utf8');
  const lines = readme.split('\n');
  const tableRowsAfter = (heading) => {
    const i = lines.findIndex((l) => l.trim() === heading);
    if (i === -1) return -1;
    let n = 0;
    for (const l of lines.slice(i + 1)) {
      const s = l.trim();
      if (s.startsWith('|')) {
        if (/^\|[\s\-|]+\|$/.test(s)) continue;
        if (/^\|\s*(Route|Pattern)\s*\|/.test(s)) continue;
        n += 1;
      } else if (s === '' && n) break;
    }
    return n;
  };

  const headingFor = (label, n) => `### ${label} (${n})`;
  const workingN = byOutcome.working || 0;
  const inconclusiveN = byOutcome.inconclusive || 0;
  const authN = byOutcome['auth-required'] || 0;

  const wRows = tableRowsAfter(headingFor('Verified working', `${workingN} automated`));
  check(wRows === workingN, `README working table rows match count (${wRows} == ${workingN})`);

  const iRows = tableRowsAfter(`### Inconclusive — throttled, NOT broken (${inconclusiveN})`);
  check(iRows === inconclusiveN, `README inconclusive table rows match count (${iRows} == ${inconclusiveN})`);

  const aRows = tableRowsAfter(`### Authentication-required (${authN})`);
  check(aRows === authN, `README auth-required table rows match count (${aRows} == ${authN})`);

  check(readme.includes(`| **total** | **${rows.length}** |`), `README states the correct total (${rows.length})`);

  console.log('\n=== Inventory validation (local only, no network) ===');
  console.log(`  inventory: ${rows.length} rows, generatedAt ${data.generatedAt}`);
  console.log(`  outcomes : ${JSON.stringify(byOutcome)}`);
  console.log(`  categories: ${JSON.stringify(byCategory)}`);
  console.log(`  patterns : ${patterns.length} (${patterns.length - untested.length} tested, ${untested.length} untested)`);
  console.log('');
  for (const n of notes) console.log(n);
}

if (failures.length) {
  console.log('');
  for (const f of failures) console.log(f);
  console.log(`\n=== RESULT: ${failures.length} check(s) FAILED ===`);
  process.exit(1);
}
console.log('\n=== RESULT: all checks passed ===');
