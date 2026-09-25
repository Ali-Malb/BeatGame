import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--in-process-gpu','--use-gl=angle','--use-angle=swiftshader','--autoplay-policy=no-user-gesture-required','--mute-audio','--window-size=1100,700']});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGE: '+String(e).slice(0,200)));
page.on('console', m => { if (m.type()==='error') errors.push('CON: '+m.text().slice(0,200)); });
await page.goto('http://localhost:3001', {waitUntil:'domcontentloaded',timeout:120000});
await page.waitForFunction(() => document.body.innerText.includes('NEON'), {timeout:100000});
let opened = false;
for (let i = 0; i < 20 && !opened; i++) {
  opened = await page.evaluate(() => {
    if (document.body.innerText.includes('CAPABILITY PROBE')) return true;
    [...document.querySelectorAll('button')].find(x => x.textContent?.includes('REMOTE RENDER'))?.click();
    return false;
  });
  await new Promise(r=>setTimeout(r,700));
}
const clicked = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent?.includes('START REMOTE SESSION'));
  b?.click();
  return !!b;
});
console.log('start clicked:', clicked);
try {
  await page.waitForFunction(() => !!document.querySelector('img[alt="server-rendered video"]'), {timeout: 120000});
  console.log('video element mounted');
  const decoded = await page.evaluate(async () => {
    const img = document.querySelector('img[alt="server-rendered video"]');
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) { if (img.naturalWidth > 0) break; await new Promise(r=>setTimeout(r,500)); }
    return { w: img.naturalWidth, h: img.naturalHeight };
  });
  console.log('decoded:', JSON.stringify(decoded));
  await new Promise(r=>setTimeout(r,5000));
  const hud = await page.evaluate(() => {
    const img = document.querySelector('img[alt="server-rendered video"]');
    return {
      strip: img.parentElement.querySelector('div').innerText.replace(/\n/g,' | '),
      bottom: img.parentElement.lastElementChild.innerText.replace(/\n/g,' | '),
    };
  });
  console.log('strip:', hud.strip);
  console.log('bottom:', hud.bottom);
} catch (e) {
  console.log('VIDEO DID NOT APPEAR:', String(e).slice(0,150));
  const state = await page.evaluate(() => document.body.innerText.slice(0, 1200));
  console.log('page state:', JSON.stringify(state));
}
console.log('errors:', errors.slice(0,5));
await page.screenshot({path:'testartifacts/_probe_live.png'});
await browser.close();
