'use strict';

/**
 * Headless-browser verification of a single page, using Chromium over the
 * DevTools Protocol.
 *
 *   node scripts/browser-check.js [url]
 *
 * Loads the proxied page in real Chromium, records every network request and
 * its outcome, and reports console output, uncaught exceptions and failed
 * loads. This distinguishes "the document was fetched" from "the application
 * works", which are different claims.
 */

const fs = require('node:fs');
const path = require('node:path');
const { launchChromium, openSession, navigate, probeDom, captureScreenshot } = require('./lib/browser');

const targetUrl = process.argv[2] || `http://localhost:${process.env.PORT || 12000}/`;
const profileDir = path.join(__dirname, '..', '.scratch', 'chrome-profile');
const NAV_SETTLE_MS = Number(process.env.NAV_SETTLE_MS || 8000);

(async () => {
  const { child, browserWsUrl } = await launchChromium(profileDir);
  let exitCode = 0;

  try {
    const session = await openSession(browserWsUrl);
    await navigate(session, targetUrl, NAV_SETTLE_MS);
    const domInfo = await probeDom(session);
    const screenshotPath = await captureScreenshot(session, path.join(__dirname, '..', '.scratch', 'screenshot.png'));
    session.ws.close();

    const list = [...session.requests.values()];
    const failed = list.filter((r) => r.failed || (r.status !== null && r.status >= 400));

    console.log('\n=== Browser navigation ===');
    console.log(`  target: ${targetUrl}`);
    console.log(`  final : ${domInfo.location || '(unknown)'}`);

    console.log('\n=== DOM after load ===');
    console.log(`  title             : ${domInfo.title}`);
    console.log(`  html length       : ${domInfo.htmlLength}`);
    console.log(`  script tags       : ${domInfo.scripts}`);
    console.log(`  inline script bytes: ${domInfo.inlineScriptBytes}`);
    console.log(`  stylesheets       : ${domInfo.stylesheets}`);
    console.log(`  body children     : ${domInfo.bodyChildren}`);
    console.log(`  react mount roots : ${domInfo.reactRoots}`);
    console.log(`  requireLazy()     : ${domInfo.hasRequireLazy}`);
    console.log(`  Polaris/comet refs: ${domInfo.hasPolaris}`);
    console.log(`  anti-bot challenge: ${domInfo.isChallenge}`);
    console.log(`  og:title          : ${domInfo.metaOgTitle}`);
    console.log(`  mount root html   : ${domInfo.mountRootInnerHtml} bytes`);
    console.log(`  forms / inputs    : ${domInfo.forms} forms, ${domInfo.usernameInputs} username, ${domInfo.passwordInputs} password`);
    console.log(`  buttons / anchors : ${domInfo.buttons} buttons, ${domInfo.anchors} anchors, ${domInfo.svgCount} svg`);
    console.log(`  visible text      : ${JSON.stringify(domInfo.visibleText)}`);
    console.log(`  screenshot        : ${screenshotPath || '(not captured)'}`);

    console.log('\n=== Network requests ===');
    const byOrigin = {};
    for (const r of list) {
      let origin = '(other)';
      try {
        origin = new URL(r.url).origin;
      } catch {
        /* data: or similar */
      }
      byOrigin[origin] = byOrigin[origin] || { count: 0, failed: 0 };
      byOrigin[origin].count += 1;
      if (r.failed || (r.status !== null && r.status >= 400)) byOrigin[origin].failed += 1;
    }
    console.log(`  total requests: ${list.length}`);
    for (const [origin, stats] of Object.entries(byOrigin).sort((a, b) => b[1].count - a[1].count)) {
      console.log(`    ${String(stats.count).padStart(3)} (failed ${stats.failed})  ${origin}`);
    }

    console.log('\n=== Failed requests ===');
    if (!failed.length) console.log('  none');
    for (const r of failed) console.log(`  ${r.status ?? 'ERR'} ${r.failed || ''} ${r.url.slice(0, 110)}`);

    console.log('\n=== Console messages ===');
    if (!session.consoleMessages.length) console.log('  none');
    for (const m of session.consoleMessages.slice(0, 40)) console.log(`  [${m.level}] ${m.text}`);

    console.log('\n=== Uncaught exceptions ===');
    if (!session.exceptions.length) console.log('  none');
    for (const e of session.exceptions.slice(0, 20)) console.log(`  ${e.url || ''} ${String(e.text).split('\n')[0]}`);

    const severeLogs = session.logEntries.filter((l) => l.level === 'error');
    console.log('\n=== Browser log errors ===');
    if (!severeLogs.length) console.log('  none');
    for (const l of severeLogs.slice(0, 30)) console.log(`  ${l.text.slice(0, 200)}`);

    console.log(`\n=== RESULT: ${list.length - failed.length}/${list.length} requests OK, ${failed.length} failed ===`);
    if (failed.length) exitCode = 1;
  } catch (error) {
    console.error(`browser check failed: ${error.message}`);
    exitCode = 2;
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(profileDir, { recursive: true, force: true });
  }

  process.exit(exitCode);
})();
