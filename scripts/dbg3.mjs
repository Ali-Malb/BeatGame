import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--in-process-gpu','--use-gl=angle','--use-angle=swiftshader','--autoplay-policy=no-user-gesture-required','--mute-audio'] });
const page = await browser.newPage();
await page.setViewport({ width: 480, height: 320 });
await page.goto('http://localhost:3000/', { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction(() => !!window.__game, { timeout: 90000 });
await new Promise(r => setTimeout(r, 1500));
await page.evaluate(() => { [...document.querySelectorAll('button')].find(x => x.textContent?.includes('QUICK RIDE'))?.click(); });
await new Promise(r => setTimeout(r, 9000));

const sample = async (label, setup) => {
  if (setup) await page.evaluate(setup);
  await new Promise(r => setTimeout(r, 3000));
  const st = await page.evaluate(() => {
    const g = window.__game;
    // rAF-independent: count render frames over the last window via renderer.info
    return { state: g.state, fps: +g.fps.toFixed(1), audioT: +(g.dspClock?.getAudioTime?.() ?? 0).toFixed(2), frames: g.renderer.info.render.frame, calls: g.renderer.info.render.calls, triangles: g.renderer.info.render.triangles };
  });
  console.log(label, JSON.stringify(st));
  return st.frames;
};

// baseline
const f1a = await sample('baseline-1');
const f1b = await sample('baseline-2');
console.log('baseline frames/s (SwiftShader):', (f1b - f1a) / 3);

const f2a = await sample('bloom-off', () => { const g=window.__game; g.postfx.bloomEnabled=false; g.postfx.bloom.enabled=false; });
const f2b = await sample('bloom-off-2');
console.log('bloom-off frames/s:', (f2b - f2a) / 3);

const f3a = await sample('shadows-off', () => { const g=window.__game; g.renderer.shadowMap.enabled=false; g.weather.sun.castShadow=false; });
const f3b = await sample('shadows-off-2');
console.log('shadows-off frames/s:', (f3b - f3a) / 3);

const f4a = await sample('postfx-direct', () => { const g=window.__game; g.postfx.render = function(){ this.renderPass.enabled=false; this.bloom.enabled=false; this.finalPass.enabled=false; this.outputPass.enabled=false; g.renderer.render(g.scene, g.cam.camera); }; });
const f4b = await sample('postfx-direct-2');
console.log('direct-render frames/s:', (f4b - f4a) / 3);

await browser.close();
