import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-gpu-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text().slice(0,200)); });
await page.goto('http://localhost:3000/', { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction(() => !!window.__game, { timeout: 90000 });
await new Promise(r => setTimeout(r, 2000));
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('QUICK RIDE'));
  b?.click();
});
for (let i = 0; i < 6; i++) {
  await new Promise(r => setTimeout(r, 2000));
  const st = await page.evaluate(() => {
    const g = window.__game;
    return { state: g.state, audioT: g.dspClock ? +g.dspClock.getAudioTime().toFixed(2) : null, fps: +g.fps.toFixed(1), audioCtx: g.audio?.context?.state ?? 'none' };
  });
  console.log(i, JSON.stringify(st));
}
await browser.close();
