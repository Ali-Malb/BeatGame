/**
 * Focused gate-sync probe at low render load (higher FPS).
 */
import puppeteer from 'puppeteer';
import fs from 'fs';

const OUT = '/workspace/hi/testartifacts';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  ],
  defaultViewport: { width: 640, height: 360 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });

await page.goto('http://localhost:4300/', { waitUntil: 'networkidle2', timeout: 90000 });
await page.waitForFunction(() => window.__game, { timeout: 60000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('START ENGINE'));
  b.click();
});
await sleep(2500);

// measure live FPS first
const fps = await page.evaluate(() => new Promise((res) => {
  let frames = 0; const t0 = performance.now();
  const cnt = () => { frames++; if (performance.now() - t0 < 2000) requestAnimationFrame(cnt); else res(frames / 2); };
  requestAnimationFrame(cnt);
}));
console.log('live FPS:', fps);

await page.keyboard.down('KeyW');
await sleep(16000);
await page.keyboard.up('KeyW');
const st = await page.evaluate(() => {
  const g = window.__game;
  return {
    kmh: +(g.bike.model.v * 3.6).toFixed(1),
    gates: g.gates.stats,
    audioTime: +g.rhythm.getCurrentAudioTime().toFixed(2),
    rhythm: g.rhythm ? g.rhythm.getSectionName() : null,
  };
});
console.log('16s probe:', JSON.stringify(st));
fs.writeFileSync(`${OUT}/gate_probe.json`, JSON.stringify(st, null, 2));
console.log('errors:', errors.length ? errors : 'NONE');
await browser.close();
console.log('DONE');
