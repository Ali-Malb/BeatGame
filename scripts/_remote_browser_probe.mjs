/** verification: remote panel in a real browser (open → stream → close) */
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox','--disable-setuid-sandbox','--in-process-gpu','--use-gl=angle','--use-angle=swiftshader','--autoplay-policy=no-user-gesture-required','--mute-audio','--window-size=1100,700'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 700 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => document.body.innerText.includes('NEON'), { timeout: 90000 });

const opened = await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.includes('REMOTE RENDER'));
  b?.click();
  return !!b;
});
await new Promise((r) => setTimeout(r, 6000));
const probe = await page.evaluate(() => {
  const txt = document.body.innerText;
  const grab = (label) => {
    const i = txt.indexOf(label);
    return i < 0 ? null : txt.slice(i + label.length, i + 400).split('\n')[0].trim();
  };
  return { renderer: grab('server renderer'), encoder: grab('server encoder'), rtc: grab('server webrtc') };
});
console.log('panel opened:', opened, probe);

const started = await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.includes('START REMOTE SESSION'));
  b?.click();
  return !!b;
});
await page.waitForFunction(() => !!document.querySelector('img[alt="server-rendered video"]'), { timeout: 90000 });
// give the JPEG stream time to decode real frames
const decoded = await page.evaluate(async () => {
  const img = document.querySelector('img[alt="server-rendered video"]');
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (img.naturalWidth > 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { w: img.naturalWidth, h: img.naturalHeight, src: img.getAttribute('src') };
});
console.log('started:', started, 'decoded frame:', decoded);
const overlay = await page.evaluate(() => {
  const img = document.querySelector('img[alt="server-rendered video"]');
  return {
    strip: img.parentElement.querySelector('div').innerText.replace(/\n/g, ' | '),
    hud: img.parentElement.lastElementChild.innerText.replace(/\n/g, ' | '),
  };
});
console.log('status strip:', overlay.strip);
console.log('authoritative HUD:', overlay.hud);
await page.screenshot({ path: 'testartifacts/remote_panel.png' });
await browser.close();
console.log('page errors:', errors.slice(0, 3));
