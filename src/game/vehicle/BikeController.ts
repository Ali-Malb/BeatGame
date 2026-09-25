/**
 * BikeController — Vehicle/BikeController layer around the pure BikePhysicsModel.
 *
 * Owns the 3D supersport + rider, translates physics state (road-frame s/x/v/
 * roll) into world space via the highway spline, runs the crash tumble and
 * respawn choreography, and feeds the rider IK. All dynamics live in the
 * model; this layer is presentation + state plumbing.
 */

import * as THREE from 'three';
import { buildBike, BikeJoints } from '../models/bikeModel';
import { RiderModel } from '../models/riderModel';
import { Highway } from '../environment/Highway';
import { JOINT_EVERY, DRIVE_HALF } from '../environment/chunkBuilder';
import { BikePhysicsModel, MAX_LEAN, SHIFT_LIGHT, WHEEL_R } from './BikePhysicsModel';
import { clamp, clampAbs, damp, kmh, smoothNoise } from '../core/utils';
import type { InputSnapshot } from '../core/Input';
import type { BikePhysicsEvents } from './BikePhysicsModel';

export { SHIFT_LIGHT };

export interface BikeTelemetry {
  speedKmh: number;
  rpm: number;
  gear: number; // 0 = N
  gearLabel: string;
  leanDeg: number;
  tuck: number;
  accel: number;
  distanceKm: number;
  neutralLeanDeg: number;
  speedLimiter: boolean;
  wheelieDeg: number;
}

/** compound collision footprint (§14) */
export const BIKE_HALF_LEN = 1.025; // 2.05 m
export const BIKE_HALF_W_BARS = 0.34; // 0.68 m at bar/mirror height
export const BIKE_HALF_W_CHASSIS = 0.21; // 0.42 m

export class BikeController {
  readonly model = new BikePhysicsModel();

  // convenience passthroughs (hot path — avoid allocation)
  get s(): number {
    return this.model.s;
  }
  get x(): number {
    return this.model.x;
  }
  get v(): number {
    return this.model.v;
  }
  get vx(): number {
    return this.model.vx;
  }
  get tuck(): number {
    return this.model.tuck;
  }
  get gear(): number {
    return this.model.gear;
  }
  get rpm(): number {
    return this.model.rpm;
  }
  get limiterCut(): boolean {
    return this.model.limiterCut;
  }
  get lean(): number {
    return this.model.rollAngle;
  }
  get wheelie(): number {
    return this.model.wheelie;
  }

  // crash
  crashed = false;
  crashTime = 0;
  private tumbleRate = 0;
  private tumbleAxis = new THREE.Vector3();
  private crashSpin = new THREE.Quaternion();
  private crashVx = 0;
  private crashVy = 0;
  private crashY = 0;

  // visuals
  group: THREE.Group;
  joints: BikeJoints;
  rider: RiderModel;
  private hbYaw = 0;
  private shiftBlip = 0;
  private lastJointS = 0;
  private detailTier: 0 | 1 | 2 = 2;

  // world frame cache
  worldPos = new THREE.Vector3();
  worldYaw = 0;
  roadYaw = 0;
  pitch = 0;
  /** §5 real brake light contribution (PointLight at the tail) */
  brakeLight: THREE.PointLight;

  private road = { kappa: 0, slope: 0, driveHalf: DRIVE_HALF };

  constructor(private highway: Highway, scene: THREE.Scene) {
    const built = buildBike();
    this.group = built.group;
    this.joints = built.joints;
    this.rider = new RiderModel();
    this.joints.body.add(this.rider.group);
    // §5: real brake light (small red PointLight at the tail)
    this.brakeLight = new THREE.PointLight(0xff2014, 0, 9, 1.9);
    this.brakeLight.position.set(0, 0.9, -0.95);
    this.group.add(this.brakeLight);
    scene.add(this.group);
    this.lastJointS = Math.floor(this.model.s / JOINT_EVERY) * JOINT_EVERY;
  }

  /** Keep the cockpit readable on weak GPUs without changing bike physics. */
  setQualityTier(tier: 0 | 1 | 2): void {
    this.detailTier = tier;
    const detailed = tier > 0;
    this.rider.group.visible = detailed;
    this.joints.wheelF.visible = detailed;
    this.joints.wheelR.visible = detailed;
    this.joints.fork.visible = detailed;
    this.joints.swingarm.visible = detailed;
    this.joints.mirrorL.visible = detailed;
    this.joints.mirrorR.visible = detailed;
    this.joints.dashboard.visible = detailed;
    this.joints.headlightSpot.visible = detailed;
    this.brakeLight.visible = detailed;
  }

  /** one physics substep (call at fixed timestep for CCD safety) */
  step(dt: number, input: InputSnapshot): BikePhysicsEvents {
    if (this.crashed) {
      return {
        shiftedUp: false,
        shiftedDown: false,
        launched: false,
        limiter: false,
        backfire: false,
        jointCrossed: false,
        barrierHit: false,
        speedLimiter: false,
      };
    }
    const frame = this.highway.frame(this.model.s);
    this.road.kappa = frame.kappa;
    this.road.slope = frame.slope;
    this.road.driveHalf = this.highway.spline.driveHalfAt(this.model.s);
    return this.model.step(dt, input, this.road, JOINT_EVERY);
  }

  forceShift(dir: 1 | -1): boolean {
    if (this.crashed) return false;
    const ok = this.model.forceShift(dir);
    if (ok && dir === 1) this.shiftBlip = 0.15;
    return ok;
  }

  /** visual update once per frame (positions bike + rider in world space) */
  updateVisuals(dt: number, time: number, cockpit: boolean) {
    const m = this.model;
    const road = this.highway.frame(m.s);

    if (this.crashed) {
      this.updateCrashVisual(dt, road);
      return;
    }

    const psi = Math.atan2(m.vx, Math.max(2, m.v));
    this.roadYaw = road.yaw;
    this.worldYaw = road.yaw + psi;
    this.worldPos.set(road.x + road.rx * m.x, road.y, road.z + road.rz * m.x);

    this.group.position.copy(this.worldPos);
    this.group.rotation.y = this.worldYaw;
    this.pitch = -Math.atan(road.slope) * 0.8;
    this.group.rotation.x = this.pitch + clamp(-m.aLong * 0.004, -0.05, 0.05);
    this.group.rotation.z = -m.rollAngle;

    // front-wheel lift: rotate about the rear contact patch (nose up = −X)
    if (m.wheelie > 0.0005) {
      this.group.rotation.x -= m.wheelie;
      // the rear contact is the pivot: the chassis rises as the nose climbs
      this.group.position.y += Math.sin(m.wheelie) * 0.75;
    }

    // suspension bob
    this.joints.body.position.y = (m.suspF - m.suspR) * 0.4;
    this.joints.body.rotation.x = (m.suspF - m.suspR) * 0.55;

    // handlebar: analytic counter-steer angle from the physics model
    this.hbYaw = damp(this.hbYaw, m.steeringAngle, 18, dt);
    this.joints.fork.rotation.y =
      this.hbYaw + smoothNoise(time * 17, 3) * 0.004 * clamp(m.v / 40, 0, 1);

    // wheels
    this.joints.wheelF.rotateX((m.v / WHEEL_R) * dt);
    this.joints.wheelR.rotateX((m.v / WHEEL_R) * dt * 0.98);

    // rider IK
    this.shiftBlip = Math.max(0, this.shiftBlip - dt);
    // §5 brake light: emissive flare + real red light contribution while braking
    const brake = clamp(-m.aLong / 3.5, 0, 1);
    this.joints.taillightMat.color.setRGB(0.55 + 3.2 * brake, 0.05 + 0.03 * brake, 0.04);
    if (this.brakeLight) {
      this.brakeLight.intensity = brake > 0.08 ? 15 * brake : 0;
    }
    const hb = this.hbYaw;
    const cy = Math.cos(hb);
    const sy = Math.sin(hb);
    const gripL = new THREE.Vector3(-0.31 * cy + 0.05 * sy, 0.93, 0.31 * sy + 0.05 * cy + 0.62);
    const gripR = new THREE.Vector3(0.31 * cy + 0.05 * sy, 0.93, -0.31 * sy + 0.05 * cy + 0.62);
    const pegL = new THREE.Vector3(-0.17, 0.34, -0.02);
    const pegR = new THREE.Vector3(0.17, 0.34, -0.02);
    const snap = this.shiftBlip > 0 ? Math.sin((this.shiftBlip / 0.15) * Math.PI) : 0;
    if (this.detailTier > 0) {
      this.rider.setTorsoVisible(!cockpit);
      this.rider.update(
        {
          tuck: m.tuck,
          lean: m.rollAngle,
          shiftBlip: snap,
          brakePull: clamp(-m.aLong / 9, 0, 1),
          vibration: m.rpm / 1000 + time,
        },
        gripL,
        gripR,
        pegL,
        pegR
      );
    }
  }

  // ---------------------------------------------------------------- crash ----
  crash() {
    if (this.crashed) return;
    this.crashed = true;
    this.crashTime = 0;
    const m = this.model;
    this.tumbleRate = 6 + Math.random() * 5;
    this.tumbleAxis
      .set(Math.random() - 0.5, 0.6 + Math.random() * 0.4, Math.random() - 0.5)
      .normalize();
    this.crashSpin.identity();
    this.crashVx = m.vx * 0.5 + (Math.random() - 0.5) * 3;
    this.crashVy = 3.5 + Math.random() * 3;
    this.crashY = 0;
    m.tuck = 0;
  }

  private updateCrashVisual(dt: number, _road: { rx: number; rz: number }) {
    const m = this.model;
    this.crashTime += dt;
    m.v = Math.max(0, m.v - (m.v * 1.9 + 4) * dt);
    m.s += m.v * dt;
    m.x = clampAbs(m.x + this.crashVx * dt, this.highway.spline.driveHalfAt(this.model.s) - 0.5);
    this.crashVx *= Math.exp(-1.2 * dt);
    const G = 9.81;
    this.crashVy -= G * dt;
    this.crashY += this.crashVy * dt;
    if (this.crashY < 0) {
      this.crashY = 0;
      this.crashVy = Math.abs(this.crashVy) * 0.35;
      if (this.crashVy < 1) this.crashVy = 0;
    }
    const q = _crashQ.setFromAxisAngle(this.tumbleAxis, this.tumbleRate * dt * Math.exp(-this.crashTime * 0.8));
    this.crashSpin.premultiply(q);

    const road2 = this.highway.frame(m.s);
    this.worldPos.set(road2.x + road2.rx * m.x, road2.y + this.crashY, road2.z + road2.rz * m.x);
    this.group.position.copy(this.worldPos);
    this.group.quaternion.setFromEuler(_crashE.set(0, road2.yaw, 0)).premultiply(this.crashSpin);
    this.joints.wheelF.rotateX((m.v / WHEEL_R) * dt);
    this.joints.wheelR.rotateX((m.v / WHEEL_R) * dt * 0.9);
    this.rider.update(
      { tuck: 0, lean: 0, shiftBlip: 0, brakePull: 0, vibration: 0 },
      _crashGripA,
      _crashGripB,
      _crashPegA,
      _crashPegB
    );
  }

  /** reposition after crash (clear lane, rolling 80 km/h) */
  respawn(s: number, lane: number) {
    this.crashed = false;
    this.crashTime = 0;
    this.crashSpin.identity();
    this.crashY = 0;
    const lanes = this.highway.spline.lanesAt(s);
    this.model.respawnRolling(s, this.highway.spline.laneX(s, clamp(lane, 0, lanes - 1)), 4);
    this.group.quaternion.setFromEuler(_crashE.set(0, 0, 0));
    this.lastJointS = Math.floor(this.model.s / JOINT_EVERY) * JOINT_EVERY;
  }

  /** rhythm-run launch: at pace (m/s) in the given lane from the first frame */
  launchAtPace(s: number, lane: number, v: number) {
    this.uncrash(s, lane, v);
    this.lastJointS = Math.floor(this.model.s / JOINT_EVERY) * JOINT_EVERY;
  }

  /** clear a tumble and resume rolling at the given speed (test-harness
   *  recovery + future respawn paths): resets the crash visual/physics state
   *  AND the model — a bare model field patch leaves the controller crashed,
   *  so updateVisuals keeps driving the tumble forever. */
  uncrash(s: number, lane: number, v: number) {
    this.crashed = false;
    this.crashTime = 0;
    this.crashSpin.identity();
    this.crashY = 0;
    const lanes = this.highway.spline.lanesAt(s);
    this.model.respawnRolling(s, this.highway.spline.laneX(s, clamp(lane, 0, lanes - 1)), 4);
    this.model.v = v;
    this.group.quaternion.setFromEuler(_crashE.set(0, 0, 0));
  }

  telemetry(): BikeTelemetry {
    const m = this.model;
    const neutral = this.highway.spline.neutralLean(m.s, m.v);
    return {
      speedKmh: kmh(m.v),
      rpm: m.rpm,
      gear: m.gear,
      gearLabel: m.gearLabel(),
      leanDeg: (m.rollAngle * 180) / Math.PI,
      tuck: m.tuck,
      accel: m.aLong,
      distanceKm: m.s / 1000,
      neutralLeanDeg: (neutral * 180) / Math.PI,
      speedLimiter: m.speedLimitCut,
      wheelieDeg: +((m.wheelie * 180) / Math.PI).toFixed(1),
    };
  }

  static readonly HALF_LEN = BIKE_HALF_LEN;
  static readonly HALF_W_BARS = BIKE_HALF_W_BARS;
  static readonly HALF_W_CHASSIS = BIKE_HALF_W_CHASSIS;
  static readonly MAX_LEAN = MAX_LEAN;
}

// module-scratch (avoid per-frame allocations in crash path)
const _crashQ = new THREE.Quaternion();
const _crashE = new THREE.Euler();
const _crashGripA = new THREE.Vector3(-0.3, 0.9, 0.66);
const _crashGripB = new THREE.Vector3(0.3, 0.9, 0.66);
const _crashPegA = new THREE.Vector3(-0.17, 0.34, -0.02);
const _crashPegB = new THREE.Vector3(0.17, 0.34, -0.02);
