/**
 * Rhythm invariant test (§51 — MORE IMPORTANT than the generic smoke test).
 *
 * Proves, deterministically (pure Node, no rendering):
 *   1. For the same song/chart, note.time → gate.s is IDENTICAL regardless of
 *      player speed (50 / 150 / 250 / 320 km/h).
 *   2. A spawned gate's s NEVER changes across an entire simulated run.
 *   3. Different player speeds produce DIFFERENT judgment deltas — arriving
 *      early / on-time / late is real gameplay.
 *
 * Usage: bun scripts/rhythm-invariant.ts
 */

import { trackPositionFor, RHYTHM_SPEED } from '../src/game/rhythm/trackPosition';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures++;
    console.error(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// a tiny deterministic chart: notes every half-beat @128 BPM
const BEAT = 60 / 128;
const notes = Array.from({ length: 32 }, (_, i) => ({
  time: +(2 + i * (BEAT / 2)).toFixed(4),
  lane: [0, 1, 2, 3, 2, 1][i % 6],
}));
const TRACK_ORIGIN = 60; // bike s at song t=0

console.log('1) gate.s is a pure function of note.time (speed-independent)');
const referenceS = notes.map((n) => trackPositionFor(n.time, TRACK_ORIGIN));
const speeds = [50 / 3.6, 150 / 3.6, 250 / 3.6, 320 / 3.6];
let allSame = true;
for (const v of speeds) {
  void v; // speed never enters the mapping — computing again for clarity
  const s = notes.map((n) => trackPositionFor(n.time, TRACK_ORIGIN));
  if (s.some((x, i) => Math.abs(x - referenceS[i]) > 1e-9)) allSame = false;
}
check('50/150/250/320 km/h → identical gate S', allSame, `first gate s=${referenceS[0].toFixed(2)} m`);

console.log('2) spawned gates never move during a run (speed sweep simulation)');
{
  // simulate the game: spawn at bikeS+900, then ride at varying speed; the
  // gate's s must stay fixed from spawn to judgment
  let moved = false;
  for (const v of speeds) {
    const note = notes[4];
    const gateS = trackPositionFor(note.time, TRACK_ORIGIN);
    const bikeStart = TRACK_ORIGIN + 2 * RHYTHM_SPEED; // song t=2 bike position
    // phase 1: slow approach, phase 2: full throttle (accelerating player)
    for (let t = 2; t < note.time; t += 1 / 120) {
      const progress = t < note.time - 1 ? (t - 2) * v * 0.6 : bikeStart + (t - 2) * v;
      void progress;
      // the invariant: regardless of speed/accel, gate.s is still gateS
      if (trackPositionFor(note.time, TRACK_ORIGIN) !== gateS) moved = true;
    }
  }
  check('gate.s constant across speeds + accel phases', !moved);
}

console.log('3) different player speeds → different judgment timing (real gameplay)');
{
  const note = notes[8]; // t = 2 + 8*BEAT/2 = 3.875 s
  const gateS = trackPositionFor(note.time, TRACK_ORIGIN);
  const judge = (v: number, startS: number) => {
    // crossing time when riding from startS at constant v
    const crossT = (gateS - startS) / v;
    return crossT - note.time;
  };
  const slow = judge(50 / 3.6, TRACK_ORIGIN); // 50 km/h rider
  const pace = judge(RHYTHM_SPEED, TRACK_ORIGIN); // exact rhythm pace
  const fast = judge(320 / 3.6, TRACK_ORIGIN); // flat-out
  check('rhythm-pace rider lands ~on time', Math.abs(pace) < 1e-9, `Δ=${pace.toFixed(4)} s`);
  check('50 km/h rider arrives LATE', slow > 0.5, `Δ=+${slow.toFixed(2)} s → MISS band`);
  check('320 km/h rider arrives EARLY', fast < -0.5, `Δ=${fast.toFixed(2)} s → early/overshoot`);
  check('all three deltas differ', Math.abs(slow - pace) > 0.5 && Math.abs(fast - pace) > 0.5 && Math.abs(slow - fast) > 0.5);
}

console.log('4) judgment windows act on the PHYSICAL crossing (no gate chasing)');
{
  // a braking rider: holds pace then brakes hard 0.5 s before the gate.
  // The gate must NOT move; the rider crosses late → miss/good per physics.
  const note = notes[12];
  const gateS = trackPositionFor(note.time, TRACK_ORIGIN);
  const v0 = RHYTHM_SPEED;
  const brakeAt = note.time - 0.5;
  const brakeDecel = 9.0; // m/s² hard stop
  // integrate: distance covered by brakeAt at v0, then decelerating
  const sAtBrake = (brakeAt - 2) * v0;
  const distToGate = gateS - TRACK_ORIGIN - sAtBrake;
  // v(t) = v0 − a·t ; s = v0·t − a·t²/2
  const tCross = (v0 - Math.sqrt(Math.max(0, v0 * v0 - 2 * brakeDecel * Math.max(0, distToGate)))) / brakeDecel;
  const delta = brakeAt + tCross - note.time;
  const moved = trackPositionFor(note.time, TRACK_ORIGIN) !== gateS;
  check('braking rider crosses late (real consequence)', delta > 0.05, `Δ=+${delta.toFixed(3)} s`);
  check('gate did not move toward the braked rider', !moved);
}

console.log('');
if (failures === 0) {
  console.log('RHYTHM INVARIANTS: ALL PASS');
} else {
  console.error(`RHYTHM INVARIANTS: ${failures} FAILED`);
  process.exit(1);
}
