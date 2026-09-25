import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--in-process-gpu','--use-gl=angle','--use-angle=swiftshader','--autoplay-policy=no-user-gesture-required','--mute-audio'] });
const page = await browser.newPage();
await page.setViewport({ width: 640, height: 400 });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:3000/', { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction(() => !!window.__game, { timeout: 90000 });
await new Promise(r => setTimeout(r, 2000));
await page.evaluate(() => { [...document.querySelectorAll('button')].find(x => x.textContent?.includes('QUICK RIDE'))?.click(); });
for (let i = 0; i < 8; i++) {
  await new Promise(r => setTimeout(r, 2000));
  const st = await page.evaluate(() => {
    const g = window.__game;
    return { state: g.state, audioT: +(g.dspClock?.getAudioTime?.() ?? 0).toFixed(2), fps: +g.fps.toFixed(1), v: Math.round(g.bike.v*3.6), hp: g.scoring?.hp, renderer: g.renderer.info.render.calls };
  });
  console.log(i, JSON.stringify(st));
}
await browser.close();
