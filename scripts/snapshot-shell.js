#!/usr/bin/env node
'use strict';

/**
 * Turn a signed-in page saved from YOUR OWN browser into a clone shell template.
 *
 *   node scripts/snapshot-shell.js --kind home --file ~/Downloads/instagram.html \
 *        --user-id 1234567890 --username yourname [--full-name "Your Name"]
 *
 * How to save the page: open https://www.instagram.com/ signed in, then view
 * the page source (Ctrl+U) and save it, or "Save page as... > Webpage, HTML
 * only". This tool never asks for, reads or stores a cookie or password.
 *
 * The page is scrubbed (src/shell/templates.js scrubTemplate): the account's id,
 * username, name and profile picture become placeholders, its prefetched data
 * and anti-forgery tokens are removed, and the tool refuses to write if any of
 * the identity values survive. Review the output before use; it is written to
 * SHELL_TEMPLATE_DIR (default .cache/shell), which is gitignored.
 *
 * Kinds: home, explore, direct, accounts_edit, activity, post, stories, profile.
 */

const fs = require('node:fs');
const path = require('node:path');
const { scrubTemplate } = require('../src/shell/templates');

const KINDS = new Set(['home', 'explore', 'direct', 'accounts_edit', 'activity', 'post', 'stories', 'profile']);

function args(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (m) {
      out[m[1]] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

function main() {
  const a = args(process.argv);
  if (!a.kind || !KINDS.has(a.kind) || !a.file || !a['user-id'] || !a.username) {
    console.error('usage: snapshot-shell.js --kind <kind> --file <saved.html> --user-id <id> --username <name> [--full-name <name>]');
    process.exit(2);
  }
  const html = fs.readFileSync(a.file, 'utf8');
  const { html: scrubbed, report } = scrubTemplate(html, { userId: a['user-id'], username: a.username, fullName: a['full-name'] });
  const dir = path.resolve(process.env.SHELL_TEMPLATE_DIR || '.cache/shell');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${a.kind}.html`);
  fs.writeFileSync(out, scrubbed, { mode: 0o600 });
  console.log(`wrote ${out}`);
  console.log(`  prefetches removed: ${report.prefetchesRemoved}`);
  console.log(`  tokens replaced:    ${report.tokensReplaced}`);
  console.log(`  identity replaced:  ${report.identityReplaced}`);
  console.log('Review the file before serving it. Delete the saved original if you no longer need it.');
}

main();
