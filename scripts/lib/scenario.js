'use strict';

/** Helpers shared by the genuine-client browser scenarios (scripts/genuine-*-check.js). */

const zlib = require('node:zlib');
const { evaluateIsolated } = require('./browser');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A real (decodable) PNG: a vertical sunset gradient with a sun disc. */
function sunsetPng(width = 1080, height = 1080) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    const t = y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const sky = [Math.round(255 - 120 * t), Math.round(140 - 100 * t), Math.round(60 + 120 * t)];
      const d = Math.hypot(x - width / 2, y - height * 0.62);
      const px = d < width * 0.14 ? [255, 214, 90] : y > height * 0.7 ? [Math.round(40 + 30 * t), Math.round(50 + 20 * t), Math.round(110 + 40 * t)] : sky;
      px.forEach((v, i) => { row[1 + x * 3 + i] = v; });
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function evaluate(session, expression) {
  const result = await session.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function type(session, selectorExpr, text) {
  const ok = await evaluate(session, `(() => { const e = ${selectorExpr}; if (!e) return false; e.focus(); e.select && e.select(); return true; })()`);
  if (ok) await session.cdp.send('Input.insertText', { text });
  return ok;
}

/** Poll (from an isolated world) until `expression` is truthy or `ms` elapse. */
async function waitFor(session, expression, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evaluateIsolated(session, expression).catch(() => false)) return true;
    await sleep(500);
  }
  return false;
}

module.exports = { sunsetPng, evaluate, type, waitFor, sleep };
