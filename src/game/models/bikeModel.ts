/**
 * BikeModel — the liter-class supersport built from primitives.
 * Faces +Z (forward), X right, Y up, origin at ground contact under the center.
 * Exposes animation joints: suspension body group, steering fork group,
 * spinning wheels, mirror planes, dashboard plane, headlight spotlight.
 */

import * as THREE from 'three';

export interface BikeJoints {
  root: THREE.Group; // world placement (yaw / pitch / roll)
  body: THREE.Group; // suspension bob + dive pitch
  fork: THREE.Group; // handlebar steering yaw
  wheelF: THREE.Group; // spins (tire/rim/spokes/disc children)
  wheelR: THREE.Group;
  forkTubeL: THREE.Mesh;
  forkTubeR: THREE.Mesh;
  swingarm: THREE.Group;
  mirrorL: THREE.Mesh;
  mirrorR: THREE.Mesh;
  dashboard: THREE.Mesh;
  headlightMat: THREE.MeshBasicMaterial;
  taillightMat: THREE.MeshBasicMaterial;
  headlightSpot: THREE.SpotLight;
  exhaustMat: THREE.MeshStandardMaterial;
}

function mat(color: number, rough = 0.5, metal = 0.35): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}

function addMesh(parent: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

export function buildBike(): { group: THREE.Group; joints: BikeJoints } {
  const group = new THREE.Group();
  group.rotation.order = 'YXZ'; // yaw → pitch → roll(lean)

  const body = new THREE.Group();
  group.add(body);

  // ---- paint materials (physical: clearcoat candy finish) ----
  const paint = new THREE.MeshPhysicalMaterial({ color: 0x101216, roughness: 0.32, metalness: 0.55, clearcoat: 0.8, clearcoatRoughness: 0.25 });
  const paintRed = new THREE.MeshPhysicalMaterial({ color: 0x8f1620, roughness: 0.26, metalness: 0.6, clearcoat: 1.0, clearcoatRoughness: 0.12 });
  const metal = mat(0x2a2d33, 0.35, 0.8);
  const engine = mat(0x31353c, 0.45, 0.75);
  const tire = mat(0x0c0d0f, 0.95, 0.0);
  const rim = mat(0x06070a, 0.3, 0.9);
  const indicatorMat = new THREE.MeshBasicMaterial({ color: 0xffa524 });
  const screenMat = new THREE.MeshPhysicalMaterial({
    color: 0x1a2630,
    transparent: true,
    opacity: 0.34,
    roughness: 0.08,
    metalness: 0.1,
    side: THREE.DoubleSide,
  });
  const headlightMat = new THREE.MeshBasicMaterial({ color: 0xfff4d8 });
  const taillightMat = new THREE.MeshBasicMaterial({ color: 0xff1a08 });  // ---- wheels: believable spoked assemblies ----
  const wheelGeo = new THREE.TorusGeometry(0.3, 0.075, 14, 40);
  wheelGeo.rotateY(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.215, 0.215, 0.085, 24, 1, false);
  rimGeo.rotateZ(Math.PI / 2);

  const buildWheel = (): THREE.Group => {
    const w = new THREE.Group();
    w.add(new THREE.Mesh(wheelGeo, tire));
    const rimM = new THREE.Mesh(rimGeo, rim);
    w.add(rimM);
    // Y-spokes (Y-spoke supersport look)
    const spokeGeo = new THREE.BoxGeometry(0.03, 0.21, 0.03);
    for (let i = 0; i < 5; i++) {
      const sp = new THREE.Mesh(spokeGeo, rim);
      sp.rotation.x = (i / 5) * Math.PI * 2;
      w.add(sp);
    }
    // brake discs + drilled look via dark ring
    const discGeo = new THREE.CylinderGeometry(0.155, 0.155, 0.012, 24);
    discGeo.rotateZ(Math.PI / 2);
    for (const side of [-0.07, 0.07]) {
      const disc = new THREE.Mesh(discGeo, mat(0x8f959c, 0.35, 0.9));
      disc.position.x = side;
      w.add(disc);
    }
    // caliper (rear-right / front-left offset)
    const cal = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.1, 0.07), mat(0x8f1620, 0.4, 0.5));
    cal.position.set(-0.075, 0.12, 0.06);
    w.add(cal);
    // tread block ring (subtle visual rotation cue)
    const treadGeo = new THREE.BoxGeometry(0.06, 0.03, 0.05);
    for (let i = 0; i < 8; i++) {
      const tb = new THREE.Mesh(treadGeo, tire);
      const a = (i / 8) * Math.PI * 2;
      tb.position.set(0, Math.cos(a) * 0.3, Math.sin(a) * 0.3);
      w.add(tb);
    }
    return w;
  };

  const wheelF = buildWheel();
  wheelF.castShadow = true;

  const wheelR = buildWheel();
  wheelR.castShadow = true;
  // rear sprocket
  const sprocket = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.012, 18), mat(0x707680, 0.4, 0.85));
  sprocket.rotation.z = Math.PI / 2;
  sprocket.position.x = 0.1;
  wheelR.add(sprocket);

  // ---- fork / front assembly ----
  // origin at the steering head (y 0.92, z 0.60), raked forward 19.5°
  const fork = new THREE.Group();
  fork.position.set(0, 0.92, 0.6);
  fork.rotation.x = -0.34;
  body.add(fork);

  const forkTubeGeo = new THREE.CylinderGeometry(0.028, 0.034, 0.62, 12);
  const forkTubeL = addMesh(fork, forkTubeGeo, metal, -0.085, -0.29, 0);
  const forkTubeR = addMesh(fork, forkTubeGeo, metal, 0.085, -0.29, 0);
  // lower gold sliders
  const sliderGeo = new THREE.CylinderGeometry(0.037, 0.037, 0.3, 12);
  for (const sx of [-0.085, 0.085]) {
    addMesh(fork, sliderGeo, mat(0xb98a2d, 0.3, 0.9), sx, -0.5, 0);
  }
  // steering head stub up to the frame
  addMesh(fork, new THREE.CylinderGeometry(0.05, 0.055, 0.16, 12), metal, 0, 0.06, 0);
  // front wheel attaches to fork (local -Y 0.575 → world y ≈ 0.377, z ≈ 0.79)
  wheelF.position.set(0, -0.575, 0);
  fork.add(wheelF);

  // front fender arcing over the wheel
  const fender = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.26, 18, 1, true, Math.PI * 1.15, Math.PI * 0.75), paintRed);
  fender.rotation.set(-Math.PI / 2 + 0.12, 0, 0);
  fender.position.set(0, -0.58, 0.02);
  fender.castShadow = true;
  fork.add(fender);

  // clip-on handlebars (just below the steering head)
  const barGeo = new THREE.CylinderGeometry(0.016, 0.016, 0.24, 10);
  barGeo.rotateZ(Math.PI / 2);
  for (const bx of [-1, 1]) {
    const bar = addMesh(fork, barGeo, metal, bx * 0.2, 0.01, 0.04);
    bar.rotation.y = -bx * 0.28;
    bar.rotation.z = -bx * 0.18;
    // brake / clutch lever
    const lever = addMesh(fork, new THREE.CylinderGeometry(0.007, 0.007, 0.14, 8), mat(0x9aa0a8, 0.3, 0.9), bx * 0.3, 0.018, 0.015);
    lever.rotation.z = Math.PI / 2 - 0.12 * bx;
    lever.rotation.y = -bx * 0.3;
  }

  // mirrors on the fairing (world y ≈ 1.02, angled toward the rider's eyes)
  const mirrorGeo = new THREE.PlaneGeometry(0.17, 0.1);
  const mirrorMat = new THREE.MeshBasicMaterial({ color: 0x223344, side: THREE.DoubleSide });
  const mirrorStalkGeo = new THREE.CylinderGeometry(0.011, 0.011, 0.16, 8);
  const mirrorL = addMesh(fork, mirrorGeo, mirrorMat, -0.34, 0.09, 0.045);
  mirrorL.rotation.set(0.42, 0.38, 0.1);
  const mirrorR = addMesh(fork, mirrorGeo, mirrorMat, 0.34, 0.09, 0.045);
  mirrorR.rotation.set(0.42, -0.38, -0.1);
  for (const mx of [-1, 1]) {
    const stalk = addMesh(fork, mirrorStalkGeo, metal, mx * 0.27, 0.05, 0.015);
    stalk.rotation.z = mx * 0.85;
    stalk.rotation.y = mx * 0.4;
  }

  // ---- dashboard (diegetic cluster, faces the rider) ----
  const dashGeo = new THREE.PlaneGeometry(0.36, 0.19);
  dashGeo.rotateY(Math.PI); // face backward toward the rider
  const dashMat = new THREE.MeshBasicMaterial({ color: 0x0a1408 });
  const dashboard = addMesh(fork, dashGeo, dashMat, 0, 0, -0.04);
  dashboard.rotation.x = 0.5; // tilt so the face points up-back toward the eyes

  // ---- windscreen (sits ABOVE the cluster, not over it) ----
  const screen = addMesh(fork, new THREE.PlaneGeometry(0.3, 0.19), screenMat, 0, 0.115, 0.105);
  screen.rotation.x = -0.55;
  screen.castShadow = false;

  // ---- main fairing & tank ----
  const nose = addMesh(body, new THREE.BoxGeometry(0.34, 0.28, 0.5), paint, 0, 0.68, 0.5);
  nose.rotation.x = 0.5;
  const noseRed = addMesh(body, new THREE.BoxGeometry(0.345, 0.12, 0.3), paintRed, 0, 0.6, 0.54);
  noseRed.rotation.x = 0.55;
  // headlight
  const headlight = addMesh(body, new THREE.BoxGeometry(0.18, 0.1, 0.06), headlightMat, 0, 0.74, 0.72);
  headlight.rotation.x = 0.35;
  headlight.castShadow = false;
  const tank = addMesh(body, new THREE.BoxGeometry(0.3, 0.22, 0.5), paintRed, 0, 0.82, 0.16);
  tank.rotation.x = -0.06;
  const tankCap = addMesh(body, new THREE.CylinderGeometry(0.03, 0.03, 0.015, 12), metal, 0, 0.93, 0.18);
  // side fairings
  for (const sx of [-1, 1]) {
    const fair = addMesh(body, new THREE.BoxGeometry(0.045, 0.34, 0.85), paint, sx * 0.19, 0.6, 0.18);
    fair.rotation.z = sx * 0.12;
    const fairRed = addMesh(body, new THREE.BoxGeometry(0.05, 0.1, 0.6), paintRed, sx * 0.215, 0.5, 0.1);
    fairRed.rotation.z = sx * 0.12;
    // front indicators (small amber pods at the nose sides)
    const indF = addMesh(body, new THREE.BoxGeometry(0.03, 0.05, 0.09), indicatorMat, sx * 0.2, 0.72, 0.62);
    indF.castShadow = false;
    // foot pegs + heel guards
    const peg = addMesh(body, new THREE.CylinderGeometry(0.014, 0.014, 0.09, 8), metal, sx * 0.2, 0.38, -0.05);
    peg.rotation.z = Math.PI / 2;
    addMesh(body, new THREE.BoxGeometry(0.02, 0.1, 0.14), mat(0x14161a, 0.7, 0.3), sx * 0.21, 0.44, -0.05);
  }
  // engine block
  addMesh(body, new THREE.BoxGeometry(0.3, 0.3, 0.45), engine, 0, 0.45, 0.1);
  // radiator
  addMesh(body, new THREE.BoxGeometry(0.26, 0.2, 0.06), mat(0x15171b, 0.8, 0.4), 0, 0.52, 0.36);
  // exhaust
  const exhaustMat = mat(0x6f7680, 0.25, 0.95);
  const exhaust = addMesh(body, new THREE.CylinderGeometry(0.055, 0.065, 0.5, 14), exhaustMat, 0.12, 0.36, -0.48);
  exhaust.rotation.x = Math.PI / 2 + 0.12;
  const exhaustTip = addMesh(body, new THREE.CylinderGeometry(0.062, 0.055, 0.06, 14), mat(0x0a0a0c, 0.4, 0.8), 0.12, 0.31, -0.74);
  exhaustTip.rotation.x = Math.PI / 2 + 0.12;

  // ---- tail section ----
  const tail = addMesh(body, new THREE.BoxGeometry(0.24, 0.14, 0.55), paint, 0, 0.84, -0.62);
  tail.rotation.x = 0.16;
  const tailRed = addMesh(body, new THREE.BoxGeometry(0.2, 0.08, 0.4), paintRed, 0, 0.9, -0.72);
  tailRed.rotation.x = 0.18;
  // rear indicators
  for (const sx of [-1, 1]) {
    const indR = addMesh(body, new THREE.BoxGeometry(0.035, 0.05, 0.1), indicatorMat, sx * 0.14, 0.83, -0.86);
    indR.castShadow = false;
  }
  const tailLight = addMesh(body, new THREE.BoxGeometry(0.14, 0.045, 0.04), taillightMat, 0, 0.87, -0.9);
  tailLight.castShadow = false;

  // ---- frame / seat / swingarm ----
  const seat = addMesh(body, new THREE.BoxGeometry(0.24, 0.07, 0.38), mat(0x101114, 0.9, 0.05), 0, 0.83, -0.28);
  const subframe = addMesh(body, new THREE.BoxGeometry(0.16, 0.1, 0.5), metal, 0, 0.74, -0.45);

  const swingarm = new THREE.Group();
  swingarm.position.set(0, 0.42, -0.2);
  body.add(swingarm);
  for (const sx of [-1, 1]) {
    const arm = addMesh(swingarm, new THREE.BoxGeometry(0.045, 0.09, 0.55), metal, sx * 0.13, 0, -0.25);
    arm.castShadow = true;
  }
  wheelR.position.set(0, -0.05, -0.49);
  swingarm.add(wheelR);
  // chain run: upper + lower spans from sprocket to countershaft
  const chainMat = mat(0x4a4e55, 0.5, 0.8);
  addMesh(swingarm, new THREE.BoxGeometry(0.02, 0.035, 0.62), chainMat, 0.105, 0.115, -0.3);
  addMesh(swingarm, new THREE.BoxGeometry(0.02, 0.035, 0.5), chainMat, 0.105, -0.075, -0.28);
  // chain guard
  addMesh(swingarm, new THREE.BoxGeometry(0.05, 0.05, 0.4), mat(0x8f1620, 0.6, 0.2), 0.13, 0.02, -0.3);
  // rear shock
  const shock = addMesh(body, new THREE.CylinderGeometry(0.03, 0.03, 0.32, 10), mat(0xb98a2d, 0.4, 0.8), 0.05, 0.62, -0.32);
  shock.rotation.x = 0.4;

  // ---- headlight spotlight (real light for night/rain) ----
  const headlightSpot = new THREE.SpotLight(0xfff2d0, 0, 70, 0.5, 0.55, 1.2);
  headlightSpot.position.set(0, 0.74, 0.8);
  const spotTarget = new THREE.Object3D();
  spotTarget.position.set(0, 0.2, 30);
  group.add(spotTarget);
  headlightSpot.target = spotTarget;
  group.add(headlightSpot);

  const joints: BikeJoints = {
    root: group,
    body,
    fork,
    wheelF,
    wheelR,
    forkTubeL,
    forkTubeR,
    swingarm,
    mirrorL,
    mirrorR,
    dashboard,
    headlightMat,
    taillightMat,
    headlightSpot,
    exhaustMat,
  };
  return { group, joints };
}
