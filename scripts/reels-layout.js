#!/usr/bin/env node
"use strict";

/**
 * Reels layout check, against the active pinned client with the upstream
 * guard on. A signed-in viewer opens /reels/ (one 9:16 reel from a followed
 * account) at 1366x768, 1440x900, 1920x1080 and 390x844, and the shown
 * video's frame is measured: its element box, the displayed picture inside
 * it (object-fit applied to the video's own size), and the reel's action
 * buttons (Like, Comment, Share).
 *
 * Desktop windows must show the desktop Reels page: the server must not
 * report the page as degraded, the picture keeps its 9:16 aspect ratio, fits
 * the window's height, takes at most half its width, and the action buttons
 * are on screen. The phone window must show the reel across the width,
 * within the window's height, cropping at most a quarter of it (the viewer
 * fills a phone screen taller than 9:16), with the buttons on screen.
 *
 * Needs ffmpeg (a short VP9 test video). Screenshots:
 * test-artifacts/screenshots/reels-layout-<w>x<h>.png; report:
 * test-artifacts/reports/reels-layout.json. Exit 0 only when every window
 * passes and nothing reached upstream.
 *
 *   node scripts/reels-layout.js
 */

const upstreamGuard = require("./lib/offline").strictOffline();

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  launchChromium,
  openSession,
  captureScreenshot,
} = require("./lib/browser");
const { evaluate, sleep, sunsetPng } = require("./lib/scenario");
const { Browser } = require("../test/clone-helpers");

const ROOT = path.join(__dirname, "..");
const SCRATCH = path.join(ROOT, ".scratch", "reels-layout");
const SHOTS = path.join(ROOT, "test-artifacts", "screenshots");
const REPORTS = path.join(ROOT, "test-artifacts", "reports");
const WINDOWS = [
  { width: 1366, height: 768, mobile: false },
  { width: 1440, height: 900, mobile: false },
  { width: 1920, height: 1080, mobile: false },
  { width: 390, height: 844, mobile: true },
];

// The largest visible video: its box, the picture object-fit draws in it, and the action buttons.
const MEASURE = `(() => {
  const videos = [...document.querySelectorAll('video')].map((v) => ({ v, r: v.getBoundingClientRect() })).filter(({ r }) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight);
  videos.sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
  const top = videos[0];
  if (!top) return JSON.stringify({ video: null });
  const { v, r } = top;
  const fit = getComputedStyle(v).objectFit;
  const vw = v.videoWidth || 0, vh = v.videoHeight || 0;
  let pic = { width: r.width, height: r.height };
  if (vw && vh && (fit === 'contain' || fit === 'scale-down' || fit === 'none')) {
    const s = Math.min(r.width / vw, r.height / vh);
    pic = { width: vw * s, height: vh * s };
  } else if (vw && vh && fit === 'fill') {
    pic = { width: r.width, height: r.height };
  }
  const button = (label) => {
    const el = [...document.querySelectorAll('svg[aria-label="' + label + '"]')].map((s) => s.getBoundingClientRect()).find((b) => b.width > 0);
    return el ? { x: Math.round(el.x), y: Math.round(el.y), onScreen: el.top >= 0 && el.bottom <= innerHeight && el.left >= 0 && el.right <= innerWidth } : null;
  };
  return JSON.stringify({
    video: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), objectFit: fit, intrinsic: [vw, vh] },
    picture: { width: Math.round(pic.width), height: Math.round(pic.height) },
    buttons: { like: button('Like'), comment: button('Comment'), share: button('Share') },
    window: [innerWidth, innerHeight],
    pageScrolls: document.scrollingElement.scrollWidth > innerWidth,
  });
})()`;

function judge(win, m, degraded) {
  const problems = [];
  if (!m.video) return ["no video shown"];
  const aspect = m.picture.width / m.picture.height;
  // How much of the reel object-fit cuts off (cover crops to the element's shape).
  const cropped =
    m.video.objectFit === "cover"
      ? 1 - Math.min(aspect, 9 / 16) / Math.max(aspect, 9 / 16)
      : 0;
  m.croppedFraction = Number(cropped.toFixed(3));
  if (!win.mobile && Math.abs(aspect - 9 / 16) > 0.03)
    problems.push(
      `picture aspect ${aspect.toFixed(3)}, not 9:16 (${(9 / 16).toFixed(3)})`,
    );
  // On a phone the viewer fills the screen; a tall phone crops a little off the reel's sides.
  if (win.mobile && cropped > 0.25)
    problems.push(`${Math.round(cropped * 100)}% of the reel cropped`);
  if (m.picture.height > win.height + 1)
    problems.push(
      `picture ${m.picture.height}px taller than the window (${win.height}px)`,
    );
  if (m.pageScrolls) problems.push("the page scrolls sideways");
  for (const [name, b] of Object.entries(m.buttons))
    if (!b || !b.onScreen)
      problems.push(`${name} button ${b ? "off screen" : "missing"}`);
  if (!win.mobile) {
    if (degraded) problems.push(`server: ${degraded}`);
    if (m.video.width > win.width / 2)
      problems.push(
        `video ${m.video.width}px wide, more than half the window (${win.width}px)`,
      );
    if (m.video.height > win.height + 1)
      problems.push(`video element ${m.video.height}px taller than the window`);
  } else if (m.picture.width < win.width * 0.9) {
    problems.push(
      `picture ${m.picture.width}px across a ${win.width}px phone window`,
    );
  }
  return problems;
}

async function main() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(REPORTS, { recursive: true });
  const videoFile = path.join(SCRATCH, "reel.mp4");
  const made = spawnSync("ffmpeg", [
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=540x960:rate=24",
    "-t",
    "4",
    "-c:v",
    "libvpx-vp9",
    "-b:v",
    "300k",
    "-y",
    videoFile,
  ]);
  if (made.status !== 0) {
    console.error(
      `ffmpeg could not make the test video: ${made.error ? made.error.message : made.stderr}`,
    );
    return 2;
  }
  Object.assign(process.env, {
    BACKEND_DB: path.join(SCRATCH, "db.sqlite"),
    CLONE_DATA_DIR: SCRATCH,
    VERBOSE: "0",
    BACKEND_VERBOSE: "0",
  });
  const { app } = require("../src/server");
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { child, browserWsUrl } = await launchChromium(
    path.join(SCRATCH, "profile"),
  );
  const rows = [];
  try {
    const A = new Browser(base);
    await A.signup(null, {
      username: "layout_viewer",
      fullName: "Layout Viewer",
    });
    const B = new Browser(base);
    const b = await B.signup(null, {
      username: "layout_author",
      fullName: "Layout Author",
    });
    await A.post(`/api/v1/friendships/create/${b.pk}/`, {});
    const vid = fs.readFileSync(videoFile);
    const id = String(Date.now());
    const entity = `fb_uploader_${id}`;
    await B.request("POST", `/rupload_igvideo/${entity}`, {
      raw: vid,
      headers: {
        "content-type": "application/octet-stream",
        offset: "0",
        "x-entity-length": String(vid.length),
        "x-entity-name": entity,
        "x-instagram-rupload-params": JSON.stringify({
          upload_id: id,
          media_type: 2,
          upload_media_width: 540,
          upload_media_height: 960,
          upload_media_duration_ms: 4000,
        }),
      },
    });
    await B.request("POST", `/rupload_igphoto/${entity}`, {
      raw: sunsetPng(540, 960),
      headers: {
        "content-type": "image/png",
        "x-instagram-rupload-params": JSON.stringify({
          upload_id: id,
          media_type: 1,
        }),
      },
    });
    await B.post("/api/v1/media/configure_to_clips/", {
      upload_id: id,
      caption: "layout reel",
    });
    const degraded = (
      await A.get("/reels/", {
        headers: {
          accept: "text/html",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
        },
      })
    ).headers.get("x-clone-page-degraded");
    for (const win of WINDOWS) {
      const s = await openSession(browserWsUrl);
      await s.cdp.send("Emulation.setDeviceMetricsOverride", {
        width: win.width,
        height: win.height,
        deviceScaleFactor: 1,
        mobile: win.mobile,
      });
      if (win.mobile)
        await s.cdp.send("Emulation.setTouchEmulationEnabled", {
          enabled: true,
          maxTouchPoints: 5,
        });
      for (const [name, value] of A.jar)
        await s.cdp.send("Network.setCookie", {
          name,
          value: encodeURIComponent(value),
          url: base,
        });
      await s.cdp.send("Page.navigate", { url: `${base}/reels/` });
      await sleep(9000);
      const m = JSON.parse(await evaluate(s, MEASURE));
      const problems = judge(win, m, degraded);
      const shot = path.join(
        SHOTS,
        `reels-layout-${win.width}x${win.height}.png`,
      );
      await captureScreenshot(s, shot);
      rows.push({
        window: `${win.width}x${win.height}`,
        ...m,
        problems,
        pass: problems.length === 0,
        screenshot: path.relative(ROOT, shot),
      });
      console.log(
        `${problems.length ? "FAIL" : "ok  "} ${win.width}x${win.height}: video ${m.video ? `${m.video.width}x${m.video.height} at ${m.video.x},${m.video.y} (${m.video.objectFit})` : "none"}, picture ${m.picture ? `${m.picture.width}x${m.picture.height}` : "-"}${m.croppedFraction ? `, ${Math.round(m.croppedFraction * 100)}% cropped` : ""}${problems.length ? `\n       ${problems.join("\n       ")}` : ""}`,
      );
      s.ws.close();
    }
  } finally {
    child.kill("SIGKILL");
    server.closeAllConnections?.();
    server.close();
  }
  fs.writeFileSync(
    path.join(REPORTS, "reels-layout.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        upstreamAttempts: upstreamGuard.attempts.length,
        windows: rows,
      },
      null,
      1,
    ),
  );
  console.log(`upstream attempts: ${upstreamGuard.attempts.length}`);
  const ok = rows.every((r) => r.pass) && upstreamGuard.attempts.length === 0;
  console.log(ok ? "reels layout PASS" : "reels layout FAILED");
  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
