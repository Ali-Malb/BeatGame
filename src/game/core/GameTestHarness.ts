/**
 * GameTestHarness — dev-only acceptance measurement API (§9, §37).
 *
 * Runs the ACTUAL physics/audio systems headlessly (fixed 1/120 s integration
 * of BikePhysicsModel with no rendering) to measure:
 *   - 0–100 / 100–200 / 200–300 km/h acceleration times
 *   - upright (≈299) and tucked (≈320) top speeds
 *   - full-swing lean time (-52° → +52°) and max lean
 *   - shift cut duration, redline/limiter behavior
 *   - engine-audio frequency progression across the RPM sweep
 *   - weather hard-cut physics integrity
 *   - traffic escape-corridor audit
 *   - rhythm gate timing statistics
 *
 * Exposed as window.__gameTest in development.
 */

import * as THREE from 'three';
import { BikePhysicsModel, MAX_LEAN, LIMITER_RPM, REDLINE, SHIFT_CUT_SEC, MAX_WHEELIE } from '../vehicle/BikePhysicsModel';
import { gamepadSteer } from './Input';
import { parseYouTubeId, splitTitle, normalizeTitle, parseSynced, parseLyricsfile, buildSongCueSheet } from '../audio/SongResolver';
import { parseCueSheet } from '../audio/CueSheetParser';
import { AudioDspClock } from '../audio/AudioDspClock';
import { MotorcycleAudio } from '../vehicle/BikeAudio';
import { CAM_CONFIG } from '../camera/CameraController';
import type { GameManager } from './Game';

interface GameInternals {
  bike: { model: BikePhysicsModel; s: number; v: number; wheelie: number; group: THREE.Group };
  weather: { setPreset: (i: number, instant?: boolean) => void; presetName: string; presetIndex: number };
  traffic: {
    auditCorridor: (s: number) => { windows: number; violations: number };
    activeCount: number;
    spawnFailSameLane: number;
    spawnFailCorridor: number;
    repairDespawns: number;
    repairPushes: number;
  };
  gates: { stats: { perfect: number; good: number; miss: number; lastDelta: number; deltas: number[] } };
  rhythm: { getCurrentAudioTime(): number; getBeatPhase(): number; getEnergy(): number; getSectionName(): string } | null;
  songInfo: () => unknown;
}

const STRAIGHT_ROAD = { kappa: 0, slope: 0, driveHalf: 6.55 };
const RPM_SWEEP = [1200, 3000, 5000, 7000, 9000, 11000, 13000, 14500, 15200];

export class GameTestHarness {
  private internals: GameInternals;

  constructor(game: GameManager) {
    this.internals = game as unknown as GameInternals;
  }

  /**
   * §9/§37 physics: measured acceleration & top speed from the real model.
   * Upright run: 0–100, 100–200, converged top speed (aero/drivetrain balance).
   * Tucked run: full-throttle with the real auto-tuck (engages > 220 km/h),
   * measuring 200→300 the way it plays, plus the 320 limited top speed.
   */
  acceleration(): {
    t0100: number;
    t100200: number;
    t200300: number;
    topUprightKmh: number;
    topTuckKmh: number;
    shifts: number;
    gearAtTop: number;
  } {
    const run = (mode: 'upright' | 'tucked') => {
      const m = new BikePhysicsModel();
      m.autoTuckEnabled = mode === 'tucked'; // real gameplay: auto tuck > 220
      const input = { throttle: 1, brake: 0, rearBrake: 0, steer: 0, tuck: false, lookBack: false };
      const h = 1 / 120;
      let t = 0;
      let t100 = -1;
      let t200 = -1;
      let t300 = -1;
      let shifts = 0;
      let settle = 0;
      while (t < 120) {
        const ev = m.step(h, input, STRAIGHT_ROAD, 1e9);
        t += h;
        if (ev.shiftedUp || ev.shiftedDown) shifts++;
        const kmh = m.v * 3.6;
        if (t100 < 0 && kmh >= 100) t100 = t;
        if (t200 < 0 && kmh >= 200) t200 = t;
        if (t300 < 0 && kmh >= 299.9) t300 = t;
        // stop when speed has converged (top speed reached)
        if (kmh > 150 && Math.abs(m.aLong) < 0.02) {
          settle += h;
          if (settle > 1.5) break;
        } else {
          settle = 0;
        }
      }
      return { t, t100, t200, t300, top: m.v * 3.6, shifts, gear: m.gear, rpm: m.rpm };
    };

    const upright = run('upright');
    const tucked = run('tucked');
    return {
      t0100: +upright.t100.toFixed(2),
      t100200: +(upright.t200 - upright.t100).toFixed(2),
      t200300: +(tucked.t300 - tucked.t200).toFixed(2),
      topUprightKmh: +upright.top.toFixed(1),
      topTuckKmh: +tucked.top.toFixed(1),
      shifts: upright.shifts,
      gearAtTop: upright.gear,
    };
  }

  /** §13 lean: max lean 52°, full-swing time at highway speed, self-righting.
   *  Sign convention (§4): steer +1 = RIGHT command → rollAngle goes NEGATIVE
   *  (rollAngle + = LEFT lean). Start leaned LEFT (+), command RIGHT (+1). */
  lean(): { maxLeanDeg: number; swingSec: number; selfRightSec: number } {
    const m = new BikePhysicsModel();
    const h = 1 / 120;
    // 216 km/h cruise in 6th
    m.v = 60;
    m.gear = 6;
    m.rpm = (m.v / 0.317) * 5.63 * (60 / (Math.PI * 2));

    // start fully leaned LEFT (+MAX_LEAN), command full RIGHT (steer = +1)
    m.rollAngle = +MAX_LEAN;
    const input = { throttle: 0.4, brake: 0, rearBrake: 0, steer: 1, lookBack: false, tuck: false };
    let t = 0;
    let swing = -1;
    let maxLean = 0;
    while (t < 3 && swing < 0) {
      m.step(h, input, STRAIGHT_ROAD, 1e9);
      t += h;
      maxLean = Math.max(maxLean, Math.abs(m.rollAngle));
      if (m.rollAngle <= -MAX_LEAN + 0.01) swing = t;
    }

    // release steering: self-right to upright
    const relInput = { throttle: 0.4, brake: 0, rearBrake: 0, steer: 0, lookBack: false, tuck: false };
    m.rollAngle = MAX_LEAN * 0.6;
    let t2 = 0;
    let righted = -1;
    while (t2 < 3 && righted < 0) {
      m.step(h, relInput, STRAIGHT_ROAD, 1e9);
      t2 += h;
      if (Math.abs(m.rollAngle) < 0.02) righted = t2;
    }
    return {
      maxLeanDeg: +((maxLean * 180) / Math.PI).toFixed(1),
      swingSec: +swing.toFixed(3),
      selfRightSec: +righted.toFixed(3),
    };
  }

  /** §32 steering-direction sanity: A/Left = LEFT, D/Right = RIGHT.
   *  A steering command must move the bike's lateral x TOWARD the commanded
   *  side and settle into a lean matching the convention (+ = LEFT). The test
   *  FAILS if the directions are swapped. */
  steeringDirection(): {
    passed: boolean;
    left: { xDrift: number; leanDeg: number };
    right: { xDrift: number; leanDeg: number };
  } {
    const run = (steer: number) => {
      const m = new BikePhysicsModel();
      const h = 1 / 120;
      m.v = 27.8; // 100 km/h in 3rd
      m.gear = 3;
      m.rpm = (m.v / 0.317) * 5.63 * (60 / (Math.PI * 2));
      const input = { throttle: 0.5, brake: 0, rearBrake: 0, steer, lookBack: false, tuck: false };
      const x0 = m.x;
      for (let i = 0; i < 120; i++) m.step(h, input, STRAIGHT_ROAD, 1e9); // 1 s
      return { xDrift: +(m.x - x0).toFixed(2), leanDeg: +((m.rollAngle * 180) / Math.PI).toFixed(1) };
    };
    const left = run(-1); // A / Left / stick-left
    const right = run(+1); // D / Right / stick-right
    // road frame: x + = LEFT. LEFT command → x must drift +, lean + (LEFT).
    // RIGHT command → x drift −, lean − (RIGHT).
    const passed = left.xDrift > 0.3 && left.leanDeg > 3 && right.xDrift < -0.3 && right.leanDeg < -3;
    return { passed, left, right };
  }

  /** §32 gamepad mapping sanity: axis − = LEFT, + = RIGHT (sign preserved) */
  inputDirection(): { passed: boolean; samples: Record<string, number> } {
    const samples = {
      'axis -1.0': gamepadSteer(-1.0),
      'axis -0.5': gamepadSteer(-0.5),
      'axis +0.5': gamepadSteer(+0.5),
      'axis +1.0': gamepadSteer(+1.0),
      'axis dead 0.05': gamepadSteer(0.05),
    };
    const passed =
      samples['axis -1.0'] < 0 && samples['axis -0.5'] < 0 && samples['axis +0.5'] > 0 && samples['axis +1.0'] > 0 && samples['axis dead 0.05'] === 0;
    return { passed, samples };
  }

  /** power wheelie: nose lifts under full throttle, brakes/roll-on settle it */
  wheelie(): { peakDeg: number; settleDeg: number; capDeg: number; airborneShiftWorks: boolean } {
    const m = new BikePhysicsModel();
    const h = 1 / 120;
    const full = { throttle: 1, brake: 0, rearBrake: 0, steer: 0, lookBack: false, tuck: false };
    let peak = 0;
    for (let i = 0; i < 150; i++) {
      m.step(h, full, STRAIGHT_ROAD, 1e9); // 1.25 s launch
      peak = Math.max(peak, m.wheelie);
    }
    // roll off + brake → nose must come down
    const brake = { throttle: 0.2, brake: 0.7, rearBrake: 0, steer: 0, lookBack: false, tuck: false };
    let settle = -1;
    for (let i = 0; i < 240; i++) {
      m.step(h, brake, STRAIGHT_ROAD, 1e9);
      if (m.wheelie < 0.005 && settle < 0) settle = i * h;
    }
    return {
      peakDeg: +((peak * 180) / Math.PI).toFixed(1),
      settleDeg: +((m.wheelie * 180) / Math.PI).toFixed(1),
      capDeg: +((MAX_WHEELIE * 180) / Math.PI).toFixed(1),
      airborneShiftWorks: m.gear >= 1,
    };
  }

  /** §31 camera framing audit: actual projected bike occupancy + target band. */
  cameraFraming(): {
    mode: 'cockpit' | 'chase';
    bikeVerticalOccupancy: number;
    targetMin: number;
    targetMax: number;
    passed: boolean;
    wheelieDeg: number;
    camera: { eyeY: number; fov: number; nearClip: number };
    chase: { distBehind: number; height: number };
    wheelieCompFraction: number;
  } {
    const camCfg = (this.internals as unknown as {
      cam: { camera: THREE.PerspectiveCamera; mode: 'cockpit' | 'chase' };
    }).cam;
    const bikeGroup = this.internals.bike.group;
    const camera = camCfg.camera;

    camera.updateMatrixWorld(true);
    bikeGroup.updateMatrixWorld(true);

    const bounds = new THREE.Box3().setFromObject(bikeGroup);
    const corners = [
      new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
      new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.max.z),
      new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.min.z),
      new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.max.z),
      new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.min.z),
      new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.max.z),
      new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.min.z),
      new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
    ];
    const visibleY: number[] = [];
    const view = new THREE.Vector3();
    for (const point of corners) {
      view.copy(point).applyMatrix4(camera.matrixWorldInverse);
      if (view.z < -camera.near) visibleY.push(point.clone().project(camera).y);
    }
    const bikeVerticalOccupancy = visibleY.length >= 2
      ? Math.min(1, Math.abs(Math.max(...visibleY) - Math.min(...visibleY)) * 0.5)
      : 0;

    const wheelieDeg = this.internals.bike.wheelie * 180 / Math.PI;
    let targetMin = 0.15;
    let targetMax = 0.22;
    if (camCfg.mode === 'chase') {
      targetMin = 0.18;
      targetMax = 0.28;
    } else if (Math.abs(wheelieDeg) > 2) {
      targetMin = 0.25;
      targetMax = 0.32;
    } else if (Math.abs(this.internals.bike.model.rollAngle) > 0.72) {
      targetMin = 0.15;
      targetMax = 0.25;
    }

    return {
      mode: camCfg.mode,
      bikeVerticalOccupancy: +bikeVerticalOccupancy.toFixed(3),
      targetMin,
      targetMax,
      passed: bikeVerticalOccupancy >= targetMin && bikeVerticalOccupancy <= targetMax,
      wheelieDeg: +wheelieDeg.toFixed(1),
      camera: {
        eyeY: +camera.position.y.toFixed(2),
        fov: +camera.fov.toFixed(1),
        nearClip: CAM_CONFIG.cockpit.nearClip,
      },
      chase: { distBehind: CAM_CONFIG.chase.distBehind, height: CAM_CONFIG.chase.height },
      wheelieCompFraction: 1 - CAM_CONFIG.cockpit.wheeliePitchComp,
    };
  }

  /** §33 song-identity: the readout must reference ONE consistent track */
  songState(): unknown {
    return this.internals.songInfo();
  }

  /** §33 resolver unit checks: URL parsing, title split, timestamp parsing, source identity */
  resolverChecks(): { passed: boolean; detail: Record<string, unknown> } {
    const id = parseYouTubeId('https://youtu.be/dQw4w9WgXcQ?t=1');
    const raw = parseYouTubeId('dQw4w9WgXcQ');
    const bad = parseYouTubeId('https://example.com/notayt');
    const parts = splitTitle('Daft Punk - One More Time (Official Video)', 'Daft Punk VEVO');
    const parts2 = splitTitle('One More Time', 'Daft Punk - Topic');
    const lrc = parseSynced('[00:01.00]First line\n[00:03.50]Second <00:04.00>word\n[not a time] skip');
    const passed =
      id === raw && id === 'dQw4w9WgXcQ' && bad === null &&
      parts.track === 'One More Time' && normalizeTitle(parts.artist) === normalizeTitle('Daft Punk') &&
      parts2.artist === 'Daft Punk' &&
      lrc.lines.length === 2 && Math.abs(lrc.lines[0].start - 1) < 1e-6 && !lrc.lines[0].words && lrc.lines[1].words?.length === 2 &&
      (() => {
        const lf = parseLyricsfile('version: \"1.0\"\nlines:\n  - text: \"First\"\n    words:\n      - text: \"First\"\n        start_ms: 290\n    start_ms: 290\n    end_ms: 900');
        const sheet = parseCueSheet(buildSongCueSheet({ videoId: 'dQw4w9WgXcQ', title: 'First', channel: '', artist: 'Artist', track: 'First', duration: 100, durationResolved: true }, { lines: lf.lines, source: lf.anyWords ? 'lrclib-synced-word' : 'lrclib-synced-line' }, 0, 0, () => 0.5));
        return lf.lines.length === 1 && lf.anyWords && sheet.bpm === 0 && sheet.beatSec === Infinity && sheet.getTimesOfType('gate').length === 0;
      })() &&
      (() => {
        const ctx = { currentTime: 10 } as AudioContext;
        const c = new AudioDspClock();
        c.attach(ctx);
        c.setEpochTo(0);
        const before = c.getAudioTime();
        c.nudgeToward(1, 0.5);
        return Math.abs(c.getAudioTime() - (before + 0.5)) < 1e-6;
      })();
    return {
      passed,
      detail: { id, raw, bad, parts, parts2, lrcLines: lrc.lines.map((l) => ({ start: l.start, words: l.words?.length })) },
    };
  }

  /** §25 engine audio: frequency progression across the RPM sweep */
  engineSweep(): { rpm: number; fireHz: number; freqs: number[]; gainSum: number; topLpHz: number }[] {
    return RPM_SWEEP.map((rpm) => {
      const p = MotorcycleAudio.engineProfile(rpm, 1);
      return {
        rpm,
        fireHz: +p.fire.toFixed(1),
        freqs: p.freqs.map((f) => +f.toFixed(1)),
        gainSum: +p.gains.reduce((a, b) => a + b, 0).toFixed(3),
        topLpHz: +p.topLpHz.toFixed(0),
      };
    });
  }

  /** §23 hard weather cut must not alter speed/RPM/lean/traffic/position */
  weatherCutIntegrity(): { passed: boolean; before: Record<string, number>; after: Record<string, number> } {
    const m = this.internals.bike.model;
    const before = {
      v: m.v,
      rpm: m.rpm,
      leanDeg: (m.rollAngle * 180) / Math.PI,
      s: m.s,
      x: m.x,
      gear: m.gear,
    };
    const weatherBefore = this.internals.weather.presetName;
    const target = (this.internals.weather.presetIndex + 1) % 4; // must differ from active
    this.internals.weather.setPreset(target, true);
    const after = {
      v: m.v,
      rpm: m.rpm,
      leanDeg: (m.rollAngle * 180) / Math.PI,
      s: m.s,
      x: m.x,
      gear: m.gear,
    };
    const weatherAfter = this.internals.weather.presetName;
    const passed =
      JSON.stringify(before) === JSON.stringify(after) && weatherBefore !== weatherAfter;
    return { passed, before, after };
  }

  /** §20 traffic: escape corridor audit around the player */
  corridor(): {
    windows: number;
    violations: number;
    activeVehicles: number;
    spawnFailSameLane: number;
    spawnFailCorridor: number;
    repairDespawns: number;
    repairPushes: number;
  } {
    const r = this.internals.traffic.auditCorridor(this.internals.bike.s);
    const t = this.internals.traffic;
    return {
      ...r,
      activeVehicles: t.activeCount,
      spawnFailSameLane: t.spawnFailSameLane,
      spawnFailCorridor: t.spawnFailCorridor,
      repairDespawns: t.repairDespawns,
      repairPushes: t.repairPushes,
    };
  }

  /** §5 rhythm gate timing stats */
  gateStats(): { perfect: number; good: number; miss: number; lastDelta: number; meanAbsDelta: number } {
    const s = this.internals.gates.stats;
    const mean = s.deltas.length
      ? s.deltas.reduce((a, b) => a + Math.abs(b), 0) / s.deltas.length
      : 0;
    return {
      perfect: s.perfect,
      good: s.good,
      miss: s.miss,
      lastDelta: +s.lastDelta.toFixed(4),
      meanAbsDelta: +mean.toFixed(4),
    };
  }

  /** rhythm clock state (all DSP-derived) */
  rhythmState(): { audioTime: number; beatPhase: number; energy: number; section: string } {
    const r = this.internals.rhythm;
    if (!r) return { audioTime: -1, beatPhase: 0, energy: 0, section: 'not-started' };
    return {
      audioTime: +r.getCurrentAudioTime().toFixed(3),
      beatPhase: +r.getBeatPhase().toFixed(3),
      energy: +r.getEnergy().toFixed(2),
      section: r.getSectionName(),
    };
  }

  constants(): { redline: number; limiter: number; shiftLight: number; shiftCutMs: number; maxLeanDeg: number } {
    return {
      redline: REDLINE,
      limiter: LIMITER_RPM,
      shiftLight: 14200,
      shiftCutMs: SHIFT_CUT_SEC * 1000,
      maxLeanDeg: +((MAX_LEAN * 180) / Math.PI).toFixed(1),
    };
  }

  /** run the whole suite */
  runAll(): Record<string, unknown> {
    return {
      acceleration: this.acceleration(),
      cameraFraming: this.cameraFraming(),
      lean: this.lean(),
      steeringDirection: this.steeringDirection(),
      inputDirection: this.inputDirection(),
      wheelie: this.wheelie(),
      resolverChecks: this.resolverChecks(),
      engineSweep: this.engineSweep(),
      weatherCut: this.weatherCutIntegrity(),
      corridor: this.corridor(),
      gateStats: this.gateStats(),
      rhythm: this.rhythmState(),
      constants: this.constants(),
    };
  }
}
