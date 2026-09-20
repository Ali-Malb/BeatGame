/**
 * Offline deterministic gate-sync simulation (§5 acceptance).
 * Uses the REAL RhythmGateSpawner + REAL BikePhysicsModel + REAL cue sheet.
 * Sim clock and audio clock advance in lockstep (sim = audio), which is the
 * condition on real hardware (≥10 FPS). Run: bun run scripts/gate_sim.ts
 */
import * as THREE from 'three';
import { RhythmGateSpawner } from '../src/game/rhythm/RhythmGateSpawner';
import { BikePhysicsModel } from '../src/game/vehicle/BikePhysicsModel';
import { AudioDspClock } from '../src/game/audio/AudioDspClock';
import { AudioRhythm } from '../src/game/audio/AudioRhythm';
import { ParsedCueSheet } from '../src/game/audio/CueSheetParser';
import { buildCueSheet } from '../src/game/audio/cueSheet';
import type { InputSnapshot } from '../src/game/core/Input';

const sheet = new ParsedCueSheet(buildCueSheet());
const clock = new AudioDspClock();
// bind the clock to a synthetic context whose currentTime we drive
const ctx = { currentTime: 0 } as unknown as AudioContext;
clock.attach(ctx);
clock.start();
const rhythm = new AudioRhythm(sheet, clock);

const scene = new THREE.Scene();
const stubHighway = {
  frame(s: number) {
    return { x: s, y: 0, z: 0, yaw: 0 };
  },
} as unknown as import('../src/game/environment/Highway').Highway;

const gates = new RhythmGateSpawner(scene, stubHighway, rhythm);
gates.reset(0);

const bike = new BikePhysicsModel();
const road = { kappa: 0, slope: 0, driveHalf: 5.6 };
const snap: InputSnapshot = { throttle: 1, brake: 0, rearBrake: 0, steer: 0, tuck: false, lookBack: false };

const DT = 1 / 120;
const SIM_SEC = 55;
let audioT = 0;
let evCount = 0;
const jointEvery = 60; // expansion-joint cadence (§29)
for (let i = 0; i < SIM_SEC / DT; i++) {
  bike.step(DT, snap, road, jointEvery);
  audioT += DT;
  // epoch = 0.12 → musical time = ctx.currentTime - 0.12
  (ctx.currentTime as unknown as number) = audioT + 0.12;
  const events = gates.update(DT, bike.s, bike.v);
  for (const ev of events) evCount++;
}

console.log('sim 55 s, full throttle, gates vs beats (sim = audio lockstep):');
console.log('final kmh:', (bike.v * 3.6).toFixed(1));
console.log('gate stats:', JSON.stringify(gates.stats));
const deltas = gates.stats.deltas;
if (deltas.length) {
  const abs = deltas.map((d) => Math.abs(d));
  const mean = abs.reduce((a, b) => a + b, 0) / abs.length;
  const within75 = abs.filter((d) => d <= 0.075).length;
  console.log(`judged: ${deltas.length}, meanAbsDelta: ${mean.toFixed(3)} s, |d|<=0.075: ${within75}/${deltas.length}`);
}
console.log(evCount > 0 ? 'GATE SIM DONE' : 'NO GATE EVENTS JUDGED');
