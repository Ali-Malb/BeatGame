/**
 * districts.ts — deterministic classification of the expressway corridor into
 * visual districts, so roadside density and asset vocabulary change in
 * readable stretches instead of random noise per chunk.
 *
 * A district is a function of arc length `s` only (no state), which keeps the
 * streaming chunk builder, the traffic manager and the minimap/telemetry in
 * agreement and makes the world identical across reloads.
 *
 *   0 URBAN       dense towers, lit windows, billboards, sign gantries
 *   1 INDUSTRIAL  storage tanks, pipe racks, chimneys, sheds, gantry cranes
 *   2 PORT        container stacks, ship-to-shore cranes, warehouses
 *   3 SUBURB      low-rise blocks, pitched roofs, trees, local shops
 *   4 PARK        tree canopy, gentle berms, lone pylons, few lights
 */

export type DistrictKind = 'urban' | 'industrial' | 'port' | 'suburb' | 'park';

export const DISTRICT_NAMES: Record<DistrictKind, string> = {
  urban: 'URBAN CORE',
  industrial: 'INDUSTRIAL BELT',
  port: 'CONTAINER PORT',
  suburb: 'SUBURBAN RING',
  park: 'PARKWAY',
};

export interface DistrictProfile {
  kind: DistrictKind;
  /** multiplier for skyline structure counts (near/mid bands) */
  skyline: number;
  /** multiplier for far-horizon light clusters */
  haze: number;
  /** emissive window intensity multiplier */
  windowGlow: number;
  /** does this district plant trees? */
  trees: boolean;
}

const PROFILES: Record<DistrictKind, DistrictProfile> = {
  urban: { kind: 'urban', skyline: 1.55, haze: 1.35, windowGlow: 1.2, trees: false },
  industrial: { kind: 'industrial', skyline: 0.55, haze: 0.85, windowGlow: 0.6, trees: false },
  port: { kind: 'port', skyline: 0.4, haze: 1.0, windowGlow: 0.5, trees: false },
  suburb: { kind: 'suburb', skyline: 0.5, haze: 0.9, windowGlow: 0.8, trees: true },
  park: { kind: 'park', skyline: 0.3, haze: 0.6, windowGlow: 0.4, trees: true },
};

/** length of one full district cycle (m) */
export const DISTRICT_CYCLE = 2600;

/** band order + share of the cycle; sums to 1 */
const BAND_LAYOUT: { kind: DistrictKind; share: number }[] = [
  { kind: 'urban', share: 0.28 },
  { kind: 'industrial', share: 0.2 },
  { kind: 'port', share: 0.16 },
  { kind: 'suburb', share: 0.2 },
  { kind: 'park', share: 0.16 },
];

/** cheap deterministic hash → [0,1) */
function hash01(n: number, salt: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35);
  x ^= x >>> 15;
  x = Math.imul(x, 0x2545f491);
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

/** district covering arc length s */
export function districtKindAt(s: number): DistrictKind {
  const cycle = Math.floor(s / DISTRICT_CYCLE);
  // per-cycle rotation so the order is not identical every lap
  const rot = Math.floor(hash01(cycle, 11) * BAND_LAYOUT.length);
  const inCycle = s - cycle * DISTRICT_CYCLE;
  // boundaries jittered per-cycle by up to ±70 m
  const jitter = (hash01(cycle, 29) - 0.5) * 140;
  let acc = jitter;
  for (let i = 0; i < BAND_LAYOUT.length; i++) {
    const band = BAND_LAYOUT[(i + rot) % BAND_LAYOUT.length];
    const len = band.share * DISTRICT_CYCLE;
    if (inCycle < acc + len) return band.kind;
    acc += len;
  }
  return BAND_LAYOUT[rot % BAND_LAYOUT.length].kind;
}

export function districtProfileAt(s: number): DistrictProfile {
  return PROFILES[districtKindAt(s)];
}

/**
 * Blend factor for the district *transition*: returns how far (0..1) s sits
 * inside its band, so the chunk builder can fade asset density in/out near
 * boundaries rather than switching abruptly.
 */
export function districtEdgeFade(s: number): number {
  const kind = districtKindAt(s);
  const cycle = Math.floor(s / DISTRICT_CYCLE);
  const rot = Math.floor(hash01(cycle, 11) * BAND_LAYOUT.length);
  const inCycle = s - cycle * DISTRICT_CYCLE;
  const jitter = (hash01(cycle, 29) - 0.5) * 140;
  let acc = jitter;
  for (let i = 0; i < BAND_LAYOUT.length; i++) {
    const band = BAND_LAYOUT[(i + rot) % BAND_LAYOUT.length];
    const len = band.share * DISTRICT_CYCLE;
    if (kind === band.kind && inCycle < acc + len) {
      const t = (inCycle - acc) / len;
      const ramp = 0.12;
      return Math.min(1, Math.min(t, 1 - t) / ramp);
    }
    acc += len;
  }
  return 1;
}
