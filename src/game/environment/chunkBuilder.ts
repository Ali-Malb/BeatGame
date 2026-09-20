/**
 * ChunkBuilder — constructs one 100 m stretch of the elevated expressway as a
 * handful of merged meshes (asphalt / concrete / emissive / additive glow).
 * Shared materials live in HighwayMaterials so the weather controller can tweak
 * the whole world at once (wet asphalt, lamp intensity, window emission...).
 */

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoadSpline, SAMPLE_STEP } from './roadSpline';
import { concreteTexture, roadTexture, oncomingRoadTexture, signTexture, windowTexture, glowTexture } from './textures';
import { RNG, clamp } from '../core/utils';

export const CHUNK_LEN = 100;

export const LANES = 4;
export const LANE_W = 3.5;
export const LANE_CENTERS = [-5.25, -1.75, 1.75, 5.25];
export const DRIVE_HALF = 6.55; // inner faces of barriers
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
    ])
      m.dispose();
  }
}

interface GeomBuckets {
  [key: string]: THREE.BufferGeometry[];
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

/** deck surface strip between two lateral bounds; u across, v = s / vRepeatMeters */
function deckStrip(spline: RoadSpline, s0: number, s1: number, latMin: number, latMax: number, vRepeatMeters: number): THREE.BufferGeometry {
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
    pos.push(pt.x + rX * latMin, pt.y, pt.z + rZ * latMin);
    pos.push(pt.x + rX * latMax, pt.y, pt.z + rZ * latMax);
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

/** extruded wall following the road (barriers) */
function barrierStrip(spline: RoadSpline, s0: number, s1: number, lateral: number, height: number, thickness: number, caps = true): THREE.BufferGeometry {
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

export function buildChunk(spline: RoadSpline, mats: HighwayMaterials, chunkIndex: number, seed: number): ChunkBuildResult {
  const s0 = chunkIndex * CHUNK_LEN;
  const s1 = s0 + CHUNK_LEN;
  spline.ensure(s1 + 300);
  const rng = new RNG(seed >>> 0);
  const geos: GeomBuckets = {};
  const push = (bucket: string, g: THREE.BufferGeometry) => {
    (geos[bucket] ??= []).push(g);
  };

  const isBridge = spline.isBridgeAt(s0 + CHUNK_LEN / 2);
  const bridge = spline.bridgeRange();
  const pt = { x: 0, y: 0, z: 0, yaw: 0, rx: 1, rz: 0, kappa: 0, s: 0, slope: 0 };
  spline.get(s0 + CHUNK_LEN / 2, pt);

  // ---------------- deck surfaces ----------------
  push('asphalt', deckStrip(spline, s0, s1, -7.3, 7.3, 14));
  push('asphaltOnc', deckStrip(spline, s0, s1, -14.6, -7.3, 18));

  // deck skirts + underside slab
  for (let s = s0; s < s1 - 0.01; s += SAMPLE_STEP) {
    spline.get(s, pt);
    push('concrete', along(box(0.35, 0.85, SAMPLE_STEP + 0.02), pt, 7.45, 0, -0.42));
    push('concrete', along(box(0.35, 0.85, SAMPLE_STEP + 0.02), pt, -14.75, 0, -0.42));
    push('concrete', along(box(22.4, 0.55, SAMPLE_STEP + 0.02), pt, -3.6, 0, -0.6));
  }

  // ---------------- median Jersey barrier + anti-glare slats ----------------
  push('concrete', barrierStrip(spline, s0, s1, -6.95, 1.1, 0.62));
  for (let s = s0 + 4; s < s1; s += 8) {
    spline.get(s, pt);
    push('darkMetal', along(box(0.34, 0.62, 0.12), pt, -6.95, 0, 1.35));
  }

  // ---------------- outer wall + railing + acoustic panels ----------------
  push('concrete', barrierStrip(spline, s0, s1, 6.95, 0.95, 0.55, false));
  for (let s = s0 + 2; s < s1; s += 4) {
    spline.get(s, pt);
    push('railing', along(box(0.16, 0.1, 3.9), pt, 6.98, 0, 1.28));
    push('railing', along(box(0.1, 0.42, 0.1), pt, 6.98, 0, 1.05));
  }
  if (rng.next() < 0.35 && !isBridge) {
    const panelLen = rng.range(40, 90);
    const ps = s0 + rng.range(0, 60);
    const pe = Math.min(s1, ps + panelLen);
    if (pe - ps > 10) {
      push('darkMetal', barrierStrip(spline, ps, pe, 7.15, 4.2, 0.18, false));
      for (let s = ps; s < pe; s += 6) {
        spline.get(s, pt);
        push('railing', along(box(0.22, 4.0, 0.26), pt, 7.15, 0, 2.9));
      }
    }
  }

  // ---------------- streetlamps (both edges, staggered 17.5 m) ----------------
  for (let s = s0 + 8; s < s1; s += 35) {
    for (const side of [1, -1]) {
      const ls = s + (side === 1 ? 0 : 17.5);
      if (ls >= s1) continue;
      spline.get(ls, pt);
      const lat = side === 1 ? 7.05 : -7.1;
      push('darkMetal', along(cyl(0.09, 0.13, 10.5, 0, 0, 0, 6), pt, lat, 0, 5.25));
      push('darkMetal', along(box(2.6, 0.12, 0.14), pt, lat - side * 1.3, 0, 10.4));
      push('lampHead', along(box(0.72, 0.16, 0.3), pt, lat - side * 2.55, 0, 10.3));
      // fake volumetric cone + light pool
      push('lampCone', along(cyl(0.18, 3.6, 9.4, 0, 0, 0, 12), pt, lat - side * 2.55, 0, 5.5));
      const pool = new THREE.PlaneGeometry(7.5, 9.5);
      pool.rotateX(-Math.PI / 2);
      push('lampPool', along(pool, pt, lat - side * 2.2, 0, 0.045));
    }
  }

  // ---------------- viaduct support pillars (skipped on bridge) ----------------
  if (!isBridge) {
    for (let s = s0 + 12; s < s1; s += 35) {
      spline.get(s, pt);
      const h = pt.y - 0.4;
      push('concrete', along(cyl(1.5, 1.9, h, 0, 0, 0, 10), pt, -3.6, 0, -h / 2));
      push('concrete', along(box(4.2, 1.0, 3.4), pt, -3.6, 0, -1.2));
    }
  }

  // ---------------- sign gantries (§18: every 200–350 m) ----------------
  if (s0 % 300 < CHUNK_LEN && rng.next() < 0.92) {
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
    // pillars land outside the full 22 m deck
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
    // orange rails along bridge edges
    for (let s = s0; s < s1 - 0.01; s += SAMPLE_STEP) {
      spline.get(s, pt);
      push('bridgePaint', along(box(0.18, 0.5, SAMPLE_STEP + 0.02), pt, 7.12, 0, 1.25));
      push('bridgePaint', along(box(0.18, 0.5, SAMPLE_STEP + 0.02), pt, -7.12, 0, 1.25));
    }
  }

  // ---------------- skyline buildings ----------------
  const variant = rng.int(0, 3);
  for (const side of [-1, 1]) {
    const count = rng.int(3, 6);
    for (let b = 0; b < count; b++) {
      const s = s0 + rng.range(0, CHUNK_LEN);
      spline.get(s, pt);
      const dist = rng.range(34, 130) * side;
      const w = rng.range(16, 42);
      const d = rng.range(16, 42);
      const h = rng.range(28, 175) * (side === 1 ? 1 : 0.8);
      const lat = dist + (side === 1 ? 14 : -14);
      push(`windows${variant}`, along(buildingBox(w, h, d), pt, lat, 0, h / 2 - pt.y));

      // Break the skyline silhouette with occasional stepped penthouses and
      // mechanical roofs; all geometry still merges into the chunk bucket.
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
    if (rng.next() < 0.16) {
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

  // ---------------- assemble meshes ----------------
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const matFor: Record<string, THREE.Material> = {
    asphalt: mats.asphalt,
    asphaltOnc: mats.asphaltOncoming,
    concrete: mats.concrete,
    darkMetal: mats.darkMetal,
    railing: mats.railing,
    bridgePaint: mats.bridgePaint,
    bridgeCable: mats.bridgePaint,
    lampHead: mats.lampHead,
    lampCone: mats.lampCone,
    lampPool: mats.lampPool,
    sign: mats.sign,
    windows0: mats.windows[0],
    windows1: mats.windows[1],
    windows2: mats.windows[2],
    windows3: mats.windows[3],
    blinkRed: mats.blinkRed,
    blinkOrange: mats.blinkOrange,
  };
  for (const [bucket, list] of Object.entries(geos)) {
    const merged = BufferGeometryUtils.mergeGeometries(list, false);
    for (const g of list) if (g !== merged) g.dispose();
    if (!merged || merged.attributes.position.count === 0) continue;
    const mesh = new THREE.Mesh(merged, matFor[bucket] ?? mats.concrete);
    mesh.castShadow = false;
    mesh.receiveShadow = bucket === 'asphalt' || bucket === 'asphaltOnc' || bucket === 'concrete';
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
    geometries.push(merged);
  }
  return { group, geometries };
}
