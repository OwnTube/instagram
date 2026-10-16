'use strict';
// Open a genuine page through the loader and run REA against it:
//   node scripts/rea-live.js <outPrefix> [path] [inspect|exec]
// REA_BIN overrides the REA executable (default ~/rea-cli/node_modules/.bin/rea).
const fs = require('node:fs'), path = require('node:path');
const { execFile } = require('node:child_process');
const REPO = path.join(__dirname, '..');
const REA = process.env.REA_BIN || require('node:path').join(require('node:os').homedir(), 'rea-cli/node_modules/.bin/rea');
const out = process.argv[2], pagePath = process.argv[3] || '/', cmds = (process.argv[4] || 'inspect').split(',');
const dir = path.join(REPO, '.scratch', 'rea-live');
fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
Object.assign(process.env, { BACKEND_DB: path.join(dir, 'db.sqlite'), CLONE_DATA_DIR: dir, VERBOSE: '0', BACKEND_VERBOSE: '0' });
const b = require(path.join(REPO, 'scripts/lib/browser.js'));
const { app } = require(path.join(REPO, 'src/server.js'));
const run = (args) => new Promise((res) => execFile(REA, args, { maxBuffer: 1 << 30, timeout: 300000 }, (e, so, se) => res({ code: e ? e.code : 0, stdout: so, stderr: se.slice(-2000) })));
(async () => {
  const server = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { child, browserWsUrl } = await b.launchChromium(path.join(dir, 'profile'));
  const http = browserWsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '');
  try {
    const targets = await (await fetch(http + '/json/list')).json();
    const page = targets.find((t) => t.type === 'page');
    if (cmds.includes('exec')) {
      // Start precise coverage before navigation so boot is covered.
      const p = run(['observe-web-execution', http, page.id, '--observation-ms', '15000', '--format', 'json']);
      await new Promise((r) => setTimeout(r, 1500));
      await fetch(`${http}/json/activate/${page.id}`);
      const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => ws.onopen = r);
      ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: base + pagePath } }));
      const r = await p; ws.close();
      fs.writeFileSync(out + '.exec.json', r.stdout); console.log('exec', r.code, r.stderr.slice(-300));
    } else {
      const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => ws.onopen = r);
      ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: base + pagePath } }));
      await new Promise((r) => setTimeout(r, 12000)); ws.close();
      const r = await run(['inspect-web-page', http, page.id, '--observation-ms', '1500', '--include-console-text', '--format', 'json']);
      fs.writeFileSync(out + '.inspect.json', r.stdout); console.log('inspect', r.code, r.stderr.slice(-300));
    }
  } finally { child.kill('SIGKILL'); server.close(); process.exit(0); }
})();
