'use strict';

/**
 * Shared headless-Chromium driver over the DevTools Protocol.
 *
 * Extracted so the single-page check and the page sweep use one implementation.
 * Chromium is driven directly with Node's built-in WebSocket; no dependency.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CHROMIUM_BIN = process.env.CHROMIUM_BIN || 'chromium';

function launchChromium(profileDir) {
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const child = spawn(
      CHROMIUM_BIN,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stderr = '';
    const timer = setTimeout(() => reject(new Error('chromium did not report a DevTools endpoint in time')), 20000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ child, browserWsUrl: match[1] });
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      if (!stderr.includes('DevTools listening')) {
        clearTimeout(timer);
        reject(new Error(`chromium exited early (code ${code})`));
      }
    });
  });
}

/** Minimal CDP client bound to one target. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const handler of this.handlers) handler(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(handler) {
    this.handlers.push(handler);
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', (event) => reject(new Error(`websocket error: ${event.message || 'unknown'}`)));
  });
}

async function openPage(browserWsUrl) {
  const httpBase = browserWsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '');
  const res = await fetch(`${httpBase}/json/new?about:blank`, { method: 'PUT' });
  const target = await res.json();
  return target.webSocketDebuggerUrl;
}

/**
 * Open a page target, attach, and return a session object that collects
 * network activity, console output and exceptions.
 */
async function openSession(browserWsUrl) {
  const pageWsUrl = await openPage(browserWsUrl);
  const ws = await connect(pageWsUrl);
  const cdp = new Cdp(ws);

  const session = {
    cdp,
    ws,
    requests: new Map(),
    consoleMessages: [],
    exceptions: [],
    logEntries: [],
  };

  cdp.on((msg) => {
    switch (msg.method) {
      case 'Network.requestWillBeSent':
        session.requests.set(msg.params.requestId, {
          url: msg.params.request.url,
          type: msg.params.type,
          method: msg.params.request.method,
          postData: msg.params.request.postData,
          status: null,
          failed: null,
          fromCache: false,
        });
        break;
      case 'Network.responseReceived': {
        const entry = session.requests.get(msg.params.requestId);
        if (entry) {
          entry.status = msg.params.response.status;
          entry.mimeType = msg.params.response.mimeType;
          entry.fromCache = Boolean(msg.params.response.fromDiskCache);
          const len = msg.params.response.headers?.['content-length'] ?? msg.params.response.headers?.['Content-Length'];
          if (len) entry.contentLength = Number(len);
        }
        break;
      }
      case 'Network.loadingFinished': {
        const entry = session.requests.get(msg.params.requestId);
        // Bytes actually transferred on the wire for this response.
        if (entry && typeof msg.params.encodedDataLength === 'number') {
          entry.encodedDataLength = msg.params.encodedDataLength;
        }
        break;
      }
      case 'Network.loadingFailed': {
        const entry = session.requests.get(msg.params.requestId);
        if (entry) entry.failed = msg.params.errorText + (msg.params.blockedReason ? ` (blocked: ${msg.params.blockedReason})` : '');
        break;
      }
      case 'Runtime.consoleAPICalled':
        session.consoleMessages.push({
          level: msg.params.type,
          text: (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 300),
        });
        break;
      case 'Runtime.exceptionThrown':
        session.exceptions.push({
          text: msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'unknown',
          url: msg.params.exceptionDetails?.url,
        });
        break;
      case 'Log.entryAdded':
        session.logEntries.push({ level: msg.params.entry.level, text: msg.params.entry.text, url: msg.params.entry.url });
        break;
      default:
        break;
    }
  });

  await cdp.send('Network.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');

  return session;
}

/** Navigate and wait for the page to settle. */
async function navigate(session, url, settleMs) {
  await session.cdp.send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, settleMs));
}

/** Evaluate the DOM-probe expression and return its parsed result. */
async function probeDom(session) {
  const expression = `(() => {
    const safe = (fn, fallback = null) => { try { return fn(); } catch (e) { return fallback; } };
    return JSON.stringify({
      title: document.title,
      htmlLength: document.documentElement.outerHTML.length,
      scripts: document.scripts.length,
      stylesheets: document.styleSheets.length,
      bodyChildren: document.body ? document.body.children.length : 0,
      location: location.href,
      reactRoots: document.querySelectorAll('[id^="mount_"]').length,
      hasRequireLazy: typeof window.requireLazy === 'function',
      hasPolaris: /Polaris|__comet/i.test(document.documentElement.outerHTML.slice(0, 400000)),
      metaOgTitle: safe(() => document.querySelector('meta[property="og:title"]').content),
      linkedStylesheets: [...document.styleSheets].filter(s => s.href).length,
      inlineScriptBytes: [...document.scripts].reduce((n, s) => n + (s.src ? 0 : s.textContent.length), 0),
      mountRootInnerHtml: safe(() => document.querySelector('[id^="mount_"]').innerHTML.length, 0),
      visibleText: safe(() => document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 400)),
      usernameInputs: document.querySelectorAll('input[name="username"]').length,
      passwordInputs: document.querySelectorAll('input[name="password"]').length,
      forms: document.forms.length,
      buttons: document.querySelectorAll('[role="button"], button').length,
      anchors: document.querySelectorAll('a[href]').length,
      svgCount: document.querySelectorAll('svg').length,
      isChallenge: /__rd_verify_/.test(document.documentElement.outerHTML)
    });
  })()`;
  const result = await session.cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  return JSON.parse(result.result.value);
}

async function captureScreenshot(session, filePath) {
  try {
    const shot = await session.cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(shot.data, 'base64'));
    return filePath;
  } catch {
    return null;
  }
}

module.exports = { launchChromium, openSession, navigate, probeDom, captureScreenshot, Cdp };
