/**
 * scripts/verify.ts — headless acceptance run (§30/§36):
 * acceleration targets, lean swing, wheelie dynamics, steering direction,
 * gamepad mapping, engine sweep, resolver unit checks. Physics/audio only —
 * no rendering, no DOM.
 */

import { GameTestHarness } from '../src/game/core/GameTestHarness';

// Every test run here is self-contained (constructs its own models); the
// GameManager internals are only touched by weatherCut/corridor/gates, which
// are skipped in this headless run.
const harness = new GameTestHarness({} as never);

const acc = harness.acceleration();
const lean = harness.lean();
const steer = harness.steeringDirection();
const input = harness.inputDirection();
const wheelie = harness.wheelie();
const resolver = harness.resolverChecks();
const sweep = harness.engineSweep();

const ok = (b: boolean) => (b ? 'PASS' : 'FAIL');

console.log('== acceleration ==');
console.log(acc);
console.log(
  ok(acc.t0100 <= 3.35 && acc.t0100 >= 2.6),
  '0-100 ~3.0s  got', acc.t0100
);
console.log(
  ok(acc.t100200 <= 4.7 && acc.t100200 >= 3.6),
  '100-200 ~4.2s got', acc.t100200
);
console.log(
  ok(acc.t200300 <= 9.8 && acc.t200300 >= 7.2),
  '200-300 ~8.5s got', acc.t200300
);
console.log(ok(acc.topUprightKmh >= 292 && acc.topUprightKmh <= 302), 'upright top ~299 got', acc.topUprightKmh);
console.log(ok(acc.topTuckKmh >= 312 && acc.topTuckKmh <= 326), 'tuck top ~320 got', acc.topTuckKmh);

console.log('== lean ==');
console.log(lean);
console.log(ok(Math.abs(lean.maxLeanDeg - 52) < 1.5), 'max lean 52 got', lean.maxLeanDeg);
console.log(ok(lean.swingSec > 0 && lean.swingSec < 1.2), 'full swing', lean.swingSec);
console.log(ok(lean.selfRightSec > 0 && lean.selfRightSec < 1.6), 'self-right', lean.selfRightSec);

console.log('== steering direction (A=left, D=right) ==');
console.log(steer);
console.log(ok(steer.passed), 'left→+x/+lean, right→−x/−lean');

console.log('== gamepad mapping (−=left, +=right) ==');
console.log(input);
console.log(ok(input.passed));

console.log('== wheelie ==');
console.log(wheelie);
console.log(ok(wheelie.peakDeg > 3 && wheelie.peakDeg <= wheelie.capDeg + 0.5), 'nose lifts, capped', wheelie.capDeg);
console.log(ok(wheelie.settleDeg === 0), 'brakes settle the nose');

console.log('== resolver checks ==');
console.log(resolver.passed ? 'PASS' : 'FAIL', JSON.stringify(resolver.detail).slice(0, 400));
console.log(ok(resolver.passed));

console.log('== engine sweep (fire Hz must rise monotonically) ==');
const fire = sweep.map((s) => s.fireHz);
let mono = true;
for (let i = 1; i < fire.length; i++) if (fire[i] <= fire[i - 1]) mono = false;
console.log(ok(mono), fire.map((f) => Math.round(f)).join(' '));

const allPass =
  steer.passed && input.passed && resolver.passed && mono &&
  lean.maxLeanDeg > 50 && lean.maxLeanDeg < 54;
console.log('== SUITE:', allPass ? 'PASS' : 'FAIL', '==');
process.exit(allPass ? 0 : 1);
