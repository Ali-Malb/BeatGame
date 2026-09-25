/**
 * ChunkBuilder — constructs one 100 m stretch of the expressway as a handful of
 * merged meshes (asphalt / concrete / emissive / additive glow). Shared materials
 * live in HighwayMaterials so the weather controller can tweak the whole world
 * at once (wet asphalt, lamp intensity, window emission...).
 *
 * Geometry is LANE-AWARE: the deck, barriers, skirts and pillars follow
 * spline.driveHalfAt(s), so the road physically widens 3→6 lanes and narrows
 * back. Tunnel zones get a full bore: roof, portal frames, interior lamps and
 * darker ambient handled by the biome controller.
 */

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoadSpline, SAMPLE_STEP } from './roadSpline';
import { concreteTexture, roadTexture, oncomingRoadTexture, signTexture, windowTexture, glowTexture } from './textures';
import { RNG, clamp } from '../core/utils';
import { districtKindAt, districtProfileAt, districtEdgeFade } from './districts';

export const CHUNK_LEN = 100;

/** legacy constants kept for compatibility (actual geometry queries the spline) */
export const LANES = 4;
export const LANE_W = 3.5;
export const LANE_CENTERS = [-5.25, -1.75, 1.75, 5.25];
export const DRIVE_HALF = 6.55;
/** joint spacing for suspension clatter / audio thumps (bridge expansion joints) */
export const JOINT_EVERY = 60;

export class HighwayMaterials {
  asphalt = new THREE.MeshStandardMaterial({ map: roadTexture(), roughness: 0.93, metalness: 0.02 });
  asphaltOncoming = new THREE.MeshStandardMaterial({ map: oncomingRoadTexture(), roughness: 0.95, metalness: 0.0 });
  concrete = new THREE.MeshStandardMaterial({ map: concreteTexture(), roughness: 0.85, metalness: 0.0, color: 0xbdbdb8 });
  lampHead = new THREE.MeshBasicMaterial({ color: 0xffe6b0 });
  lampCone = new THREE.MeshBasicMaterial({
    color: 0xffd9a0,
    transparent: true,
    opacity: 0.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  lampPool = new THREE.MeshBasicMaterial({
    map: glowTexture(),
    color: 0xffd9a0,
    transparent: true,
    opacity: 0.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  railing = new THREE.MeshStandardMaterial({ color: 0x8d949c, metalness: 0.85, roughness: 0.32 });
  bridgePaint = new THREE.MeshStandardMaterial({ color: 0xc2571f, roughness: 0.55, metalness: 0.25 });
  darkMetal = new THREE.MeshStandardMaterial({ color: 0x2e3238, roughness: 0.6, metalness: 0.55 });
  sign = new THREE.MeshStandardMaterial({
    map: signTexture(0),
    emissiveMap: signTexture(0),
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 0.25,
    roughness: 0.8,
  });
  windows = [0, 1, 2, 3].map(
    (v) =>
      new THREE.MeshStandardMaterial({
        map: windowTexture(v),
        emissiveMap: windowTexture(v),
        emissive: new THREE.Color(0xffffff),
        emissiveIntensity: 0.25 + v * 0.01,
        color: [0x69717b, 0x626a74, 0x727985, 0x5e6772][v],
        roughness: 0.82,
      })
  );
  blinkRed = new THREE.MeshBasicMaterial({ color: 0xff2211 });
  blinkOrange = new THREE.MeshBasicMaterial({ color: 0xff8c1a });
  /** geometric lane dashes (slightly emissive so headlights/ageing read) */
  paint = new THREE.MeshStandardMaterial({ color: 0xd8d6c8, roughness: 0.6, metalness: 0.0, emissive: 0x55534a, emissiveIntensity: 0.12 });
  /** continuous shoulder line */
  paintEdge = new THREE.MeshStandardMaterial({ color: 0xe8e6d8, roughness: 0.62, metalness: 0.0, emissive: 0x55534a, emissiveIntensity: 0.1 });
  /** reflector post body */
  reflector = new THREE.MeshStandardMaterial({ color: 0xd8d8d4, roughness: 0.7, metalness: 0.1 });
  /** reflector head (bright, catches headlights) */
  reflectorHead = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.0, emissive: 0xfff8e0, emissiveIntensity: 0.55 });
  /** shipping containers (port district) — a few believable paint colours */
  containers = [0xb8452f, 0x2f6bb8, 0x3f8f4a, 0xc98a24, 0x7d7f86].map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.78, metalness: 0.22 })
  );
  /** storage tank shells (industrial belt) */
  tank = new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.42, metalness: 0.45 });
  /** brick/concrete low-rise facades (suburbs) */
  brick = new THREE.MeshStandardMaterial({ color: 0x5c4b41, roughness: 0.92, metalness: 0.0 });
  /** parkway / suburb canopy foliage */
  foliage = new THREE.MeshStandardMaterial({ color: 0x1c3324, roughness: 0.95, metalness: 0.0 });
  /** harbour / canal water in the container port */
  water = new THREE.MeshStandardMaterial({ color: 0x0a1620, roughness: 0.12, metalness: 0.85 });

  dispose() {
    for (const m of [
      this.asphalt,
      this.asphaltOncoming,
      this.concrete,
      this.lampHead,
      this.lampCone,
      this.lampPool,
      this.railing,
      this.bridgePaint,
      this.darkMetal,
      this.sign,
      ...this.windows,
      this.blinkRed,
      this.blinkOrange,
      this.paint,
      this.paintEdge,
      this.reflector,
      this.reflectorHead,
      ...this.containers,
      this.tank,
      this.brick,
      this.foliage,
      this.water,
    ])
      m.dispose();
  }
}

interface GeomBuckets {
  [key: string]: THREE.BufferGeometry[];
}

/** Geometry-only payload sent from the chunk worker to the render thread. */
export interface SerializedChunkPart {
  bucket: string;
  position: ArrayBuffer;
  normal: ArrayBuffer | null;
  uv: ArrayBuffer | null;
  index: ArrayBuffer | null;
}

/** Shared bucket → material mapping used by both the worker and the renderer. */
export function materialForChunkBucket(mats: HighwayMaterials, bucket: string): THREE.Material {
  if (bucket.startsWith('windows')) return mats.windows[Number(bucket.slice(7))] ?? mats.windows[0];
  if (bucket.startsWith('container')) return mats.containers[Number(bucket.slice(9))] ?? mats.containers[0];
  switch (bucket) {
    case 'asphalt': return mats.asphalt;
    case 'asphaltOnc': return mats.asphaltOncoming;
    case 'darkMetal': return mats.darkMetal;
    case 'railing': return mats.railing;
    case 'bridgePaint':
    case 'bridgeCable': return mats.bridgePaint;
    case 'lampHead': return mats.lampHead;
    case 'lampCone': return mats.lampCone;
    case 'lampPool': return mats.lampPool;
    case 'sign': return mats.sign;
    case 'blinkRed': return mats.blinkRed;
    case 'blinkOrange': return mats.blinkOrange;
    case 'paint': return mats.paint;
    case 'paintEdge': return mats.paintEdge;
    case 'reflector': return mats.reflector;
    case 'reflectorHead': return mats.reflectorHead;
    case 'tank': return mats.tank;
    case 'brick': return mats.brick;
    case 'foliage': return mats.foliage;
    case 'water': return mats.water;
    default: return mats.concrete;
  }
}

function box(w: number, h: number, d: number, x = 0, y = 0, z = 0, rotY = 0, rotZ = 0, rotX = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotX) g.rotateX(rotX);
  if (rotZ) g.rotateZ(rotZ);
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z);
  return g;
}

function cyl(rTop: number, rBot: number, h: number, x = 0, y = 0, z = 0, seg = 10): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, true);
  g.translate(x, y, z);
  return g;
}

interface P3 {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * Place a local-space geometry (local +Z = forward, +X = right) onto the road
 * frame at (lateral, forward, lift) relative to point p with heading p.yaw.
 * rotateY(yaw) maps +Z → (sin yaw, 0, cos yaw) which is exactly our forward.
 */
function alongR(g: THREE.BufferGeometry, px: number, py: number, pz: number, yaw: number, lateral: number, forward: number, lift: number): THREE.BufferGeometry {
  g.rotateY(yaw);
  const rX = Math.cos(yaw);
  const rZ = -Math.sin(yaw);
  const fX = Math.sin(yaw);
  const fZ = Math.cos(yaw);
  g.translate(px + rX * lateral + fX * forward, py + lift, pz + rZ * lateral + fZ * forward);
  return g;
}

function along(g: THREE.BufferGeometry, p: P3, lateral: number, forward: number, lift: number): THREE.BufferGeometry {
  return alongR(g, p.x, p.y, p.z, p.yaw, lateral, forward, lift);
}

/** deck surface strip between two lateral bounds (lateral now = fn(s) for variable width) */
function deckStrip(spline: RoadSpline, s0: number, s1: number, latMin: (s: number) => number, latMax: (s: number) => number, vRepeatMeters: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  const n = Math.max(2, Math.round((s1 - s0) / SAMPLE_STEP) + 1);
  const step = (s1 - s0) / (n - 1);
  const pt = { x: 0, y: 0, z: 0, yaw: 0, rx: 1, rz: 0, kappa: 0, s: 0, slope: 0 };
  for (let i = 0; i < n; i++) {
    const s = s0 + i * step;
    spline.get(s, pt);
    const rX = Math.cos(pt.yaw);
    const rZ = -Math.sin(pt.yaw);
    const lMin = latMin(s);
    const lMax = latMax(s);
    pos.push(pt.x + rX * lMin, pt.y, pt.z + rZ * lMin);
    pos.push(pt.x + rX * lMax, pt.y, pt.z + rZ * lMax);
    const v = s / vRepeatMeters;
    uvs.push(0, v, 1, v);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    // winding so normals face +Y
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** flat ground-level strip parallel to the spline (service roads below the deck) */
function groundStrip(spline: RoadSpline, s0: number, s1: number, latMin: number, latMax: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  const n = Math.max(2, Math.round((s1 - s0) / SAMPLE_STEP) + 1);
  const step = (s1 - s0) / (n - 1);
  const pt = { x: 0, y: 0, z: 0, yaw: 0, rx: 1, rz: 0, kappa: 0, s: 0, slope: 0 };
  for (let i = 0; i < n; i++) {
    const s = s0 + i * step;
    spline.get(s, pt);
    const rX = Math.cos(pt.yaw);
    const rZ = -Math.sin(pt.yaw);
    pos.push(pt.x + rX * latMin, 0.08, pt.z + rZ * latMin);
    pos.push(pt.x + rX * latMax, 0.08, pt.z + rZ * latMax);
    const v = s / 18;
    uvs.push(0, v, 1, v);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** extruded wall following the road (barriers) at a per-s lateral offset */
function barrierStrip(spline: RoadSpline, s0: number, s1: number, lateralFn: (s: number) => number, height: number, thickness: number, caps = true): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = [];
  const pt = { x: 0, y: 0, z: 0, yaw: 0, rx: 1, rz: 0, kappa: 0, s: 0, slope: 0 };
  const n = Math.max(2, Math.round((s1 - s0) / SAMPLE_STEP) + 1);
  const step = (s1 - s0) / (n - 1);
  let prevX = 0;
  let prevZ = 0;
  let prevY = 0;
  for (let i = 0; i < n; i++) {
    const s = s0 + i * step;
    spline.get(s, pt);
    const lateral = lateralFn(s);
    const rX = Math.cos(pt.yaw);
    const rZ = -Math.sin(pt.yaw);
    const cx = pt.x + rX * lateral;
    const cz = pt.z + rZ * lateral;
    if (i > 0) {
      const segLen = Math.hypot(cx - prevX, cz - prevZ);
      const yawMid = Math.atan2(cx - prevX, cz - prevZ);
      const mid = { x: (cx + prevX) / 2, y: (pt.y + prevY) / 2, z: (cz + prevZ) / 2, yaw: yawMid };
      const g = box(thickness, height, segLen + 0.02, 0, 0, 0);
      along(g, mid, 0, 0, height / 2);
      geos.push(g);
      if (caps && i % 2 === 1) {
        const cap = box(thickness * 1.14, height * 0.12, 0.24, 0, 0, 0);
        along(cap, mid, 0, 0, height);
        geos.push(cap);
      }
    }
    prevX = cx;
    prevZ = cz;
    prevY = pt.y;
  }
  return BufferGeometryUtils.mergeGeometries(geos, false)!;
}

function buildingBox(w: number, h: number, d: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const faceScales: [number, number][] = [
    [d / 7, h / 3.4], // +x
    [d / 7, h / 3.4], // -x
    [w / 9, d / 9], // +y roof
    [w / 9, d / 9], // -y
    [w / 7, h / 3.4], // +z
    [w / 7, h / 3.4], // -z
  ];
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 4; i++) {
      const vi = f * 4 + i;
      uv.setXY(vi, uv.getX(vi) * faceScales[f][0], uv.getY(vi) * faceScales[f][1]);
    }
  }
  return g;
}

export interface ChunkBuildResult {
  group: THREE.Group;
  geometries: THREE.BufferGeometry[];
}

export interface ChunkBuildOptions {
  /** 0 keeps only the road/structural silhouette; 2 is the full scene. */
  detail?: 0 | 1 | 2;
}

/** Buckets that remain in the software-renderer silhouette. */
export const LOW_DETAIL_BUCKETS = new Set([
  'asphalt',
  'asphaltOnc',
  'concrete',
  'railing',
  'bridgePaint',
  'bridgeCable',
  'paint',
  'paintEdge',
]);

export function buildChunk(spline: RoadSpline, mats: HighwayMaterials, chunkIndex: number, seed: number, options: ChunkBuildOptions = {}): ChunkBuildResult {
  const detail = options.detail ?? 2;
  const s0 = chunkIndex * CHUNK_LEN;
  const s1 = s0 + CHUNK_LEN;
  spline.ensure(s1 + 300);
  const rng = new RNG(seed >>> 0);
  const geos: GeomBuckets = {};
  const push = (bucket: string, g: THREE.BufferGeometry) => {
    (geos[bucket] ??= []).push(g);
  };

  const isBridge = spline.isBridgeAt(s0 + CHUNK_LEN / 2);
  const isTunnel = spline.isTunnelAt(s0 + CHUNK_LEN / 2);
  const bridge = spline.bridgeRange();
  const pt = { x: 0, y: 0, z: 0, yaw: 0, rx: 1, rz: 0, kappa: 0, s: 0, slope: 0 };

  // ---- lateral bounds as functions of s (lane-aware width) ----
  const dHalf = (s: number) => spline.driveHalfAt(s);
  const latMaxD = (s: number) => dHalf(s) + 0.75; // asphalt slightly under barrier
  const latMinD = (s: number) => -7.3; // median-side edge fixed

  // ---------------- deck surfaces ----------------
  push('asphalt', deckStrip(spline, s0, s1, latMinD, latMaxD, 14));
  push('asphaltOnc', deckStrip(spline, s0, s1, () => -14.6, () => -7.3, 18));

  // ground-level service road under the viaduct (§11 multi-level world): a
  // dark ribbon at y≈0 following the spline's plan shape, visible wherever the
  // deck is elevated — reads as a real road network below the highway
  push('asphaltOnc', groundStrip(spline, s0, s1, 9.5, 24));
  push('asphaltOnc', groundStrip(spline, s0, s1, -34, -19));

  // deck skirts + underside slab (right edge follows variable width)
  for (let s = s0; s < s1 - 0.01; s += SAMPLE_STEP) {
    spline.get(s, pt);
    const half = dHalf(s);
    push('concrete', along(box(0.35, 0.85, SAMPLE_STEP + 0.02), pt, half + 0.15, 0, -0.42));
    push('concrete', along(box(0.35, 0.85, SAMPLE_STEP + 0.02), pt, -14.75, 0, -0.42));
    const slabW = half + 15.4; // from -15.4ish to right edge
    const slabCx = (half + 0.4 - 15.4) / 2;
    push('concrete', along(box(slabW, 0.55, SAMPLE_STEP + 0.02), pt, slabCx, 0, -0.6));
  }

  // ---------------- retaining walls + ground-level guard rail ----------------
  // Where the viaduct rides high, a concrete retaining wall runs down the
  // embankment; the ground-level service roads get their own guard rail, so the
  // multi-level world reads as a real road network, not a floating slab.
  for (let s = s0; s < s1 - 0.01; s += SAMPLE_STEP) {
    spline.get(s, pt);
    if (pt.y > 11 && !isBridge) {
      const h = pt.y - 0.6;
      for (const lat of [-24.5, 22.5]) {
        push('concrete', along(box(1.0, h, SAMPLE_STEP + 0.02), pt, lat, 0, -h / 2));
        push('darkMetal', along(box(1.35, 0.25, SAMPLE_STEP + 0.02), pt, lat, 0, 0.1 - h));
      }
    }
  }
  for (let s = Math.ceil(s0 / 12) * 12; s < s1; s += 12) {
    spline.get(s, pt);
    for (const lat of [9.7, -19.4]) {
      push('railing', along(box(0.14, 0.09, 11.6), pt, lat, 0, -pt.y + 0.72));
      push('darkMetal', along(box(0.12, 0.66, 0.12), pt, lat, 0, -pt.y + 0.4));
    }
  }

  // ---------------- geometric lane markings (follow REAL lane boundaries) ----
  // The asphalt texture carries only edge lines + wear; dashes are geometry so
  // they stay aligned with laneX(s) on 3/4/5/6-lane sections and tapers.
  for (let s = s0; s < s1 - 0.01; s += SAMPLE_STEP) {
    spline.get(s, pt);
    const lanes = spline.lanesAt(s + SAMPLE_STEP / 2);
    for (let b = 1; b < lanes; b++) {
      // boundary between lane b-1 and b at the segment MIDPOINT of this step
      const xa = spline.laneX(s, b - 1);
      const xb = spline.laneX(s, b);
      const x = (xa + xb) / 2;
      const g = box(0.14, 0.012, SAMPLE_STEP * 0.55);
      push('paint', along(g, pt, x, 0.006, 0));
    }
    // right shoulder line hugging the outer barrier (worn white)
    const edge = dHalf(s) + 0.28;
    push('paintEdge', along(box(0.16, 0.012, SAMPLE_STEP + 0.02), pt, edge, 0.006, 0));
  }

  // ---------------- median Jersey barrier + anti-glare slats ----------------
  push('concrete', barrierStrip(spline, s0, s1, () => -6.95, 1.1, 0.62));
  for (let s = s0 + 4; s < s1; s += 8) {
    spline.get(s, pt);
    push('darkMetal', along(box(0.34, 0.62, 0.12), pt, -6.95, 0, 1.35));
  }

  // ---------------- outer wall + railing + acoustic panels ----------------
  push('concrete', barrierStrip(spline, s0, s1, (s) => dHalf(s) + 0.4, 0.95, 0.55, false));
  for (let s = s0 + 2; s < s1; s += 4) {
    spline.get(s, pt);
    const edge = dHalf(s) + 0.4;
    push('railing', along(box(0.16, 0.1, 3.9), pt, edge + 0.03, 0, 1.28));
    push('railing', along(box(0.1, 0.42, 0.1), pt, edge + 0.03, 0, 1.05));
  }
  if (rng.next() < 0.35 && !isBridge && !isTunnel) {
    const panelLen = rng.range(40, 90);
    const ps = s0 + rng.range(0, 60);
    const pe = Math.min(s1, ps + panelLen);
    if (pe - ps > 10) {
      push('darkMetal', barrierStrip(spline, ps, pe, (s) => dHalf(s) + 0.6, 4.2, 0.18, false));
      for (let s = ps; s < pe; s += 6) {
        spline.get(s, pt);
        push('railing', along(box(0.22, 4.0, 0.26), pt, dHalf(s) + 0.6, 0, 2.9));
      }
    }
  }

  // ---------------- streetlamps (right edge, staggered with left) ----------------
  // GLOBAL uniform stations (s ≡ 8 mod 35 right, +17.5 left) so StreetLights'
  // real PointLights land exactly on the visual lamp heads across chunk seams.
  for (let ls = Math.ceil(s0 / 35) * 35 + 8; ls < s1; ls += 35) {
    for (const side of [1, -1]) {
      const st = side === 1 ? ls : ls + 17.5;
      if (st >= s1 || st < s0) continue;
      if (spline.isBridgeAt(st)) continue; // suspension spans carry their own cable lighting
      const s = st;
      spline.get(s, pt);
      const edge = dHalf(s) + 0.2;
      const lat = side === 1 ? edge : -7.1;
      push('darkMetal', along(cyl(0.09, 0.13, 10.5, 0, 0, 0, 6), pt, lat, 0, 5.25));
      push('darkMetal', along(box(2.6, 0.12, 0.14), pt, lat - side * 1.3, 0, 10.4));
      push('lampHead', along(box(0.72, 0.16, 0.3), pt, lat - side * 2.55, 0, 10.3));
      // NO cone geometry: the additive ground pool below does the visual work,
      // a REAL PointLight is contributed by the nearby-light pool (§24)
      const pool = new THREE.PlaneGeometry(7.5, 9.5);
      pool.rotateX(-Math.PI / 2);
      push('lampPool', along(pool, pt, lat - side * 2.2, 0, 0.045));
    }
  }

  // ---------------- roadside reflector posts (night depth cue, §8) --------
  // small white/amber posts at the shoulder every 20 m; emissive so they
  // pop under headlights — cheap (4 tris each) and merges into one bucket
  for (let s = Math.ceil(s0 / 20) * 20; s < s1; s += 20) {
    spline.get(s, pt);
    const edge = dHalf(s) + 0.75;
    push('reflector', along(box(0.06, 0.75, 0.06), pt, edge, 0, 0.375));
    push('reflectorHead', along(box(0.08, 0.08, 0.02), pt, edge, 0, 0.72));
  }

  // ---------------- viaduct support pillars (skipped on bridge) ----------------
  if (!isBridge) {
    for (let s = s0 + 12; s < s1; s += 35) {
      spline.get(s, pt);
      const h = pt.y - 0.4;
      const cx = (dHalf(s) + 0.4 - 15.4) / 2;
      push('concrete', along(cyl(1.5, 1.9, h, 0, 0, 0, 10), pt, cx, 0, -h / 2));
      push('concrete', along(box(4.2, 1.0, 3.4), pt, cx, 0, -1.2));
    }
  }

  // ---------------- tunnel bore ----------------
  if (isTunnel) {
    // portal frame at the entry (thick face + sign band)
    const entryS = spline.tunnelRangesUpTo(s1).find((t) => s0 < t.end && t.end < s1 || (t.start <= s0 && t.end >= s0));
    const tStart = entryS ? entryS.start : s0;
    if (s0 - tStart < CHUNK_LEN) {
      // portal face: arch approximated by a rectangular frame
      spline.get(Math.max(s0, tStart) + 0.5, pt);
      const half = dHalf(pt.s) + 0.8;
      push('concrete', along(box(half * 2 + 3, 2.2, 2.6), pt, 0, 0, 7.2));
      for (const side of [-1, 1]) {
        push('concrete', along(box(2.4, 8.6, 2.6), pt, side * (half + 1.1), 0, 4.1));
      }
    }
    // interior: ceiling slab + side walls + wall lamps
    for (let s = s0; s < s1 - 0.01; s += SAMPLE_STEP) {
      spline.get(s, pt);
      const half = dHalf(s) + 1.2;
      // ceiling
      push('concrete', along(box(half * 2 + 2.4, 0.7, SAMPLE_STEP + 0.02), pt, 0, 0, 7.6));
      // walls
      for (const side of [-1, 1]) {
        push('concrete', along(box(0.7, 8.0, SAMPLE_STEP + 0.02), pt, side * half, 0, 3.6));
      }
    }
    // wall lamps every 10 m (emissive heads + additive pools brighten the deck)
    for (let s = s0 + 5; s < s1; s += 10) {
      spline.get(s, pt);
      for (const side of [-1, 1]) {
        const half = dHalf(s) + 0.9;
        push('lampHead', along(box(0.5, 0.16, 0.24), pt, side * half, 0, 5.4));
        const pool = new THREE.PlaneGeometry(6.5, 8);
        pool.rotateX(-Math.PI / 2);
        push('lampPool', along(pool, pt, side * (dHalf(s) - 1.6), 0, 0.05));
      }
    }
  }

  // ---------------- sign gantries (every 200–350 m) ----------------
  if (s0 % 300 < CHUNK_LEN && rng.next() < 0.92 && !isTunnel) {
    const gs = s0 + 55;
    spline.get(gs, pt);
    for (const lat of [-7.7, 7.7]) {
      push('darkMetal', along(box(0.32, 6.6, 0.32), pt, lat, 0, 3.3));
    }
    push('darkMetal', along(box(15.8, 0.5, 0.5), pt, 0, 0, 6.4));
    push('darkMetal', along(box(15.8, 0.22, 0.22), pt, 0, 0, 5.6));
    for (let i = -6; i <= 6; i += 2) {
      const diag = box(2.4, 0.1, 0.1, 0, 0, 0);
      diag.rotateZ(0.42);
      push('darkMetal', along(diag, pt, i, 0, 6.0));
    }
    const nBoards = rng.int(1, 2);
    for (let b = 0; b < nBoards; b++) {
      const lat = b === 0 ? -4.0 : 3.4;
      const board = new THREE.PlaneGeometry(4.4, 2.0);
      board.rotateY(Math.PI);
      push('sign', along(board, pt, lat, 0, 5.4));
      push('darkMetal', along(box(4.6, 2.2, 0.08), pt, lat, 0, 5.4));
    }
  }

  // ---------------- overpasses crossing overhead at oblique angles ----------------
  for (const ov of spline.consumeOverpassesUpTo(s1 + 50)) {
    if (ov.s < s0 || ov.s >= s1) continue;
    spline.get(ov.s, pt);
    const yaw = pt.yaw + ov.angle;
    const deckY = 9.2;
    const cx = pt.x + Math.cos(pt.yaw) * -3.6;
    const cz = pt.z - Math.sin(pt.yaw) * -3.6;
    // crossing deck: local X = span direction
    const deckOv = box(33, 1.1, 9.5);
    push('concrete', alongR(deckOv, cx, pt.y + deckY, cz, yaw, 0, 0, 0));
    for (const side of [-4.6, 4.6]) {
      push('concrete', alongR(box(0.2, 1.05, 33), cx, pt.y + deckY + 1.0, cz, yaw, side, 0, 0));
    }
    // pillars land outside the full deck
    for (const sgn of [-1, 1]) {
      for (const zf of [-8, 8]) {
        const h = pt.y + deckY - 1.5;
        push('concrete', alongR(cyl(0.85, 1.05, h, 0, 0, 0, 10), cx, pt.y + deckY, cz, yaw, sgn * 19.5, zf, -h / 2 - 0.4));
      }
    }
    for (const f of [-9, 9]) {
      push('lampHead', alongR(box(0.5, 0.14, 0.24), cx, pt.y + deckY + 2.0, cz, yaw, 0, f, 0));
    }
  }

  // ---------------- suspension bridge zone ----------------
  if (isBridge && bridge) {
    // towers at fixed stations inside the zone
    for (const towerS of [bridge.start + 60, bridge.start + 260]) {
      if (towerS < s0 - 5 || towerS > s1 + 5) continue;
      spline.get(towerS, pt);
      const towerH = 27;
      for (const lat of [-13.2, 8.2]) {
        push('bridgePaint', along(box(2.2, towerH, 2.4), pt, lat, 0, towerH / 2));
        for (const hy of [8, 18, towerH - 1.5]) {
          push('bridgePaint', along(box(21.6, 1.2, 0.7), pt, -2.5, 0, hy));
        }
        const al = new THREE.SphereGeometry(0.35, 8, 6);
        push('blinkOrange', along(al, pt, lat, 0, towerH + 0.5));
      }
    }
    // main cables + hangers along both edges of our carriageway
    for (const edgeLat of [7.05, -7.05]) {
      const n = 20;
      const pts3: THREE.Vector3[] = [];
      for (let i = 0; i <= n; i++) {
        const s = s0 + (i / n) * CHUNK_LEN;
        spline.get(s, pt);
        const p = s - bridge.start;
        const d = Math.min(Math.abs(p - 60), Math.abs(p - 260));
        const cableY = pt.y + 2.2 + Math.pow(1 - clamp(d / 100, 0, 1), 1.5) * 23.5;
        const rX = Math.cos(pt.yaw);
        const rZ = -Math.sin(pt.yaw);
        pts3.push(new THREE.Vector3(pt.x + rX * edgeLat, cableY, pt.z + rZ * edgeLat));
      }
      const curve = new THREE.CatmullRomCurve3(pts3);
      push('bridgeCable', new THREE.TubeGeometry(curve, 24, 0.11, 6, false));
      for (let i = 1; i < n; i += 2) {
        const p = pts3[i];
        const s = s0 + (i / n) * CHUNK_LEN;
        spline.get(s, pt);
        const hangH = p.y - (pt.y + 1.4);
        if (hangH > 3.5) {
          const hg = cyl(0.05, 0.05, hangH, 0, 0, 0, 4);
          hg.translate(p.x, p.y - hangH / 2, p.z);
          push('bridgeCable', hg);
        }
      }
    }
    // orange rails along bridge edges (follow variable width on the right)
    for (let s = s0; s < s1 - 0.01; s += SAMPLE_STEP) {
      spline.get(s, pt);
      push('bridgePaint', along(box(0.18, 0.5, SAMPLE_STEP + 0.02), pt, dHalf(s) + 0.55, 0, 1.25));
      push('bridgePaint', along(box(0.18, 0.5, SAMPLE_STEP + 0.02), pt, -7.12, 0, 1.25));
    }
  }

  // ---------------- interchange / exit ramp (landmark every ~1.7 km) -------
  if (!isTunnel && !isBridge && s0 % 1700 < CHUNK_LEN) {
    spline.get(s0 + 18, pt);
    const steps = 15;
    for (let i = 0; i < steps; i++) {
      const fw = i * 8;
      const lat = 8.6 + i * i * 0.135;
      const lift = -0.3 - i * i * 0.062;
      push('concrete', along(box(7.6, 0.7, 8.4), pt, lat, fw, lift));
      for (const sgn of [-1, 1]) {
        push('railing', along(box(0.16, 0.1, 8.2), pt, lat + sgn * 3.6, fw, lift + 0.95));
        push('darkMetal', along(box(0.14, 0.9, 0.14), pt, lat + sgn * 3.6, fw, lift + 0.5));
      }
      if (i % 3 === 0) {
        push('darkMetal', along(cyl(0.08, 0.11, 6.2, 0, 0, 0, 6), pt, lat - 3.4, fw, lift + 3.1));
        push('lampHead', along(box(0.6, 0.14, 0.28), pt, lat - 4.4, fw, lift + 6.1));
      }
      if (i % 4 === 2) {
        const h = Math.max(2.5, pt.y + lift - 0.4);
        push('concrete', along(cyl(0.9, 1.1, h, 0, 0, 0, 8), pt, lat, fw, lift - h / 2 - 0.4));
      }
    }
    // divergence gantry + exit board over the ramp
    push('darkMetal', along(box(0.3, 5.8, 0.3), pt, 7.4, 12, 2.9));
    push('darkMetal', along(box(0.3, 5.8, 0.3), pt, 18.6, 26, 2.9));
    push('darkMetal', along(box(12.4, 0.4, 0.4), pt, 13, 19, 5.6));
    const exitSign = new THREE.PlaneGeometry(3.6, 1.6);
    exitSign.rotateY(Math.PI);
    push('sign', along(exitSign, pt, 13, 19, 4.6));
  }

  // ---------------- skyline buildings ----------------
  // The low render tier keeps the deterministic spline/road structure but
  // skips distant set dressing.  This removes the expensive city/factory
  // geometry before it can compete with the render thread for CPU.
  if (detail > 0) {
  const dKind = districtKindAt(s0 + CHUNK_LEN / 2);
  const dProf = districtProfileAt(s0 + CHUNK_LEN / 2);
  const dEdge = districtEdgeFade(s0 + CHUNK_LEN / 2);
  const density = 0.5 + 0.5 * dEdge;
  if (!isTunnel) {
    const variant = rng.int(0, 3);
    for (const side of [-1, 1]) {
      const count = Math.max(1, Math.round(rng.int(3, 6) * dProf.skyline * density));
      for (let b = 0; b < count; b++) {
        const s = s0 + rng.range(0, CHUNK_LEN);
        spline.get(s, pt);
        const dist = rng.range(34, 130) * side;
        const w = rng.range(16, 42);
        const d = rng.range(16, 42);
        const h = rng.range(28, 175) * (side === 1 ? 1 : 0.8);
        const lat = dist + (side === 1 ? 14 : -14);
        push(`windows${variant}`, along(buildingBox(w, h, d), pt, lat, 0, h / 2 - pt.y));

        const roofChance = h > 110 ? 0.72 : 0.34;
        if (rng.next() < roofChance) {
          const roofH = rng.range(4, Math.min(15, h * 0.12));
          const roofW = w * rng.range(0.48, 0.78);
          const roofD = d * rng.range(0.48, 0.78);
          push('darkMetal', along(box(roofW, roofH, roofD), pt, lat, 0, h - pt.y + roofH * 0.5));
          if (rng.next() < 0.55) {
            push('darkMetal', along(box(roofW * 0.18, roofH * 0.7, roofD * 0.18), pt, lat + rng.range(-roofW * 0.2, roofW * 0.2), 0, h - pt.y + roofH + roofH * 0.35));
          }
        }
        if (h > 120) {
          push('darkMetal', along(box(w * 0.4, 3.5, d * 0.4), pt, lat, 0, h - pt.y + 1.75));
          push('blinkRed', along(new THREE.SphereGeometry(0.55, 8, 6), pt, lat, 0, h - pt.y + 3.9));
        }
      }
      if (rng.next() < 0.18 * dProf.skyline) {
        const s = s0 + rng.range(0, CHUNK_LEN);
        spline.get(s, pt);
        const lat = rng.range(48, 95) * side;
        push('darkMetal', along(box(3.0, 62, 3.0), pt, lat, 0, 24 - pt.y));
        push('darkMetal', along(box(48, 2.4, 2.4), pt, lat, 0, 46 - pt.y));
        push('darkMetal', along(box(13, 2.0, 2.0), pt, lat - 9 * side, 0, 45.5 - pt.y));
        push('darkMetal', along(box(2.6, 2.6, 3.4), pt, lat - 9 * side, 0, 43.5 - pt.y));
        push('blinkRed', along(new THREE.SphereGeometry(0.6, 8, 6), pt, lat, 0, 55 - pt.y));
      }
    }

    // ---- district vocabulary: the roadside changes character by stretch ----
    if (dKind === 'industrial') {
      for (const side of [-1, 1]) {
        // storage tank farm
        for (let t = 0, tanks = rng.int(2, 4); t < tanks; t++) {
          spline.get(s0 + rng.range(0, CHUNK_LEN), pt);
          const r = rng.range(5, 8.5);
          const h = rng.range(8, 15);
          const lat = side * rng.range(30, 78);
          const lift = -pt.y + h / 2;
          push('tank', along(cyl(r, r, h, 0, 0, 0, 14), pt, lat, 0, lift));
          push('darkMetal', along(cyl(r + 0.25, r + 0.25, 0.7, 0, 0, 0, 14), pt, lat, 0, lift + h / 2));
        }
        // pipe rack: frame carrying three long pipes
        spline.get(s0 + rng.range(10, 70), pt);
        const rackLat = side * rng.range(16, 24);
        push('darkMetal', along(box(0.35, 4.4, 0.35), pt, rackLat, -6, -pt.y + 2.2));
        push('darkMetal', along(box(0.35, 4.4, 0.35), pt, rackLat, 6, -pt.y + 2.2));
        push('darkMetal', along(box(2.6, 0.3, 14), pt, rackLat, 0, -pt.y + 4.3));
        for (let p = 0; p < 3; p++) {
          push('tank', along(cyl(0.28, 0.28, 13, 0, 0, 0, 8), pt, rackLat - 0.7 + p * 0.7, 0, -pt.y + 4.9));
        }
        // chimney stack with an aviation beacon
        if (rng.next() < 0.5) {
          spline.get(s0 + rng.range(10, 90), pt);
          const h = rng.range(38, 72);
          const lat = side * rng.range(36, 70);
          push('concrete', along(cyl(2.0, 3.0, h, 0, 0, 0, 12), pt, lat, 0, -pt.y + h / 2));
          push('blinkRed', along(new THREE.SphereGeometry(0.7, 8, 6), pt, lat, 0, -pt.y + h + 0.8));
        }
        // long low shed with a lit strip
        if (rng.next() < 0.65) {
          spline.get(s0 + rng.range(0, CHUNK_LEN), pt);
          const w = rng.range(26, 46);
          const ww = rng.range(12, 20);
          const hh = rng.range(7, 11);
          const lat = side * rng.range(32, 58);
          push(`windows${rng.int(0, 3)}`, along(box(w, hh, ww), pt, lat, 0, -pt.y + hh / 2));
          push('lampHead', along(box(w * 0.9, 0.18, 0.22), pt, lat - side * (ww / 2 + 0.3), 0, -pt.y + hh * 0.62));
        }
      }
    } else if (dKind === 'port') {
      for (const side of [-1, 1]) {
        // harbour water band (dark, reflective) beyond the quay
        spline.get(s0 + CHUNK_LEN / 2, pt);
        const quay = side * 92;
        push('water', along(box(150, 0.1, CHUNK_LEN + 40), pt, quay + side * 78, 0, -pt.y + 0.06));
        push('concrete', along(box(2.4, 3.2, CHUNK_LEN + 40), pt, quay, 0, -pt.y + 0.9));
        // container rows
        for (let r = 0, rows = rng.int(2, 4); r < rows; r++) {
          spline.get(s0 + rng.range(0, CHUNK_LEN), pt);
          const lat = side * rng.range(34, 80);
          const run = rng.int(4, 8);
          const stackH = rng.int(2, 4);
          for (let i = 0; i < run; i++) {
            for (let y = 0; y < stackH; y++) {
              push(
                `container${rng.int(0, 4)}`,
                along(box(2.44, 2.6, 12.2), pt, lat + i * 2.6 * side, 0, -pt.y + 1.35 + y * 2.66)
              );
            }
          }
        }
        // ship-to-shore gantry crane straddling the yard
        if (rng.next() < 0.6) {
          spline.get(s0 + rng.range(20, 80), pt);
          const lat = side * rng.range(40, 66);
          const legH = rng.range(24, 34);
          for (const dl of [-6, 6]) {
            push('darkMetal', along(box(1.0, legH, 1.0), pt, lat + dl * side, 0, -pt.y + legH / 2));
          }
          push('darkMetal', along(box(14, 1.6, 1.6), pt, lat, 0, -pt.y + legH + 0.8));
          push('darkMetal', along(box(2.0, 1.4, 34), pt, lat, -16 * side, -pt.y + legH + 1.4));
          push('blinkRed', along(new THREE.SphereGeometry(0.5, 8, 6), pt, lat, 0, -pt.y + legH + 2.0));
        }
        // warehouse shed
        if (rng.next() < 0.5) {
          spline.get(s0 + rng.range(0, CHUNK_LEN), pt);
          const w = rng.range(30, 54);
          const hh = rng.range(9, 13);
          const lat = side * rng.range(26, 44);
          push('concrete', along(box(w, hh, rng.range(16, 26)), pt, lat, 0, -pt.y + hh / 2));
          push('lampHead', along(box(w * 0.85, 0.2, 0.24), pt, lat, 0, -pt.y + hh + 0.2));
        }
      }
    } else if (dKind === 'suburb') {
      for (const side of [-1, 1]) {
        for (let b = 0, blocks = rng.int(2, 4); b < blocks; b++) {
          spline.get(s0 + rng.range(0, CHUNK_LEN), pt);
          const floors = rng.int(2, 5);
          const h = floors * 3.1;
          const w = rng.range(13, 21);
          const d = rng.range(12, 19);
          const lat = side * rng.range(24, 58);
          push(`windows${rng.int(0, 3)}`, along(box(w, h, d), pt, lat, 0, -pt.y + h / 2));
          push('brick', along(box(w + 0.6, 0.5, d + 0.6), pt, lat, 0, -pt.y + h + 0.25));
          push('darkMetal', along(box(w * 0.5, 1.6, d * 0.5), pt, lat, 0, -pt.y + h + 1.3));
          if (rng.next() < 0.5) {
            push('sign', along(box(2.6, 0.9, 0.12), pt, lat - side * (w / 2 + 0.2), 0, -pt.y + 4.4));
          }
        }
        // frontage street trees
        for (let t = 0; t < 4; t++) {
          spline.get(s0 + 8 + t * 24 + rng.range(0, 6), pt);
          const lat = side * rng.range(13, 18);
          const hh = rng.range(6, 10);
          push('darkMetal', along(cyl(0.18, 0.26, 2.4, 0, 0, 0, 6), pt, lat, 0, -pt.y + 1.2));
          push('foliage', along(cyl(0.2, 2.4, hh, 0, 0, 0, 7), pt, lat, 0, -pt.y + 2.4 + hh / 2));
        }
      }
    } else if (dKind === 'park') {
      for (const side of [-1, 1]) {
        // dense canopy line just outside the barrier
        for (let t = 0; t < 7; t++) {
          spline.get(s0 + 6 + t * 14 + rng.range(0, 5), pt);
          const lat = side * rng.range(11, 30);
          const hh = rng.range(7, 13);
          push('darkMetal', along(cyl(0.16, 0.24, 2.2, 0, 0, 0, 6), pt, lat, 0, -pt.y + 1.1));
          push('foliage', along(cyl(0.25, 3.0, hh, 0, 0, 0, 7), pt, lat, 0, -pt.y + 2.2 + hh / 2));
        }
        if (rng.next() < 0.5) {
          spline.get(s0 + rng.range(20, 80), pt);
          const lat = side * rng.range(45, 90);
          const h = rng.range(28, 44);
          push('darkMetal', along(box(3.2, h, 3.2), pt, lat, 0, -pt.y + h / 2));
          push('darkMetal', along(box(16, 1.2, 1.2), pt, lat, 0, -pt.y + h - 4));
          push('darkMetal', along(box(11, 1.0, 1.0), pt, lat, 0, -pt.y + h - 10));
        }
      }
    } else {
      // urban core: lit storefront band + projecting signage at street level
      for (const side of [-1, 1]) {
        for (let b = 0; b < 2; b++) {
          if (rng.next() > 0.6) continue;
          spline.get(s0 + rng.range(0, CHUNK_LEN), pt);
          const lat = side * rng.range(20, 34);
          const w = rng.range(9, 18);
          const h = rng.range(5, 9);
          push('brick', along(box(w, h, rng.range(10, 16)), pt, lat, 0, -pt.y + h / 2));
          push(`windows${rng.int(0, 3)}`, along(box(w * 0.9, 1.1, 0.2), pt, lat - side * 5.2, 0, -pt.y + 2.6));
          push('sign', along(box(3.4, 1.1, 0.14), pt, lat - side * 6.2, 0, -pt.y + 5.4));
        }
      }
    }

    // ---- far horizon band: silhouettes + scattered light clusters (depth) ---
    for (let b = 0, farN = rng.int(2, 5); b < farN; b++) {
      const side = rng.next() < 0.5 ? -1 : 1;
      spline.get(s0 + rng.range(0, CHUNK_LEN), pt);
      const lat = side * rng.range(150, 430);
      const w = rng.range(24, 60);
      const h = rng.range(30, 130);
      push(`windows${rng.int(0, 3)}`, along(buildingBox(w, h, w * 0.8), pt, lat, 0, -pt.y + h / 2));
    }
    for (let i = 0, clusters = rng.int(4, 12); i < clusters; i++) {
      const side = rng.next() < 0.5 ? -1 : 1;
      spline.get(s0 + rng.range(0, CHUNK_LEN), pt);
      const lat = side * rng.range(70, 380);
      const n = rng.int(3, 7);
      for (let k = 0; k < n; k++) {
        const h = rng.range(1.2, 3.4);
        push(
          'lampHead',
          along(box(rng.range(1.6, 4.4), h, rng.range(1.6, 4.4)), pt, lat + rng.range(-9, 9), 0, -pt.y + h / 2 + rng.range(0, 26))
        );
      }
    }
  }
  }

  // ---------------- assemble meshes ----------------
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  for (const [bucket, list] of Object.entries(geos)) {
    const merged = BufferGeometryUtils.mergeGeometries(list, false);
    for (const g of list) if (g !== merged) g.dispose();
    if (!merged || merged.attributes.position.count === 0) continue;
    const mesh = new THREE.Mesh(merged, materialForChunkBucket(mats, bucket));
    // Keep the logical bucket on the mesh so workers can serialize geometry
    // without constructing the render-thread's texture-backed materials.
    mesh.userData.bucket = bucket;
    mesh.castShadow = false;
    mesh.receiveShadow = bucket === 'asphalt' || bucket === 'asphaltOnc' || bucket === 'concrete';
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
    geometries.push(merged);
  }
  return { group, geometries };
}
