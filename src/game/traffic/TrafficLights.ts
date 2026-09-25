/**
 * TrafficLights — a small pool of REAL PointLights assigned to the nearest
 * traffic (§7/§30). Vehicles keep their emissive lenses + additive pavement
 * pools; this module adds genuine dynamic illumination so headlights and brake
 * lights light up actual geometry (barriers, deck, nearby cars) instead of
 * pretending with cone meshes.
 *
 * Budget: 12 white headlight points + 4 red brake points, re-ranked each frame
 * by distance to the player. Far vehicles fall back to emissive-only rendering.
 */

import * as THREE from 'three';
import type { TrafficManager } from './TrafficManager';

interface Candidate {
  d: number;
  x: number;
  y: number;
  z: number;
  braking: boolean;
  frontX: number;
  frontY: number;
  frontZ: number;
  backX: number;
  backY: number;
  backZ: number;
}

const WHITE_COUNT = 8;
const RED_COUNT = 4;

export class TrafficLights {
  private whites: THREE.PointLight[] = [];
  private reds: THREE.PointLight[] = [];
  private candidates: Candidate[] = [];
  /** global intensity scale (0 in daylight, 1 at night) — set by Weather */
  intensity = 0;
  private enabled = true;

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < WHITE_COUNT; i++) {
      const l = new THREE.PointLight(0xfff1d4, 0, 30, 1.7);
      l.visible = false;
      scene.add(l);
      this.whites.push(l);
    }
    for (let i = 0; i < RED_COUNT; i++) {
      const l = new THREE.PointLight(0xff2a18, 0, 22, 1.8);
      l.visible = false;
      scene.add(l);
      this.reds.push(l);
    }
    for (let i = 0; i < 40; i++) {
      this.candidates.push({ d: 0, x: 0, y: 0, z: 0, braking: false, frontX: 0, frontY: 0, frontZ: 0, backX: 0, backY: 0, backZ: 0 });
    }
  }

  private nCandidates = 0;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      for (const l of [...this.whites, ...this.reds]) {
        l.intensity = 0;
        l.visible = false;
      }
    }
  }

  update(dt: number, playerPos: THREE.Vector3, traffic: TrafficManager): void {
    void dt;
    if (!this.enabled) return;
    const want = this.intensity > 0.02;
    if (!want) {
      for (const l of this.whites) {
        l.intensity = 0;
        l.visible = false;
      }
      for (const l of this.reds) {
        l.intensity = 0;
        l.visible = false;
      }
      return;
    }

    // ---- gather candidates (front/rear anchors per car) ----
    this.nCandidates = 0;
    traffic.forEachActive((front, back, braking) => {
      if (this.nCandidates >= this.candidates.length) return;
      const c = this.candidates[this.nCandidates++];
      const dx = front.x - playerPos.x;
      const dz = front.z - playerPos.z;
      c.d = dx * dx + dz * dz;
      c.frontX = front.x;
      c.frontY = front.y;
      c.frontZ = front.z;
      c.backX = back.x;
      c.backY = back.y;
      c.backZ = back.z;
      c.braking = braking;
    });

    // ---- rank by distance (insertion into the white budget) ----
    const whites = this.whites;
    for (const l of whites) l.visible = false;
    for (const l of this.reds) l.visible = false;

    // simple selection: repeatedly take the nearest unused candidate
    const used = this._used;
    used.fill(0, 0, this.nCandidates);
    let assigned = 0;
    let redAssigned = 0;
    const scale = this.intensity;
    while (assigned < WHITE_COUNT) {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < this.nCandidates; i++) {
        if (used[i]) continue;
        if (this.candidates[i].d < bestD) {
          bestD = this.candidates[i].d;
          best = i;
        }
      }
      if (best < 0) break;
      used[best] = 1;
      const c = this.candidates[best];
      // fade with distance (closest lights strongest)
      const dist = Math.sqrt(c.d);
      const fade = Math.max(0, 1 - dist / 160);
      const l = whites[assigned++];
      l.visible = fade > 0.03;
      l.position.set(c.frontX, c.frontY, c.frontZ);
      l.intensity = 26 * fade * scale;
      if (redAssigned < RED_COUNT && c.braking) {
        const r = this.reds[redAssigned++];
        r.visible = fade > 0.03;
        r.position.set(c.backX, c.backY, c.backZ);
        r.intensity = 18 * fade * scale;
      }
    }
  }

  private _used = new Uint8Array(40);

  dispose(): void {
    for (const l of this.whites) l.dispose();
    for (const l of this.reds) l.dispose();
  }
}
