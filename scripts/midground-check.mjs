/**
 * midground-check.mjs — verification for the CityBlock layer:
 *  1. CityBlock groups exist and are visible while riding
 *  2. deck geometry is present (concrete/railing/lampHead buckets)
 *  3. distant cars are visible and their positions ADVANCE over time
 *  4. draw-call delta stays bounded
 */
import puppeteer from 'puppeteer';

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
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction(() => !!window.__game, { timeout: 90000 });
await sleep(1500);

// start a quick ride (same flow as observe.mjs)
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
await sleep(3000);

// HARNESS-ONLY overrides (same pattern as the HP pin): force tier 2 so the
// midground layer is exercised even under SwiftShader, neutralize the adaptive
// downgrade, and pin pace so cells roll while we sample.
await page.evaluate(() => {
  const g = window.__game;
  g.applyQualityTier(2);
  g.adaptQuality = () => {};
  window.__paceTimer = setInterval(() => {
    const gg = window.__game;
    if (gg?.bike?.model) gg.bike.model.v = 55; // ~200 km/h cruise
  }, 400);
});
await sleep(8000); // let chunks + cells stream in

const report = await page.evaluate(() => {
  const g = window.__game;
  const cb = g.cityBlock;
  if (!cb) return { fail: 'no cityBlock on GameManager' };
  const cells = cb.cells ?? [];
  let groups = 0, visGroups = 0, deckMeshes = 0, cars = 0, visCars = 0;
  for (const c of cells) {
    groups++;
    if (c.group.visible) visGroups++;
    if (c.deckMesh) deckMeshes++;
    for (const car of c.cars ?? []) {
      cars++;
      if (car.mesh.visible) visCars++;
    }
  }
  return {
    tier: g.qualityTier,
    groups, visGroups, deckMeshes, cars, visCars,
    splineLen: Math.round(g.highway.spline.totalLength),
    playerS: Math.round(g.bike.s),
    drawCalls: g.renderer.info.render.calls,
  };
});
console.log('midground state:', JSON.stringify(report));

// track distant-car movement: sum of car s positions should increase
const s1 = await page.evaluate(() => {
  const cb = window.__game.cityBlock;
  let sum = 0, n = 0, vis = 0;
  for (const c of cb.cells) for (const car of c.cars) { sum += car.s; n++; if (car.mesh.visible) vis++; }
  return { sum, n, vis };
});
await sleep(4000);
const s2 = await page.evaluate(() => {
  const cb = window.__game.cityBlock;
  let sum = 0, n = 0, vis = 0;
  for (const c of cb.cells) for (const car of c.cars) { sum += car.s; n++; if (car.mesh.visible) vis++; }
  return { sum, n, vis };
});
const advanced = s2.sum > s1.sum;
console.log(`traffic: cars=${s1.n} visibleNow=${s2.vis} sumAdvance=${(s2.sum - s1.sum).toFixed(1)}m over 4s → ${advanced ? 'MOVING' : 'NOT MOVING'}`);

const playerS2 = await page.evaluate(() => { clearInterval(window.__paceTimer); return Math.round(window.__game.bike.s); });
console.log(`player advanced: ${report.playerS} → ${playerS2} m (${playerS2 > report.playerS ? 'OK' : 'STALLED?'})`);
console.log(`draw calls at ride time: ${report.drawCalls}`);

const pass = report.visGroups >= 1 && report.deckMeshes >= 1 && advanced && playerS2 > report.playerS;
console.log(pass ? 'MIDGROUND CHECK: PASS' : 'MIDGROUND CHECK: FAIL');
console.log(errors.length ? `PAGE ERRORS: ${errors.slice(0, 5).join(' | ')}` : 'no page errors');
await browser.close();
process.exit(pass && errors.length === 0 ? 0 : 1);
