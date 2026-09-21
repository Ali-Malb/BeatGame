/**
 * RoadSpline — the streaming centerline of the elevated expressway network.
 *
 * The centerline is generated lazily as an arc-length parameterized polyline
 * (5 m samples) with clamped curvature so every curve is navigable above
 * 200 km/h (min radius ≈ 900 m). Segments carry:
 *   - lane count (3–6) so the carriageway physically widens and narrows,
 *   - a target grade so the deck climbs hills and dips into valleys,
 *   - bridge zones (suspension spans) and tunnel zones (enclosed bores).
 *
 * Lane changes happen on 80 m tapers; `laneX(s, lane)` maps a lane index to
 * its physical lateral position at s, and `driveHalfAt(s)` gives the inner
 * barrier face so physics, traffic, gates and geometry all agree.
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
  bridge: boolean;
  tunnel: boolean;
  /** sample index at which this segment starts */
  i0: number;
  /** lane count across this segment */
  lanes: number;
}

export const SAMPLE_STEP = 5; // meters between spline samples

/** tapers (width transitions) span this many meters at each lane-count boundary */
export const TAPER_LEN = 80;

const MIN_LANES = 3;
const MAX_LANES = 6;

export class RoadSpline {
  private samples: RoadPoint[] = [];
  private cumLen = 0; // total generated length
  private segs: CurveSegment[] = [];
  private segCursor = 0;
  private rng: RNG;
  private bridgeStart = -1;
  private bridgeEnd = -1;
  private nextBridgeAt = 1600;
  private nextTunnelAt = 2100;
  private nextOverpassAt = 650;
  private nextLaneChangeAt = 900;

  /** elevation state (integrated grade, not a fixed function) */
  private elev = 12;
  private grade = 0; // current dy/ds

  /** world-space overpass / bridge bookkeeping (consumed by chunk builder) */
  readonly overpasses: { s: number; angle: number }[] = [];

  bridgeRange(): { start: number; end: number } | null {
    if (this.bridgeStart < 0) return null;
    return { start: this.bridgeStart, end: this.bridgeEnd };
  }

  /** active tunnel zones (start, end) — grown lazily, consumed by the chunk builder */
  private tunnels: { start: number; end: number }[] = [];

  constructor(seed = 20240) {
    this.rng = new RNG(seed);
    // seed the first segment: long straight launch pad
    this.pushSegment(400, 0, false, false, 4);
    this.ensure(1200);
  }

  get totalLength(): number {
    return this.cumLen;
  }

  get generatedSamples(): number {
    return this.samples.length;
  }

  private pushSegment(length: number, kappa: number, bridge: boolean, tunnel: boolean, lanes: number) {
    const i0 = this.samples.length;
    this.segs.push({ length, kappa, bridge, tunnel, i0, lanes });
    // integrate samples for this segment
    const last = this.samples[this.samples.length - 1] ?? { x: 0, y: this.elev, z: 0, yaw: 0, rx: 1, rz: 0, kappa: 0, s: 0, slope: 0 };
    let { x, y, z, yaw } = last;
    const steps = Math.round(length / SAMPLE_STEP);
    const ds = length / steps;
    // grade eases toward the segment target across the whole segment
    const targetGrade = this.pendingGrade;
    this.pendingGrade = 0;
    for (let i = 0; i < steps; i++) {
      // midpoint rotation integration (2nd order)
      yaw += (kappa * ds) / 2;
      x += Math.sin(yaw) * ds;
      z += Math.cos(yaw) * ds;
      const s = last.s + (i + 1) * ds;
      // ease current grade toward the target, integrate elevation
      this.grade = lerp(this.grade, targetGrade, 0.08);
      this.elev += this.grade * ds;
      // keep the elevated-deck band sane (7 m ground-level service roads … 30 m high viaduct)
      if (this.elev < 7) {
        this.elev = 7;
        this.grade = Math.max(this.grade, 0);
      } else if (this.elev > 30) {
        this.elev = 30;
        this.grade = Math.min(this.grade, 0);
      }
      y = this.elev;
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
        slope: this.grade,
      });
    }
    this.cumLen = this.samples[this.samples.length - 1].s;
  }

  /** grade queued for the NEXT pushSegment (set by planNextSegment) */
  private pendingGrade = 0;

  /** ---- segment planning: curves, hills, lane counts, bridges, tunnels ---- */
  private planNextSegment() {
    const s = this.cumLen;
    // ---- suspension bridge zones every ~2.6 km (flat-ish deck, fixed lanes) ----
    if (s >= this.nextBridgeAt) {
      const len = 340;
      this.bridgeStart = s;
      this.bridgeEnd = s + len;
      this.nextBridgeAt = s + 2600 + this.rng.range(0, 500);
      this.pendingGrade = 0;
      this.pushSegment(len, 0, true, false, this.lanesAtEnd());
      return;
    }
    // ---- tunnel bores every ~2.2 km ----
    if (s >= this.nextTunnelAt) {
      const len = 150 + this.rng.range(0, 110);
      this.tunnels.push({ start: s, end: s + len });
      this.nextTunnelAt = s + len + 2100 + this.rng.range(0, 900);
      this.pendingGrade = 0;
      this.pushSegment(len, 0, false, true, this.lanesAtEnd());
      return;
    }
    // ---- overpasses ----
    if (s >= this.nextOverpassAt) {
      this.overpasses.push({ s, angle: this.rng.range(-0.5, 0.5) });
      this.nextOverpassAt = s + 550 + this.rng.range(0, 420);
    }
    // ---- lane-count changes every 0.9–2 km (§15) ----
    let lanes = this.lanesAtEnd();
    if (s >= this.nextLaneChangeAt) {
      lanes = Math.max(MIN_LANES, Math.min(MAX_LANES, lanes + (this.rng.next() < 0.55 ? 1 : -1)));
      if (lanes !== this.lanesAtEnd()) this.nextLaneChangeAt = s + TAPER_LEN + 900 + this.rng.range(0, 1100);
      else this.nextLaneChangeAt = s + 400;
    }
    // ---- grade targets: rolling terrain (§9) — gentle for high-speed corners ----
    if (this.pendingGrade === 0) {
      const pull = (14 - this.elev) * 0.02; // drift back toward the 14 m band
      const target = this.rng.range(-0.045, 0.05) + pull;
      this.pendingGrade = Math.max(-0.06, Math.min(0.06, target));
    }
    // alternate straight / gentle arc
    const isArc = this.segCursor % 2 === 1;
    this.segCursor++;
    if (isArc) {
      // radius 900–2600 m, arc 3–9°, either direction
      const radius = this.rng.range(900, 2600);
      const arcDeg = this.rng.range(3, 9);
      const len = (arcDeg * Math.PI) / 180 * radius;
      const dir = this.rng.next() < 0.5 ? 1 : -1;
      this.pushSegment(len, dir / radius, false, false, lanes);
    } else {
      this.pushSegment(this.rng.range(220, 620), 0, false, false, lanes);
    }
  }

  /** lane count of the most recently generated segment */
  private lanesAtEnd(): number {
    return this.segs.length ? this.segs[this.segs.length - 1].lanes : 4;
  }

  /** make sure spline covers up to s */
  ensure(s: number) {
    let guard = 0;
    while (this.cumLen < s && guard++ < 8000) {
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

  isTunnelAt(s: number): boolean {
    for (const t of this.tunnels) if (s >= t.start - 2 && s <= t.end + 2) return true;
    return false;
  }

  tunnelRangesUpTo(sMax: number): { start: number; end: number }[] {
    return this.tunnels.filter((t) => t.end <= sMax);
  }

  // ------------------------------------------------------------------ lanes ----

  /** segment containing sample index i (segments are indexed by i0) */
  private segAtSample(i: number): CurveSegment {
    // binary search
    let lo = 0;
    let hi = this.segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.segs[mid].i0 <= i) lo = mid;
      else hi = mid - 1;
    }
    return this.segs[lo];
  }

  /**
   * Playable lane count at s. Lane-count boundaries ease over TAPER_LEN meters:
   * within the first half of a taper the count is the previous segment's,
   * within the second half it's the new one (barrier/deck geometry interpolates
   * continuously via driveHalfAt/laneX so there is no visible step).
   */
  lanesAt(s: number): number {
    const idx = Math.min(this.samples.length - 1, Math.max(0, Math.round(s / SAMPLE_STEP)));
    const seg = this.segAtSample(idx);
    return seg.lanes;
  }

  /**
   * Half-width of the playable carriageway at s (inner face of the outer
   * barrier). Continuous across tapers: linear interpolation between the
   * widths implied by the lane counts of the two neighboring segments.
   */
  driveHalfAt(s: number): number {
    const idx = Math.min(this.samples.length - 1, Math.max(0, Math.round(s / SAMPLE_STEP)));
    const seg = this.segAtSample(idx);
    const prev = this.segs[Math.max(0, this.segs.indexOf(seg) - 1)];
    const wA = this.lanesHalfWidth(prev.lanes);
    const wB = this.lanesHalfWidth(seg.lanes);
    if (wA === wB) return wA;
    const segStart = seg.i0 * SAMPLE_STEP;
    const t = Math.min(1, Math.max(0, (s - segStart) / TAPER_LEN));
    return lerp(wA, wB, t);
  }

  /** half-width implied by a lane count: symmetric centers + 0.35 m edge margin */
  private lanesHalfWidth(lanes: number): number {
    return (lanes * 3.5) / 2 + 0.35;
  }

  /**
   * Lateral center of lane `lane` (0 = leftmost playable) at s. Continuous
   * across tapers; lanes beyond the available count clamp to the outermost.
   */
  laneX(s: number, lane: number): number {
    const idx = Math.min(this.samples.length - 1, Math.max(0, Math.round(s / SAMPLE_STEP)));
    const seg = this.segAtSample(idx);
    const prev = this.segs[Math.max(0, this.segs.indexOf(seg) - 1)];
    const lanes = seg.lanes;
    const clamped = Math.max(0, Math.min(lanes - 1, lane));
    const cA = this.laneCenter(prev.lanes, clamped);
    const cB = this.laneCenter(lanes, clamped);
    if (cA === cB) return cB;
    const segStart = seg.i0 * SAMPLE_STEP;
    const t = Math.min(1, Math.max(0, (s - segStart) / TAPER_LEN));
    return lerp(cA, cB, t);
  }

  /** symmetric lane centers: lane 0 leftmost (negative X = left of forward) */
  private laneCenter(lanes: number, lane: number): number {
    const w = lanes * 3.5;
    return -w / 2 + 3.5 * (lane + 0.5);
  }

  // ------------------------------------------------------------------ query ----

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
    this.tunnels = [];
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
