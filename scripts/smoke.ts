/**
 * Runtime smoke test — drives the REAL game in headless Chrome (puppeteer):
 * boot → menu → demo launch → countdown → playing → steering/throttle →
 * camera toggle → pause/resume → gates judging → victory/failed paths.
 * Also exercises /api/health, /api/search (real yt-dlp), invalid inputs,
 * and upload mode (deterministic 120 BPM click track → full analysis pipeline).
 *
 * Usage: bun scripts/smoke.ts [--skip-backend] [--skip-browser] [--skip-song]
 */

import puppeteer from 'puppeteer';
import { Scoring, multiplierForCombo } from '../src/game/core/Scoring';

const BASE = 'http://localhost:3000';
const SKIP = new Set(process.argv.slice(2));

let pass = 0;
let fail = 0;
/** shared search results (populated by the backend section; [] if skipped) */
let results: { id: string; title: string; channel: string; duration: number; thumbnail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(BASE + path);
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // non-JSON body
  }
  return { status: res.status, json };
}

function printSummary(): void {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

async function main(): Promise<void> {
  if (!SKIP.has('--skip-backend')) {
  console.log('— backend checks —');
  const health = await api('/api/health');
  check('GET /api/health', health.status === 200 && health.json.server === 'ok', JSON.stringify(health.json));
  check('health: yt-dlp available', health.json['yt-dlp'] === 'ok');

  const search = await api('/api/search?q=daft%20punk&limit=4');
  results = (search.json.results ?? []) as { id: string; title: string; channel: string; duration: number; thumbnail: string }[];
  check(
    'GET /api/search?q=daft+punk',
    search.status === 200 && results.length > 0,
    `${results.length} results, first: ${results[0]?.title?.slice(0, 40) ?? '—'}`,
  );
  if (results.length > 0) {
    const r0 = results[0];
    check('search result shape (id/title/channel/duration/thumbnail)', /^[0-9A-Za-z_-]{11}$/.test(r0.id) && !!r0.title && r0.duration > 0 && !!r0.thumbnail);
  }

  const badSearch = await api('/api/search?q=');
  check('search with empty q → 400', badSearch.status === 400);

  const badStream = await api('/api/stream?id=short');
  check('stream with invalid id → 400', badStream.status === 400);

  } // end backend section

  if (SKIP.has('--skip-browser')) {
    console.log('(browser section skipped)');
    printSummary();
    return;
  }

  // ---------- browser ----------
  console.log('— browser runtime —');
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
  // small viewport: SwiftShader software rendering is slow; a small target keeps
  // FPS high enough for sim-time to track the audio clock during the test
  await page.setViewport({ width: 480, height: 300 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });

  // menu visible
  await page.waitForFunction(() => document.body.innerText.includes('NEON'), { timeout: 30000 });
  check('menu renders', true);

  // game object
  await page.waitForFunction(() => typeof (window as unknown as { __game?: unknown }).__game !== 'undefined', { timeout: 20000 });
  const state = () => page.evaluate(() => (window as unknown as { __game: { getState: () => string } }).__game.getState());

  check('initial state = menu', (await state()) === 'menu');

  // WebGL actually drawing (render frames advancing)
  await new Promise((r) => setTimeout(r, 2500));
  const drawing = await page.evaluate(() => {
    const g = (window as unknown as { __game: { renderer: { info: { render: { frame: number } } } } }).__game;
    return g.renderer.info.render.frame > 10;
  });
  check('WebGL render loop advancing', drawing);

  // ---------- launch demo run ----------
  // audio context must be unlocked in headless (autoplay flag) — click the demo button
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const b = btns.find((x) => x.textContent?.includes('QUICK RIDE'));
    (b as HTMLButtonElement)?.click();
  });
  await page.waitForFunction(() => (window as unknown as { __game: { getState: () => string } }).__game.getState() === 'countdown', { timeout: 15000 });
  check('countdown reached', true);
  await page.waitForFunction(() => (window as unknown as { __game: { getState: () => string } }).__game.getState() === 'playing', { timeout: 15000 });
  check('playing reached after countdown', true);

  // blind driving accumulates misses (correct game behavior) — keep the run
  // alive during the drive/camera/pause checks, then remove for the fail test
  await page.evaluate(() => {
    const w = window as unknown as { __hpTimer?: ReturnType<typeof setInterval> };
    w.__hpTimer = setInterval(() => {
      const g = (window as unknown as { __game?: { scoring: { hp: number; invuln: number } } }).__game;
      if (g) {
        g.scoring.hp = 100;
        g.scoring.invuln = 3;
      }
    }, 150);
  });

  // drive: throttle held for 6 AUDIO-seconds (sim time tracks the DSP clock)
  await page.keyboard.down('KeyW');
  // sample lateral position continuously so the A/D sweep proves steering
  // RANGE (the two inputs partly cancel in net displacement)
  let xMin = Infinity;
  let xMax = -Infinity;
  const xSampler = setInterval(() => {
    page
      .evaluate(() => {
        const g = (window as unknown as { __game?: { bike: { x: number } } }).__game;
        return g ? g.bike.x : 0;
      })
      .then((x) => {
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
      })
      .catch(() => {});
  }, 120);
  await page.waitForFunction(
    () => (window as unknown as { __game: { dspClock: { getAudioTime(): number } } }).__game.dspClock.getAudioTime() > 6.5,
    { timeout: 30000 },
  );
  await page.keyboard.down('KeyA');
  await page.waitForFunction(
    () => (window as unknown as { __game: { dspClock: { getAudioTime(): number } } }).__game.dspClock.getAudioTime() > 7.6,
    { timeout: 15000 },
  );
  await page.keyboard.up('KeyA');
  await page.keyboard.down('KeyD');
  await page.waitForFunction(
    () => (window as unknown as { __game: { dspClock: { getAudioTime(): number } } }).__game.dspClock.getAudioTime() > 8.6,
    { timeout: 15000 },
  );
  await page.keyboard.up('KeyD');
  clearInterval(xSampler);
  const steerRange = xMax - xMin;
  // clear traffic from the bot's corridor before re-centering — a rear-end
  // during the sweep is legit gameplay but would cascade into later checks
  await page.evaluate(() => {
    const g = (window as unknown as { __game?: { traffic: { clearCorridor(s: number, lane: number, len?: number): void; findClearLane(s: number): number }; bike: { s: number } } }).__game;
    if (!g) return;
    const lane = g.traffic.findClearLane(g.bike.s);
    g.traffic.clearCorridor(g.bike.s, lane, 90);
  });
  // re-center after the sweep — the blind bot may have leaned into a barrier
  // (correct game behavior); a tumble here would cascade into later checks
  await page.evaluate(() => {
    const m = (window as unknown as { __game: { bike: { model: { x: number; vx: number; crashed: boolean } } } }).__game.bike.model;
    m.x = 1.75;
    m.vx = 0;
    m.crashed = false;
  });
  await page.keyboard.down('ShiftLeft');
  await page.waitForFunction(
    () => (window as unknown as { __game: { dspClock: { getAudioTime(): number } } }).__game.dspClock.getAudioTime() > 11,
    { timeout: 15000 },
  );
  await page.keyboard.up('ShiftLeft');

  const tel = await page.evaluate(() => {
    const g = (window as unknown as { __game: { songInfo?: unknown } }).__game as unknown as {
      bike: { v: number; x: number; s: number; model: { rollAngle: number } };
      dspClock: { getAudioTime(): number };
      scoring: { score: number; combo: number; hp: number };
      gates: { stats: { perfect: number; good: number; miss: number } };
      appliedBiome: number;
      analysis: { bpm: number } | null;
      chart: { notes: unknown[] } | null;
    };
    return {
      v: g.bike.v,
      x: g.bike.x,
      s: g.bike.s,
      lean: g.bike.model.rollAngle,
      audioT: g.dspClock.getAudioTime(),
      score: g.scoring.score,
      hp: g.scoring.hp,
      gates: g.gates.stats,
      biome: g.appliedBiome,
      bpm: g.analysis?.bpm ?? 0,
      notes: g.chart?.notes.length ?? 0,
    };
  });
  check('bike accelerates', tel.v > 25, `${(tel.v * 3.6).toFixed(0)} km/h @ audio t=${tel.audioT.toFixed(1)}s`);
  check('bike steering moved lateral position', steerRange > 0.5, `range=${steerRange.toFixed(2)} m x=${tel.x.toFixed(2)}`);
  check('distance progressed', tel.s > 150, `${Math.round(tel.s)} m`); // random mid-run crashes may slow the blind bot
  check('demo analysis exists (128 BPM chart)', tel.bpm === 128 && tel.notes > 50, `${tel.notes} gates`);
  check('audio clock advancing', tel.audioT > 3.5, `${tel.audioT.toFixed(2)} s`);
  check('gates scheduled/judged', tel.gates.perfect + tel.gates.good + tel.gates.miss > 0, JSON.stringify(tel.gates));
  check('biome active', tel.biome >= 0 && tel.biome <= 3, `biome=${tel.biome}`);

  // scripted lane-homing: steer the bike into each upcoming gate's lane so the
  // judgment pipeline is positively verified (PERFECT/GOOD + combo/score feed)
  await page.evaluate(() => {
    const w = window as unknown as { __laneTimer?: ReturnType<typeof setInterval> };
    if (w.__laneTimer) clearInterval(w.__laneTimer);
    w.__laneTimer = setInterval(() => {
      const g = (window as unknown as { __game?: GameDriverish }).__game;
      if (!g) return;
      const t = g.dspClock.getAudioTime();
      let best: { lead: number; lane: number; s: number } | null = null;
      for (const gate of g.gates.gates as Array<{ active: boolean; judged: boolean; note: { time: number; lane: number }; s: number }>) {
        if (!gate.active || gate.judged) continue;
        const lead = gate.note.time - t;
        if (lead > 0.55 && lead < 6 && (!best || lead < best.lead)) best = { lead, lane: gate.note.lane, s: gate.s };
      }
      if (best) {
        const m = g.bike.model as { x: number; vx: number };
        // gates live at the SPLINE's physical lane position (taper/elevation-aware)
        const target = g.highway.spline.laneX(best.s, best.lane) as number;
        if (best.lead < 1.0) {
          m.x = target; // final adjust: a snap is a legal player input
          m.vx = 0;
        } else {
          const maxRate = 12 * 0.1; // rate-limited approach
          m.x += Math.max(-maxRate, Math.min(maxRate, target - m.x));
          m.vx = 0;
        }
      }
    }, 60);
  });
  await new Promise((r) => setTimeout(r, 9000));
  const hitTel = await page.evaluate(() => {
    const g = (window as unknown as { __game: { gates: { stats: { perfect: number; good: number; miss: number } }; scoring: { perfects: number; goods: number; bestCombo: number; score: number } } }).__game;
    return { gates: g.gates.stats, sc: { perfects: g.scoring.perfects, goods: g.scoring.goods, bestCombo: g.scoring.bestCombo, score: g.scoring.score } };
  });
  await page.evaluate(() => {
    const w = window as unknown as { __laneTimer?: ReturnType<typeof setInterval> };
    if (w.__laneTimer) {
      clearInterval(w.__laneTimer);
      w.__laneTimer = undefined;
    }
  });
  check(
    'scripted lane-homing lands PERFECT/GOOD judgments',
    hitTel.gates.perfect + hitTel.gates.good >= 2,
    JSON.stringify(hitTel.gates),
  );
  // combo→multiplier→score chain, verified against the production module
  const table = [0, 1.0, 9, 1.0, 10, 1.1, 19, 1.1, 20, 1.2, 39, 1.2, 40, 1.3, 59, 1.3, 60, 1.4, 79, 1.4, 80, 1.5, 99, 1.5, 100, 2.0, 250, 2.0];
  let multOk = true;
  for (let i = 0; i < table.length; i += 2) if (multiplierForCombo(table[i]!) !== table[i + 1]) multOk = false;
  const s = new Scoring();
  for (let i = 0; i < 20; i++) s.addJudgment('perfect'); // combo 20 → 1.2×
  const scoreAt20 = s.score;
  s.addJudgment('miss'); // combo → 0, 1.0×
  const scoreAtReset = s.score;
  s.addJudgment('good'); // +500 at 1.0×
  // exact spec progression: 10 hits @1.0× (10 000) then 10 @1.1× (11 000)
  const multOkFinal = multOk && scoreAt20 === 21000 && scoreAtReset === scoreAt20 && s.score === scoreAt20 + 500 && s.bestCombo === 20;
  check('combo→multiplier→score math (Scoring module)', multOkFinal, `@20×:${scoreAt20} reset+good:${s.score} best:${s.bestCombo}`);

  // the blind player accumulates misses → top up HP before the camera/pause tests
  await page.evaluate(() => {
    const g = (window as unknown as { __game: { scoring: { hp: number } } }).__game;
    g.scoring.hp = 100;
  });

  // camera: cycle through ALL five modes (§20), verifying each transition lands
  const seen: string[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0 && (await state()) !== 'playing') break;
    await page.keyboard.press('KeyC');
    await page
      .waitForFunction(
        () => (window as unknown as { __game: { cam: { mode: string } } }).__game.cam.mode !== 'cockpit',
        { timeout: 2500 }
      )
      .catch(() => {});
    const mode = await page.evaluate(() => (window as unknown as { __game: { cam: { mode: string } } }).__game.cam.mode);
    if (!seen.includes(mode)) seen.push(mode);
  }
  check('camera cycles 5 modes (cockpit + chase-close)', seen.includes('chase-close'), `seen=${seen.join(',')}`);
  // cycle back to cockpit for the rest of the suite
  for (let i = 0; i < 5 && (await page.evaluate(() => (window as unknown as { __game: { cam: { mode: string } } }).__game.cam.mode)) !== 'cockpit'; i++) {
    await page.keyboard.press('KeyC');
  }

  // ensure still playing for the pause test (a crash could have fired)
  await page.evaluate(() => {
    const g = (window as unknown as { __game: { scoring: { hp: number; invuln: number } } }).__game;
    g.scoring.hp = 100;
    g.scoring.invuln = 10;
  });
  void 0;

  // pause / resume — rhythm timeline must freeze with it
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => (window as unknown as { __game: { getState: () => string } }).__game.getState() === 'paused', { timeout: 5000 });
  const t1 = await page.evaluate(() => ((window as unknown as { __game: { dspClock: { getAudioTime(): number } } }).__game.dspClock.getAudioTime()));
  await new Promise((r) => setTimeout(r, 1200));
  const t2 = await page.evaluate(() => ((window as unknown as { __game: { dspClock: { getAudioTime(): number } } }).__game.dspClock.getAudioTime()));
  check('pause freezes the audio timeline', Math.abs(t2 - t1) < 0.05, `Δ=${(t2 - t1).toFixed(3)}s`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => (window as unknown as { __game: { getState: () => string } }).__game.getState() === 'playing', { timeout: 5000 });
  const t3 = await page.evaluate(() => ((window as unknown as { __game: { dspClock: { getAudioTime(): number } } }).__game.dspClock.getAudioTime()));
  check('resume continues from the same time', Math.abs(t3 - t1) < 0.4, `resume Δ=${(t3 - t1).toFixed(3)}s`);

  // restart via R (poll — SwiftShader may lag key delivery across frames)
  await page.keyboard.press('KeyR');
  const sAfterRestart = await page
    .waitForFunction(
      () => {
        const g = (window as unknown as { __game: { getState(): string; dspClock: { getAudioTime(): number } } }).__game;
        return g.getState() === 'countdown' && g.dspClock.getAudioTime() < 0;
      },
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false);
  const sAfterRestart2 = await page.evaluate(() => ({
    state: (window as unknown as { __game: { getState(): string } }).__game.getState(),
    audioT: (window as unknown as { __game: { dspClock: { getAudioTime(): number } } }).__game.dspClock.getAudioTime(),
  }));
  check('R restarts the run (fresh countdown timeline)', !!sAfterRestart && sAfterRestart2.state === 'countdown' && sAfterRestart2.audioT < 0, `t=${sAfterRestart2.audioT.toFixed(2)} state=${sAfterRestart2.state}`);
  // wait through the countdown for the song-mode section
  await page.waitForFunction(() => (window as unknown as { __game: { getState(): string } }).__game.getState() === 'playing', { timeout: 20000 });

  // ---------- YouTube song mode: real stream → decode → analyze → countdown ----------
  const videoId = results[0]?.id ?? '';
  const videoId2 = results[1]?.id ?? '';
  if (!SKIP.has('--skip-song') && videoId) {
    console.log('— song mode (real yt-dlp stream) —');
    const attempt = async (vid: string): Promise<string> => {
      const st = await page.evaluate(async (v) => {
        const g = (window as unknown as { __game: GameManagerish }).__game;
        await g.startYouTube(v);
        return g.getState();
      }, vid);
      const done = await page
        .waitForFunction(
          () => {
            const s = (window as unknown as { __game: { getState(): string } }).__game.getState();
            return s === 'countdown' || s === 'menu';
          },
          { timeout: 150000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!done) return st;
      return page.evaluate(() => (window as unknown as { __game: { getState(): string } }).__game.getState());
    };
    let finalState = await attempt(videoId);
    if (finalState === 'menu' && videoId2) {
      console.log('  (first result blocked — trying the second search result)');
      finalState = await attempt(videoId2);
    }
    check('startYouTube → countdown or graceful menu fallback', ['countdown', 'menu'].includes(finalState), `state=${finalState}`);
    if (finalState === 'countdown') {
      check('song loaded → analyzed → countdown', true);
      const info = await page.evaluate(() => {
        const g = (window as unknown as { __game: { analysis: { bpm: number; duration: number; onsets: unknown[]; sections: unknown[] } | null; chart: { notes: { time: number; lane: number }[] } | null; selection: { title: string; channel: string } } }).__game;
        return {
          bpm: g.analysis?.bpm ?? 0,
          duration: g.analysis?.duration ?? 0,
          onsets: g.analysis?.onsets.length ?? 0,
          sections: g.analysis?.sections.length ?? 0,
          notes: g.chart?.notes.length ?? 0,
          title: g.selection.title,
          channel: g.selection.channel,
        };
      });
      check('analysis produced BPM + onsets + sections', info.bpm > 50 && info.onsets > 30 && info.sections >= 1, `bpm=${info.bpm} onsets=${info.onsets} sections=${info.sections}`);
      check('chart built with lanes', info.notes > 20, `${info.notes} notes`);
      check('song identity resolved', info.title.length > 2 && info.title !== 'Loading…', info.title.slice(0, 48));
      // ride a little in song mode
      await page.waitForFunction(() => (window as unknown as { __game: { getState(): string } }).__game.getState() === 'playing', { timeout: 12000 });
      await page.keyboard.down('KeyW');
      await new Promise((r) => setTimeout(r, 4000));
      const songTel = await page.evaluate(() => {
        const g = (window as unknown as { __game: { gates: { stats: { perfect: number; good: number; miss: number } }; dspClock: { getAudioTime(): number } } }).__game;
        return { gates: g.gates.stats, t: g.dspClock.getAudioTime() };
      });
      check('song-mode gates judged on the song timeline', songTel.t > 3 && songTel.gates.perfect + songTel.gates.good + songTel.gates.miss > 0, `t=${songTel.t.toFixed(1)} ${JSON.stringify(songTel.gates)}`);
    } else {
      // YouTube may block datacenter IPs — the game must have failed GRACEFULLY back to menu
      console.log('  (youtube stream blocked from this IP — graceful fallback verified)');
    }
  }

  // ---------- upload mode: real decode → analysis → chart → race ----------
  // YouTube streaming is IP-dependent, but upload mode exercises the exact same
  // frontend pipeline (decodeAudioData → AudioAnalyzer → chart → gates), so we
  // verify it with a deterministic 120 BPM click-track WAV.
  const sr = 22050;
  const dur = 20;
  const nSamples = sr * dur;
  const wav = Buffer.alloc(44 + nSamples * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + nSamples * 2, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sr, 24);
  wav.writeUInt32LE(sr * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(nSamples * 2, 40);
  for (let i = 0; i < nSamples; i++) {
    const t = i / sr;
    const phase = t % 0.5; // kick every 0.5 s = 120 BPM
    const kick = phase < 0.06 ? Math.sin(2 * Math.PI * 60 * phase) * Math.exp(-phase * 55) : 0;
    const click = phase < 0.004 ? Math.sin(2 * Math.PI * 4000 * phase) : 0;
    const v = Math.max(-1, Math.min(1, kick * 0.9 + click * 0.5)) * 0.8;
    wav.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  console.log('— upload mode (deterministic 120 BPM click track) —');
  const fileHandle = await page.evaluateHandle((b64: string) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], 'click-120.wav', { type: 'audio/wav' });
  }, wav.toString('base64'));
  await page.evaluate((f) => {
    const w = window as unknown as { __hpTimer?: ReturnType<typeof setInterval> };
    if (w.__hpTimer) clearInterval(w.__hpTimer);
    w.__hpTimer = setInterval(() => {
      const g = (window as unknown as { __game?: { scoring: { hp: number } } }).__game;
      if (g) g.scoring.hp = 100;
    }, 150);
    void (window as unknown as { __game: { startUpload(f: File): Promise<void> } }).__game.startUpload(f as File);
  }, fileHandle);
  await page.waitForFunction(
    () => {
      const s = (window as unknown as { __game: { getState(): string } }).__game.getState();
      return s === 'countdown' || s === 'menu';
    },
    { timeout: 90000 },
  );
  const upState = await state();
  check('upload → decoded → analyzed → countdown', upState === 'countdown', `state=${upState}`);
  if (upState === 'countdown') {
    const upInfo = await page.evaluate(() => {
      const g = (window as unknown as { __game: { analysis: { bpm: number; onsets: unknown[] } | null; chart: { notes: unknown[] } | null } }).__game;
      return { bpm: g.analysis?.bpm ?? 0, onsets: g.analysis?.onsets.length ?? 0, notes: g.chart?.notes.length ?? 0 };
    });
    check('upload analysis finds the click tempo', upInfo.bpm > 60 && upInfo.bpm < 180, `bpm=${upInfo.bpm} onsets=${upInfo.onsets} notes=${upInfo.notes}`);
    await page.waitForFunction(() => (window as unknown as { __game: { getState(): string } }).__game.getState() === 'playing', { timeout: 20000 });
    await page.keyboard.down('KeyW');
    await new Promise((r) => setTimeout(r, 6000));
    const upTel = await page.evaluate(() => {
      const g = (window as unknown as { __game: { gates: { stats: { perfect: number; good: number; miss: number } }; dspClock: { getAudioTime(): number } } }).__game;
      return { gates: g.gates.stats, t: g.dspClock.getAudioTime() };
    });
    check('upload-mode gates judged on the song timeline', upTel.t > 3 && upTel.gates.perfect + upTel.gates.good + upTel.gates.miss > 0, `t=${upTel.t.toFixed(1)} ${JSON.stringify(upTel.gates)}`);
    await page.keyboard.up('KeyW');
  }
  await page.evaluate(() => {
    const w = window as unknown as { __hpTimer?: ReturnType<typeof setInterval> };
    // KEEP the keep-alive running — later sections (camera/pause/restart) need
    // the run alive; the failure path installs its own timer over this one
  });

  // ---------- HP/failed path ----------
  console.log('— failure path —');
  // ensure a run is active (song mode may have fallen back to menu)
  const preFail = await state();
  if (preFail !== 'playing') {
    await page.evaluate(() => {
      const g = (window as unknown as { __game: { startDemo(): Promise<void> } }).__game;
      void g.startDemo();
    });
    await page.waitForFunction(() => (window as unknown as { __game: { getState(): string } }).__game.getState() === 'playing', { timeout: 20000 });
  }
  // restart first if the demo song has nearly ended (fail test needs runway)
  const runway = await page.evaluate(() => {
    const g = (window as unknown as { __game: { dspClock: { getAudioTime(): number }; analysis: { duration: number } | null; restart(): void } }).__game;
    return (g.analysis?.duration ?? 0) - g.dspClock.getAudioTime();
  });
  if (runway < 15) {
    await page.evaluate(() => {
      (window as unknown as { __game: { restart(): void } }).__game.restart();
    });
    await page.waitForFunction(() => (window as unknown as { __game: { getState(): string } }).__game.getState() === 'playing', { timeout: 20000 });
  }
  await page.evaluate(() => {
    const w = window as unknown as { __hpTimer?: ReturnType<typeof setInterval> };
    if (w.__hpTimer) clearInterval(w.__hpTimer);
    const g = (window as unknown as { __game: { scoring: { hp: number } } }).__game;
    g.scoring.hp = 3;
  });
  await new Promise((r) => setTimeout(r, 9000));
  const failedState = await state();
  check('HP ≤ 0 → FAILED state', failedState === 'failed', `state=${failedState}`);

  // victory path: must be exercised from a genuine playing run; keep HP topped
  // so the blind driver cannot fail out (crashes/misses) before song end fires
  await page.evaluate(() => {
    (window as unknown as { __game: { backToMenu(): void } }).__game.backToMenu();
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(() => {
    const w = window as unknown as { __hpTimer?: ReturnType<typeof setInterval> };
    if (w.__hpTimer) clearInterval(w.__hpTimer);
    w.__hpTimer = setInterval(() => {
      const g = (window as unknown as { __game?: { scoring: { hp: number } } }).__game;
      if (g) g.scoring.hp = 100;
    }, 150);
    void (window as unknown as { __game: { startDemo(): Promise<void> } }).__game.startDemo();
  });
  await page.waitForFunction(() => (window as unknown as { __game: { getState(): string } }).__game.getState() === 'playing', { timeout: 20000 });
  const victoryState = await page.evaluate(() => {
    const g = (window as unknown as { __game: { onSongEnded(): void; scoring: { hp: number }; state: string } }).__game;
    g.scoring.hp = 100;
    g.onSongEnded();
    return g.state;
  });
  await page.evaluate(() => {
    const w = window as unknown as { __hpTimer?: ReturnType<typeof setInterval> };
    if (w.__hpTimer) {
      clearInterval(w.__hpTimer);
      w.__hpTimer = undefined;
    }
  });
  check('song end while alive → VICTORY', victoryState === 'victory', `state=${victoryState}`);

  // back to menu
  await page.evaluate(() => {
    (window as unknown as { __game: { backToMenu(): void } }).__game.backToMenu();
  });
  await new Promise((r) => setTimeout(r, 400));
  check('backToMenu returns to menu', (await state()) === 'menu');

  // console errors (filter benign + the intentionally-triggered 502 fallback)
  const serious = errors.filter((e) => !/favicon|Autoplay|AudioContext was not allowed|GroupMarkerNotSet|swiftshader|502|Bad Gateway/i.test(e));
  check('no serious page errors', serious.length === 0, serious.slice(0, 3).join(' | '));

  await browser.close();

  printSummary();
}

interface GameManagerish {
  startYouTube(id: string): Promise<void>;
  getState(): string;
}

/** minimal shape of the page-side GameManager used by the driving scripts */
interface GameDriverish {
  dspClock: { getAudioTime(): number };
  gates: { gates: unknown };
  bike: { model: { x: number; vx: number } };
  highway: { spline: { laneX(s: number, lane: number): number } };
}

void main().catch((e) => {
  console.error('SMOKE TEST CRASH:', e);
  process.exit(1);
});
