'use strict';

/**
 * The packaged client as ONE downloadable file (the "client artifact"), for a
 * fresh checkout that has client/bundle.json and the manifest (committed) but
 * not client/blobs/ (Meta's bodies, kept out of git).
 *
 * Format (gzip of):
 *   line 1   {"format":"igrl-client-artifact","version":1,"snapshot",...} + "\n"
 *   then, for the manifest and every blob, sorted by sha256:
 *            "<kind> <sha256> <bytes>\n" followed by exactly <bytes> bytes
 *            (kind: "manifest" once, first; then "blob")
 * Built deterministically (sorted, fixed gzip level, no timestamps), so the
 * same bundle always packs to the same bytes and the same sha256.
 *
 * Pinning: client/bundle.json records the artifact's file name, byte length
 * and sha256 (`artifact`), and where it is published (`artifact.urls`). A
 * download is accepted only when the whole file hashes to that sha256 AND
 * every record inside hashes to its name AND the set of blobs is exactly the
 * manifest's. Nothing is installed until all of that holds; the install is a
 * rename of a fully verified staging directory.
 *
 * The downloader contacts only the artifact URL it is given (and the
 * redirects that host answers with); Instagram/Meta hosts are refused, so
 * setup can never quietly become an acquisition.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');

const FORMAT = 'igrl-client-artifact';
const VERSION = 1;
const HEX64 = /^[0-9a-f]{64}$/;
// Setup must never turn into contacting Instagram or Meta.
const REFUSED_HOSTS = /(^|\.)(instagram\.com|cdninstagram\.com|fbcdn\.net|facebook\.com|fbsbx\.com|meta\.com)$/i;

class ArtifactError extends Error {}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function artifactName(descriptor) {
  return `client-${descriptor.snapshot}.igrl.gz`;
}

/**
 * Pack a valid bundle directory (its manifest and the blobs it references)
 * into one artifact file. Returns { file, name, sha256, bytes }.
 */
async function packArtifact({ bundleDir, descriptor, manifestRaw, blobs, outFile }) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmp = `${outFile}.${process.pid}.tmp`;
  const header = { format: FORMAT, version: VERSION, snapshot: descriptor.snapshot, revision: descriptor.revision, manifestSha256: descriptor.manifestSha256, blobs: descriptor.blobs, bytes: descriptor.bytes, contentsSha256: descriptor.contentsSha256 };
  const hashes = [...blobs.keys()].sort();
  async function* records() {
    yield Buffer.from(`${JSON.stringify(header)}\n`);
    yield Buffer.from(`manifest ${descriptor.manifestSha256} ${manifestRaw.length}\n`);
    yield manifestRaw;
    for (const hash of hashes) {
      const body = fs.readFileSync(path.join(bundleDir, 'blobs', hash.slice(0, 2), hash));
      if (sha256(body) !== hash) throw new ArtifactError(`blob ${hash.slice(0, 12)} in ${bundleDir} does not hash to its name`);
      yield Buffer.from(`blob ${hash} ${body.length}\n`);
      yield body;
    }
  }
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const gzip = zlib.createGzip({ level: 9 });
  gzip.on('data', (chunk) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  await pipeline(records, gzip, fs.createWriteStream(tmp));
  fs.renameSync(tmp, outFile);
  return { file: outFile, name: path.basename(outFile), sha256: hash.digest('hex'), bytes };
}

/** The artifact pin from bundle.json, validated. */
function artifactPin(descriptor) {
  const a = descriptor.artifact;
  if (!a || typeof a !== 'object') return null;
  if (!HEX64.test(String(a.sha256)) || !Number.isSafeInteger(a.bytes) || a.bytes <= 0 || typeof a.name !== 'string') {
    throw new ArtifactError('client/bundle.json: artifact entry is malformed (needs name, bytes, sha256)');
  }
  return { name: a.name, sha256: a.sha256, bytes: a.bytes, urls: Array.isArray(a.urls) ? a.urls.filter((u) => typeof u === 'string' && u) : [] };
}

function checkUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new ArtifactError(`not a URL: ${url}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ArtifactError(`unsupported artifact URL scheme ${u.protocol}`);
  if (REFUSED_HOSTS.test(u.hostname)) throw new ArtifactError(`refusing to download the client from ${u.hostname}: setup never contacts Instagram or Meta; acquisition is npm run client:acquire`);
  return u;
}

/**
 * Get the artifact into `dest` (a staging path), from a local file or a URL,
 * hashing as it arrives. Rejects (and removes the partial file) unless the
 * length and sha256 equal the pin. Returns { source, hosts }.
 */
async function fetchArtifact(source, pin, dest, { fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const hosts = [];
  const meter = async function* (chunks) {
    for await (const chunk of chunks) {
      bytes += chunk.length;
      if (bytes > pin.bytes) throw new ArtifactError(`artifact is larger than the pinned ${pin.bytes} bytes`);
      hash.update(chunk);
      yield chunk;
    }
  };
  try {
    if (/^https?:\/\//i.test(source)) {
      const url = checkUrl(source);
      hosts.push(url.hostname);
      log(`downloading ${pin.name} (${pin.bytes} bytes) from ${url.host}`);
      const res = await fetchImpl(url.href, { redirect: 'follow' });
      if (res.url) {
        const final = checkUrl(res.url);
        if (!hosts.includes(final.hostname)) hosts.push(final.hostname);
      }
      if (!res.ok || !res.body) throw new ArtifactError(`download failed: HTTP ${res.status} from ${url.host} (is the artifact published at ${url.href}?)`);
      await pipeline(res.body, meter, fs.createWriteStream(dest));
    } else {
      const file = path.resolve(source);
      if (!fs.existsSync(file)) throw new ArtifactError(`artifact file not found: ${file}`);
      log(`reading ${file}`);
      await pipeline(fs.createReadStream(file), meter, fs.createWriteStream(dest));
    }
    const digest = hash.digest('hex');
    if (bytes !== pin.bytes) throw new ArtifactError(`artifact is ${bytes} bytes, pinned ${pin.bytes}: truncated or a different file`);
    if (digest !== pin.sha256) throw new ArtifactError(`artifact sha256 ${digest.slice(0, 16)}… does not match the pinned ${pin.sha256.slice(0, 16)}…: corrupt or a different client`);
    return { source, hosts };
  } catch (error) {
    fs.rmSync(dest, { force: true });
    throw error instanceof ArtifactError ? error : new ArtifactError(`could not get the artifact from ${source}: ${error.message}`);
  }
}

/** Lines and exact byte runs from an async byte stream. */
function makeReader(stream) {
  const it = stream[Symbol.asyncIterator]();
  let buf = Buffer.alloc(0);
  let done = false;
  async function fill(n) {
    if (buf.length >= n || done) return;
    const parts = [buf];
    let len = buf.length;
    while (len < n) {
      const r = await it.next();
      if (r.done) {
        done = true;
        break;
      }
      parts.push(r.value);
      len += r.value.length;
    }
    buf = Buffer.concat(parts, len);
  }
  return {
    /** The next "\n"-terminated line, or null at a clean end of stream. */
    async line(max = 4096) {
      for (;;) {
        const i = buf.indexOf(10);
        if (i >= 0) {
          const out = buf.subarray(0, i).toString('utf8');
          buf = buf.subarray(i + 1);
          return out;
        }
        if (buf.length > max) throw new ArtifactError('artifact record header is malformed');
        if (done) {
          if (buf.length) throw new ArtifactError('artifact ends inside a record header');
          return null;
        }
        await fill(buf.length + 1);
      }
    },
    async bytes(n) {
      await fill(n);
      if (buf.length < n) throw new ArtifactError('artifact ends inside a record');
      const out = Buffer.from(buf.subarray(0, n));
      buf = buf.subarray(n);
      return out;
    },
  };
}

/**
 * Unpack a downloaded (already sha256-checked) artifact into stagingDir as a
 * bundle layout (snapshots/<id>/manifest.json, blobs/<aa>/<sha256>), checking
 * every record against the committed descriptor and manifest.
 */
async function unpackArtifact(file, stagingDir, descriptor, opts) {
  try {
    return await unpackRecords(file, stagingDir, descriptor, opts);
  } catch (error) {
    throw error instanceof ArtifactError ? error : new ArtifactError(`artifact is not a readable client artifact (${error.message})`);
  }
}

async function unpackRecords(file, stagingDir, descriptor, { manifestRaw, referenced }) {
  const reader = makeReader(fs.createReadStream(file).pipe(zlib.createGunzip()));
  let header;
  try {
    header = JSON.parse(await reader.line());
  } catch (error) {
    throw error instanceof SyntaxError ? new ArtifactError('artifact header is not JSON') : error;
  }
  if (header.format !== FORMAT || header.version !== VERSION) throw new ArtifactError(`not a client artifact (format ${header.format} v${header.version})`);
  for (const key of ['snapshot', 'revision', 'manifestSha256', 'blobs', 'bytes', 'contentsSha256']) {
    if (String(header[key]) !== String(descriptor[key])) throw new ArtifactError(`artifact is for ${key} ${header[key]}, bundle.json pins ${descriptor[key]}`);
  }
  const seen = new Set();
  let sawManifest = false;
  for (;;) {
    const line = await reader.line();
    if (line == null) break;
    const m = /^(manifest|blob) ([0-9a-f]{64}) (\d{1,12})$/.exec(line);
    if (!m) throw new ArtifactError('artifact record header is malformed');
    const [, kind, hash, size] = m;
    const body = await reader.bytes(Number(size));
    if (sha256(body) !== hash) throw new ArtifactError(`artifact record ${hash.slice(0, 12)} does not hash to its name`);
    if (kind === 'manifest') {
      if (sawManifest || hash !== descriptor.manifestSha256 || !body.equals(manifestRaw)) throw new ArtifactError('artifact manifest is not the committed manifest');
      sawManifest = true;
      continue;
    }
    if (!referenced.has(hash)) throw new ArtifactError(`artifact holds a blob the manifest does not reference (${hash.slice(0, 12)})`);
    if (seen.has(hash)) throw new ArtifactError(`artifact repeats blob ${hash.slice(0, 12)}`);
    if (referenced.get(hash) !== body.length) throw new ArtifactError(`blob ${hash.slice(0, 12)} has ${body.length} bytes, the manifest says ${referenced.get(hash)}`);
    seen.add(hash);
    const dest = path.join(stagingDir, 'blobs', hash.slice(0, 2), hash);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
  }
  if (!sawManifest) throw new ArtifactError('artifact has no manifest record');
  const missing = [...referenced.keys()].filter((h) => !seen.has(h));
  if (missing.length) throw new ArtifactError(`artifact lacks ${missing.length} of the manifest's blobs (e.g. ${missing[0].slice(0, 12)})`);
  return { blobs: seen.size };
}

module.exports = { FORMAT, VERSION, ArtifactError, artifactName, packArtifact, artifactPin, fetchArtifact, unpackArtifact, checkUrl };
