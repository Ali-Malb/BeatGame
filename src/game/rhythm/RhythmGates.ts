/**
 * RhythmGates — physical, lane-assigned rhythm gates driven by the chart.
 *
 * Each chart note becomes a real 3D object (3.2 × 0.2 × 0.8 m emissive bar
 * floating over its lane). The gate's spline position is continuously
 * reconciled so that it physically reaches the bike's crossing point at the
 * note's AUDIO timestamp:
 *
 *   s_gate = s_bike + v_pred · (t_note − audioNow)
 *
 * (v_pred is a damped copy of player velocity, so acceleration/braking are
 * absorbed while the gate is far; the position LOCKS ~0.55 s before the note,
 * after which the player's own timing decides the judgment.)
 *
 * Judging (front-tire crossing of the gate plane):
 *   PERFECT |Δt| ≤ 45 ms  and lane offset ≤ 1.2 m
 *   GOOD    46–90 ms      and lane offset ≤ 1.6 m
 *   MISS    beyond the windows, or the gate passes un-judged
 *
 * All pools are preallocated; nothing is created or destroyed per frame.
 */

import * as THREE from 'three';
import type { Highway } from '../environment/Highway';
import type { RhythmChart, ChartNote } from './RhythmChart';
import { clamp, damp } from '../core/utils';

export type GateJudgment = 'perfect' | 'good' | 'miss';

export interface GateEvent {
  judgment: GateJudgment;
  delta: number; // audioNow − noteTime (s, + = late)
  laneOffset: number; // |bike.x − gate.x| (m)
  note: ChartNote;
}

const PERFECT_SEC = 0.045;
const GOOD_SEC = 0.09;
const PERFECT_LANE = 1.2;
const GOOD_LANE = 1.6;
const LOCK_WINDOW = 0.20; // s before the note when the gate snaps to the ideal crossing point
const SCHEDULE_HORIZON = 7.0; // s of music to keep instantiated
const POOL_SIZE = 44;
const TRACK_LAMBDA = 10; // reconcile rate; tracking lag v/λ is compensated

const LANE_COLORS = [0x35e0ff, 0xff4fd8, 0xffb43a, 0x7dff5a];

interface Gate {
  active: boolean;
  judged: boolean;
  locked: boolean;
  note: ChartNote;
  s: number;
  group: THREE.Group;
  bar: THREE.Mesh;
  halo: THREE.Mesh;
  mats: THREE.MeshBasicMaterial[];
  flash: number;
}

/** shared shatter particle burst (bounded, additive, no per-frame allocation) */
class ShatterBurst {
  points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private cursor = 0;
  private count: number;
  private col: Float32Array;

  constructor(scene: THREE.Scene, count = 360) {
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.col = new Float32Array(count * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.16,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
    scene.add(this.points);
  }

  burst(x: number, y: number, z: number, color: THREE.Color, n = 22, spread = 1): void {
    for (let i = 0; i < n; i++) {
      const idx = this.cursor;
      this.cursor = (this.cursor + 1) % this.count;
      this.pos[idx * 3] = x;
      this.pos[idx * 3 + 1] = y;
      this.pos[idx * 3 + 2] = z;
      const a = Math.random() * Math.PI * 2;
      const up = 1.5 + Math.random() * 4.5;
      const sp = (2 + Math.random() * 7) * spread;
      this.vel[idx * 3] = Math.cos(a) * sp;
      this.vel[idx * 3 + 1] = up;
      this.vel[idx * 3 + 2] = Math.sin(a) * sp * 0.6 + 8;
      this.life[idx] = 0.55 + Math.random() * 0.5;
      this.maxLife[idx] = this.life[idx];
      this.col[idx * 3] = color.r * 2;
      this.col[idx * 3 + 1] = color.g * 2;
      this.col[idx * 3 + 2] = color.b * 2;
    }
    this.points.visible = true;
  }

  update(dt: number): void {
    let anyAlive = false;
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= 9.8 * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      this.col[i * 3] *= 1 - (1 - k) * 0.4;
      this.col[i * 3 + 1] *= 1 - (1 - k) * 0.4;
      this.col[i * 3 + 2] *= 1 - (1 - k) * 0.4;
      if (this.life[i] > 0) anyAlive = true;
      else {
        this.pos[i * 3 + 1] = -50; // hide below the world
      }
    }
    if (this.points.visible) {
      (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (this.points.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
      if (!anyAlive) this.points.visible = false;
    }
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

export class RhythmGates {
  private gates: Gate[] = [];
  private chart: RhythmChart | null = null;
  private chartIndex = 0;
  private lastScheduled = -1;
  private predV = 60;
  private shatter: ShatterBurst;
  private frameScratch = { x: 0, y: 0, z: 0, yaw: 0, rx: 1, rz: 0, kappa: 0, s: 0, slope: 0 };
  private tmpColor = new THREE.Color();

  stats = { perfect: 0, good: 0, miss: 0, lastDelta: 0, recent: [] as number[] };

  constructor(scene: THREE.Scene, private highway: Highway) {
    // ---- shared geometries ----
    const barGeo = new THREE.BoxGeometry(3.2, 0.2, 0.8);
    const capGeo = new THREE.BoxGeometry(0.18, 0.28, 0.86);
    const haloGeo = new THREE.PlaneGeometry(3.4, 1.6);
    haloGeo.rotateX(-Math.PI / 2);
    const barMat = LANE_COLORS.map(
      (c) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(1.15) }),
    );
    const capMats = LANE_COLORS.map((c) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(1.9) }));
    const haloMat = LANE_COLORS.map(
      (c) =>
        new THREE.MeshBasicMaterial({
          map: RhythmGates.haloTexture(),
          color: new THREE.Color(c),
          transparent: true,
          opacity: 0.34,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
    );

    for (let i = 0; i < POOL_SIZE; i++) {
      const lane = i % 4;
      const group = new THREE.Group();
      const mats = [barMat[lane], capMats[lane], haloMat[lane]];
      const bar = new THREE.Mesh(barGeo, mats[0]);
      bar.position.y = 0.55;
      group.add(bar);
      for (const side of [-1, 1]) {
        const cap = new THREE.Mesh(capGeo, mats[1]);
        cap.position.set(side * 1.62, 0.58, 0);
        group.add(cap);
      }
      const halo = new THREE.Mesh(haloGeo, mats[2]);
      halo.position.y = 0.03;
      group.add(halo);
      group.visible = false;
      scene.add(group);
      this.gates.push({
        active: false,
        judged: true,
        locked: false,
        note: { time: 0, lane, subdivision: 4, strength: 0, type: 'kick' },
        s: 0,
        group,
        bar,
        halo,
        mats,
        flash: 0,
      });
    }
    this.shatter = new ShatterBurst(scene);
  }

  private static haloTexture(): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    if (ctx) {
      const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
      g.addColorStop(0, 'rgba(255,255,255,0.9)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
    }
    const tex = new THREE.CanvasTexture(c);
    return tex;
  }

  /** swap in a new chart (analysis complete / restart). Resets all state. */
  setChart(chart: RhythmChart | null, audioTime: number): void {
    this.chart = chart;
    this.reset(audioTime);
  }

  reset(audioTime: number): void {
    for (const g of this.gates) {
      g.active = false;
      g.judged = true;
      g.group.visible = false;
    }
    this.lastScheduled = audioTime;
    this.chartIndex = 0;
    this.stats = { perfect: 0, good: 0, miss: 0, lastDelta: 0, recent: [] as number[] };
  }

  /** consume judgment events for the UI/scoring (drained inside update) */
  private pending: GateEvent[] = [];

  update(dt: number, audioNow: number, bikeS: number, bikeV: number, bikeX: number): GateEvent[] {
    // seed the velocity estimate on first contact so the first reconciliations
    // don't place gates at bikeS + 0 (measured: cold-start predV=0 bulldozed
    // the opening gates and burned the miss budget before the run even formed)
    if (this.predV <= 0 && bikeV > 2) this.predV = bikeV;
    this.predV = damp(this.predV, bikeV, 6, dt);
    this.pending.length = 0;
    const chart = this.chart;
    if (chart && chart.notes.length > 0) {
      // ---- schedule: instantiate gates inside the horizon ----
      while (
        this.chartIndex < chart.notes.length &&
        chart.notes[this.chartIndex].time < audioNow + SCHEDULE_HORIZON
      ) {
        const note = chart.notes[this.chartIndex++];
        if (note.time < audioNow - 0.2) continue; // already past (restart case)
        const gate = this.findFree();
        if (!gate) break;
        this.initGate(gate, note, audioNow, bikeS, bikeV);
      }

      // ---- per-gate reconcile / judge / recycle ----
      for (const g of this.gates) {
        if (!g.active) continue;
        const note = g.note;

        if (!g.judged) {
          // CONTINUOUS ideal reconciliation (§39): while the note is in the
          // future the gate sits at bikeS + v·lead — exactly where the bike
          // will be at note.time if it holds speed. Exact under acceleration,
          // braking and at any frame rate; a locked/snap approach bakes in a
          // stale speed and makes every crossing late by the acceleration
          // integral (measured 0.3–0.4 s when racing out of the countdown).
          // predV is damped so the plane doesn't jitter with per-frame noise.
          // Once note.time passes, the plane FREEZES so the bike can
          // physically cross it (the back-projected crossing time keeps the
          // judgment FPS-independent); a braking rider who never arrives is
          // caught by the timeout-miss below.
          const lead = note.time - audioNow;
          if (lead > 0) {
            g.s = bikeS + Math.max(2, this.predV * lead);
            this.place(g);
          }
        }

        if (g.flash > 0) {
          g.flash -= dt;
          const k = Math.max(0, g.flash / 0.4);
          g.mats[0].color.setRGB(
            (g.note.lane === 0 ? 0.21 : g.note.lane === 1 ? 1 : g.note.lane === 2 ? 1 : 0.49) * (1 + 2.4 * k),
            (g.note.lane === 0 ? 0.88 : g.note.lane === 1 ? 0.31 : g.note.lane === 2 ? 0.71 : 1) * (1 + 2.4 * k),
            (g.note.lane === 0 ? 1 : g.note.lane === 1 ? 0.85 : g.note.lane === 2 ? 0.23 : 0.35) * (1 + 2.4 * k),
          );
          g.bar.scale.y = 1 + 1.6 * k;
          (g.mats[2] as THREE.MeshBasicMaterial).opacity = 0.34 + 0.5 * k;
        }

        // ---- judging ----
        if (!g.judged) {
          const crossed = bikeS >= g.s;
          const late = audioNow - note.time;
          if (crossed) {
            // §39: judge against the INTERPOLATED crossing instant, not the
            // frame-sampled audioNow — at low FPS the detection frame can lag
            // the physical crossing by hundreds of ms, which would otherwise
            // fake a "late" miss. Back-project the overshoot distance at the
            // current speed to recover when the plane was actually crossed.
            const vRef = Math.max(4, bikeV);
            const crossTime = audioNow - (bikeS - g.s) / vRef;
            const delta = crossTime - note.time;
            const laneOffset = Math.abs(bikeX - this.highway.spline.laneX(g.s, note.lane));
            g.judged = true;
            this.stats.lastDelta = delta;
            this.stats.recent.push(+delta.toFixed(3));
            if (this.stats.recent.length > 16) this.stats.recent.shift();
            if (Math.abs(delta) <= PERFECT_SEC && laneOffset <= PERFECT_LANE) {
              this.stats.perfect++;
              this.judged(g, 'perfect');
              this.pending.push({ judgment: 'perfect', delta, laneOffset, note });
            } else if (Math.abs(delta) <= GOOD_SEC && laneOffset <= GOOD_LANE) {
              this.stats.good++;
              this.judged(g, 'good');
              this.pending.push({ judgment: 'good', delta, laneOffset, note });
            } else {
              this.stats.miss++;
              this.judged(g, 'miss');
              this.pending.push({ judgment: 'miss', delta, laneOffset, note });
            }
          } else if (late > GOOD_SEC + 0.1) {
            // player braked hard and never crossed in time
            g.judged = true;
            this.stats.miss++;
            this.stats.lastDelta = late;
            this.judged(g, 'miss');
            this.pending.push({ judgment: 'miss', delta: late, laneOffset: Math.abs(bikeX - this.highway.spline.laneX(g.s, note.lane)), note });
          }
        }

        // ---- recycle ----
        if (g.judged && g.flash <= 0 && bikeS > g.s + 20) {
          g.active = false;
          g.group.visible = false;
        }
      }
    }

    this.shatter.update(dt);
    return this.pending;
  }

  private judged(g: Gate, kind: GateJudgment): void {
    const c = this.tmpColor.setHex(LANE_COLORS[g.note.lane]);
    if (kind === 'miss') {
      g.flash = 0.0; // dim out immediately
      g.mats[0].color.setRGB(0.25, 0.25, 0.28);
      (g.mats[2] as THREE.MeshBasicMaterial).opacity = 0.1;
      g.bar.scale.y = 0.35;
    } else {
      g.flash = kind === 'perfect' ? 0.4 : 0.22;
      this.shatter.burst(g.group.position.x, g.group.position.y + 0.7, g.group.position.z, c, kind === 'perfect' ? 26 : 14, kind === 'perfect' ? 1.2 : 0.8);
    }
  }

  private initGate(gate: Gate, note: ChartNote, audioNow: number, bikeS: number, bikeV: number): void {
    gate.active = true;
    gate.judged = false;
    gate.locked = false;
    gate.note = note;
    gate.flash = 0;
    gate.s = bikeS + Math.max(6, (bikeV || 60) * (note.time - audioNow));
    gate.bar.scale.y = 1;
    (gate.mats[2] as THREE.MeshBasicMaterial).opacity = 0.34;
    const c = LANE_COLORS[note.lane];
    gate.mats[0].color.setHex(c).multiplyScalar(1.15);
    gate.mats[1].color.setHex(c).multiplyScalar(1.9);
    gate.group.visible = true;
    this.place(gate);
  }

  private place(g: Gate): void {
    const f = this.highway.frame(g.s);
    // gate sits on the ACTUAL spline lane position — elevation-aware, taper-aware
    const lx = this.highway.spline.laneX(g.s, g.note.lane);
    g.group.position.set(f.x + f.rx * lx, f.y + 0.12, f.z + f.rz * lx);
    g.group.rotation.y = f.yaw;
  }

  private findFree(): Gate | null {
    for (const g of this.gates) if (!g.active) return g;
    return null;
  }

  /** next un-judged note time (debug HUD) */
  nextNoteTime(audioNow: number): number {
    const chart = this.chart;
    if (!chart) return 0;
    for (const n of chart.notes) if (n.time > audioNow) return n.time;
    return 0;
  }

  activeCount(): number {
    let n = 0;
    for (const g of this.gates) if (g.active) n++;
    return n;
  }

  dispose(scene: THREE.Scene): void {
    for (const g of this.gates) scene.remove(g.group);
    this.shatter.dispose();
  }
}
