/**
 * RiderModel — rigged humanoid rider (dark armored hoodie with "BFS" lettering,
 * kevlar jeans, gauntlet gloves, full-face helmet). Arms and legs are two-bone
 * IK chains solved analytically every frame so hands stay pinned to the
 * clip-ons and feet to the pegs through all lean / tuck poses.
 */

import * as THREE from 'three';
import { riderBackTexture } from '../environment/textures';
import { clamp } from '../core/utils';

/** one bone: unit cylinder stretched/oriented between two points */
class Bone {
  mesh: THREE.Mesh;
  constructor(parent: THREE.Object3D, radius: number, material: THREE.Material) {
    const geo = new THREE.CylinderGeometry(radius, radius * 0.85, 1, 10);
    geo.translate(0, 0.5, 0); // pivot at top
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.castShadow = true;
    parent.add(this.mesh);
  }
  set(root: THREE.Vector3, tip: THREE.Vector3) {
    const dir = new THREE.Vector3().subVectors(tip, root);
    const len = Math.max(0.02, dir.length());
    this.mesh.position.copy(root);
    this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    this.mesh.scale.set(1, len, 1);
  }
}

export interface RiderPose {
  /** 0..1 tuck amount */
  tuck: number;
  /** lean angle (rad, + = leaning right) */
  lean: number;
  /** left foot lift for shift blips 0..1 */
  shiftBlip: number;
  /** brake lever pull 0..1 */
  brakePull: number;
  /** speed-based vibration phase */
  vibration: number;
}

export class RiderModel {
  group = new THREE.Group(); // child of bike body
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private hips = new THREE.Group();
  private chestMesh: THREE.Mesh;
  private backpack: THREE.Mesh;

  // arm IK
  private armUpperL: Bone;
  private armUpperR: Bone;
  private armForeL: Bone;
  private armForeR: Bone;
  private gloveL: THREE.Mesh;
  private gloveR: THREE.Mesh;
  // leg IK
  private legUpperL: Bone;
  private legUpperR: Bone;
  private legLowerL: Bone;
  private legLowerR: Bone;
  private bootL: THREE.Mesh;
  private bootR: THREE.Mesh;

  private v = {
    shoulderL: new THREE.Vector3(-0.185, 0.26, -0.02),
    shoulderR: new THREE.Vector3(0.185, 0.26, -0.02),
    hipL: new THREE.Vector3(-0.115, 0.0, -0.02),
    hipR: new THREE.Vector3(0.115, 0.0, -0.02),
    gripL: new THREE.Vector3(),
    gripR: new THREE.Vector3(),
    pegL: new THREE.Vector3(),
    pegR: new THREE.Vector3(),
    tmpA: new THREE.Vector3(),
    tmpB: new THREE.Vector3(),
    up: new THREE.Vector3(0, 1, 0),
  };

  constructor() {
    const hoodie = new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.85, metalness: 0.05 });
    const hoodieBack = new THREE.MeshStandardMaterial({
      map: riderBackTexture(),
      roughness: 0.85,
      metalness: 0.05,
      color: 0xbfc3c8,
    });
    const jeans = new THREE.MeshStandardMaterial({ color: 0x23262e, roughness: 0.8, metalness: 0.1 });
    const glove = new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.6, metalness: 0.2 });
    const boot = new THREE.MeshStandardMaterial({ color: 0x121316, roughness: 0.55, metalness: 0.25 });
    const helmetMat = new THREE.MeshStandardMaterial({ color: 0xd8262e, roughness: 0.22, metalness: 0.35 });
    const visorMat = new THREE.MeshStandardMaterial({ color: 0x05070c, roughness: 0.08, metalness: 0.8 });
    const armor = new THREE.MeshStandardMaterial({ color: 0x2e3238, roughness: 0.6, metalness: 0.15 });

    // hips / pelvis
    this.group.add(this.hips);
    this.hips.position.set(0, 0.88, -0.1);
    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.24), jeans);
    pelvis.castShadow = true;
    this.hips.add(pelvis);

    // torso
    this.hips.add(this.torso);
    this.torso.position.set(0, 0.1, 0);
    this.chestMesh = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.46, 0.24), hoodie);
    this.chestMesh.position.set(0, 0.26, 0.01);
    this.chestMesh.castShadow = true;
    this.torso.add(this.chestMesh);
    // back plate with BFS lettering (plane on the back)
    this.backpack = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), hoodieBack);
    this.backpack.position.set(0, 0.28, -0.125);
    this.backpack.rotation.y = Math.PI;
    this.torso.add(this.backpack);
    // shoulder armor bumps
    for (const sx of [-1, 1]) {
      const pad = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), armor);
      pad.position.set(sx * 0.2, 0.44, 0);
      pad.scale.set(1, 0.7, 1);
      this.torso.add(pad);
    }

    // head
    this.torso.add(this.head);
    this.head.position.set(0, 0.56, 0.02);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 18, 14), helmetMat);
    helmet.castShadow = true;
    helmet.scale.set(1, 1.12, 1.18);
    this.head.add(helmet);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.07, 0.1), visorMat);
    visor.position.set(0, 0.0, 0.1);
    this.head.add(visor);
    // helmet stripe
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.02, 0.26), new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.3 }));
    stripe.position.y = 0.115;
    this.head.add(stripe);

    // arms (bones live in body space so IK targets from the bike frame match)
    this.armUpperL = new Bone(this.group, 0.048, hoodie);
    this.armUpperR = new Bone(this.group, 0.048, hoodie);
    this.armForeL = new Bone(this.group, 0.042, armor);
    this.armForeR = new Bone(this.group, 0.042, armor);
    const gloveGeo = new THREE.SphereGeometry(0.043, 10, 8);
    gloveGeo.scale(1, 0.8, 1.35);
    this.gloveL = new THREE.Mesh(gloveGeo, glove);
    this.gloveR = new THREE.Mesh(gloveGeo, glove);
    this.gloveL.castShadow = true;
    this.gloveR.castShadow = true;
    this.group.add(this.gloveL, this.gloveR);

    // legs
    this.legUpperL = new Bone(this.group, 0.072, jeans);
    this.legUpperR = new Bone(this.group, 0.072, jeans);
    this.legLowerL = new Bone(this.group, 0.058, jeans);
    this.legLowerR = new Bone(this.group, 0.058, jeans);
    const bootGeo = new THREE.BoxGeometry(0.09, 0.08, 0.24);
    this.bootL = new THREE.Mesh(bootGeo, boot);
    this.bootR = new THREE.Mesh(bootGeo, boot);
    this.bootL.castShadow = true;
    this.bootR.castShadow = true;
    this.group.add(this.bootL, this.bootR);
  }

  /** hide the helmet in cockpit mode (classic onboard-camera trick) */
  setHeadVisible(v: boolean) {
    this.head.visible = v;
  }

  /** cockpit mode: hide torso+helmet (arms & legs remain for immersion) */
  setTorsoVisible(v: boolean) {
    this.torso.visible = v;
  }

  /**
   * Solve the full rider pose. Grip and peg positions are supplied in
   * BIKE-BODY local space (same space this.group lives in).
   */
  update(pose: RiderPose, gripL: THREE.Vector3, gripR: THREE.Vector3, pegL: THREE.Vector3, pegR: THREE.Vector3) {
    const t = pose.tuck;
    const lean = pose.lean;

    // pelvis shifts toward the inside of the turn and forward in tuck
    const hipShift = clamp(lean * 0.13, -0.14, 0.14);
    this.hips.position.set(hipShift, 0.88 - t * 0.115 + Math.sin(pose.vibration * 31) * 0.0035 * (t > 0 ? 0.6 : 1), -0.1 + t * 0.16);
    // torso: always leaned forward ~20°, tuck pitches to ~72°
    this.torso.rotation.set(0.35 + t * 0.9, 0, lean * 0.4);
    this.torso.position.set(hipShift * 0.6, 0.1, t * 0.1);
    // head counter-rolls toward horizon and dips in tuck
    this.head.rotation.set(-0.35 - t * 0.62 + (t > 0 ? 0.14 : 0), 0, -lean * 0.55);
    this.head.position.set(hipShift * 0.4, 0.56 - t * 0.06, 0.02 + t * 0.12);
    // knee out on the inside of the lean
    const kneeOutL = clamp(-lean * 1.1, 0, 0.9) + 0.12;
    const kneeOutR = clamp(lean * 1.1, 0, 0.9) + 0.12;

    // ---- arm IK (shoulders in torso-local, grips converted by caller into torso space approx) ----
    // convert grip targets from body-space into hips-space manually:
    // hips = torso parent; torso has rotation applied above — approximate transform:
    this.solveArm(this.armUpperL, this.armForeL, this.gloveL, this.v.shoulderL, gripL, -1, pose);
    this.solveArm(this.armUpperR, this.armForeR, this.gloveR, this.v.shoulderR, gripR, 1, pose);
    this.solveLeg(this.legUpperL, this.legLowerL, this.bootL, this.v.hipL, pegL, kneeOutL, -1, pose);
    this.solveLeg(this.legUpperR, this.legLowerR, this.bootR, this.v.hipR, pegR, kneeOutR, 1, pose);
  }

  private tmpElbow = new THREE.Vector3();
  private tmpKnee = new THREE.Vector3();

  private solveArm(
    upper: Bone,
    fore: Bone,
    glove: THREE.Mesh,
    shoulderLocal: THREE.Vector3,
    grip: THREE.Vector3,
    side: number,
    pose: RiderPose
  ) {
    // shoulder world-ish position in hips/torso composite space (torso transform approximated)
    const torso = this.torso;
    const sh = this.v.tmpA.copy(shoulderLocal);
    sh.applyEuler(torso.rotation);
    sh.add(torso.position);
    sh.add(this.hips.position);
    // slight elbow tuck in aero mode
    const gripAdj = this.v.tmpB.copy(grip);
    gripAdj.y -= pose.brakePull * 0.012 * side;
    const l1 = 0.36;
    const l2 = 0.38;
    const elbow = this.tmpElbow;
    solveIK(sh, gripAdj, l1, l2, new THREE.Vector3(side * 0.25, -0.55, -0.8), elbow);
    upper.set(sh, elbow);
    fore.set(elbow, gripAdj);
    glove.position.copy(gripAdj);
    glove.quaternion.setFromUnitVectors(this.v.up, new THREE.Vector3(0.1, 0.25, 1).normalize());
  }

  private solveLeg(upper: Bone, fore: Bone, boot: THREE.Mesh, hipLocal: THREE.Vector3, peg: THREE.Vector3, kneeOut: number, side: number, pose: RiderPose) {
    const hip = this.v.tmpA.copy(hipLocal);
    hip.add(this.hips.position);
    // foot target: peg position, lifted on shift blip (left foot only)
    const foot = this.v.tmpB.copy(peg);
    if (side === -1) foot.y += pose.shiftBlip * 0.09;
    const l1 = 0.44;
    const l2 = 0.46;
    const knee = this.tmpKnee;
    solveIK(hip, foot, l1, l2, new THREE.Vector3(side * (0.3 + kneeOut * 0.5), 0.25, 0.6), knee);
    upper.set(hip, knee);
    fore.set(knee, foot);
    boot.position.copy(foot);
    boot.position.z += 0.05;
    boot.rotation.x = -0.15;
  }
}

/** analytic two-bone IK: returns the joint position. bendHint points where the elbow/knee should bulge. */
export function solveIK(root: THREE.Vector3, target: THREE.Vector3, l1: number, l2: number, bendHint: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const dir = new THREE.Vector3().subVectors(target, root);
  let d = dir.length();
  const minD = Math.abs(l1 - l2) + 0.02;
  const maxD = l1 + l2 - 0.02;
  if (d < 1e-5) {
    out.copy(root).addScaledVector(bendHint, 0.1);
    return out;
  }
  const dClamped = clamp(d, minD, maxD);
  if (Math.abs(dClamped - d) > 1e-6) {
    // target unreachable: pull target onto the reachable sphere (bones will shorten visually)
    dir.multiplyScalar(dClamped / d);
    target.copy(root).add(dir);
    d = dClamped;
  }
  const x = (l1 * l1 + d * d - l2 * l2) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const dirN = dir.multiplyScalar(1 / d);
  // bend direction perpendicular to the root→target axis, closest to hint
  const perp = new THREE.Vector3().copy(bendHint).addScaledVector(dirN, -bendHint.dot(dirN));
  if (perp.lengthSq() < 1e-8) perp.set(0, 1, 0).addScaledVector(dirN, -dirN.y);
  perp.normalize();
  out.copy(root).addScaledVector(dirN, x).addScaledVector(perp, h);
  return out;
}
