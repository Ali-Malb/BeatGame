/**
 * RoadSpline — the streaming centerline of the elevated Shutoko-style expressway.
 *
 * The centerline is generated lazily as an arc-length parameterized polyline
 * (5 m samples) with clamped curvature so every curve is navigable above
 * 200 km/h (min radius ≈ 1200 m). Provides road-frame queries:
 * position, heading, right-vector, curvature and deck elevation at any s.
 */

import { lerp } from '../core/utils';
import { RNG } from '../core/utils';

export interface RoadPoint {
  /** world position of centerline at s */
  x: number;
  y: number;
  z: number;
  /** unwrapped heading (rad). forward = (sin yaw, 0, cos yaw); increasing yaw turns right */
  yaw: number;
  /** right-hand normal unit vector (cos yaw, 0, -sin yaw) */
  rx: number;
  rz: number;
  /** signed curvature 1/m (+ = curving right) */
  kappa: number;
  s: number;
  /** deck surface pitch (dy/ds) */
  slope: number;
}

interface CurveSegment {
  length: number;
  kappa: number;
  bridge: boolean; // suspension bridge zone
}

export const SAMPLE_STEP = 5; // meters between spline samples

export class RoadSpline {
  private samples: RoadPoint[] = [];
  private cumLen = 0; // total generated length
  private segs: CurveSegment[] = [];
  private segCursor = 0;
  private rng: RNG;
  private bridgeStart = -1;
  private bridgeEnd = -1;
  private nextBridgeAt = 1600;
  private nextOverpassAt = 650;

  /** world-space overpass / bridge bookkeeping (consumed by chunk builder) */
  readonly overpasses: { s: number; angle: number }[] = [];

  bridgeRange(): { start: number; end: number } | null {
    if (this.bridgeStart < 0) return null;
    return { start: this.bridgeStart, end: this.bridgeEnd };
  }

  constructor(seed = 20240) {
    this.rng = new RNG(seed);
    // seed the first segment: long straight launch pad
    this.pushSegment(400, 0, false);
    this.ensure(1200);
  }

  get totalLength(): number {
    return this.cumLen;
  }

  get generatedSamples(): number {
    return this.samples.length;
  }

  private pushSegment(length: number, kappa: number, bridge: boolean) {
    this.segs.push({ length, kappa, bridge });
    // integrate samples for this segment
    const last = this.samples[this.samples.length - 1] ?? { x: 0, y: 12, z: 0, yaw: 0, rx: 1, rz: 0, kappa: 0, s: 0, slope: 0 };
    let { x, y, z, yaw } = last;
    const steps = Math.round(length / SAMPLE_STEP);
    const ds = length / steps;
    for (let i = 0; i < steps; i++) {
      // midpoint rotation integration (2nd order)
      yaw += (kappa * ds) / 2;
      x += Math.sin(yaw) * ds;
      z += Math.cos(yaw) * ds;
      const s = last.s + (i + 1) * ds;
      y = this.elevationAt(s);
      yaw += (kappa * ds) / 2;
      this.samples.push({
        x,
        y,
        z,
        yaw,
        rx: Math.cos(yaw),
        rz: -Math.sin(yaw),
        kappa,
        s,
        slope: (this.elevationAt(s + 2) - this.elevationAt(s - 2)) / 4,
      });
    }
    this.cumLen = this.samples[this.samples.length - 1].s;
  }

  /** gentle rolling elevation of the deck (12 m baseline, ±3 m) */
  elevationAt(s: number): number {
    return 12 + Math.sin(s * 0.00042) * 2.2 + Math.sin(s * 0.0011 + 1.7) * 0.8;
  }

  private planNextSegment() {
    const s = this.cumLen;
    // ---- bridge zones every ~2.6 km ----
    if (s >= this.nextBridgeAt) {
      const len = 320;
      this.bridgeStart = s;
      this.bridgeEnd = s + len;
      this.nextBridgeAt = s + 2600 + this.rng.range(0, 500);
      this.pushSegment(len, 0, true);
      return;
    }
    // ---- overpasses ----
    if (s >= this.nextOverpassAt) {
      this.overpasses.push({ s, angle: this.rng.range(-0.5, 0.5) });
      this.nextOverpassAt = s + 550 + this.rng.range(0, 420);
    }
    // alternate straight / gentle arc
    const isArc = this.segCursor % 2 === 1;
    this.segCursor++;
    if (isArc) {
      // radius 1200–2600 m, arc 3–9°, either direction, banked feel via small curvature
      const radius = this.rng.range(1200, 2600);
      const arcDeg = this.rng.range(3, 9);
      const len = (arcDeg * Math.PI) / 180 * radius;
      const dir = this.rng.next() < 0.5 ? 1 : -1;
      this.pushSegment(len, dir / radius, false);
    } else {
      this.pushSegment(this.rng.range(220, 620), 0, false);
    }
  }

  /** make sure spline covers up to s */
  ensure(s: number) {
    let guard = 0;
    while (this.cumLen < s && guard++ < 5000) {
      this.planNextSegment();
    }
  }

  /** overpass entries not yet consumed by the chunk builder */
  consumeOverpassesUpTo(sMax: number): { s: number; angle: number }[] {
    const out: { s: number; angle: number }[] = [];
    while (this.overpasses.length && this.overpasses[0].s <= sMax) {
      out.push(this.overpasses.shift()!);
    }
    return out;
  }

  isBridgeAt(s: number): boolean {
    return this.bridgeStart >= 0 && s >= this.bridgeStart && s <= this.bridgeEnd;
  }

  /** query road frame at distance s. Samples are uniform 5 m apart. */
  get(s: number, out: RoadPoint): RoadPoint {
    if (this.samples.length === 0) return out;
    if (s <= 0) {
      const p = this.samples[0];
      copyPoint(p, out);
      return out;
    }
    const idx = s / SAMPLE_STEP;
    const i0 = Math.min(this.samples.length - 2, Math.floor(idx));
    const i1 = i0 + 1;
    const t = Math.min(1, idx - i0);
    const a = this.samples[i0];
    const b = this.samples[i1];
    out.x = lerp(a.x, b.x, t);
    out.y = lerp(a.y, b.y, t);
    out.z = lerp(a.z, b.z, t);
    out.yaw = lerp(a.yaw, b.yaw, t);
    out.rx = Math.cos(out.yaw);
    out.rz = -Math.sin(out.yaw);
    out.kappa = lerp(a.kappa, b.kappa, t);
    out.s = s;
    out.slope = lerp(a.slope, b.slope, t);
    return out;
  }

  /** total curvature-derived lateral accel requirement at speed (used for HUD/physics) */
  neutralLean(s: number, speed: number): number {
    const idx = Math.min(this.samples.length - 1, Math.max(0, Math.floor(s / SAMPLE_STEP)));
    const k = this.samples[idx].kappa;
    return Math.atan((speed * speed * k) / 9.81);
  }

  dispose() {
    this.samples = [];
    this.segs = [];
  }
}

function copyPoint(src: RoadPoint, dst: RoadPoint) {
  dst.x = src.x;
  dst.y = src.y;
  dst.z = src.z;
  dst.yaw = src.yaw;
  dst.rx = src.rx;
  dst.rz = src.rz;
  dst.kappa = src.kappa;
  dst.s = src.s;
  dst.slope = src.slope;
}
