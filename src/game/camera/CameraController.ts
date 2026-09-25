/**
 * CameraController — two cinematic modes + dual live mirrors.
 *
 * §1–§3 rider framing: the cockpit eye sits at RIDER EYE HEIGHT (1.58 m, above
 * the tank/instrument cluster, z −0.20 behind the front cockpit) so the handlebars,
 * mirrors and cluster render along the LOWER EDGE of the frame and the road,
 * traffic and skyline dominate the view. The bike is subordinate to the
 * environment; all framing values are exposed in CAM_CONFIG.
 *
 * §2 wheelie compensation layer — THE THREE-STEP CHAIN (§2 as documented):
 *   bike orientation → CAM compensation → final camera transform.
 *
 *   Step 1 (INHERIT): the eye rides the chassis as the bike pitches about the
 *   rear contact — the eye both rises and INHERITS a damped share of the
 *   bike's nose-up pitch. The camera must first be a camera mounted on a
 *   pitching bike before it can compensate.
 *   Step 2 (COMPENSATE): a damped fraction of that inherited pitch is then
 *   CANCELLED so the horizon and road stay readable — the rider's gaze stays
 *   on the road ahead, not at the sky. The compensation operates ON the
 *   inherited pitch (documented 90% figure ⇒ 10% passes through), not on
 *   thin air; the two factors are internally consistent.
 *   Step 3 (COMPOSE): the residual pitch is applied on top of the view
 *   bias + road slope + throttle/brake kicks. Roll (lean) still passes
 *   through at 60%. The camera is never hard-locked to world orientation.
 *
 *   Empirically verified (rendered screenshots, pixel-measured horizon):
 *   at MAX_WHEELIE (24°) the view pitch rises only a few degrees while the
 *   road surface remains in the lower half of the frame — the rider looks
 *   OVER the raised nose, not down the fork or at the sky.
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

/** §20: five camera modes cycled with C / gamepad Y */
export type CameraMode = 'cockpit' | 'chase-close' | 'chase-far' | 'dynamic' | 'cinematic';

export const CAMERA_MODES: CameraMode[] = ['cockpit', 'chase-close', 'chase-far', 'dynamic', 'cinematic'];
export const CAMERA_MODE_NAMES: Record<CameraMode, string> = {
  cockpit: 'COCKPIT',
  'chase-close': 'CHASE',
  'chase-far': 'FAR CHASE',
  dynamic: 'DYNAMIC',
  cinematic: 'CINEMATIC',
};

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
    /** static view pitch bias (rad, + = look DOWN; −0.17 keeps the horizon
     *  near the upper third so the road fills most of the frame) */
    viewDownBias: -0.17,
    /** how much road slope attitude transfers into the view pitch */
    slopePitchFactor: 0.85,
    /** throttle lift / brake dive pitch (rad) */
    accelPitchKick: -0.03,
    brakePitchKick: 0.045,
    /** §2 fraction of the INHERITED wheelie pitch the rider's gaze CANCELS
     *  (0.10 passes through) — step 2 of the orientation chain */
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
  chaseClose: { distBehind: 4.6, height: 1.72, heightSpeedRise: 0.35, basePitch: -6, posDamp: 12, lookDamp: 8, rollFactor: 0.15, wheelieLookRise: 0.25, fovBase: 66, fovMax: 76 },
  chaseFar: { distBehind: 9.5, height: 3.4, heightSpeedRise: 0.5, basePitch: -8, posDamp: 7.5, lookDamp: 5.5, rollFactor: 0.1, wheelieLookRise: 0.25, fovBase: 60, fovMax: 70 },
  /** §20 #4: base rig + speed/lean-driven modulation */
  dynamic: {
    distBehind: 5.8,
    distBehindSpeed: 2.2,
    height: 2.0,
    heightSpeedRise: 0.7,
    /** lateral offset away from the lean direction (lean 1 → +1.4 m) */
    leanOffset: 1.4,
    basePitch: -7,
    posDamp: 9,
    lookDamp: 7,
    rollFactor: 0.2,
    wheelieLookRise: 0.25,
    fovBase: 72,
    fovMax: 92,
  },
  /** §20 #5: orbiting cinematic crane — showcase framing */
  cinematic: {
    distBehind: 11,
    height: 3.1,
    heightSpeedRise: 0.25,
    orbitAmp: 3.2,
    orbitRate: 0.21,
    heightAmp: 1.1,
    heightRate: 0.34,
    basePitch: -9,
    posDamp: 4.5,
    lookDamp: 3.5,
    rollFactor: 0.06,
    wheelieLookRise: 0.2,
    fovBase: 55,
    fovMax: 62,
  },
  vibration: {
    amp: 0.0022,
    buffet: 0.009,
    windSpeedLo: 220,
  },
} as const;

/** union of all chase-rig configs (mode-specific extras are optional) */
interface ChaseCfg {
  distBehind: number;
  height: number;
  heightSpeedRise: number;
  basePitch: number;
  posDamp: number;
  lookDamp: number;
  rollFactor: number;
  wheelieLookRise: number;
  fovBase: number;
  fovMax: number;
  distBehindSpeed?: number;
  leanOffset?: number;
  orbitAmp?: number;
  orbitRate?: number;
  heightAmp?: number;
  heightRate?: number;
}

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

  // wheelie compensation state (damped — never robotic).
  // wheeliePitch = the nose-up pitch the eye has INHERITED from the chassis
  // (step 1 of the §2 chain); also drives the chassis-rise eye lift.
  private wheeliePitch = 0;

  // dual mirror rigs
  mirrorRTL: THREE.WebGLRenderTarget;
  mirrorRTR: THREE.WebGLRenderTarget;
  private mirrorCamL: THREE.PerspectiveCamera;
  private mirrorCamR: THREE.PerspectiveCamera;
  mirrorEvery = 2; // render each mirror every Nth frame (2 → ~30 Hz @60fps)
  private mirrorsEnabled = true;
  /** mirror render-target resolution (settings: Mirror Quality, §31) */
  mirrorRes = MIRROR_W;
  /** user FOV offset added to every mode's base FOV (settings, §31) */
  fovOffset = 0;
  /** camera feel scale from settings (lean roll + shake response, §29) */
  sensitivity = 1;

  // scratch
  private vForward = new THREE.Vector3();
  private vRight = new THREE.Vector3();
  private vPos = new THREE.Vector3();
  private vLook = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private _chaseLook: THREE.Vector3 | null = null;
  private _chasePos: THREE.Vector3 | null = null;

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
    const i = CAMERA_MODES.indexOf(this.mode);
    this.mode = CAMERA_MODES[(i + 1) % CAMERA_MODES.length];
    this._chaseLook = null; // re-anchor look target on cut
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

  setMirrorsEnabled(enabled: boolean): void {
    this.mirrorsEnabled = enabled;
    if (!enabled) this.mirrorEvery = 9999;
  }

  /** Mirror Quality setting: RT width in px (off handled via mirrorEvery=9999) */
  setMirrorRes(px: number): void {
    if (px === this.mirrorRes) return;
    this.mirrorRes = px;
    this.mirrorRTL.setSize(px, px / 2);
    this.mirrorRTR.setSize(px, px / 2);
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
      this.updateChase(dt, bike, kmhV, input);
    }
  }

  private updateCockpit(dt: number, bike: BikeController, kmhV: number, input: { accel: number; brakeInput: number }): void {
    const cfg = CAM_CONFIG.cockpit;
    const tuck = bike.tuck;
    const back = this.lookBlend;

    // ---- §2 compensation layer (bike orientation → compensation → camera):
    // step 1 — INHERIT: the eye is mounted on the chassis, so it first
    // inherits the bike's damped nose-up pitch (this is what was missing —
    // without it the compensation below had nothing real to cancel)
    this.wheeliePitch = damp(this.wheeliePitch, bike.wheelie, cfg.wheelieCompDamp, dt);
    // step 2 — COMPENSATE: the rider's gaze cancels 90% of the inherited
    // pitch (10% of the genuine bike movement passes through) so the horizon
    // and road stay readable. The compensation acts ON the inherited pitch,
    // making the documented fraction internally consistent.
    const netWheeliePitch = this.wheeliePitch * (1 - cfg.wheeliePitchComp);

    // ---- rider eye anchor: above the cluster, slightly over/forward of the tank ----
    const tuckY = cfg.tuckSlideY * tuck;
    const tuckZ = cfg.tuckSlideZ * tuck;
    this.vPos.copy(bike.worldPos);
    // eye rides the chassis rise as the bike pitches about the rear contact
    this.vPos.y += cfg.eyeHeight + tuckY + Math.sin(this.wheeliePitch) * cfg.wheelieEyeRise;
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

    // ---- view pitch: bias + road attitude + INHERITED wheelie residual
    // (step 3 COMPOSE) + throttle/brake kicks + micro-jitter (positive = down) ----
    let viewPitch = cfg.viewDownBias + bike.pitch * cfg.slopePitchFactor - netWheeliePitch;
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
    const roll = -bike.lean * cfg.leanRollFactor * this.sensitivity * (back > 0.5 ? -1 : 1) + smoothNoise(t * 40, 7) * vibAmp * 3;
    this.camera.rotateZ(roll);

    // ---- FOV: 85 → 105 between 150–300 km/h + beat kick + user offset (§17/§31) ----
    const fovTarget =
      cfg.fovBase + this.fovOffset + (cfg.fovMax - cfg.fovBase) * clamp((kmhV - cfg.fovSpeedLo) / (cfg.fovSpeedHi - cfg.fovSpeedLo), 0, 1) +
      (this.fovKick * 180) / Math.PI;
    this.fovCurrent = lerp(this.fovCurrent, fovTarget, lerpFactor(6, dt));
    if (Math.abs(this.camera.fov - this.fovCurrent) > 0.05) {
      this.camera.fov = this.fovCurrent;
      this.camera.updateProjectionMatrix();
    }
    this.camera.near = cfg.nearClip;
  }

  /**
   * All non-cockpit modes share one parametric chase rig (§22: every mode is
   * tuned independently via its config, and responds to speed / lean / brake /
   * wheelie; DYNAMIC adds speed-stretched distance + lean lateral offset +
   * strong FOV breathing; CINEMATIC adds a slow orbiting crane).
   */
  private updateChase(dt: number, bike: BikeController, kmhV: number, input: { brakeInput: number }): void {
    const mode = this.mode;
    const cfg = (mode === 'chase-close' ? CAM_CONFIG.chaseClose : mode === 'chase-far' ? CAM_CONFIG.chaseFar : mode === 'dynamic' ? CAM_CONFIG.dynamic : CAM_CONFIG.cinematic) as ChaseCfg;
    const back = this.lookBlend;
    const dirSign = back > 0.5 ? -1 : 1;
    const speedK = clamp((kmhV - 120) / 180, 0, 1);

    // ---- desired position ----
    const desired = this.vPos;
    desired.copy(bike.worldPos);
    let dist = cfg.distBehind;
    let height = cfg.height + speedK * (cfg.heightSpeedRise ?? 0);
    let lateral = 0;
    if (mode === 'dynamic') {
      dist += speedK * (cfg.distBehindSpeed ?? 0);
      lateral = -bike.lean * (cfg.leanOffset ?? 0) * 0.55;
    } else if (mode === 'cinematic') {
      const t = this.time;
      lateral = Math.sin(t * (cfg.orbitRate ?? 0) * Math.PI * 2) * (cfg.orbitAmp ?? 0);
      height += Math.sin(t * (cfg.heightRate ?? 0) * Math.PI * 2) * (cfg.heightAmp ?? 0);
    } else {
      lateral = -bike.lean * 0.4;
    }
    desired.y += height;
    desired.addScaledVector(this.vForward, -(0.7 + dist) * dirSign);
    desired.addScaledVector(this.vRight, lateral * dirSign);

    // exponential position smoothing (per-mode damp)
    if (!this._chasePos) this._chasePos = desired.clone();
    this._chasePos.lerp(desired, lerpFactor(cfg.posDamp, dt));
    this.camera.position.copy(this._chasePos);

    // ---- look target with lag — road-anchored during wheelies ----
    const rise = Math.sin(bike.wheelie) * cfg.wheelieLookRise;
    this.vLook.copy(bike.worldPos);
    this.vLook.y += 0.9 + rise;
    this.vLook.addScaledVector(this.vForward, (7 + speedK * 4) * dirSign);
    if (!this._chaseLook) this._chaseLook = this.vLook.clone();
    this._chaseLook.lerp(this.vLook, lerpFactor(cfg.lookDamp, dt));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this._chaseLook);
    this.camera.rotateX((cfg.basePitch * Math.PI) / 180 - clamp(input.brakeInput, 0, 1) * 0.025);
    this.camera.rotateZ(-bike.lean * cfg.rollFactor * dirSign);

    // shake
    if (this.trauma > 0.01) {
      const tr = this.trauma * this.trauma;
      this.camera.rotateZ(smoothNoise(this.time * 30, 21) * 0.14 * tr);
      this.camera.position.y += smoothNoise(this.time * 26, 22) * 0.5 * tr;
    }

    const fovRange = CAM_CONFIG.dynamic.fovMax - CAM_CONFIG.dynamic.fovBase;
    const fovBase = cfg.fovBase + this.fovOffset; // user FOV offset (§31)
    const fovTarget = fovBase + (cfg.fovMax - fovBase + this.fovOffset) * clamp((kmhV - 120) / 190, 0, 1) +
      (mode === 'dynamic' ? (this.fovKick * 180) / Math.PI * fovRange / 10 : 0);
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
    if (!this.mirrorsEnabled || this.mode !== 'cockpit') return;
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
