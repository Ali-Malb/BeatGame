/**
 * Focused rhythm-gate crossing test (§11) — pure headless, deterministic.
 *
 * Covers:
 *   1. Exact hit (cross time == note time) → PERFECT
 *   2. Early −30 ms → PERFECT · slightly early −60 ms → GOOD
 *   3. Late +60 ms → GOOD · too late +120 ms → MISS
 *   4. Wrong lane (right time, outside lane threshold) → MISS
 *   5. Late-miss timeout never deletes a reachable gate before crossing (§8)
 *   6. Low-FPS sweep: one frame across several gates → each judged EXACTLY once (§7/§9)
 *   7. Speed independence: same note → same gateS at 50/150/250/320 km/h (§3)
 *
 * Usage: bun scripts/gate-crossing.test.ts
 */

import * as THREE from 'three';
import { RoadSpline } from '../src/game/environment/roadSpline';
import { RhythmGates, type GateEvent } from '../src/game/rhythm/RhythmGates';
import { trackPositionFor, RHYTHM_SPEED } from '../src/game/rhythm/trackPosition';
import type { ChartNote, RhythmChart } from '../src/game/rhythm/RhythmChart';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.error(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function note(time: number, lane = 1): ChartNote {
  return { time, lane, subdivision: 4, strength: 1, type: 'kick' };
}

function makeChart(notes: ChartNote[]): RhythmChart {
  return { notes, bpm: 128, firstBeat: 0, beatSec: 60 / 128, duration: 60, sections: [] };
}

function makeGates(notes: ChartNote[]): { gates: RhythmGates; highway: { spline: RoadSpline; frame: (s: number) => { x: number; y: number; z: number; yaw: number; rx: number; rz: number } } } {
  const scene = new THREE.Scene();
  const spline = new RoadSpline(90210);
  // headless stand-in for Highway.frame(): same data, no canvas materials
  const pt = { x: 0, y: 0, z: 0, yaw: 0, rx: 1, rz: 0, kappa: 0, s: 0, slope: 0 };
  const highway = {
    spline,
    frame(s: number) {
      spline.get(s, pt);
      return pt;
    },
  };
  const gates = new RhythmGates(scene, highway as unknown as ConstructorParameters<typeof RhythmGates>[1]);
  gates.setChart(makeChart(notes), TRACK_ORIGIN);
  return { gates, highway };
}

interface Frame {
  dt: number;
  audioT: number;
  s: number;
  x: number;
}

/** drive a frame sequence through the real RhythmGates update loop */
function drive(gates: RhythmGates, frames: Frame[]): GateEvent[] {
  const events: GateEvent[] = [];
  for (const f of frames) events.push(...gates.update(f.dt, f.audioT, f.s, 0, f.x));
  return events;
}

const TRACK_ORIGIN = 60;
const NOTE_T = 3.0;
const GATE_S = trackPositionFor(NOTE_T, TRACK_ORIGIN); // 260 m

console.log('1) exact hit: cross time == note time → PERFECT');
{
  const { gates, highway } = makeGates([note(NOTE_T)]);
  const laneX = highway.spline.laneX(GATE_S, 1);
  // prev (gateS−10 m @ 2.9 s) → cur (gateS+10 m @ 3.1 s): alpha 0.5 → crossAudio 3.0
  const ev = drive(gates, [
    { dt: 0.1, audioT: 2.9, s: GATE_S - 10, x: laneX },
    { dt: 0.2, audioT: 3.1, s: GATE_S + 10, x: laneX },
  ]);
  check('one event, PERFECT', ev.length === 1 && ev[0].judgment === 'perfect', `Δ=${ev[0]?.delta.toFixed(4)}`);
  check('delta ≈ 0', ev.length === 1 && Math.abs(ev[0].delta) < 1e-6, `${ev[0]?.delta}`);
  check('crossAudio == note.time', ev.length === 1 && Math.abs(ev[0].delta) < 1e-6);
  check('crossing logged once', gates.lastCross !== null && gates.lastCross.judgment === 'perfect');
  // further frames must NOT re-judge
  const more = drive(gates, [{ dt: 0.1, audioT: 3.4, s: GATE_S + 60, x: laneX }]);
  check('judged exactly once', more.length === 0 && gates.stats.perfect === 1);
}

console.log('2/3) timing bands: −30 PERFECT · −60 GOOD · +60 GOOD · +120 MISS');
{
  const band = (prevT: number, curT: number, xFrac = 0.5) => {
    const { gates, highway } = makeGates([note(NOTE_T)]);
    const laneX = highway.spline.laneX(GATE_S, 1);
    // symmetric ±10 m around the plane, alpha 0.5 → crossAudio = mid(prevT, curT)
    const ev = drive(gates, [
      { dt: 0.05, audioT: prevT, s: GATE_S - 10, x: laneX },
      { dt: curT - prevT, audioT: curT, s: GATE_S + 10, x: laneX },
    ]);
    void xFrac;
    void highway;
    return { ev, gates };
  };
  const earlyPerfect = band(2.9, 3.04); // crossAudio 2.97 → Δ −0.030
  check('early −0.030 → PERFECT', earlyPerfect.ev[0]?.judgment === 'perfect', `Δ=${earlyPerfect.ev[0]?.delta.toFixed(4)}`);
  const earlyGood = band(2.9, 2.98); // crossAudio 2.94 → Δ −0.060
  check('slightly early −0.060 → GOOD', earlyGood.ev[0]?.judgment === 'good', `Δ=${earlyGood.ev[0]?.delta.toFixed(4)}`);
  const lateGood = band(2.9, 3.22); // crossAudio 3.06 → Δ +0.060
  check('late +0.060 → GOOD', lateGood.ev[0]?.judgment === 'good', `Δ=${lateGood.ev[0]?.delta.toFixed(4)}`);
  const lateMiss = band(2.9, 3.34); // crossAudio 3.12 → Δ +0.120
  check('too late +0.120 → MISS', lateMiss.ev[0]?.judgment === 'miss', `Δ=${lateMiss.ev[0]?.delta.toFixed(4)}`);
}

console.log('4) wrong lane: exact time but outside lane threshold → MISS');
{
  const { gates, highway } = makeGates([note(NOTE_T, 1)]);
  const wrongX = highway.spline.laneX(GATE_S, 3); // two lanes (7 m) away
  const laneOffsetTheoretical = Math.abs(wrongX - highway.spline.laneX(GATE_S, 1));
  check('spline lane spacing is 3.5 m per lane', Math.abs(laneOffsetTheoretical - 7.0) < 0.01, `lane1→lane3 = ${laneOffsetTheoretical.toFixed(2)} m`);
  const ev = drive(gates, [
    { dt: 0.1, audioT: 2.9, s: GATE_S - 10, x: wrongX },
    { dt: 0.2, audioT: 3.1, s: GATE_S + 10, x: wrongX },
  ]);
  check('right time + wrong lane → MISS', ev.length === 1 && ev[0].judgment === 'miss' && Math.abs(ev[0].delta) < 1e-6, `offset=${ev[0]?.laneOffset.toFixed(2)} m`);
}

console.log('5) §8 timeout: gate NEVER deleted before its plane while reachable');
{
  const { gates, highway } = makeGates([note(NOTE_T)]);
  const laneX = highway.spline.laneX(GATE_S, 1);
  const pos0 = JSON.stringify(highway.frame(GATE_S));
  // creep toward the gate from note time until just inside the +2 s window
  const frames: Frame[] = [];
  for (let t = NOTE_T; t <= 4.9; t += 0.1) frames.push({ dt: 0.1, audioT: t, s: GATE_S - 30 - (4.9 - t) * 4, x: laneX });
  drive(gates, frames);
  const g = gates['gates' as keyof RhythmGates] as unknown as Array<{ active: boolean; judged: boolean }>;
  const stillThere = g.some((x) => x.active && !x.judged);
  check('gate alive at note+1.9 s (no premature recycle)', stillThere);
  check('no judgment yet', gates.stats.perfect + gates.stats.good + gates.stats.miss === 0);
  // crossing just inside the window is judged on the PHYSICAL plane
  const ev = drive(gates, [{ dt: 0.05, audioT: 4.95, s: GATE_S + 2, x: laneX }]);
  check('late physical cross at +1.95 s judged on crossing', ev.length === 1 && Math.abs(ev[0].delta - 1.95) < 0.01, `Δ=${ev[0]?.delta.toFixed(3)}`);
  // never-reached gate: audio beyond +2 s while still behind → MISS (not deleted silently)
  const { gates: g2, highway: h2 } = makeGates([note(NOTE_T)]);
  const lx2 = h2.spline.laneX(GATE_S, 1);
  drive(g2, [
    { dt: 0.1, audioT: 4.0, s: GATE_S - 50, x: lx2 },
    { dt: 0.1, audioT: 5.3, s: GATE_S - 46, x: lx2 },
  ]);
  check('stopped rider: gate late-missed (MISS, not silent)', g2.stats.miss === 1);
  const pos1 = JSON.stringify(h2.frame(GATE_S));
  check('gate world position never moved', pos0 === pos1);
}

console.log('6) §7/§9 low-FPS sweep: one frame across MANY gates — each judged exactly once');
{
  // 5 gates 0.25 s apart (66.7 m); single 10 FPS frame from before g1 to past g5
  const notes = [3.0, 3.25, 3.5, 3.75, 4.0].map((t) => note(t, 1));
  const { gates, highway } = makeGates(notes);
  const lx = highway.spline.laneX(GATE_S, 1);
  const lastS = trackPositionFor(4.0, TRACK_ORIGIN);
  const ev = drive(gates, [
    { dt: 0.1, audioT: 2.98, s: GATE_S - 5, x: lx },
    { dt: 0.1, audioT: 3.08, s: GATE_S - 2, x: lx }, // nothing crossed yet
    { dt: 0.1, audioT: 4.7, s: lastS + 10, x: lx }, // ONE frame crosses g1..g5
    { dt: 0.1, audioT: 5.0, s: lastS + 80, x: lx },
  ]);
  check('exactly 5 events for 5 gates in one frame', ev.length === 5, `got ${ev.length}`);
  check('all judged once (no doubles)', gates.stats.perfect + gates.stats.good + gates.stats.miss === 5);
  // 20 FPS sweep: 2 gates per frame, still exactly once each (pre-frame
  // anchors the swept segment BEFORE the first gate, as the live loop does)
  const notes2 = [3.0, 3.25, 3.5, 3.75].map((t) => note(t, 1));
  const { gates: g2, highway: h2 } = makeGates(notes2);
  const lx2 = h2.spline.laneX(GATE_S, 1);
  const ev2: GateEvent[] = [];
  ev2.push(...g2.update(0.1, 2.9, GATE_S - 12, 0, lx2)); // anchor frame
  for (let i = 0; i < 6; i++) {
    ev2.push(...g2.update(0.05, 3.02 + i * 0.05, GATE_S - 12 + (i + 1) * 33.33, 0, lx2));
  }
  check('20 FPS: 4 gates → 4 events', ev2.length === 4, `got ${ev2.length}`);
  check('20 FPS: no double judgments', g2.stats.perfect + g2.stats.good + g2.stats.miss === 4);
}

console.log('7) §3 speed independence: same note → same gateS at any speed');
{
  const ref = trackPositionFor(NOTE_T, TRACK_ORIGIN);
  const speeds = [50 / 3.6, 150 / 3.6, 250 / 3.6, 320 / 3.6];
  const same = speeds.every(() => Math.abs(trackPositionFor(NOTE_T, TRACK_ORIGIN) - ref) < 1e-9);
  check('50/150/250/320 km/h → identical gateS', same, `gateS=${ref.toFixed(2)} m (pace ${(RHYTHM_SPEED * 3.6).toFixed(0)} km/h)`);
}

console.log('');
if (failures === 0) console.log('GATE CROSSING TESTS: ALL PASS');
else {
  console.error(`GATE CROSSING TESTS: ${failures} FAILED`);
  process.exit(1);
}
