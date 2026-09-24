/** observe.mjs — launch the game headless, screenshot menu/gameplay/cameras, sample perf + scene stats.
 * PNG analysis is done in Node with pngjs because WebGL canvas readback (drawImage)
 * returns black under SwiftShader. HP is pinned so slow headless runs don't fail out.
 */
import puppeteer from 'puppeteer';
import fs from 'fs';
import { PNG } from 'pngjs';

const OUT = 'testartifacts/observe';
fs.mkdirSync(OUT, { recursive: true });

const W = Number(process.argv[2] ?? 1280);
const H = Number(process.argv[3] ?? 720);
const TAG = process.argv[4] ?? 'desktop';
const URL = process.env.OBSERVE_URL ?? 'http://localhost:3000/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function analyze(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const { width: w, height: h, data: d } = png;
  const reg = (x0, y0, x1, y1) => {
    let s = 0, n = 0, mx = 0;
    x0 = Math.floor(x0 * w); x1 = Math.floor(x1 * w);
    y0 = Math.floor(y0 * h); y1 = Math.floor(y1 * h);
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const i = (y * w + x) * 4;
      const v = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      s += v; n++; if (v > mx) mx = v;
    }
    return { avg: Math.round(s / n), max: Math.round(mx) };
  };
  return {
    sky: reg(0.1, 0.02, 0.9, 0.2),
    horizon: reg(0.25, 0.22, 0.75, 0.34),
    mid: reg(0.2, 0.36, 0.8, 0.52),
    road: reg(0.35, 0.56, 0.65, 0.92),
    left: reg(0, 0.3, 0.22, 0.7),
    right: reg(0.78, 0.3, 1, 0.7),
  };
}

const MOBILE = TAG === 'mobile';
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--in-process-gpu', '--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required', '--mute-audio', `--window-size=${W},${H}`],
});
const page = await browser.newPage();
if (MOBILE) {
  // phone portrait: touch emulation triggers the (pointer: coarse) overlay
  await page.setViewport({ width: W, height: H, isMobile: true, hasTouch: true });
} else {
  // SwiftShader is slow — a small viewport keeps sim-time tracking the audio clock
  await page.setViewport({ width: Math.min(W, 640), height: Math.min(H, 400) });
}
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text().slice(0, 300)}`);
});

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction(() => !!window.__game, { timeout: 90000 });
await sleep(2500);
await page.screenshot({ path: `${OUT}/${TAG}_01_menu.png` });

// start the demo; retry if the click didn't land, and pin HP from the page side
await page.evaluate(() => {
  const g = window.__game;
  if (!g) return;
  // page-side HP pin: slow headless runs must not fail out on missed gates
  window.__pinTimer = setInterval(() => {
    const gg = window.__game;
    if (gg?.scoring && 'hp' in gg.scoring) gg.scoring.hp = 9999;
  }, 500);
  const click = () => {
    if (g.state !== 'menu' || !window.__started) {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('QUICK RIDE'));
      if (b) { window.__started = true; b.click(); }
    }
  };
  window.__retryTimer = setInterval(click, 3000);
});
await sleep(2000);
await page.screenshot({ path: `${OUT}/${TAG}_02_countdown.png` });

// wait into playing (or a finished run)
await page.waitForFunction(
  () => ['playing', 'failed', 'victory'].includes(window.__game?.state),
  { timeout: 60000 },
);

await sleep(6000);
await page.screenshot({ path: `${OUT}/${TAG}_03_cockpit.png` });

if (MOBILE) {
  // touch controls present + GAS pad drives the bike
  const touchInfo = await page.evaluate(() => {
    const gas = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'GAS');
    const tuck = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'TUCK');
    const pause = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Pause');
    return { gas: !!gas, tuck: !!tuck, pause: !!pause, gasRect: gas ? gas.getBoundingClientRect().toJSON() : null };
  });
  console.log(`${TAG} touch controls:`, JSON.stringify(touchInfo));
  if (touchInfo.gasRect) {
    const cx = touchInfo.gasRect.x + touchInfo.gasRect.width / 2;
    const cy = touchInfo.gasRect.y + touchInfo.gasRect.height / 2;
    const before = await page.evaluate(() => Math.round(window.__game.bike.v * 3.6));
    await page.touchscreen.touchStart(cx, cy);
    await sleep(2500);
    const after = await page.evaluate(() => ({
      v: Math.round(window.__game.bike.v * 3.6),
      usingTouch: window.__game.usingTouch,
    }));
    await page.touchscreen.touchEnd();
    console.log(`${TAG} gas pad: ${before} -> ${after.v} km/h, usingTouch=${after.usingTouch}`);
  }
}

const stats1 = await page.evaluate(() => {
  const g = window.__game;
  let meshes = 0, triangles = 0, lights = 0;
  g.scene.traverse((o) => {
    if (o.isMesh) {
      meshes++;
      const geo = o.geometry;
      if (geo?.index) triangles += geo.index.count / 3;
      else if (geo?.attributes?.position) triangles += geo.attributes.position.count / 3;
    }
    if (o.isLight) lights++;
  });
  return { state: g.state, fps: +g.fps.toFixed(1), meshes, lights, triangles: Math.round(triangles) };
});
console.log(`${TAG} t+8s playing:`, JSON.stringify(stats1));

// toggle chase camera
await page.evaluate(() => window.__game.setCamera());
await sleep(3500);
await page.screenshot({ path: `${OUT}/${TAG}_04_chase.png` });
await page.evaluate(() => window.__game.setCamera());

// let it ride — sample fps over time for stutter detection
const samples = [];
for (let i = 0; i < 8; i++) {
  await sleep(1500);
  const st = await page.evaluate(() => {
    const g = window.__game;
    return { fps: +g.fps.toFixed(1), state: g.state, speed: Math.round(g.bike.v * 3.6), score: Math.round(g.scoring?.score ?? 0) };
  });
  samples.push(st);
}
console.log(`${TAG} fps samples:`, samples.map((s) => s.fps).join(', '));

await page.screenshot({ path: `${OUT}/${TAG}_05_late.png` });

// pause menu
await page.evaluate(() => {
  clearInterval(window.__pinTimer); clearInterval(window.__retryTimer);
  window.__game.togglePause();
});
await sleep(800);
await page.screenshot({ path: `${OUT}/${TAG}_06_pause.png` });

for (const f of ['01_menu', '03_cockpit', '04_chase']) {
  const r = analyze(`${OUT}/${TAG}_${f}.png`);
  console.log(`${TAG} ${f}:`, JSON.stringify(r));
}

if (errors.length) console.log(`ERRORS (${errors.length}):`);
for (const e of errors.slice(0, 10)) console.log(' ', e);
await browser.close();
