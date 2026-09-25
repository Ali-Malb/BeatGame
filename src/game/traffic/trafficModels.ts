/**
 * Traffic vehicle model factory — 7 civilian classes built from merged
 * vertex-colored primitives. Each instance gets its own head/tail light
 * materials so brake intensity can flash individually, plus merged additive
 * glow quads and optional night headlight cones.
 */

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { glowTexture } from '../environment/textures';
import { RNG } from '../core/utils';

export type VehicleKind = 'sedan' | 'coupe' | 'taxi' | 'suv' | 'van' | 'boxTruck' | 'flatbed' | 'ambulance' | 'bus';

export interface VehicleModel {
  group: THREE.Group;
  halfL: number;
  halfW: number;
  height: number;
  headMat: THREE.MeshBasicMaterial;
  tailMat: THREE.MeshBasicMaterial;
  blinkerMat: THREE.MeshBasicMaterial;
  glowMesh: THREE.Mesh; // additive glow quads
  heavy: boolean;
  kind: VehicleKind;
  /** additive pavement pool in front of the headlights (night/rain) */
  headPoolMat: THREE.MeshBasicMaterial;
  /** additive red pavement glow behind the car while braking */
  brakePoolMat: THREE.MeshBasicMaterial;
  /** low-quality render switch; simulation state is unaffected */
  setDetailTier: (tier: 0 | 1 | 2) => void;
  /** emergency light bar materials (ambulance) */
  emergA?: THREE.MeshBasicMaterial;
  emergB?: THREE.MeshBasicMaterial;
}

function cbox(w: number, h: number, d: number, x: number, y: number, z: number, color: THREE.Color): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  const n = g.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

function cwheel(r: number, x: number, z: number, color: THREE.Color): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, 0.24, 10);
  g.rotateZ(Math.PI / 2);
  g.translate(x, r, z);
  const n = g.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

const GLASS = new THREE.Color(0.06, 0.07, 0.09);
const TIRE = new THREE.Color(0.03, 0.03, 0.035);
const CHROME = new THREE.Color(0.55, 0.57, 0.6);
const DARK = new THREE.Color(0.1, 0.1, 0.11);

export function buildTrafficVehicle(kind: VehicleKind, paintSeed: number): VehicleModel {
  const rng = new RNG(paintSeed);
  const group = new THREE.Group();
  const geos: THREE.BufferGeometry[] = [];
  const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.55 });
  let halfL = 2.4;
  let halfW = 0.9;
  let height = 1.45;
  let heavy = false;

  // realistic road-mix paint palette — white/silver/black dominate real
  // traffic, with a tail of muted colors so the pack never reads as 4 clones
  const paints = [
    new THREE.Color(0.82, 0.82, 0.84), // white
    new THREE.Color(0.82, 0.82, 0.84),
    new THREE.Color(0.08, 0.08, 0.1), // black
    new THREE.Color(0.08, 0.08, 0.1),
    new THREE.Color(0.72, 0.73, 0.75), // silver
    new THREE.Color(0.72, 0.73, 0.75),
    new THREE.Color(0.45, 0.47, 0.5), // gray
    new THREE.Color(0.16, 0.22, 0.38), // dark blue
    new THREE.Color(0.42, 0.08, 0.08), // dark red
    new THREE.Color(0.2, 0.3, 0.2), // dark green
    new THREE.Color(0.62, 0.56, 0.44), // beige
  ];
  let paint = rng.pick(paints);

  if (kind === 'suv') {
    // taller body, big greenhouse, roof rails
    halfL = 2.55;
    halfW = 0.96;
    height = 1.78;
    geos.push(cbox(1.9, 0.62, 4.8, 0, 0.62, 0, paint));
    geos.push(cbox(1.78, 0.62, 3.4, 0, 1.22, -0.3, paint));
    geos.push(cbox(1.82, 0.4, 3.2, 0, 1.28, -0.3, GLASS));
    geos.push(cbox(1.86, 0.07, 3.5, 0, 1.56, -0.3, DARK)); // roof rails
    geos.push(cbox(1.94, 0.24, 0.3, 0, 0.42, 2.42, DARK));
    geos.push(cbox(1.94, 0.24, 0.3, 0, 0.42, -2.42, DARK));
    for (const [x, z] of [[-0.92, 1.55], [0.92, 1.55], [-0.92, -1.55], [0.92, -1.55]] as [number, number][]) {
      geos.push(cwheel(0.38, x, z, TIRE));
    }
  } else if (kind === 'van') {
    // one-box delivery van
    heavy = false;
    halfL = 2.6;
    halfW = 1.0;
    height = 2.35;
    geos.push(cbox(2.0, 1.5, 2.0, 0, 1.0, 1.75, paint));
    geos.push(cbox(2.04, 2.1, 3.2, 0, 1.3, -0.75, new THREE.Color(0.86, 0.87, 0.9)));
    geos.push(cbox(1.9, 0.55, 0.16, 0, 1.45, 2.74, GLASS));
    geos.push(cbox(2.08, 0.3, 4.9, 0, 0.45, 0, DARK));
    for (const [x, z] of [[-0.95, 1.6], [0.95, 1.6], [-0.95, -1.7], [0.95, -1.7]] as [number, number][]) {
      geos.push(cwheel(0.36, x, z, TIRE));
    }
  } else if (kind === 'sedan' || kind === 'taxi') {
    if (kind === 'taxi') paint = new THREE.Color(0.95, 0.72, 0.08);
    halfL = 2.42;
    halfW = 0.88;
    // lower body
    geos.push(cbox(1.76, 0.52, 4.7, 0, 0.56, 0, paint));
    // cabin
    geos.push(cbox(1.6, 0.5, 2.5, 0, 1.08, -0.25, paint));
    // greenhouse glass
    geos.push(cbox(1.64, 0.34, 2.3, 0, 1.16, -0.25, GLASS));
    // pillars hint
    geos.push(cbox(1.72, 0.06, 2.42, 0, 1.4, -0.25, paint));
    // bumpers
    geos.push(cbox(1.8, 0.22, 0.3, 0, 0.38, 2.35, DARK));
    geos.push(cbox(1.8, 0.22, 0.3, 0, 0.38, -2.35, DARK));
    // wheels
    for (const [x, z] of [[-0.82, 1.45], [0.82, 1.45], [-0.82, -1.45], [0.82, -1.45]] as [number, number][]) {
      geos.push(cwheel(0.31, x, z, TIRE));
    }
    if (kind === 'taxi') {
      // roof light bar
      geos.push(cbox(0.7, 0.16, 0.34, 0, 1.52, -0.25, new THREE.Color(0.9, 0.5, 0.06)));
    }
  } else if (kind === 'coupe') {
    paint = new THREE.Color(0.06, 0.35, 0.6); // signature blue sport coupe
    halfL = 2.28;
    halfW = 0.87;
    geos.push(cbox(1.72, 0.44, 4.5, 0, 0.5, 0, paint));
    geos.push(cbox(1.56, 0.42, 2.1, 0, 0.94, -0.42, paint));
    geos.push(cbox(1.6, 0.28, 1.9, 0, 1.0, -0.42, GLASS));
    geos.push(cbox(1.74, 0.1, 0.7, 0, 0.72, 1.35, paint)); // hood scoop
    geos.push(cbox(1.7, 0.18, 0.26, 0, 0.34, 2.2, DARK));
    geos.push(cbox(1.7, 0.18, 0.26, 0, 0.34, -2.2, DARK));
    // big rear wing
    geos.push(cbox(1.5, 0.06, 0.36, 0, 1.06, -2.05, DARK));
    for (const [x, z] of [[-0.8, 1.4], [0.8, 1.4], [-0.8, -1.4], [0.8, -1.4]] as [number, number][]) {
      geos.push(cwheel(0.32, x, z, TIRE));
    }
  } else if (kind === 'boxTruck' || kind === 'flatbed') {
    heavy = true;
    halfL = 3.9;
    halfW = 1.12;
    height = 3.1;
    // cab
    geos.push(cbox(2.14, 1.5, 1.9, 0, 1.35, 2.85, paint));
    geos.push(cbox(2.18, 0.6, 0.2, 0, 1.75, 3.78, GLASS));
    geos.push(cbox(2.2, 0.5, 1.0, 0, 0.55, 2.9, DARK));
    if (kind === 'boxTruck') {
      geos.push(cbox(2.26, 2.5, 5.4, 0, 1.95, -1.0, new THREE.Color(0.82, 0.83, 0.85)));
      geos.push(cbox(2.3, 0.2, 5.5, 0, 0.72, -1.0, DARK));
    } else {
      // flatbed with containers
      geos.push(cbox(2.3, 0.3, 5.8, 0, 0.78, -1.0, DARK));
      geos.push(cbox(2.1, 1.3, 3.4, 0, 1.6, -1.6, new THREE.Color(0.28, 0.42, 0.3)));
      geos.push(cbox(2.1, 1.1, 1.6, 0, 1.5, 1.2, new THREE.Color(0.55, 0.3, 0.15)));
    }
    for (const [x, z] of [[-0.98, 2.85], [0.98, 2.85], [-0.98, -1.6], [0.98, -1.6], [-0.98, -3.2], [0.98, -3.2]] as [number, number][]) {
      geos.push(cwheel(0.45, x, z, TIRE));
    }
  } else if (kind === 'ambulance') {
    heavy = true;
    paint = new THREE.Color(0.92, 0.93, 0.95);
    halfL = 2.9;
    halfW = 1.08;
    height = 2.75;
    geos.push(cbox(2.16, 1.1, 5.6, 0, 0.98, 0, paint));
    geos.push(cbox(2.1, 1.3, 3.0, 0, 2.15, -0.9, paint));
    geos.push(cbox(2.14, 0.5, 0.16, 0, 2.2, 2.62, GLASS));
    // red cross stripe
    geos.push(cbox(2.2, 0.28, 5.4, 0, 1.32, 0, new THREE.Color(0.75, 0.08, 0.1)));
    for (const [x, z] of [[-0.96, 1.9], [0.96, 1.9], [-0.96, -1.9], [0.96, -1.9]] as [number, number][]) {
      geos.push(cwheel(0.38, x, z, TIRE));
    }
  } else {
    // bus
    heavy = true;
    paint = new THREE.Color(0.75, 0.2, 0.12);
    halfL = 5.4;
    halfW = 1.22;
    height = 3.25;
    geos.push(cbox(2.44, 2.3, 10.6, 0, 1.85, 0, paint));
    geos.push(cbox(2.48, 0.8, 10.2, 0, 2.35, 0, GLASS));
    geos.push(cbox(2.4, 0.5, 0.2, 0, 2.2, 5.28, GLASS));
    geos.push(cbox(2.48, 0.3, 10.6, 0, 0.62, 0, DARK));
    for (const [x, z] of [[-1.05, 3.6], [1.05, 3.6], [-1.05, -3.4], [1.05, -3.4]] as [number, number][]) {
      geos.push(cwheel(0.45, x, z, TIRE));
    }
  }

  const body = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(geos, false)!, bodyMat);
  body.castShadow = true;
  group.add(body);
  for (const g of geos) g.dispose();

  // ---- lights (per-instance materials for intensity control) ----
  const headMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.4, 1.35, 1.2) });
  const tailMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 0.04, 0.03) });
  const blinkerMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.55, 0.1), transparent: true, opacity: 0 });
  const lightGeos: THREE.BufferGeometry[] = [];
  const hy = kind === 'bus' || kind === 'boxTruck' || kind === 'flatbed' || kind === 'ambulance' ? 0.9 : 0.68;
  lightGeos.push(cbox(halfW * 2 - 0.5, 0.12, 0.06, -halfW + 0.28, hy, halfL - 0.04, new THREE.Color(1, 1, 1)));
  lightGeos.push(cbox(halfW * 2 - 0.5, 0.12, 0.06, halfW - 0.28, hy, halfL - 0.04, new THREE.Color(1, 1, 1)));
  const lightsMesh = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(lightGeos, false)!, headMat);
  group.add(lightsMesh);
  for (const g of lightGeos) g.dispose();

  const tailGeos: THREE.BufferGeometry[] = [];
  tailGeos.push(cbox(0.34, 0.14, 0.06, -halfW + 0.22, hy, -halfL + 0.04, new THREE.Color(1, 1, 1)));
  tailGeos.push(cbox(0.34, 0.14, 0.06, halfW - 0.22, hy, -halfL + 0.04, new THREE.Color(1, 1, 1)));
  const tailMesh = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(tailGeos, false)!, tailMat);
  group.add(tailMesh);
  for (const g of tailGeos) g.dispose();

  // blinkers (4 corners)
  const blinkGeos: THREE.BufferGeometry[] = [];
  for (const [x, z] of [[-halfW + 0.1, halfL - 0.06], [halfW - 0.1, halfL - 0.06], [-halfW + 0.1, -halfL + 0.06], [halfW - 0.1, -halfL + 0.06]] as [number, number][]) {
    blinkGeos.push(cbox(0.14, 0.12, 0.1, x, hy + 0.12, z, new THREE.Color(1, 1, 1)));
  }
  const blinker = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(blinkGeos, false)!, blinkerMat);
  group.add(blinker);
  for (const g of blinkGeos) g.dispose();

  // ---- additive glow quads (headlight + taillight halos, seen from behind) ----
  const glowMat = new THREE.MeshBasicMaterial({
    map: glowTexture(),
    transparent: true,
    opacity: 0.75,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glowGeos: THREE.BufferGeometry[] = [];
  const mkGlow = (x: number, y: number, z: number, size: number, faceBack: boolean) => {
    const p = new THREE.PlaneGeometry(size, size);
    if (faceBack) p.rotateY(Math.PI);
    p.translate(x, y, z);
    glowGeos.push(p);
  };
  mkGlow(-halfW + 0.28, hy, halfL + 0.06, 0.5, false);
  mkGlow(halfW - 0.28, hy, halfL + 0.06, 0.5, false);
  mkGlow(-halfW + 0.22, hy, -halfL - 0.06, 0.75, true);
  mkGlow(halfW - 0.22, hy, -halfL - 0.06, 0.75, true);
  const glowMesh = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(glowGeos, false)!, glowMat);
  group.add(glowMesh);
  for (const g of glowGeos) g.dispose();

  // ---- night headlight cones REMOVED (§24): crude cone geometry is replaced by
  // the additive pavement pools below (headPool/brakePool) + shared real
  // PointLights contributed by TrafficLights, which illuminate actual surfaces.

  // ---- pavement light pools: headlights actually illuminate the road ----
  const headPoolMat = new THREE.MeshBasicMaterial({
    map: glowTexture(),
    color: new THREE.Color(0.55, 0.5, 0.32),
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const poolGeo = new THREE.PlaneGeometry(4.4, 9.5);
  poolGeo.rotateX(-Math.PI / 2);
  poolGeo.translate(0, 0.03, halfL + 3.4);
  const headPool = new THREE.Mesh(poolGeo, headPoolMat);
  group.add(headPool);

  const brakePoolMat = new THREE.MeshBasicMaterial({
    map: glowTexture(),
    color: new THREE.Color(0.55, 0.05, 0.03),
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const bpoolGeo = new THREE.PlaneGeometry(2.8, 5.0);
  bpoolGeo.rotateX(-Math.PI / 2);
  bpoolGeo.translate(0, 0.03, -halfL - 1.6);
  const brakePool = new THREE.Mesh(bpoolGeo, brakePoolMat);
  group.add(brakePool);

  // ---- emergency bar (ambulance) ----
  let emergA: THREE.MeshBasicMaterial | undefined;
  let emergB: THREE.MeshBasicMaterial | undefined;
  const emergencyMeshes: THREE.Mesh[] = [];
  if (kind === 'ambulance') {
    emergA = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 0.05, 0.05) });
    emergB = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.05, 0.05, 2.2) });
    const a = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.3), emergA);
    a.position.set(-0.35, height + 0.08, -0.2);
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.3), emergB);
    b.position.set(0.35, height + 0.08, -0.2);
    group.add(a, b);
    emergencyMeshes.push(a, b);
  }

  const setDetailTier = (tier: 0 | 1 | 2): void => {
    // Keep the body as the reliable gameplay silhouette in the low tier;
    // accessory passes are decorative and otherwise dominate draw calls.
    lightsMesh.visible = tier >= 1;
    tailMesh.visible = tier >= 1;
    blinker.visible = tier >= 2;
    glowMesh.visible = tier >= 2;
    headPool.visible = tier >= 1;
    brakePool.visible = tier >= 1;
    for (const mesh of emergencyMeshes) mesh.visible = tier >= 1;
  };

  return {
    group,
    halfL,
    halfW,
    height,
    headMat,
    tailMat,
    blinkerMat,
    glowMesh,
    heavy,
    kind,
    headPoolMat,
    brakePoolMat,
    setDetailTier,
    emergA,
    emergB,
  };
}

/** dark simplified oncoming car (visual only, opposite carriageway) */
export function buildOncomingCar(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.4, metalness: 0.4 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.75, 1.1, 4.6), mat);
  body.position.y = 0.62;
  g.add(body);
  const lightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.8, 1.75, 1.6) });
  for (const x of [-0.6, 0.6]) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.06), lightMat);
    l.position.set(x, 0.66, -2.32); // facing us (traveling -s)
    g.add(l);
    const halo = new THREE.Mesh(
      new THREE.PlaneGeometry(0.8, 0.8),
      new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    halo.position.set(x, 0.66, -2.4);
    halo.rotation.y = Math.PI;
    g.add(halo);
  }
  return g;
}
