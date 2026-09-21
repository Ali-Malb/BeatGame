/**
 * StreetLights — real PointLights for the streetlamps the player actually
 * passes under (§6/§30). The chunk builder emits an emissive lamp head + an
 * additive ground pool for EVERY lamp (cheap); this module contributes REAL
 * dynamic illumination for the handful of lamps near the player, so the road
 * surface, barriers and bike genuinely respond to lamp light. Lamp geometry
 * sits at the right-edge arm tip: edge = driveHalfAt(s) + 0.2, arm tip 2.55 m
 * inward, head at 10.3 m above the deck — mirrored on the left edge.
 */

import * as THREE from 'three';
import type { Highway } from './Highway';

const COUNT = 8;
const RANGE = 26;

export class StreetLights {
  private lights: THREE.PointLight[] = [];
  /** global intensity scale (0 in daylight, 1 at night) */
  intensity = 0;
  private pt = { x: 0, y: 0, z: 0, yaw: 0, rx: 1, rz: 0, kappa: 0, s: 0, slope: 0 };

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < COUNT; i++) {
      const l = new THREE.PointLight(0xffdfae, 0, RANGE, 1.6);
      l.visible = false;
      scene.add(l);
      this.lights.push(l);
    }
  }

  update(_dt: number, highway: Highway, playerS: number): void {
    const scale = this.intensity;
    if (scale <= 0.02) {
      for (const l of this.lights) {
        l.intensity = 0;
        l.visible = false;
      }
      return;
    }
    // lamps are placed at s ≡ 8 (mod 35) right edge and s ≡ 25.5 (mod 35) left
    // edge; walk lamp stations near the player and assign nearest lights
    const lamps: { s: number; side: 1 | -1 }[] = [];
    const sStart = Math.floor((playerS - 30) / 35) * 35 + 8;
    for (let s = sStart; s < playerS + 120; s += 35) {
      if (s > 0) lamps.push({ s, side: 1 });
      const ls = s + 17.5;
      if (ls > 0 && ls < playerS + 120) lamps.push({ s: ls, side: -1 });
    }
    // sort by distance ahead/behind the player
    lamps.sort((a, b) => Math.abs(a.s - playerS) - Math.abs(b.s - playerS));
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const lamp = lamps[i];
      if (!lamp || !scale) {
        l.visible = false;
        continue;
      }
      const f = highway.frame(lamp.s);
      const edge = highway.spline.driveHalfAt(lamp.s) + 0.2;
      const lat = lamp.side === 1 ? edge - 2.55 : -7.1 + 2.55;
      l.position.set(f.x + f.rx * lat, f.y + 10.1, f.z + f.rz * lat);
      l.visible = true;
      l.intensity = 30 * scale;
    }
  }

  dispose(): void {
    for (const l of this.lights) l.dispose();
  }
}
