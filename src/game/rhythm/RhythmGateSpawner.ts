/**
 * RhythmGateSpawner — overhead gates (toll gantry arches / illuminated arches)
 * that the motorcycle passes under ON the musical beat.
 *
 * Scheduling is DSP-authoritative (§5):
 *   - each gate targets a specific beat time T from the cue sheet
 *   - its world position s is predicted from player position + velocity:
 *         s_gate = s_player + v_player · (T − audioNow)
 *   - the position is continuously corrected while the gate is still far
 *     enough away (> 0.6 s to the beat), then locks
 *   - at the instant the bike reaches the gate:
 *         delta = audioNow − T
 *         |delta| ≤ 0.075 s → PERFECT SYNC (+250, combo, strobe, bloom, FOV kick)
 *
 * No fixed-speed movement — the gate never "moves at a speed"; it is placed on
 * the road and re-predicted against the audio clock, so it stays correct even
 * if the render FPS drops.
 */

import * as THREE from 'three';
import type { Highway } from '../environment/Highway';
import { AudioRhythm } from '../audio/AudioRhythm';
import { clamp, damp } from '../core/utils';

export interface GateEvent {
  kind: 'perfect' | 'good' | 'miss';
  delta: number;
  s: number;
}

interface Gate {
  active: boolean;
  /** absolute DSP time of the target beat */
  targetTime: number;
  /** road-frame arc position */
  s: number;
  locked: boolean;
  judged: boolean;
  group: THREE.Group;
  neonMat: THREE.MeshBasicMaterial;
  strobeMat: THREE.MeshBasicMaterial;
  flashTimer: number;
  strobeTimer: number;
}

const POOL_SIZE = 8;
/** correction window (s before the beat) */
const LOCK_WINDOW = 0.6;
/** how far ahead we schedule gates (s of music) */
const SCHEDULE_HORIZON = 7.5;

export class RhythmGateSpawner {
  private gates: Gate[] = [];
  private lastScheduledTime = -1;
  private predV = 60; // damped player velocity for prediction
  private tmpFrame: { rx: number; rz: number; x: number; y: number; z: number; yaw: number } | null = null;

  /** stats for the acceptance harness */
  stats = { perfect: 0, good: 0, miss: 0, lastDelta: 0, deltas: [] as number[] };

  constructor(scene: THREE.Scene, private highway: Highway, private rhythm: AudioRhythm) {
    // ---- build the gate arch pool ----
    const pylonGeo = new THREE.BoxGeometry(0.55, 7.4, 0.55);
    const beamGeo = new THREE.BoxGeometry(15.6, 0.7, 0.9);
    const neonGeo = new THREE.BoxGeometry(15.2, 0.18, 0.18);
    const strobeGeo = new THREE.BoxGeometry(14.6, 1.5, 0.06);
    const pylonMat = new THREE.MeshStandardMaterial({ color: 0x2a2e36, roughness: 0.55, metalness: 0.7 });

    for (let i = 0; i < POOL_SIZE; i++) {
      const group = new THREE.Group();
      const neonMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 0.75, 1.4) });
      const strobeMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(1, 1, 1),
        transparent: true,
        opacity: 0,
      });

      for (const side of [-1, 1]) {
        const pylon = new THREE.Mesh(pylonGeo, pylonMat);
        pylon.position.set(side * 7.6, 3.7, 0);
        pylon.castShadow = true;
        group.add(pylon);
      }
      const beam = new THREE.Mesh(beamGeo, pylonMat);
      beam.position.set(0, 7.1, 0);
      beam.castShadow = true;
      group.add(beam);

      // neon edges (top + bottom of the beam) — bloom picks these up
      for (const dy of [6.68, 7.52]) {
        const neon = new THREE.Mesh(neonGeo, neonMat);
        neon.position.set(0, dy, 0.45);
        group.add(neon);
      }
      // strobe panel under the beam
      const strobe = new THREE.Mesh(strobeGeo, strobeMat);
      strobe.position.set(0, 6.3, 0.45);
      group.add(strobe);
      // small hazard lights on pylon tops
      const beaconGeo = new THREE.SphereGeometry(0.14, 10, 8);
      const beaconMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.35, 0.2) });
      for (const side of [-1, 1]) {
        const b = new THREE.Mesh(beaconGeo, beaconMat);
        b.position.set(side * 7.6, 7.55, 0);
        group.add(b);
      }

      group.visible = false;
      scene.add(group);
      this.gates.push({
        active: false,
        targetTime: 0,
        s: 0,
        locked: false,
        judged: false,
        group,
        neonMat,
        strobeMat,
        flashTimer: 0,
        strobeTimer: 0,
      });
    }
  }

  /** reset on restart */
  reset(audioTime: number): void {
    for (const g of this.gates) {
      g.active = false;
      g.group.visible = false;
    }
    this.lastScheduledTime = audioTime;
    this.stats = { perfect: 0, good: 0, miss: 0, lastDelta: 0, deltas: [] };
  }

  /**
   * Per-frame update. Returns judged events this frame.
   */
  update(dt: number, bikeS: number, bikeV: number): GateEvent[] {
    const now = this.rhythm.getCurrentAudioTime();
    this.predV = damp(this.predV, bikeV, 6, dt);
    const events: GateEvent[] = [];

    // ---------- scheduling: ensure a gate exists for every upcoming beat ----
    if (this.lastScheduledTime < now - 1) this.lastScheduledTime = now; // first run
    while (this.lastScheduledTime < now + SCHEDULE_HORIZON) {
      const nextT = this.nextGateTimeAfter(this.lastScheduledTime);
      if (nextT == null) break;
      this.lastScheduledTime = nextT;
      // create the gate (prediction from current state)
      const lead = nextT - now;
      if (lead < 0.5) continue; // too soon to matter
      const gate = this.findFreeGate();
      if (!gate) break;
      gate.active = true;
      gate.judged = false;
      gate.locked = false;
      gate.targetTime = nextT;
      gate.s = bikeS + Math.max(8, this.predV * lead);
      gate.group.visible = true;
      this.placeGate(gate);
    }

    // ---------- per-gate update ----------
    for (const g of this.gates) {
      if (!g.active) continue;

      // flash/strobe decay
      if (g.flashTimer > 0) {
        g.flashTimer -= dt;
        const k = Math.max(0, g.flashTimer / 0.35);
        g.neonMat.color.setRGB(0.2 + 2.6 * k, 0.75 + 2.2 * k, 1.4 + 2.2 * k);
      } else {
        g.neonMat.color.setRGB(0.2, 0.75, 1.4);
      }
      if (g.strobeTimer > 0) {
        g.strobeTimer -= dt;
        // rapid strobing at ~24 Hz during the flash window
        const on = Math.sin(g.strobeTimer * Math.PI * 48) > 0;
        g.strobeMat.opacity = on ? 0.85 : 0.05;
      } else {
        g.strobeMat.opacity = 0;
      }

      // continuous position correction while far from the beat
      const timeToBeat = g.targetTime - now;
      if (!g.locked) {
        if (timeToBeat > LOCK_WINDOW) {
          const sPred = bikeS + Math.max(8, this.predV * timeToBeat);
          g.s = damp(g.s, sPred, 5, dt);
          this.placeGate(g);
        } else {
          g.locked = true; // freeze in place, await arrival
        }
      }

      // ---------- arrival judgement ----------
      if (!g.judged) {
        if (bikeS >= g.s) {
          const delta = now - g.targetTime;
          this.stats.lastDelta = delta;
          this.stats.deltas.push(delta);
          if (this.stats.deltas.length > 24) this.stats.deltas.shift();
          g.judged = true;
          if (Math.abs(delta) <= 0.075) {
            events.push({ kind: 'perfect', delta, s: g.s });
            this.stats.perfect++;
            g.flashTimer = 0.35;
            g.strobeTimer = 0.35;
          } else if (Math.abs(delta) <= 0.16) {
            events.push({ kind: 'good', delta, s: g.s });
            this.stats.good++;
            g.flashTimer = 0.18;
          } else {
            events.push({ kind: 'miss', delta, s: g.s });
            this.stats.miss++;
          }
        } else if (now > g.targetTime + 0.45) {
          // player fell too far behind the beat — recycle silently
          g.judged = true;
          this.stats.miss++;
          this.stats.lastDelta = now - g.targetTime;
        }
      }

      // recycle after the flash window & once behind the player
      if (g.judged && g.flashTimer <= 0 && g.strobeTimer <= 0 && (bikeS > g.s + 25 || g.group.position.lengthSq() === 0 || now > g.targetTime + 0.8)) {
        g.active = false;
        g.group.visible = false;
      }
    }

    return events;
  }

  /**
   * Song-mode sheet swap (§14): rhythm gate timing must follow the SELECTED
   * song — the session re-attaches a new AudioRhythm when the player
   * calibrates the song's BPM. Scheduling state resets with it.
   */
  attachRhythm(rhythm: AudioRhythm, audioTime: number): void {
    this.rhythm = rhythm;
    this.reset(audioTime);
  }

  private nextGateTimeAfter(t: number): number | null {
    // gate cue times live in [0, timeline); next absolute occurrence after t.
    // The timeline length comes from the ACTIVE sheet (demo loop OR song §13).
    const times = this.rhythm.getTypeTimes('gate');
    if (times.length === 0) return null;
    const loop = this.rhythm.loopSec > 0 ? this.rhythm.loopSec : Infinity;
    const k = Math.floor(t / loop);
    const rel = t - k * loop;
    for (let i = 0; i < times.length; i++) {
      if (times[i] > rel) return times[i] + k * loop;
    }
    return times[0] + (k + 1) * loop;
  }

  private findFreeGate(): Gate | null {
    for (const g of this.gates) {
      if (!g.active) return g;
    }
    return null;
  }

  private placeGate(g: Gate): void {
    const f = this.highway.frame(g.s);
    if (!this.tmpFrame) this.tmpFrame = { rx: 0, rz: 0, x: 0, y: 0, z: 0, yaw: 0 };
    g.group.position.set(f.x, f.y, f.z);
    g.group.rotation.y = f.yaw;
    g.group.rotation.z = 0;
  }
}
