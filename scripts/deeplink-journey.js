#!/usr/bin/env node
'use strict';

/**
 * Browser journey for deep links, against the active pinned client with the
 * upstream guard on: a signed-in viewer opens a story from the home tray,
 * the Reels tab, a reel link (/reels/<code>/) and a story item link
 * (/stories/<user>/<media id>/), then refreshes and goes back and forward.
 * Each step checks the URL and what is shown (the reel's caption nearest the
 * viewport's centre, the story's image). Screenshots go to
 * test-artifacts/screenshots/history-*.png.
 *
 * Needs ffmpeg (a short VP9 test video for the reels). Exit 0 only when every
 * step passes and nothing reached upstream.
 *
 *   node scripts/deeplink-journey.js
 */
const upstreamGuard = require('./lib/offline').strictOffline();
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { launchChromium, openSession, captureScreenshot } = require('./lib/browser');
const { evaluate, sleep, sunsetPng } = require('./lib/scenario');
const { Browser } = require('../test/clone-helpers');
const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, '.scratch', 'deeplink-journey');
(async () => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  Object.assign(process.env, {
    BACKEND_DB: path.join(SCRATCH, 'db.sqlite'),
    CLONE_DATA_DIR: SCRATCH,
    VERBOSE: '0',
    BACKEND_VERBOSE: '0',
  });
  const { app } = require('../src/server');
  const server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const A = new Browser(base);
  await A.signup(null, { username: 'hist_a', fullName: 'Hist A' });
  const B = new Browser(base);
  const b = await B.signup(null, { username: 'hist_b', fullName: 'Hist B' });
  await A.post(`/api/v1/friendships/create/${b.pk}/`, {});
  const videoFile = path.join(SCRATCH, 'reel.mp4');
  const made = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=540x960:rate=24', '-t', '4', '-c:v', 'libvpx-vp9', '-b:v', '300k', '-y', videoFile]);
  if (made.status !== 0) {
    console.error(`ffmpeg could not make the test video: ${made.error ? made.error.message : made.stderr}`);
    process.exit(2);
  }
  const vid = fs.readFileSync(videoFile);
  const codes = [];
  for (const caption of ['older reel alpha', 'newer reel beta']) {
    const id = String(Date.now());
    const ent = `fb_uploader_${id}`;
    await B.request('POST', `/rupload_igvideo/${ent}`, {
      raw: vid,
      headers: {
        'content-type': 'application/octet-stream',
        offset: '0',
        'x-entity-length': String(vid.length),
        'x-entity-name': ent,
        'x-instagram-rupload-params': JSON.stringify({
          upload_id: id,
          media_type: 2,
          upload_media_width: 540,
          upload_media_height: 960,
          upload_media_duration_ms: 4000,
        }),
      },
    });
    await B.request('POST', `/rupload_igphoto/${ent}`, {
      raw: sunsetPng(540, 960),
      headers: {
        'content-type': 'image/png',
        'x-instagram-rupload-params': JSON.stringify({
          upload_id: id,
          media_type: 1,
        }),
      },
    });
    codes.push(
      (
        await B.post('/api/v1/media/configure_to_clips/', {
          upload_id: id,
          caption,
        })
      ).body.media.code,
    );
    await sleep(1100);
  }
  const ids = [];
  for (const png of [sunsetPng(), sunsetPng(720, 1280)]) {
    const id = String(Date.now() + ids.length);
    await B.request('POST', `/rupload_igphoto/fb_uploader_${id}`, {
      raw: png,
      headers: {
        'content-type': 'image/png',
        'x-instagram-rupload-params': JSON.stringify({
          upload_id: id,
          media_type: 1,
          is_story: '1',
        }),
      },
    });
    ids.push(String((await B.post('/api/v1/media/configure_to_story/', { upload_id: id })).body.media.pk));
  }
  const items = (await A.get(`/api/v1/feed/reels_media/?reel_ids=${b.pk}`)).body.reels_media[0].items;
  const srcOf = Object.fromEntries(items.map((it) => [String(it.pk), new URL(it.image_versions2.candidates[0].url, base).pathname]));
  const { child, browserWsUrl } = await launchChromium(path.join(SCRATCH, 'profile'));
  const s = await openSession(browserWsUrl);
  await s.cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  for (const [name, value] of A.jar)
    await s.cdp.send('Network.setCookie', {
      name,
      value: encodeURIComponent(value),
      url: base,
    });
  const reelShown = () =>
    evaluate(
      s,
      `(() => { const cy = innerHeight / 2; let best = null; for (const el of document.querySelectorAll('span, div')) { const t = (el.innerText || '').trim(); if (!/^(older reel alpha|newer reel beta)$/.test(t)) continue; const r = el.getBoundingClientRect(); if (r.width === 0) continue; const d = Math.abs((r.top + r.bottom) / 2 - cy); if (!best || d < best.d) best = { t, d }; } return best && best.t; })()`,
    );
  const storyShown = async () => {
    await evaluate(s, "(() => { const b = [...document.querySelectorAll('button, div[role=button]')].find((e) => (e.innerText || '').trim() === 'View story'); if (b) b.click(); })()");
    await sleep(1200);
    await evaluate(s, "(() => { const b = [...document.querySelectorAll('svg[aria-label=Pause]')].map((x) => x.closest('[role=button],button')).find(Boolean); if (b) b.click(); })()");
    const imgs = JSON.parse(await evaluate(s, `JSON.stringify([...document.querySelectorAll('img')].filter((i) => i.getBoundingClientRect().width > 200).map((i) => i.getAttribute('src')))`));
    const which = Object.entries(srcOf)
      .filter(([, p]) => imgs.some((i) => i && i.includes(p)))
      .map(([pk]) => `story ${ids.indexOf(pk) + 1}`);
    return which.join(',');
  };
  const clickText = (text) => evaluate(s, `(() => { const el = [...document.querySelectorAll('[role=button], button, a')].filter((e) => (e.innerText || '').trim().split('\\n').includes(${JSON.stringify(text)})).pop(); if (el) el.click(); return Boolean(el); })()`);
  const steps = [
    ['home', () => s.cdp.send('Page.navigate', { url: `${base}/` }), '/', null],
    ['click story tray', () => evaluate(s, `(() => { const el = document.querySelector('[aria-label^="Story by ${b.username}"]'); if (el) el.click(); return Boolean(el); })()`), `/stories/${b.username}/`, 'story 1'],
    ['back to home', () => evaluate(s, 'history.back()'), '/', null],
    // The client replaces /reels/ with the shown reel's URL (as on Instagram).
    ['open /reels/', () => s.cdp.send('Page.navigate', { url: `${base}/reels/` }), `/reels/${codes[1]}/`, 'newer reel beta'],
    ['open older reel link', () => s.cdp.send('Page.navigate', { url: `${base}/reels/${codes[0]}/` }), `/reels/${codes[0]}/`, 'older reel alpha'],
    [
      'open 2nd story link',
      () =>
        s.cdp.send('Page.navigate', {
          url: `${base}/stories/${b.username}/${ids[1]}/`,
        }),
      `/stories/${b.username}/${ids[1]}/`,
      'story 2',
    ],
    ['refresh story', () => evaluate(s, 'location.reload()'), `/stories/${b.username}/${ids[1]}/`, 'story 2'],
    ['back', () => evaluate(s, 'history.back()'), `/reels/${codes[0]}/`, 'older reel alpha'],
    ['back', () => evaluate(s, 'history.back()'), `/reels/${codes[1]}/`, 'newer reel beta'],
    ['forward', () => evaluate(s, 'history.forward()'), `/reels/${codes[0]}/`, 'older reel alpha'],
    ['refresh reel', () => evaluate(s, 'location.reload()'), `/reels/${codes[0]}/`, 'older reel alpha'],
    ['forward', () => evaluate(s, 'history.forward()'), `/stories/${b.username}/${ids[1]}/`, 'story 2'],
  ];
  let ok = true;
  for (const [i, [label, act, wantPath, want]] of steps.entries()) {
    await act();
    await sleep(7000);
    const p = await evaluate(s, 'location.pathname');
    const got = want === null ? null : want.startsWith('story') ? await storyShown() : await reelShown();
    // The tray opens the owner's stories (with or without an item id in the URL).
    const pathOk = label === 'click story tray' ? p.startsWith(wantPath) : p === wantPath;
    const pass = pathOk && got === want;
    ok = ok && pass;
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}: path ${pathOk ? 'as expected' : `UNEXPECTED (${p.replace(/[A-Za-z0-9_-]{6,}/g, '<code>')})`}, showing ${got}`);
    await captureScreenshot(s, path.join(ROOT, 'test-artifacts', 'screenshots', `history-${i + 1}-${label.replace(/\W+/g, '-')}.png`));
  }
  console.log('upstream', upstreamGuard.attempts.length);
  child.kill('SIGKILL');
  server.closeAllConnections?.();
  server.close();
  ok = ok && upstreamGuard.attempts.length === 0;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
