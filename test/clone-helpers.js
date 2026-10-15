'use strict';

/**
 * Harness for the compatibility layer: the full server (loader + backend +
 * clone) against a stand-in upstream origin that records everything it
 * receives, plus a browser-like client that keeps cookies and sends requests
 * the way the original Instagram client does (form-encoded, X-CSRFToken from
 * the csrftoken cookie, enc_password encrypted to the advertised key).
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { encryptLikeClient } = require('../src/clone/passwordEncryption');

const SRC = path.join(__dirname, '..', 'src');
const TEST_ROOT = path.join(__dirname, '..', '.scratch', 'test');

function clearSrcCache() {
  for (const key of Object.keys(require.cache)) if (key.startsWith(SRC)) delete require.cache[key];
}

async function startFakeOrigin() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, cookie: req.headers.cookie || null, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'sessionid=UPSTREAM; Path=/' });
      res.end('<!doctype html><html><head></head><body>upstream document</body></html>');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, received, close: () => new Promise((r) => server.close(r)) };
}

/**
 * Start the whole server. Pass `dir` to reuse a data directory (a restart);
 * `keepDir` leaves it on close so a second server can open it.
 */
async function startCloneServer(extraEnv = {}, { dir: reuseDir, keepDir = false } = {}) {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const dir = reuseDir || fs.mkdtempSync(path.join(TEST_ROOT, 'clone-'));
  const fake = await startFakeOrigin();
  const env = {
    UPSTREAM_ORIGIN: fake.origin,
    BACKEND_DB: path.join(dir, 'db.sqlite'),
    CLONE_DATA_DIR: dir,
    MAX_RETRIES: '0',
    VERBOSE: '0',
    BACKEND_VERBOSE: '0',
    RATE_LIMIT_MAX: '100000',
    AUTH_RATE_LIMIT_MAX: '100000',
    CLONE_MAIL_TRANSPORT: 'log',
    ...extraEnv,
  };
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  clearSrcCache();
  const mail = [];
  const logs = [];
  const realLog = console.log;
  console.log = (...args) => {
    const line = args.join(' ');
    logs.push(line);
    const m = line.match(/signup confirmation code for (\S+): (\d{6})/);
    if (m) mail.push({ email: m[1], code: m[2] });
    else if (!/^\[(loader|backend)\]/.test(line)) realLog(...args);
  };
  const { app } = require('../src/server');
  for (const [k] of Object.entries(env)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    upstream: fake.received,
    mail,
    logs,
    dir,
    dbFile: env.BACKEND_DB,
    /** A second connection to the server's database, for checking stored state. */
    openDb() {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(env.BACKEND_DB);
      db.exec('PRAGMA busy_timeout = 5000');
      return db;
    },
    async close() {
      console.log = realLog;
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await fake.close();
      if (!keepDir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A browser: a cookie jar, and requests shaped like the original client's. */
class Browser {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
  }

  cookie(name) {
    return this.jar.get(name);
  }

  absorb(res) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = decodeURIComponent(pair.slice(eq + 1).trim());
      if (attrs.some((a) => /max-age=0/i.test(a)) || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header() {
    return [...this.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  }

  async request(method, p, { form, json, raw, headers = {}, csrf = true } = {}) {
    const h = { 'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest', ...headers };
    if (this.jar.size) h.cookie = this.header();
    if (csrf && method !== 'GET' && this.cookie('csrftoken')) h['x-csrftoken'] = this.cookie('csrftoken');
    let body;
    if (form) {
      h['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(Object.entries(form).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])).toString();
    } else if (json) {
      h['content-type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (raw) {
      body = raw;
    }
    const res = await fetch(`${this.base}${p}`, { method, headers: h, body, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    this.absorb(res);
    const text = await res.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: parsed, headers: res.headers, text };
  }

  get(p, opts) {
    return this.request('GET', p, opts);
  }

  post(p, form, opts = {}) {
    return this.request('POST', p, { form, ...opts });
  }

  /** Open a page, as a first visit does, which issues the anonymous csrftoken. */
  async visit(p = '/') {
    return this.get(p, { headers: { accept: 'text/html' } });
  }

  async encryption() {
    return (await this.get('/data/shared_data/')).body.encryption;
  }

  async encPassword(password) {
    const enc = await this.encryption();
    return encryptLikeClient({ keyId: enc.key_id, publicKeyHex: enc.public_key, password, time: Math.floor(Date.now() / 1000) });
  }

  /**
   * Signup through the original form's endpoints: a dry run, then creation.
   * Only a username and password are needed; an email is sent only if given.
   */
  async signup(server, { username, email, password = 'correct horse 42', fullName = '' }) {
    await this.visit();
    const fields = { username, enc_password: await this.encPassword(password), first_name: fullName, opt_into_one_tap: 'false' };
    if (email) fields.email = email;
    const attempt = await this.post('/api/v1/web/accounts/web_create_ajax/attempt/', fields);
    if (!attempt.body.dryrun_passed) throw new Error(`signup attempt failed: ${JSON.stringify(attempt.body)}`);
    const created = await this.post('/api/v1/web/accounts/web_create_ajax/', {
      ...fields,
      enc_password: await this.encPassword(password),
      day: 1,
      month: 1,
      year: 1990,
    });
    if (!created.body.account_created) throw new Error(`signup failed: ${JSON.stringify(created.body)}`);
    return { pk: created.body.user_id, username, password };
  }
}

/** A tiny but structurally valid PNG header with the given dimensions. */
function pngBytes(width = 640, height = 480) {
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

module.exports = { startCloneServer, Browser, pngBytes };
