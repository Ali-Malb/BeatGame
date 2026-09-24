/**
 * RhythmGates — physical lane gates with DETERMINISTIC world positions.
 *
 * ═══ THE CORE INVARIANT (§3/§4) ═══
 * A note's track position is a pure function of its chart timestamp:
 *
 *     gate.s = trackOrigin + note.time × RHYTHM_SPEED   (240 km/h)
 *
 * Once spawned, a gate's S NEVER changes — not with player speed, not with
 * acceleration, not with FPS. The PLAYER rides to the beat: accelerate to
 * arrive early, brake to arrive late, hold the rhythm pace (240 km/h) to land
 * PERFECT. The gate never chases, predicts or reconciles toward the bike.
 *
 * Judgment happens on the PHYSICAL crossing of the gate's plane, recovered
 * from the swept prev→current bike segment (§4/§7/§9) so it is independent of
 * render FPS — one frame may span multiple gates and every one is judged:
 *   alpha = (gateS − prevBikeS) / (bikeS − prevBikeS), clamped 0..1
 *   crossAudio = prevAudio + alpha·(audioNow − prevAudio)   (NOT frame time)
 *   delta = crossAudio − note.time
 *   PERFECT |Δt| ≤ 45 ms & lane offset ≤ 1.2 m · GOOD ≤ 90 ms & ≤ 1.6 m
 * Lane offset uses the interpolated crossX against the road spline's laneX at
 * gateS (curved/banked roads give per-lane world X).
 *
 * Spawning: a note is instantiated when the PLAYER is close enough that the
 * gate will be visible (see SPAWN_AHEAD_SEC), NOT based on audio proximity —
 * a slow player sees gates materialize ahead early, a fast player later.
 * Gate visuals (shatter, flash, anchor posts, lane pad) are presentation only.
 * All pools preallocated; nothing created/destroyed per frame.
 */

import * as THREE from 'three';
import type { Highway } from '../environment/Highway';
import type { RhythmChart, ChartNote } from './RhythmChart';
import { trackPositionFor } from './trackPosition';

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export type GateJudgment = 'perfect' | 'good' | 'miss';

export interface GateEvent {
  judgment: GateJudgment;
  delta: number; // crossingAudioTime − noteTime (s, + = late)
  laneOffset: number; // |bike.x − gate lane center| (m)
  note: ChartNote;
}

const PERFECT_SEC = 0.045;
const GOOD_SEC = 0.09;
const PERFECT_LANE = 1.2;
const GOOD_LANE = 1.6;
/** gates materialize when the PLAYER is within this many meters of travel */
const SPAWN_AHEAD_M = 900;
/** audio-time lateness beyond which an un-crossed gate is judged MISS (§8 B) */
const LATE_MISS_SEC = 2.0;
const POOL_SIZE = 48;

const LANE_COLORS = [0x35e0ff, 0xff4fd8, 0xffb43a, 0x7dff5a];

interface Gate {
  active: boolean;
  judged: boolean;
  note: ChartNote;
  s: number; // FIXED track position (never changes after spawn)
  group: THREE.Group;
  bar: THREE.Mesh;
  halo: THREE.Mesh;
  pad: THREE.Mesh;
  field: THREE.Mesh;
  mats: THREE.MeshBasicMaterial[];
  flash: number;
  phase: number;
}

/** per-frame bike state (§4/§9): the render frame is only the OBSERVATION
 *  interval — crossings are recovered from the swept prev→current segment. */
interface BikeFrame {
  s: number;
  x: number;
  audioT: number;
}

/** last GATE CROSS log line for the debug overlay */
export interface GateCrossLog {
  noteTime: number;
  gateS: number;
  crossS: number;
  crossAudio: number;
  delta: number;
  laneOffset: number;
  judgment: GateJudgment;
  alpha: number;
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
  private trackOrigin = 60;
  private shatter: ShatterBurst;
  private tmpColor = new THREE.Color();

  /** §4/§9: bike state at the END of the previous update — swept-segment origin */
  private prevBike: BikeFrame = { s: -Infinity, x: 0, audioT: 0 };
  private havePrev = false;
  /** last GATE CROSS log (debug overlay / telemetry) */
  lastCross: GateCrossLog | null = null;

  stats = { perfect: 0, good: 0, miss: 0, lastDelta: 0, recent: [] as number[] };

  constructor(scene: THREE.Scene, private highway: Highway) {
    // ---- shared geometries: lane-scale light PORTAL over the crossing plane
    // (two 5.2 m posts + glowing top beam + translucent energy field) so the
    // gate reads as architecture from 200 m, not a strip on the road ----
    const barGeo = new THREE.BoxGeometry(4.1, 0.3, 0.55);
    const capGeo = new THREE.BoxGeometry(0.28, 0.4, 0.62);
    const postGeo = new THREE.BoxGeometry(0.17, 5.3, 0.17);
    const haloGeo = new THREE.PlaneGeometry(4.6, 2.0);
    haloGeo.rotateX(-Math.PI / 2);
    const fieldGeo = new THREE.PlaneGeometry(3.94, 4.9);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2e3238, roughness: 0.55, metalness: 0.6 });
    const padGeo = new THREE.PlaneGeometry(3.3, 4.2);
    padGeo.rotateX(-Math.PI / 2);
    const barMat = LANE_COLORS.map(
      (c) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(1.15) }),
    );
    const capMats = LANE_COLORS.map((c) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(1.9) }));
    const padMats = LANE_COLORS.map((c) => new THREE.MeshStandardMaterial({ color: new THREE.Color(c).multiplyScalar(0.5), roughness: 0.75, metalness: 0.0, transparent: true, opacity: 0.45 }));
    const fieldMats = LANE_COLORS.map(
      (c) =>
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(c),
          transparent: true,
          opacity: 0.0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
    );
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
      const mats = [barMat[lane], capMats[lane], haloMat[lane], fieldMats[lane]];
      // glowing top beam at portal crown
      const bar = new THREE.Mesh(barGeo, mats[0]);
      bar.position.y = 5.15;
      group.add(bar);
      for (const side of [-1, 1]) {
        const cap = new THREE.Mesh(capGeo, mats[1]);
        cap.position.set(side * 2.02, 5.15, 0);
        group.add(cap);
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(side * 1.98, 2.65, 0);
        group.add(post);
      }
      const pad = new THREE.Mesh(padGeo, padMats[lane]);
      pad.position.y = 0.02;
      group.add(pad);
      const halo = new THREE.Mesh(haloGeo, mats[2]);
      halo.position.y = 0.03;
      group.add(halo);
      // translucent energy field filling the portal
      const field = new THREE.Mesh(fieldGeo, mats[3]);
      field.position.y = 2.7;
      group.add(field);
      group.visible = false;
      scene.add(group);
      this.gates.push({
        active: false,
        judged: true,
        note: { time: 0, lane, subdivision: 4, strength: 0, type: 'kick' },
        s: 0,
        group,
        bar,
        halo,
        pad,
        field,
        mats,
        flash: 0,
        phase: i * 1.7,
      });
    }
    this.shatter = new ShatterBurst(scene);
  }

  private static haloTexture(): THREE.Texture {
    // headless-safe: tests run without DOM — a blank texture is fine there
    if (typeof document === 'undefined') return new THREE.Texture();
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
    return new THREE.CanvasTexture(c);
  }

  /** swap in a new chart. trackOrigin = the bike's spline coordinate at song t=0. */
  setChart(chart: RhythmChart | null, trackOrigin: number): void {
    this.chart = chart;
    this.trackOrigin = trackOrigin;
    this.reset();
  }

  reset(): void {
    for (const g of this.gates) {
      g.active = false;
      g.judged = true;
      g.group.visible = false;
    }
    this.chartIndex = 0;
    this.prevBike = { s: -Infinity, x: 0, audioT: 0 };
    this.havePrev = false;
    this.lastCross = null;
    this.stats = { perfect: 0, good: 0, miss: 0, lastDelta: 0, recent: [] as number[] };
  }

  /** consume judgment events for the UI/scoring (drained inside update) */
  private pending: GateEvent[] = [];

  update(dt: number, audioNow: number, bikeS: number, bikeV: number, bikeX: number): GateEvent[] {
    void dt;
    void bikeV;
    this.pending.length = 0;
    const curBike: BikeFrame = { s: bikeS, x: bikeX, audioT: audioNow };
    const chart = this.chart;
    if (chart && chart.notes.length > 0) {
      // ---- spawn: gates materialize when the PLAYER gets close enough ----
      // (audio time is irrelevant to spawning — a slow rider sees them early)
      // NOTE: chartIndex only advances when the note is spawned or skipped;
      // a full pool leaves the note queued for a later frame.
      while (this.chartIndex < chart.notes.length) {
        const note = chart.notes[this.chartIndex];
        const s = trackPositionFor(note.time, this.trackOrigin);
        if (s >= bikeS + SPAWN_AHEAD_M) break; // too far ahead — wait
        this.chartIndex++;
        if (s < bikeS - 40) continue; // already passed (restart case)
        const gate = this.findFree();
        if (!gate) {
          this.chartIndex--; // pool exhausted — retry next frame
          break;
        }
        this.initGate(gate, note, s);
      }

      // ── §4/§7/§9: SWEPT crossing detection ──
      // The frame is only the observation interval [prevBike.s, bikeS]. Every
      // active gate whose plane lies inside it was physically crossed — even
      // when one frame spans several gates (10 FPS) or the bike never renders
      // near a gate (144 FPS at 320 km/h ≈ 89 m/frame).
      const fromS = this.havePrev ? this.prevBike.s : bikeS;
      const fromAudio = this.havePrev ? this.prevBike.audioT : audioNow;
      const fromX = this.havePrev ? this.prevBike.x : bikeX;
      const spanS = bikeS - fromS;
      const spanAudio = audioNow - fromAudio;
      const crossed: Gate[] = [];
      for (const g of this.gates) {
        if (g.active && !g.judged && fromS < g.s && bikeS >= g.s) crossed.push(g);
      }
      if (crossed.length > 1) crossed.sort((a, b) => a.s - b.s); // world order

      for (const g of crossed) {
        // recover the actual crossing instant inside the frame
        const alpha = spanS > 1e-9 ? Math.min(1, Math.max(0, (g.s - fromS) / spanS)) : 1;
        const crossAudio = fromAudio + alpha * spanAudio;
        const crossX = fromX + alpha * (bikeX - fromX);
        const delta = crossAudio - g.note.time;
        // §6: lane position from the ACTUAL road spline at gateS
        const laneOffset = Math.abs(crossX - this.highway.spline.laneX(g.s, g.note.lane));
        g.judged = true;
        this.lastCross = {
          noteTime: g.note.time,
          gateS: g.s,
          crossS: g.s,
          crossAudio,
          delta,
          laneOffset,
          judgment: 'miss',
          alpha,
        };
        let judgment: GateJudgment;
        if (Math.abs(delta) <= PERFECT_SEC && laneOffset <= PERFECT_LANE) {
          judgment = 'perfect';
          this.stats.perfect++;
        } else if (Math.abs(delta) <= GOOD_SEC && laneOffset <= GOOD_LANE) {
          judgment = 'good';
          this.stats.good++;
        } else {
          judgment = 'miss';
          this.stats.miss++;
        }
        this.lastCross.judgment = judgment;
        this.stats.lastDelta = delta;
        this.stats.recent.push(+delta.toFixed(3));
        if (this.stats.recent.length > 16) this.stats.recent.shift();
        // §10: one log per physical crossing — this is event-rate, not
        // per-frame, so it never becomes verbose spam in production.
        if (typeof console !== 'undefined') {
          console.log(
            `[GATE CROSS] note=${g.note.time.toFixed(3)} gateS=${g.s.toFixed(1)} crossS=${g.s.toFixed(1)} crossAudio=${crossAudio.toFixed(3)} delta=${delta.toFixed(3)} laneOffset=${laneOffset.toFixed(2)} judgment=${judgment.toUpperCase()}`,
          );
        }
        this.judged(g, judgment);
        this.pending.push({ judgment, delta, laneOffset, note: g.note });
      }

      // ── §8 B: late-miss ONLY while still BEHIND the plane ──
      // A gate the player is physically approaching (or standing beside) is
      // never recycled or teleported; the late window is pure audio lateness
      // for a rider who failed to reach the fixed world position in time.
      if (audioNow - (this.havePrev ? this.prevBike.audioT : audioNow) >= -1) {
        for (const g of this.gates) {
          if (g.active && !g.judged && bikeS < g.s && audioNow - g.note.time > LATE_MISS_SEC) {
            const laneOffset = Math.abs(bikeX - this.highway.spline.laneX(g.s, g.note.lane));
            const late = audioNow - g.note.time;
            g.judged = true;
            this.stats.miss++;
            this.stats.lastDelta = late;
            this.lastCross = {
              noteTime: g.note.time,
              gateS: g.s,
              crossS: bikeS,
              crossAudio: audioNow,
              delta: late,
              laneOffset,
              judgment: 'miss',
              alpha: 0,
            };
            this.judged(g, 'miss');
            this.pending.push({ judgment: 'miss', delta: late, laneOffset, note: g.note });
          }
        }
      }

      // ---- per-gate visuals / recycle ----
      const now = performance.now() * 0.001;
      for (const g of this.gates) {
        if (!g.active) continue;
        // idle portal breathing on the energy field
        if (!g.judged) {
          (g.field.material as THREE.MeshBasicMaterial).opacity = 0.05 + 0.035 * (0.5 + 0.5 * Math.sin(now * 3.1 + g.phase));
        }
        if (g.flash > 0) {
          g.flash -= dt;
          const k = Math.max(0, g.flash / 0.5);
          g.mats[0].color.setRGB(
            (g.note.lane === 0 ? 0.21 : g.note.lane === 1 ? 1 : g.note.lane === 2 ? 1 : 0.49) * (1 + 2.4 * k),
            (g.note.lane === 0 ? 0.88 : g.note.lane === 1 ? 0.31 : g.note.lane === 2 ? 0.71 : 1) * (1 + 2.4 * k),
            (g.note.lane === 0 ? 1 : g.note.lane === 1 ? 0.85 : g.note.lane === 2 ? 0.23 : 0.35) * (1 + 2.4 * k),
          );
          g.bar.scale.y = 1 + 1.6 * k;
          (g.mats[2] as THREE.MeshBasicMaterial).opacity = 0.34 + 0.5 * k;
          (g.field.material as THREE.MeshBasicMaterial).opacity = 0.06 + 0.5 * k;
          g.pad.material instanceof THREE.MeshStandardMaterial &&
            ((g.pad.material as THREE.MeshStandardMaterial).opacity = 0.45 + 0.5 * k);
        }
        // §8 D: recycle only AFTER judgment (never mid-approach)
        if (g.judged && g.flash <= 0 && bikeS > g.s + 20) {
          g.active = false;
          g.group.visible = false;
        }
      }
    }

    this.prevBike = curBike;
    this.havePrev = true;
    this.shatter.update(dt);
    return this.pending;
  }

  private judged(g: Gate, kind: GateJudgment): void {
    const c = this.tmpColor.setHex(LANE_COLORS[g.note.lane]);
    if (kind === 'miss') {
      g.flash = 0.0;
      g.mats[0].color.setRGB(0.25, 0.25, 0.28);
      (g.mats[2] as THREE.MeshBasicMaterial).opacity = 0.1;
      g.bar.scale.y = 0.35;
      g.bar.position.y = 1.0; // beam drops — dead portal
      (g.field.material as THREE.MeshBasicMaterial).opacity = 0.0;
      (g.pad.material as THREE.MeshStandardMaterial).opacity = 0.12;
    } else {
      g.flash = kind === 'perfect' ? 0.5 : 0.3;
      // shatter the whole portal, not just the ground line
      this.shatter.burst(g.group.position.x, g.group.position.y + 1.9, g.group.position.z, c, kind === 'perfect' ? 34 : 18, kind === 'perfect' ? 1.35 : 0.9);
    }
  }

  private initGate(gate: Gate, note: ChartNote, s: number): void {
    gate.active = true;
    gate.judged = false;
    gate.note = note;
    gate.s = s; // FIXED — never modified after this
    gate.flash = 0;
    gate.bar.scale.y = 1;
    gate.bar.position.y = 5.15;
    (gate.mats[2] as THREE.MeshBasicMaterial).opacity = 0.34;
    (gate.pad.material as THREE.MeshStandardMaterial).opacity = 0.45;
    (gate.field.material as THREE.MeshBasicMaterial).opacity = 0.06;
    const c = LANE_COLORS[note.lane];
    gate.mats[0].color.setHex(c).multiplyScalar(1.15);
    gate.mats[1].color.setHex(c).multiplyScalar(1.9);
    gate.group.visible = true;
    this.place(gate);
  }

  private place(g: Gate): void {
    const f = this.highway.frame(g.s);
    const lx = this.highway.spline.laneX(g.s, g.note.lane);
    g.group.position.set(f.x + f.rx * lx, f.y + 0.12, f.z + f.rz * lx);
    g.group.rotation.y = f.yaw;
  }

  private findFree(): Gate | null {
    for (const g of this.gates) if (!g.active) return g;
    return null;
  }

  /** deterministic track position of the next un-judged note (debug HUD) */
  nextNoteS(bikeS: number): { s: number; time: number; lane: number } {
    const chart = this.chart;
    if (!chart) return { s: 0, time: 0, lane: 1 };
    for (let i = Math.max(0, this.chartIndex - 40); i < chart.notes.length; i++) {
      const n = chart.notes[i];
      const s = trackPositionFor(n.time, this.trackOrigin);
      if (s >= bikeS - 5) return { s, time: n.time, lane: n.lane };
    }
    return { s: 0, time: 0, lane: 1 };
  }

  /** §10 debug telemetry: swept-frame + last-crossing internals for the HUD */
  debugInfo(bikeS: number): {
    prevBikeS: number;
    prevAudioT: number;
    crossAlpha: number;
    crossAudio: number;
    crossDelta: number;
    crossLaneOffset: number;
    crossJudgment: string;
    gateS: number;
    gateTime: number;
    gateLane: number;
    gateLaneX: number;
  } {
    const next = this.nextNoteS(bikeS);
    const c = this.lastCross;
    return {
      prevBikeS: this.havePrev ? Math.round(this.prevBike.s) : 0,
      prevAudioT: +this.prevBike.audioT.toFixed(3),
      crossAlpha: c ? +c.alpha.toFixed(3) : 0,
      crossAudio: c ? +c.crossAudio.toFixed(3) : 0,
      crossDelta: c ? +c.delta.toFixed(4) : 0,
      crossLaneOffset: c ? +c.laneOffset.toFixed(2) : 0,
      crossJudgment: c ? c.judgment.toUpperCase() : '—',
      gateS: +next.s.toFixed(1),
      gateTime: +next.time.toFixed(3),
      gateLane: next.lane,
      gateLaneX: +this.highway.spline.laneX(next.s, next.lane).toFixed(2),
    };
  }

  /** next un-judged note time (compat) */
  nextNoteTime(): number {
    const chart = this.chart;
    if (!chart) return 0;
    for (let i = Math.max(0, this.chartIndex - 40); i < chart.notes.length; i++) {
      if (trackPositionFor(chart.notes[i].time, this.trackOrigin) >= 0) return chart.notes[i].time;
    }
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
