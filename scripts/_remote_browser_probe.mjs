/** verification: remote panel in a real browser (open → stream → close). Honors OBSERVE_URL. */
import puppeteer from 'puppeteer';

const URL = process.env.OBSERVE_URL ?? 'http://localhost:3001';
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox','--disable-setuid-sandbox','--in-process-gpu','--use-gl=angle','--use-angle=swiftshader','--autoplay-policy=no-user-gesture-required','--mute-audio','--window-size=1100,700'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 700 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 200));
  if (m.text().includes('[remote]')) console.log('[page]', m.text());
});
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => document.body.innerText.includes('NEON'), { timeout: 120000 });

// retry-click until the panel mounts — hydration timing under SwiftShader varies
let opened = false;
for (let i = 0; i < 20 && !opened; i++) {
  opened = await page.evaluate(() => {
    if (document.body.innerText.includes('CAPABILITY PROBE')) return true;
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.includes('REMOTE RENDER'));
    b?.click();
    return false;
  });
  await new Promise((r) => setTimeout(r, 700));
}
console.log('panel opened:', opened);
await new Promise((r) => setTimeout(r, 1200));
const probe = await page.evaluate(() => {
  const txt = document.body.innerText;
  const grab = (label) => {
    const i = txt.indexOf(label);
    return i < 0 ? null : txt.slice(i + label.length, i + 400).split('\n')[0].trim();
  };
  return { renderer: grab('server renderer'), encoder: grab('server encoder'), rtc: grab('server webrtc') };
});
console.log('capability probe:', JSON.stringify(probe));
await page.screenshot({ path: 'testartifacts/remote_panel_caps.png' });

const started = await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.includes('START REMOTE SESSION'));
  b?.click();
  return !!b;
});
await page.waitForFunction(() => !!document.querySelector('img[alt="server-rendered video"]'), { timeout: 120000 });
// give the JPEG stream time to decode real frames
const decoded = await page.evaluate(async () => {
  const img = document.querySelector('img[alt="server-rendered video"]');
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    if (img.naturalWidth > 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { w: img.naturalWidth, h: img.naturalHeight, src: (img.getAttribute('src') ?? '').replace(/\/api.*/, '/api/…') };
});
console.log('started:', started, 'decoded frame:', JSON.stringify(decoded));
await new Promise((r) => setTimeout(r, 4000)); // let HUD sync from snapshots
const overlay = await page.evaluate(() => {
  const img = document.querySelector('img[alt="server-rendered video"]');
  return {
    strip: img.parentElement.querySelector('div').innerText.replace(/\n/g, ' | '),
    hud: img.parentElement.lastElementChild.innerText.replace(/\n/g, ' | '),
  };
});
console.log('status strip:', overlay.strip);
console.log('authoritative HUD:', overlay.hud);
await page.screenshot({ path: 'testartifacts/remote_panel_live.png' });

// close the panel — must dispose the runtime (video img gone). The DELETE can
// take a moment while the server session is mid-frame, so poll.
const closeClicked = await page.evaluate(() => {
  const b = document.querySelector('button[aria-label="close"]');
  if (!b) return { clicked: false, reason: 'close button not found' };
  const r = b.getBoundingClientRect();
  b.click();
  return { clicked: true, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, visible: r.width > 0 && r.height > 0 };
});
console.log('close click:', JSON.stringify(closeClicked));
let closed = false;
for (let i = 0; i < 20 && !closed; i++) {
  await new Promise((r) => setTimeout(r, 500));
  closed = await page.evaluate(
    () => !document.querySelector('img[alt="server-rendered video"]') || window.__remoteDisposed === true,
  );
}
console.log('panel closed + runtime disposed:', closed);

let liveCount = -1;
for (let i = 0; i < 12 && liveCount !== 0; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const still = await fetch(`${URL}/api/remote/session`).then((r) => r.json());
  liveCount = still.sessions.length;
}
console.log('live sessions after close (expect 0):', liveCount);
await browser.close();
console.log('page errors:', errors.slice(0, 3));
process.exit(closed && liveCount === 0 ? 0 : 1);
