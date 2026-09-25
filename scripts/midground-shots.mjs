/** midground-shots.mjs — screenshot the midground decks at tier 2 (harness override) */
import puppeteer from 'puppeteer';
import fs from 'fs';

const OUT = 'testartifacts/observe';
fs.mkdirSync(OUT, { recursive: true });
const URL = process.env.OBSERVE_URL ?? 'http://localhost:3001/';
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
await sleep(1200);
await page.evaluate(() => {
  window.__started = false;
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
await page.waitForFunction(() => ['playing', 'failed'].includes(window.__game?.state), { timeout: 60000 });
await sleep(2500);
await page.evaluate(() => {
  const g = window.__game;
  g.applyQualityTier(2);
  g.adaptQuality = () => {};
  window.__paceTimer = setInterval(() => {
    const gg = window.__game;
    if (gg?.bike?.model) gg.bike.model.v = 55;
  }, 400);
});
await sleep(10000); // ride forward so decks stream and build
await page.screenshot({ path: `${OUT}/midground_cockpit.png` });
await page.evaluate(() => window.__game.setCamera());
await sleep(2500);
await page.screenshot({ path: `${OUT}/midground_chase.png` });
console.log('shots saved:', fs.readdirSync(OUT).filter((f) => f.startsWith('midground')).join(', '));
console.log(errors.length ? `ERRORS: ${errors.slice(0, 3).join(' | ')}` : 'no page errors');
await browser.close();
