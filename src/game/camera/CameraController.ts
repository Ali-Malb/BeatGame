/**
 * CameraController — two cinematic modes + dual live mirrors.
 *
 * §1–§3 rider framing: the cockpit eye sits at RIDER EYE HEIGHT (1.58 m, above
 * the tank/instrument cluster, z −0.20 behind the front cockpit) so the handlebars,
 * mirrors and cluster render along the LOWER EDGE of the frame and the road,
 * traffic and skyline dominate the view. The bike is subordinate to the
 * environment; all framing values are exposed in CAM_CONFIG.
 *
 * §2 wheelie compensation layer:
 *   bike orientation → CAM compensation → final camera transform.
 *   As the nose lifts, the view pitch is counter-rotated (90% of the wheelie
 *   pitch is cancelled, damped) so the horizon and road stay readable while
 *   10% of the genuine bike movement is preserved. Roll (lean) still passes
 *   through at 60%. The camera is never hard-locked to world orientation.
 *
 * Cockpit: FOV 87°→105° between 150–300 km/h PLUS beat FOV kicks (+3° decaying
 * 0.12 s), 52° lean → ≈31° camera roll, RPM-linked 45–90 Hz micro-jitter,
 * braking dive / throttle lift pitch, wind buffet above 220 km/h, tuck slide,
 * 180° look-back.
 *
 * Chase (§18): retuned to 4.6 m behind the rear axle, 1.72 m up — the bike
 * reads ≈20% of the vertical frame; lane lines, traffic and curvature stay
 * visible. Look target stays road-anchored during wheelies.
 *
 * Mirrors: INDEPENDENT left/right cameras (65° FOV, alternating ~30 Hz update,
 * own render targets) angled outward so each shows its own side of the road
 * behind — genuinely useful for judging approaching traffic.
 */

import * as THREE from 'three';
import type { BikeController } from '../vehicle/BikeController';
import { clamp, damp, lerp, lerpFactor, smoothNoise } from '../core/utils';

export type CameraMode = 'cockpit' | 'chase';

// ---------------------------------------------------------------- config ----
export const CAM_CONFIG = {
  cockpit: {
    /** rider eye height above the ground contact (m) — §3 "above the cluster" */
    eyeHeight: 1.58,
    /** eye longitudinal offset in the bike frame (m; − = farther behind the tank/front cockpit) */
    eyeForward: -0.20,
    /** tuck aero slide (dy / dz over ~0.22 s) */
    tuckSlideY: -0.12,
    tuckSlideZ: 0.15,
    /** static view pitch bias (rad, + = look DOWN; small negative keeps the
     *  horizon in the 45–55% band) */
    viewDownBias: -0.05,
    /** how much road slope attitude transfers into the view pitch */
    slopePitchFactor: 0.85,
    /** throttle lift / brake dive pitch (rad) */
    accelPitchKick: -0.03,
    brakePitchKick: 0.045,
    /** §2 fraction of wheelie pitch the camera CANCELS (0.10 passes through) */
    wheeliePitchComp: 0.90,
    /** smoothing of the wheelie compensation (exponential damp) */
    wheelieCompDamp: 5.5,
    /** head roll fraction of bike lean (52° → ≈31°) */
    leanRollFactor: 0.6,
    /** eye rides the chassis rise as the bike pitches about the rear contact */
    wheelieEyeRise: 0.35,
    /** FOV expansion band (km/h) and values (deg) — §17 */
    fovBase: 87,
    fovMax: 105,
    fovSpeedLo: 150,
    fovSpeedHi: 300,
    /** view target distance ahead (m) */
    lookAheadDist: 42,
    nearClip: 0.02,
  },
  chase: {
    /** distance behind the REAR AXLE (m) + camera height (m) — §18 */
    distBehind: 4.6,
    height: 1.72,
    /** extra height at top speed (m) */
    heightSpeedRise: 0.35,
    /** static pitch after lookAt (deg, − = camera looks slightly down) */
    basePitch: -6,
    posDamp: 12,
    lookDamp: 8,
    rollFactor: 0.15,
    /** §2 road-anchored look target during wheelies (chassis rise fraction) */
    wheelieLookRise: 0.25,
    fovBase: 66,
    fovMax: 76,
  },
  vibration: {
    amp: 0.0022,
    buffet: 0.009,
    windSpeedLo: 220,
  },
} as const;

const MIRROR_FOV = 65;
const MIRROR_W = 256;
const MIRROR_H = 128;

export class CameraController {
  camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'cockpit';
  private lookBlend = 0; // 0 forward, 1 fully back
  private fovCurrent = CAM_CONFIG.cockpit.fovBase as number;
  private trauma = 0; // crash shake
  private time = 0;

  // FOV kick (beat reactive): transient on top of the speed FOV
  private fovKick = 0;
  private fovKickDecay = 0.12;

  // wheelie compensation state (damped — never robotic)
  private wheelieComp = 0;

  // dual mirror rigs
  mirrorRTL: THREE.WebGLRenderTarget;
  mirrorRTR: THREE.WebGLRenderTarget;
  private mirrorCamL: THREE.PerspectiveCamera;
  private mirrorCamR: THREE.PerspectiveCamera;
  mirrorEvery = 2; // render each mirror every Nth frame (2 → ~30 Hz @60fps)

  // scratch
  private vForward = new THREE.Vector3();
  private vRight = new THREE.Vector3();
  private vPos = new THREE.Vector3();
  private vLook = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private _chaseLook: THREE.Vector3 | null = null;

  constructor(private scene: THREE.Scene, aspect: number) {
    this.camera = new THREE.PerspectiveCamera(CAM_CONFIG.cockpit.fovBase, aspect, CAM_CONFIG.cockpit.nearClip, 3400);
    this.camera.rotation.order = 'YXZ';
    this.camera.layers.enable(1); // rain layer visible to main cam only

    const rtOpts: THREE.RenderTargetOptions = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    };
    this.mirrorRTL = new THREE.WebGLRenderTarget(MIRROR_W, MIRROR_H, rtOpts);
    this.mirrorRTR = new THREE.WebGLRenderTarget(MIRROR_W, MIRROR_H, rtOpts);
    for (const rt of [this.mirrorRTL, this.mirrorRTR]) {
      rt.texture.wrapS = THREE.RepeatWrapping;
      rt.texture.repeat.x = -1; // horizontal mirror flip
    }
    this.mirrorCamL = new THREE.PerspectiveCamera(MIRROR_FOV, MIRROR_W / MIRROR_H, 0.4, 320);
    this.mirrorCamR = new THREE.PerspectiveCamera(MIRROR_FOV, MIRROR_W / MIRROR_H, 0.4, 320);
    // mirrors show only the base world layer (no lens rain)
    this.mirrorCamL.layers.set(0);
    this.mirrorCamR.layers.set(0);
  }

  attachMirrors(bike: BikeController): void {
    const matL = bike.joints.mirrorL.material as THREE.MeshBasicMaterial;
    matL.map = this.mirrorRTL.texture;
    matL.color.setRGB(1.12, 1.16, 1.22);
    matL.needsUpdate = true;
    const matR = bike.joints.mirrorR.material as THREE.MeshBasicMaterial;
    matR.map = this.mirrorRTR.texture;
    matR.color.setRGB(1.12, 1.16, 1.22);
    matR.needsUpdate = true;
  }

  toggle(): void {
    this.mode = this.mode === 'cockpit' ? 'chase' : 'cockpit';
  }

  addTrauma(amount: number): void {
    this.trauma = clamp(this.trauma + amount, 0, 1.4);
  }

  /** beat-reactive transient FOV kick (e.g. +3° over 0.12 s decay) */
  addFovKick(deg: number, decaySec = 0.12): void {
    this.fovKick = Math.max(this.fovKick, (deg * Math.PI) / 180);
    this.fovKickDecay = decaySec;
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number, bike: BikeController, input: { lookBack: boolean; tuck: boolean; accel: number; brakeInput: number }): void {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.1);
    this.lookBlend = damp(this.lookBlend, input.lookBack ? 1 : 0, 14, dt);
    // FOV kick decay
    if (this.fovKick > 0.0001) {
      this.fovKick = Math.max(0, this.fovKick - (this.fovKick / this.fovKickDecay) * dt * 1.6);
    }

    const yaw = bike.worldYaw;
    this.vForward.set(Math.sin(yaw), 0, Math.cos(yaw));
    this.vRight.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const kmhV = bike.v * 3.6;

    if (this.mode === 'cockpit') {
      this.updateCockpit(dt, bike, kmhV, input);
    } else {
      this.updateChase(dt, bike, kmhV);
    }
  }

  private updateCockpit(dt: number, bike: BikeController, kmhV: number, input: { accel: number; brakeInput: number }): void {
    const cfg = CAM_CONFIG.cockpit;
    const tuck = bike.tuck;
    const back = this.lookBlend;

    // ---- §2 compensation layer: damped fraction of the wheelie pitch the
    // view direction cancels (bike orientation → compensation → camera) ----
    this.wheelieComp = damp(this.wheelieComp, bike.wheelie, cfg.wheelieCompDamp, dt);
    const compPitch = this.wheelieComp * cfg.wheeliePitchComp;

    // ---- rider eye anchor: above the cluster, slightly over/forward of the tank ----
    const tuckY = cfg.tuckSlideY * tuck;
    const tuckZ = cfg.tuckSlideZ * tuck;
    this.vPos.copy(bike.worldPos);
    // eye rides the chassis rise as the bike pitches about the rear contact
    this.vPos.y += cfg.eyeHeight + tuckY + Math.sin(this.wheelieComp) * cfg.wheelieEyeRise;
    this.vPos.addScaledVector(this.vForward, cfg.eyeForward + tuckZ);

    // ---- vibration: 45–90 Hz jitter tied to RPM + buffet > 220 (§16) ----
    const vib = CAM_CONFIG.vibration;
    const rpmF = clamp(bike.rpm / 15200, 0, 1);
    const vibAmp = vib.amp * (0.35 + rpmF * 0.95);
    const t = this.time;
    const buffet = clamp((kmhV - vib.windSpeedLo) / 90, 0, 1) * vib.buffet;
    const jx = smoothNoise(t * 62, 1) * vibAmp + smoothNoise(t * 3.1, 5) * buffet;
    const jy = smoothNoise(t * 71, 2) * vibAmp + smoothNoise(t * 2.3, 6) * buffet;
    const jz = smoothNoise(t * 88, 3) * vibAmp * 0.6;
    const tr = this.trauma * this.trauma;
    const sx = smoothNoise(t * 38, 11) * 0.12 * tr;
    const sy = smoothNoise(t * 44, 12) * 0.1 * tr;
    this.vPos.x += jx + sx;
    this.vPos.y += jy + sy;
    this.vPos.z += jz;

    // ---- view pitch: bias + road attitude + throttle/brake kicks + wheelie
    // compensation + micro-jitter (positive = look down) ----
    let viewPitch = cfg.viewDownBias + bike.pitch * cfg.slopePitchFactor + compPitch;
    if (input.accel > 0.8) viewPitch += cfg.accelPitchKick * clamp(input.accel / 8, 0, 1);
    if (input.accel < -0.8) viewPitch += -cfg.accelPitchKick * clamp(-input.accel / 8, 0, 1) * 1.4;
    if (input.brakeInput > 0.05) viewPitch += cfg.brakePitchKick * input.brakeInput;
    viewPitch += smoothNoise(t * 50, 4) * vibAmp * 2;

    this.camera.position.copy(this.vPos);

    // ---- look target: corridor ahead / 180° behind blend ----
    const dir = back < 0.5 ? 1 : -1;
    const dist = cfg.lookAheadDist;
    this.vLook.copy(this.vPos);
    this.vLook.addScaledVector(this.vForward, dist * dir);
    if (back > 0.02 && back < 0.98) {
      this.vLook.addScaledVector(this.vRight, (0.5 - Math.abs(back - 0.5)) * 60);
    }
    // explicit view pitch on the target (down angle positive → target lower)
    this.vLook.y = this.vPos.y - Math.tan(clamp(viewPitch, -0.6, 0.6)) * dist;
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.vLook);

    // ---- head roll: 52° lean → ≈31° (§17), flipped while looking back ----
    const roll = -bike.lean * cfg.leanRollFactor * (back > 0.5 ? -1 : 1) + smoothNoise(t * 40, 7) * vibAmp * 3;
    this.camera.rotateZ(roll);

    // ---- FOV: 85 → 105 between 150–300 km/h + beat kick (§17) ----
    const fovTarget =
      cfg.fovBase + (cfg.fovMax - cfg.fovBase) * clamp((kmhV - cfg.fovSpeedLo) / (cfg.fovSpeedHi - cfg.fovSpeedLo), 0, 1) +
      (this.fovKick * 180) / Math.PI;
    this.fovCurrent = lerp(this.fovCurrent, fovTarget, lerpFactor(6, dt));
    if (Math.abs(this.camera.fov - this.fovCurrent) > 0.05) {
      this.camera.fov = this.fovCurrent;
      this.camera.updateProjectionMatrix();
    }
    this.camera.near = cfg.nearClip;
  }

  private updateChase(dt: number, bike: BikeController, kmhV: number): void {
    const cfg = CAM_CONFIG.chase;
    const back = this.lookBlend;
    const dirSign = back > 0.5 ? -1 : 1;
    // desired: cfg.distBehind behind the REAR AXLE (axle at z −0.70), cfg.height up
    const desired = this.vPos;
    desired.copy(bike.worldPos);
    desired.y += cfg.height;
    desired.addScaledVector(this.vForward, -(0.7 + cfg.distBehind) * dirSign);
    desired.y += clamp((kmhV - 160) / 320, 0, 1) * cfg.heightSpeedRise;

    // exponential position smoothing (posDamp·dt)
    this.camera.position.lerp(desired, lerpFactor(cfg.posDamp, dt));

    // rotation with lag (lookDamp·dt) via smoothed look target — stays road-
    // anchored during wheelies (only wheelieLookRise of the chassis rise)
    this.vLook.copy(bike.worldPos);
    this.vLook.y += 0.9 + Math.sin(bike.wheelie) * cfg.wheelieLookRise;
    this.vLook.addScaledVector(this.vForward, 7 * dirSign);
    this._chaseLook = this._chaseLook ?? this.vLook.clone();
    this._chaseLook.lerp(this.vLook, lerpFactor(cfg.lookDamp, dt));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this._chaseLook);
    // base pitch (−6°)
    this.camera.rotateX((cfg.basePitch * Math.PI) / 180);
    // rollFactor lean roll contribution
    this.camera.rotateZ(-bike.lean * cfg.rollFactor * dirSign);

    // shake
    if (this.trauma > 0.01) {
      const tr = this.trauma * this.trauma;
      this.camera.rotateZ(smoothNoise(this.time * 30, 21) * 0.14 * tr);
      this.camera.position.y += smoothNoise(this.time * 26, 22) * 0.5 * tr;
    }

    const fovTarget = cfg.fovBase + (cfg.fovMax - cfg.fovBase) * clamp((kmhV - 120) / 190, 0, 1);
    this.fovCurrent = lerp(this.fovCurrent, fovTarget, lerpFactor(5, dt));
    if (Math.abs(this.camera.fov - this.fovCurrent) > 0.05) {
      this.camera.fov = this.fovCurrent;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Render the dual live mirrors — one mirror per call, alternating
   * (~30 Hz each at 60 fps). Each mirror has its OWN camera + render target
   * angled outward, so left/right views differ and oncoming traffic is
   * actually judgeable.
   */
  renderMirror(renderer: THREE.WebGLRenderer, bike: BikeController): void {
    if (this.mode !== 'cockpit') return;
    this.mirrorFrame++;
    if (this.mirrorFrame % this.mirrorEvery !== 0) return;

    const yawBack = bike.worldYaw + Math.PI;
    // outward cant: left mirror looks back-left, right mirror back-right
    const outward = 0.34; // ≈20°

    for (let side = -1; side <= 1; side += 2) {
      const cam = side === -1 ? this.mirrorCamL : this.mirrorCamR;
      const rt = side === -1 ? this.mirrorRTL : this.mirrorRTR;
      const mirrorMesh = side === -1 ? bike.joints.mirrorL : bike.joints.mirrorR;

      // mount at the mirror's world position (follows steering)
      mirrorMesh.getWorldPosition(this.vPos);
      this.q.setFromEuler(this.e.set(-0.07, yawBack + side * outward, 0, 'YXZ'));
      cam.position.copy(this.vPos);
      cam.quaternion.copy(this.q);
      cam.updateMatrixWorld();

      renderer.setRenderTarget(rt);
      renderer.clear(true, true, false);
      renderer.render(this.scene, cam);
      renderer.setRenderTarget(null);
    }
  }
  private mirrorFrame = 0;

  dispose(): void {
    this.mirrorRTL.dispose();
    this.mirrorRTR.dispose();
  }
}
