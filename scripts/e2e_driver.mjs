/**
 * E2E driver — launches the game headless, takes ride screenshots,
 * runs the in-page acceptance harness, captures runtime errors.
 * Run: node scripts/e2e_driver.mjs
 */
import puppeteer from 'puppeteer';
import fs from 'fs';

const OUT = '/workspace/hi/testartifacts';
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--window-size=1280,720',
  ],
  defaultViewport: { width: 1280, height: 720 },
});

const page = await browser.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

const probe = () =>
  page.evaluate(() => {
    const g = window.__game;
    const m = g.bike.model;
    return {
      kmh: +(m.v * 3.6).toFixed(1),
      rpm: Math.round(m.rpm),
      gear: m.gear,
      leanDeg: +(m.rollAngle * (180 / Math.PI)).toFixed(1),
      s: +m.s.toFixed(1),
      crashed: g.bike.crashed,
      state: g.state,
      fps: g.fpsAvg ?? null,
    };
  });

console.log('--- opening page');
await page.goto('http://localhost:4300/', { waitUntil: 'networkidle2', timeout: 90000 });
await page.waitForFunction(() => window.__game, { timeout: 60000 });
await sleep(1500);
await page.screenshot({ path: `${OUT}/01_start_menu.png` });

console.log('--- clicking START ENGINE');
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('START ENGINE'));
  b.click();
});
await sleep(3500);
await page.screenshot({ path: `${OUT}/02_idle_cockpit.png` });

console.log('--- full throttle run (hold W)');
await page.keyboard.down('KeyW');
await sleep(6000);
await page.screenshot({ path: `${OUT}/03_accel_6s.png` });
await sleep(8000);
await page.screenshot({ path: `${OUT}/04_accel_14s.png` });
await sleep(10000);
await page.screenshot({ path: `${OUT}/05_full_throttle_24s.png` });
await sleep(6000);
await page.screenshot({ path: `${OUT}/06_full_throttle_30s.png` });
console.log('30s probe:', await probe());
console.log('normal cockpit framing:', await page.evaluate(() => window.__gameTest.cameraFraming()));

console.log('--- tuck (shift)');
await page.keyboard.down('ShiftLeft');
await page.keyboard.up('ShiftLeft');
await sleep(8000);
await page.screenshot({ path: `${OUT}/07_tuck_highspeed.png` });
console.log('tuck probe:', await probe());
console.log('high-speed cockpit framing:', await page.evaluate(() => window.__gameTest.cameraFraming()));
await page.keyboard.down('ShiftLeft');
await page.keyboard.up('ShiftLeft');

console.log('--- chase camera');
await page.keyboard.down('KeyC');
await page.keyboard.up('KeyC');
await sleep(2500);
await page.screenshot({ path: `${OUT}/08_chase_camera.png` });
console.log('chase framing:', await page.evaluate(() => window.__gameTest.cameraFraming()));
await page.keyboard.down('KeyC');
await page.keyboard.up('KeyC');

console.log('--- steering sweep (lean test, hold D then A)');
await page.keyboard.down('KeyD');
await sleep(2200);
await page.screenshot({ path: `${OUT}/09_lean_right.png` });
await page.keyboard.up('KeyD');
await sleep(1500);
await page.keyboard.down('KeyA');
await sleep(2200);
await page.screenshot({ path: `${OUT}/10_lean_left.png` });
await page.keyboard.up('KeyA');
await sleep(2000);
console.log('self-right probe:', await probe());
await page.screenshot({ path: `${OUT}/11_self_right.png` });

console.log('--- acceptance harness (in-page)');
const report = await page.evaluate(() => window.__gameTest.runAll());
fs.writeFileSync(`${OUT}/acceptance.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2).slice(0, 2400));

console.log('--- weather presets (hard cuts mid-ride)');
await page.keyboard.down('KeyW');
const presetNames = ['twilight', 'starry_embers', 'golden_sunset', 'wet_rain'];
for (let i = 0; i < 4; i++) {
  const before = await probe();
  await page.evaluate((idx) => window.__game.weather.setPreset(idx, true), i);
  await sleep(2200);
  const after = await probe();
  await page.screenshot({ path: `${OUT}/12_preset_${i}_${presetNames[i]}.png` });
  console.log(`preset ${i}: pre ${before.kmh}kmh/${before.rpm}rpm lean ${before.leanDeg} -> post ${after.kmh}kmh/${after.rpm}rpm lean ${after.leanDeg} (must be ~equal)`);
}
await page.keyboard.up('KeyW');

console.log('--- crash test (steer into barrier at speed)');
await page.keyboard.down('KeyW');
await sleep(9000);
await page.keyboard.down('KeyD');
await page.keyboard.down('KeyD');
await sleep(6000);
await page.keyboard.up('KeyD');
console.log('crash probe:', await probe());
await page.screenshot({ path: `${OUT}/13_after_crash_or_contact.png` });
await sleep(6000);
await page.screenshot({ path: `${OUT}/14_after_respawn.png` });
console.log('respawn probe:', await probe());

fs.writeFileSync(`${OUT}/runtime_errors.txt`, errors.join('\n') || 'NO RUNTIME ERRORS');
console.log('--- runtime errors:', errors.length ? errors.slice(0, 10) : 'NONE');
await browser.close();
console.log('DONE');
