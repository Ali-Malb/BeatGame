import puppeteer from 'puppeteer';
import fs from 'fs';

const URL = 'http://localhost:3001/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--in-process-gpu', '--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--window-size=640,400'],
});
const page = await browser.newPage();
await page.setViewport({ width: 640, height: 400 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction(() => !!window.__game, { timeout: 90000 });
await sleep(1500);

// Start the ride via the menu button
await page.evaluate(() => {
  window.__started = false;
  const g = window.__game;
  window.__pinTimer = setInterval(() => {
    const gg = window.__game;
    if (gg?.scoring && 'hp' in gg.scoring) gg.scoring.hp = 9999;
  }, 500);
  const click = () => {
    if (!window.__started) {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('QUICK RIDE'));
      if (b) { window.__started = true; b.click(); }
    }
  };
  click();
  setTimeout(click, 1200);
});

await sleep(12000); // let chunks stream in
const stats = await page.evaluate(() => {
  const g = window.__game;
  const r = g.renderer;
  const scene = g.scene;
  let meshes = 0, vis = 0;
  scene.traverse((o) => { if (o.isMesh) { meshes++; if (o.visible) vis++; } });
  return {
    calls: r.info.render.calls,
    tris: r.info.render.triangles,
    meshes,
    vis,
    fps: g.telemetry?.fps ?? null,
    tier: g.qualityTier ?? null,
  };
});
console.log(JSON.stringify(stats, null, 2));
if (errors.length) console.log('ERRORS:', errors.slice(0, 5));
await browser.close();
