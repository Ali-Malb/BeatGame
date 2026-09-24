/** Probe: what happens to the bike during full-lock steering at pinned pace? */
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--in-process-gpu',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--window-size=1280,720',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 480, height: 300 });
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 200)));

await page.goto('http://localhost:3000', { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction(() => typeof (window as unknown as { __game?: unknown }).__game !== 'undefined', { timeout: 20000 });

await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  (btns.find((x) => x.textContent?.includes('QUICK RIDE')) as HTMLButtonElement)?.click();
});
await page.waitForFunction(
  () => (window as unknown as { __game: { getState(): string } }).__game.getState() === 'playing',
  { timeout: 30000 },
);

// pace pin + hp top (no homing)
await page.evaluate(() => {
  const w = window as unknown as { __paceTimer?: ReturnType<typeof setInterval> };
  w.__paceTimer = setInterval(() => {
    const g = (window as unknown as { __game?: { bike: { model: { v: number; crashed: boolean } }; scoring: { hp: number; invuln: number } } }).__game;
    if (!g) return;
    if (!g.bike.model.crashed) g.bike.model.v = 66.67;
    g.scoring.hp = 100;
    g.scoring.invuln = 3;
  }, 30);
});

const snap = () =>
  page.evaluate(() => {
    const g = (window as unknown as {
      __game: {
        bike: { x: number; v: number; crashed?: boolean };
        input: { steer: number; throttle: number };
        scoring: { hp: number; dead: boolean };
        getState(): string;
        stateLog: Array<{ from: string; to: string }>;
      };
    }).__game;
    return {
      st: g.getState(),
      x: +g.bike.x.toFixed(2),
      v: Math.round(g.bike.v * 3.6),
      steer: +g.input.steer.toFixed(2),
      thr: +g.input.throttle.toFixed(2),
      crashed: g.bike.crashed,
      hp: Math.round(g.scoring.hp),
      dead: g.scoring.dead,
      lastTrans: g.stateLog[g.stateLog.length - 1],
    };
  });

// hold W (like smoke) then full A
await page.keyboard.down('KeyW');
await new Promise((r) => setTimeout(r, 1500));
console.log('before A:', JSON.stringify(await snap()));
await page.keyboard.down('KeyA');
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 700));
  console.log('A held:', JSON.stringify(await snap()));
}
await page.keyboard.up('KeyA');
await browser.close();
