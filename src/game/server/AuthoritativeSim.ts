/**
 * server/AuthoritativeSim.ts — the server-owned simulation for remote play.
 *
 * This is NOT a re-implementation and NOT a recorded replay: it constructs the
 * real world and simulation modules (RoadSpline, Highway, BikeController with
 * the real BikePhysicsModel, TrafficManager with its escape-corridor solver,
 * RhythmGates with the swept crossing judgment, CameraController, Scoring) and
 * steps them on a fixed 1/120 s substep grid.
 *
 * Authority rules mirrored from the local game:
 *   - the song clock belongs to the simulation (here: the server),
 *   - gate positions are a pure function of note time (trackPositionFor),
 *   - judgments come from the swept gate crossing, never from frame timing.
 *
 * The rhythm chart itself (a beatmap: note times + lanes) is produced
 * client-side by the deterministic DSP analysis and uploaded with the session,
 * exactly like a beatmap upload — the server then owns clock, spacing and
 * judgment.
 */

import './shimInstall';

import * as THREE from 'three';
import { Highway } from '../environment/Highway';
import { TrafficManager } from '../traffic/TrafficManager';
import { BikeController } from '../vehicle/BikeController';
import { CameraController } from '../camera/CameraController';
import { RhythmGates, type GateEvent } from '../rhythm/RhythmGates';
import type { RhythmChart, ChartNote } from '../rhythm/RhythmChart';
import { Scoring, type Judgment } from '../core/Scoring';
import { RHYTHM_SPEED } from '../rhythm/trackPosition';
import { BIOME_NAMES } from '../environment/Biomes';
import { districtKindAt, DISTRICT_NAMES } from '../environment/districts';
import { clamp } from '../core/utils';
import { smoothInput, createInputState, type InputState } from '../runtime/InputState';
import type {
  JudgmentEvent,
  RuntimeAction,
  RuntimeState,
  SimSnapshot,
  SnapshotCar,
  SnapshotGate,
} from '../runtime/types';

/** beatmap payload uploaded by the client with the session */
export interface SimChartPayload {
  notes: { time: number; lane: number; type?: string; strength?: number; subdivision?: number }[];
  bpm: number;
  duration: number;
  firstBeat: number;
  beatSec: number;
  sections: { start: number; end: number; kind: string; energy: number }[];
}

export interface SimStartOptions {
  countdownSec?: number;
  /** song the client plays locally while the server owns the clock */
  music?: { source: 'youtube' | 'upload' | 'demo' | 'none'; title: string; streamUrl: string | null };
  /** starting pace (m/s) — rhythm runs launch at the rhythm pace */
  startSpeed?: number;
  startLane?: number;
}

const SUBSTEP = 1 / 120;
const MAX_SUBSTEPS = 12;
const SECTION_BIOME_CYCLE: Array<0 | 1 | 2 | 3> = [0, 2, 1, 3];
/** gates are authored at the nominal rhythm pace; the sim runs at real pace */
const TRACK_ORIGIN = 60;

export class AuthoritativeSim {
  readonly highway: Highway;
  readonly scene = new THREE.Scene();
  readonly bike: BikeController;
  readonly traffic: TrafficManager;
  readonly gates: RhythmGates;
  readonly cam: CameraController;
  readonly scoring = new Scoring();

  state: RuntimeState = 'idle';
  /** authoritative song clock (s). Negative during the countdown. */
  songTime = -3;
  songDuration = 0;
  tick = 0;

  private chart: RhythmChart | null = null;
  private sections: SimChartPayload['sections'] = [];
  private countdownSec = 3;
  private input = createInputState();
  private rawInput = createInputState();
  private camInput = { lookBack: false, tuck: false, accel: 0, brakeInput: 0 };
  private appliedBiome = 2;
  private lastSectionIndex = -1;
  private simTime = 0;
  private chunkTimer = 0;
  private lastJudgment: JudgmentEvent | null = null;
  private judgmentSerial = 0;
  private music: SimStartOptions['music'] = { source: 'none', title: '', streamUrl: null };
  private startLane = 2;
  private crashedOut = false;
  private disposed = false;

  constructor(seed = 90210) {
    this.highway = new Highway(this.scene);
    this.bike = new BikeController(this.highway, this.scene);
    this.traffic = new TrafficManager(this.highway, this.scene);
    this.gates = new RhythmGates(this.scene, this.highway);
    this.cam = new CameraController(this.scene, 16 / 9);
    this.cam.attachMirrors(this.bike);
    this.traffic.onCollision = () => this.handleImpact();
    this.traffic.gateGuard = (lane, s, playerS, playerV) => this.gateZoneFree(lane, s, playerS, playerV);
    void seed;
  }

  // ------------------------------------------------------------------- setup ----

  /** the ±1.5 s window around an upcoming gate must stay drivable (§28) */
  private gateZoneFree(lane: number, s: number, playerS: number, playerV: number): boolean {
    const travelling = s - playerS;
    if (travelling < 0 || playerV < 5) return true;
    const eta = travelling / Math.max(playerV, 1);
    if (eta > 3.5) return true;
    const info = this.gates.nextNoteS(playerS);
    if (!info || info.lane !== lane) return true;
    const noteEta = (info.s - playerS) / Math.max(playerV, 1);
    return Math.abs(noteEta - eta) > 1.5;
  }

  loadChart(payload: SimChartPayload | null): void {
    if (!payload || !payload.notes?.length) {
      this.chart = null;
      this.sections = [];
      this.songDuration = payload?.duration ?? 0;
      return;
    }
    const notes: ChartNote[] = payload.notes.map((n) => ({
      time: n.time,
      lane: Math.max(0, Math.min(3, Math.round(n.lane))),
      subdivision: (n.subdivision ?? 4) as ChartNote['subdivision'],
      strength: n.strength ?? 1,
      type: (n.type ?? 'kick') as ChartNote['type'],
    }));
    const sections = (payload.sections ?? []).map((s) => ({
      start: s.start,
      end: s.end,
      energy: s.energy ?? 0.5,
      kind: (s.kind ?? 'verse') as never,
    }));
    this.chart = {
      notes,
      bpm: payload.bpm,
      firstBeat: payload.firstBeat,
      beatSec: payload.beatSec || 60 / Math.max(1, payload.bpm),
      duration: payload.duration,
      sections: sections as never,
    };
    this.sections = payload.sections ?? [];
    this.songDuration = payload.duration;
  }

  start(opts: SimStartOptions = {}): void {
    this.countdownSec = opts.countdownSec ?? 3;
    this.music = opts.music ?? { source: 'none', title: '', streamUrl: null };
    this.scoring.reset();
    this.lastJudgment = null;
    this.crashedOut = false;
    this.appliedBiome = 2;
    this.lastSectionIndex = -1;
    this.input = createInputState();
    this.rawInput = createInputState();

    // rhythm runs launch at pace so the first authored notes are reachable
    this.startLane = opts.startLane ?? 2;
    this.bike.launchAtPace(TRACK_ORIGIN, this.startLane, opts.startSpeed ?? RHYTHM_SPEED);
    this.gates.setChart(this.chart, TRACK_ORIGIN);
    this.gates.reset();
    this.traffic.reset(this.bike.s);
    this.songTime = -this.countdownSec;
    this.tick = 0;
    this.state = 'countdown';
  }

  // ------------------------------------------------------------------- input ----

  /** raw normalized input (keyboard/gamepad/touch/remote all look the same here) */
  setInput(state: InputState): void {
    this.rawInput.steer = state.steer;
    this.rawInput.throttle = state.throttle;
    this.rawInput.brake = state.brake;
    this.rawInput.rearBrake = state.rearBrake;
    this.rawInput.tuck = state.tuck;
    this.rawInput.lookBack = state.lookBack;
  }

  action(a: RuntimeAction): void {
    if (this.state === 'error' || this.state === 'ended') return;
    switch (a.type) {
      case 'pause':
        if (this.state === 'playing' || this.state === 'countdown') this.state = 'paused';
        break;
      case 'resume':
        if (this.state === 'paused') this.state = this.songTime < 0 ? 'countdown' : 'playing';
        break;
      case 'restart':
        this.start({ countdownSec: this.countdownSec, music: this.music });
        break;
      case 'camera':
        this.cam.toggle();
        break;
      case 'menu':
        this.state = 'ended';
        break;
    }
  }

  // -------------------------------------------------------------------- step ----

  /** advance the simulation by a real-time delta (seconds) */
  step(dtReal: number): void {
    if (this.disposed) return;
    if (this.state !== 'countdown' && this.state !== 'playing' && this.state !== 'failed') return;
    const dt = Math.min(0.25, Math.max(0, dtReal));
    this.simTime += dt;

    if (this.state === 'failed') {
      this.bike.updateVisuals(dt, this.simTime, this.cam.mode === 'cockpit');
      this.cam.update(dt, this.bike, this.camInput);
      return;
    }

    // authoritative music clock: the simulation owns song time
    this.songTime += dt;
    if (this.state === 'countdown' && this.songTime >= 0) this.state = 'playing';

    smoothInput(this.input, this.rawInput, dt);

    // ---- fixed-step physics with CCD substeps (same grid as the local game)
    let remaining = dt;
    let steps = 0;
    const snapshotInput = {
      throttle: this.input.throttle,
      brake: this.input.brake,
      rearBrake: this.input.rearBrake,
      steer: this.input.steer,
      tuck: this.input.tuck,
      lookBack: this.input.lookBack,
    };
    while (remaining > 1e-6 && steps < MAX_SUBSTEPS) {
      const sub = Math.min(SUBSTEP, remaining);
      if (this.state === 'playing') {
        this.bike.step(sub, snapshotInput);
        if (this.bike.crashed) {
          // the server resolves scrapes instantly: traffic damage, not a wipeout
          this.bike.uncrash(this.bike.s, this.startLane, 22);
        }
      }
      if (this.traffic.collideAndScore(this.bike, sub)) {
        this.handleImpact();
      }
      remaining -= sub;
      steps++;
    }

    this.tick++;
    this.traffic.update(dt, this.bike.s, this.bike.v);
    this.scoring.tick(dt);

    // stream world chunks at 2 Hz so the server scene really contains the
    // expressway around the bike (the renderer draws whatever is in there)
    this.chunkTimer += dt;
    if (this.chunkTimer >= 0.5) {
      this.highway.update(this.bike.s, this.chunkTimer);
      this.chunkTimer = 0;
    }

    if (this.state === 'playing') {
      const events = this.gates.update(dt, this.songTime, this.bike.s, this.bike.v, this.bike.x);
      if (events.length) this.handleGateEvents(events);
      this.updateBiome();
    }

    this.bike.updateVisuals(dt, this.simTime, this.cam.mode === 'cockpit');
    this.camInput.accel = this.input.throttle;
    this.camInput.brakeInput = this.input.brake;
    this.camInput.tuck = this.input.tuck;
    this.camInput.lookBack = this.input.lookBack;
    this.cam.update(dt, this.bike, this.camInput);

    // ---- terminal conditions (server authority)
    if (this.state === 'playing') {
      if (this.scoring.dead && !this.crashedOut) {
        this.crashedOut = true;
        this.bike.crash();
        this.state = 'failed';
      } else if (this.songDuration > 0 && this.songTime > this.songDuration) {
        this.state = this.scoring.hp > 0 ? 'victory' : 'failed';
      }
    }
  }

  private handleImpact(): void {
    if (this.state !== 'playing') return;
    const damaged = this.scoring.applyCrash(0.4);
    if (!damaged) return;
    this.bike.model.v *= 0.4;
    this.pushJudgment('miss', 0, -1, this.scoring.hp <= 0);
  }

  private handleGateEvents(events: GateEvent[]): void {
    for (const ev of events) {
      const judgment: Judgment = ev.judgment;
      this.scoring.addJudgment(judgment);
      this.pushJudgment(judgment, ev.delta, ev.note.lane, this.scoring.dead);
      if (this.scoring.dead) break;
    }
  }

  private pushJudgment(judgment: Judgment, delta: number, lane: number, dead: boolean): void {
    this.lastJudgment = { judgment, delta, lane, at: Date.now() };
    this.judgmentSerial++;
    if (dead && !this.crashedOut) {
      this.crashedOut = true;
      this.bike.crash();
      this.state = 'failed';
    }
  }

  private updateBiome(): void {
    if (!this.sections.length) return;
    let idx = 0;
    for (let i = 0; i < this.sections.length; i++) {
      if (this.songTime >= this.sections[i].start) idx = i;
      else break;
    }
    if (idx !== this.lastSectionIndex) {
      const first = this.lastSectionIndex === -1;
      this.lastSectionIndex = idx;
      this.appliedBiome = first ? SECTION_BIOME_CYCLE[0] : SECTION_BIOME_CYCLE[idx % SECTION_BIOME_CYCLE.length];
    }
  }

  // ---------------------------------------------------------------- snapshot ----

  private cars: SnapshotCar[] = [];
  private gateSnaps: SnapshotGate[] = [];

  snapshot(perf: SimSnapshot['perf']): SimSnapshot {
    this.traffic.snapshotCars(this.cars);
    this.gateSnaps.length = 0;
    for (const g of this.gates.snapshotGates()) this.gateSnaps.push(g);
    const district = districtKindAt(this.bike.s);
    const section = this.sections.length ? this.sectionKindAt(this.songTime) : 'ride';
    return {
      t: Date.now(),
      tick: this.tick,
      state: this.state,
      songTime: this.songTime,
      songDuration: this.songDuration,
      bike: {
        s: this.bike.s,
        x: this.bike.x,
        v: this.bike.v,
        rpm: this.bike.rpm,
        gear: this.bike.gear,
        lean: this.bike.lean,
        wheelie: this.bike.wheelie,
        tuck: this.bike.tuck,
        crashed: this.bike.crashed,
        lane: this.trafficLane(this.bike.x, this.bike.s),
      },
      traffic: this.cars.slice(),
      gates: this.gateSnaps.slice(),
      scoring: {
        score: this.scoring.score,
        combo: this.scoring.combo,
        multiplier: this.scoring.multiplier,
        hp: this.scoring.hp,
        perfects: this.scoring.perfects,
        goods: this.scoring.goods,
        misses: this.scoring.misses,
        crashes: this.scoring.crashes,
        bestCombo: this.scoring.bestCombo,
        dead: this.scoring.dead,
      },
      judgment: this.lastJudgment,
      environment: {
        biome: this.appliedBiome,
        biomeName: BIOME_NAMES[clamp(this.appliedBiome, 0, 3)],
        weather: [3, 2, 0, 1][clamp(this.appliedBiome, 0, 3)],
        district,
        districtName: DISTRICT_NAMES[district],
        section,
      },
      lyrics: { line: '', nextTime: NaN },
      camera: { mode: this.cam.mode, fov: this.cam.camera.fov },
      music: {
        source: this.music?.source ?? 'none',
        title: this.music?.title ?? '',
        bpm: this.chart?.bpm ?? 0,
        duration: this.songDuration,
        streamUrl: this.music?.streamUrl ?? null,
      },
      perf,
    };
  }

  private sectionKindAt(t: number): string {
    for (const s of this.sections) if (t >= s.start && t < s.end) return s.kind;
    return this.sections.length ? this.sections[this.sections.length - 1].kind : 'ride';
  }

  private trafficLane(x: number, s: number): number {
    let best = 0;
    let bestD = Infinity;
    for (let l = 0; l < 4; l++) {
      const d = Math.abs(this.highway.spline.laneX(s, l) - x);
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
    return best;
  }

  get judgmentSerial_(): number {
    return this.judgmentSerial;
  }

  /** weather preset index implied by the active biome (renderer palette input) */
  get weatherPreset(): number {
    return [3, 2, 0, 1][clamp(this.appliedBiome, 0, 3)];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.traffic.dispose(this.scene);
    this.gates.dispose(this.scene);
    this.highway.dispose();
    this.state = 'ended';
  }
}
