/**
 * BikePhysicsModel — pure road-frame liter-bike physics, no rendering, no scene.
 *
 * Explicit state & parameters (§8):
 *   mass, wheelbase, CoM height, steering angle, roll angle, roll rate,
 *   yaw rate, longitudinal velocity, lateral velocity, tire forces,
 *   aerodynamic drag, braking, engine torque, drivetrain ratios.
 *
 * Drivetrain: true sequential box N,1,2,3,4,5,6 — 70 ms torque interruption,
 * peak torque 9.5k–13.5k, redline 14 500, limiter 15 200.
 *
 * Longitudinal: torque-curve × drivetrain force with traction/wheelie caps
 * (load transfer), ρ=1.225 · A=0.65 · Cd 0.58 upright / 0.46 tucked, ECU limit
 * 299 upright → 320 fully tucked (the tucked figure falls out of the aero +
 * drivetrain balance at the limiter, not a raw speed clamp).
 *
 * Lateral: above ~100 km/h steering commands ROLL RATE (counter-steering);
 * lean integrates with gyro-capped rate (full ±52° swing ≈ 0.38 s at speed),
 * self-righting relaxes toward the curve-neutral lean when input releases.
 */

import { clamp, clampAbs, lerp } from '../core/utils';
import type { InputSnapshot } from '../core/Input';

// ------------------------------------------------------------------ params ----
export const MASS = 284; // kg (199 bike + 85 rider)
export const WHEELBASE = 1.41; // m
export const COM_HEIGHT = 0.6; // m
export const STATIC_REAR = 0.53; // rear weight bias with rider
export const WHEEL_R = 0.317; // m (190/55ZR17)
export const RHO = 1.225; // kg/m³
export const FRONTAL_A = 0.65; // m²
export const CD_UPRIGHT = 0.58;
export const CD_TUCK = 0.46;
export const DRIVETRAIN_EFF = 0.94;
export const MU = 1.14; // warm sport-tire friction coefficient
export const ROLL_RES = 0.014; // rolling resistance coefficient

export const RPM_IDLE = 1200;
export const RPM_PEAK_TORQUE_LO = 9500;
export const RPM_PEAK_TORQUE_HI = 13500;
export const REDLINE = 14500;
export const LIMITER_RPM = 15200;
export const RPM_MAX_MODEL = 15600;
export const SHIFT_LIGHT = 14200;
export const SHIFT_CUT_SEC = 0.07; // 70 ms torque interruption
export const MAX_LEAN = (52 * Math.PI) / 180;
export const MAX_WHEELIE = (24 * Math.PI) / 180; // dynamic front-lift ceiling (power wheelie)


/** ECU speed limiters (gentlemen's 299, released under full aero tuck) */
export const LIMIT_UPRIGHT_MS = 299 / 3.6;
export const LIMIT_TUCK_MS = 320 / 3.6;

/** overall per-gear ratios (primary × gear × final); tops @15200 rpm:
 *  68 / 92 / 121 / 157 / 200 / 322 km/h */
const GEAR_RATIO = [26.7, 19.8, 15.0, 11.54, 9.08, 5.63];
const RATIO_NEUTRAL = 0;

/** torque curve control points [rpm, Nm] */
const TORQUE_CURVE: [number, number][] = [
  [1000, 55],
  [2500, 73],
  [4000, 84],
  [6000, 90],
  [8000, 97],
  [9500, 114],
  [10500, 117],
  [11500, 116],
  [12500, 115],
  [13500, 113],
  [14500, 110],
  [15000, 100],
  [15200, 92],
  [15600, 80],
];

export function engineTorque(rpm: number): number {
  if (rpm <= TORQUE_CURVE[0][0]) return TORQUE_CURVE[0][1];
  const last = TORQUE_CURVE.length - 1;
  if (rpm >= TORQUE_CURVE[last][0]) return TORQUE_CURVE[last][1];
  for (let i = 0; i < last; i++) {
    const [r0, t0] = TORQUE_CURVE[i];
    const [r1, t1] = TORQUE_CURVE[i + 1];
    if (rpm >= r0 && rpm <= r1) return lerp(t0, t1, (rpm - r0) / (r1 - r0));
  }
  return 0;
}

export interface BikePhysicsEvents {
  shiftedUp: boolean;
  shiftedDown: boolean;
  /** neutral → 1st launch engagement */
  launched: boolean;
  limiter: boolean;
  backfire: boolean;
  jointCrossed: boolean;
  barrierHit: boolean;
  /** electronic speed limiter active */
  speedLimiter: boolean;
}

export interface RoadSample {
  /** path curvature 1/m (signed, + = left) */
  kappa: number;
  /** road slope (dy/ds) */
  slope: number;
  /** guardrail half-width in the road frame */
  driveHalf: number;
}

const G = 9.81;

export class BikePhysicsModel {
  // ---- explicit state ----
  /** longitudinal arc position along the spline (m) */
  s = 30;
  /** lateral offset from the spline center (m, + = left) */
  x = 1.75;
  /** longitudinal velocity (m/s) */
  v = 0;
  /** lateral velocity in the road frame (m/s) */
  vx = 0;
  /** roll/lean angle (rad, + = left) */
  rollAngle = 0;
  /** roll rate (rad/s) */
  rollRate = 0;
  /** yaw rate about the contact vertical (rad/s, derived) */
  yawRate = 0;
  /** handlebar steering angle (rad, derived) */
  steeringAngle = 0;
  /** gear: 0 = N, 1..6 */
  gear = 0;
  /** engine rpm */
  rpm = RPM_IDLE;
  /** aero tuck 0..1 */
  tuck = 0;
  /** smoothed longitudinal acceleration (m/s²) */
  aLong = 0;
  /** front-wheel lift angle (rad, 0 = grounded, + = wheelie) */
  wheelie = 0;
  /** front-wheel lift rate (rad/s) */
  wheelieRate = 0;

  // drivetrain internals
  shiftTimer = 0;
  limiterCut = false;
  limiterCutTimer = 0;
  speedLimitCut = false;
  neutralRev = 0; // free-rev state for N
  lastThrottle = 0;
  autoShift = true;
  /** automatic aero tuck above 220 km/h (disabled for acceptance testing) */
  autoTuckEnabled = true;

  // tire force report (for telemetry / audio)
  tireForceRear = 0;
  tireForceBrake = 0;

  // suspension states (visual springs)
  suspF = 0;
  suspFv = 0;
  suspR = 0;
  suspRv = 0;

  // ---- tuning ----
  /** max roll rate the bike will sustain (gyro-capped) */
  maxRollRateAt(vMs: number): number {
    // ~0.38 s full ±52° swing at highway speed; a touch quicker at crawl
    const hi = clamp((vMs - 13.9) / 13.9, 0, 1);
    return lerp(5.8, 5.35, hi);
  }

  /** neutral (curve-matching) lean for the current speed & curvature */
  neutralLean(kappa: number, vMs: number): number {
    return Math.atan((vMs * vMs * kappa) / G);
  }

  // -------------------------------------------------------------- step ----
  /**
   * One fixed-timestep physics step. Pure: no scene access, deterministic.
   */
  step(h: number, input: InputSnapshot, road: RoadSample, jointEvery: number): BikePhysicsEvents {
    const ev: BikePhysicsEvents = {
      shiftedUp: false,
      shiftedDown: false,
      launched: false,
      limiter: false,
      backfire: false,
      jointCrossed: false,
      barrierHit: false,
      speedLimiter: false,
    };

    const kappa = road.kappa;

    // ============================ drivetrain ============================
    if (this.shiftTimer > 0) this.shiftTimer -= h;
    if (this.limiterCutTimer > 0) this.limiterCutTimer -= h;

    // neutral launch: clutch out as soon as throttle is applied
    if (this.gear === 0 && input.throttle > 0.08 && this.v < 2) {
      this.gear = 1;
      ev.launched = true;
    }

    const ratio = this.gear === 0 ? RATIO_NEUTRAL : GEAR_RATIO[this.gear - 1];
    // wheel-speed implied rpm (locked clutch)
    const wheelRpm = this.v > 0.05 ? (this.v / WHEEL_R) * ratio * (60 / (Math.PI * 2)) : 0;

    if (this.gear === 0) {
      // free rev in neutral
      const target = RPM_IDLE + input.throttle * (REDLINE - RPM_IDLE) * 0.92;
      this.neutralRev = lerp(this.neutralRev, target, 1 - Math.exp(-3.5 * h));
      this.rpm = clamp(this.neutralRev, RPM_IDLE, LIMITER_RPM);
    } else if (this.shiftTimer > 0) {
      // rpm blips through the torque interruption window (dog rings)
      this.rpm = lerp(this.rpm, clamp(wheelRpm, RPM_IDLE, RPM_MAX_MODEL), 1 - Math.exp(-9 * h));
    } else {
      // clutch slip below ~2200 rpm: launch zone blends engine & wheel speed
      const slipRpm = clamp(wheelRpm, 0, RPM_MAX_MODEL);
      const blend = clamp((slipRpm - 1800) / 1400, 0, 1);
      this.rpm = lerp(Math.max(RPM_IDLE, this.rpm * 0.995), slipRpm, blend);
      this.rpm = clamp(this.rpm, RPM_IDLE, RPM_MAX_MODEL);
    }

    // ---- auto shifting (sequential, with 70 ms cuts) ----
    if (this.autoShift && this.gear > 0 && this.shiftTimer <= 0) {
      if (this.rpm > 14350 && this.gear < 6 && input.throttle > 0.22) {
        this.gear++;
        this.shiftTimer = SHIFT_CUT_SEC;
        ev.shiftedUp = true;
      } else if (this.rpm < 5850 && this.gear > 1) {
        this.gear--;
        this.shiftTimer = SHIFT_CUT_SEC * 0.9;
        ev.shiftedDown = true;
      }
    }

    // ---- ignition limiter (15200, hard bounce) ----
    if (this.rpm >= LIMITER_RPM && this.gear > 0) {
      this.limiterCut = true;
    }
    if (this.limiterCut) {
      if (this.limiterCutTimer <= 0) {
        this.limiterCutTimer = 0.085;
        ev.limiter = true;
      }
      if (this.rpm < LIMITER_RPM - 260 || this.v < 2) this.limiterCut = false;
    }

    // ============================ aero tuck ============================
    const autoTuck = this.autoTuckEnabled && this.v > 61.1; // 220 km/h
    const tuckTarget = input.tuck || autoTuck ? 1 : 0;
    this.tuck = lerp(this.tuck, tuckTarget, 1 - Math.exp(-4.4 * h));

    // ============================ forces ============================
    // ---- engine force at the contact patch ----
    let driveForce = 0;
    const throttle = input.throttle;
    if (this.gear > 0 && throttle > 0.01 && this.shiftTimer <= 0 && !this.limiterCut && !this.speedLimitCut) {
      const torque = engineTorque(this.rpm) * (0.18 + 0.82 * throttle);
      driveForce = (torque * ratio * DRIVETRAIN_EFF) / WHEEL_R;
    }
    // engine braking (closed throttle, in gear)
    if (this.gear > 0 && throttle <= 0.01 && this.v > 1 && this.shiftTimer <= 0) {
      const pump = -1 - (this.rpm / RPM_MAX_MODEL) * 13; // Nm
      driveForce += (pump * ratio * DRIVETRAIN_EFF) / WHEEL_R;
    }

    // ---- electronic speed limiter: 299 upright / 320 tucked ----
    const limitMs = this.tuck > 0.8 ? LIMIT_TUCK_MS : LIMIT_UPRIGHT_MS;
    if (this.v > limitMs) {
      this.speedLimitCut = true;
      driveForce = Math.min(driveForce, 0);
    } else if (this.v < limitMs - 0.35) {
      this.speedLimitCut = false;
    }
    ev.speedLimiter = this.speedLimitCut;

    // ---- traction / wheelie with rear load transfer ----
    const frontStatic = MASS * G * (1 - STATIC_REAR);
    const accTransfer = MASS * Math.max(0, this.aLong) * (COM_HEIGHT / WHEELBASE);
    const launchRamp = clamp(this.v / 1.7, 0.68, 1); // soft clutch engagement
    // raw engine force at the contact patch (pre-grip) — this is the pitch/lift authority
    const rawDriveForce = Math.max(0, driveForce);
    // grip cap on the rear: once the front is airborne the rear carries everything
    const frontLoad = this.wheelie > 0.02 ? 0 : clamp(frontStatic - accTransfer, 0, frontStatic);
    const rearLoad = MASS * G - frontLoad;
    const tractionCap = MU * rearLoad * launchRamp;
    // raw contact force that unloads the front (tuned 0.92 — chain pull + wheelspin jack)
    const liftThreshold = (frontStatic / (COM_HEIGHT / WHEELBASE)) * 0.92;
    const liftExcess = rawDriveForce - liftThreshold;
    driveForce = Math.min(driveForce, tractionCap);
    this.tireForceRear = driveForce;

    // ---- brakes ----
    // front brake acts through the front contact — ineffective while airborne
    const airborneFac = this.wheelie > 0.02 ? clamp(1 - this.wheelie * 4, 0, 1) : 1;
    const frontBrake = input.brake * 2010 * airborneFac;
    const rearBrake = input.rearBrake * 640;
    const brakeTotal = (frontBrake + rearBrake) * (this.v > 0.35 ? 1 : Math.max(0, this.v / 0.35));
    this.tireForceBrake = brakeTotal;

    // ---- front-wheel lift (power wheelie) dynamics ----
    if (this.wheelie > 0.001 || liftExcess > 0) {
      // excess drive force lifts; gravity about the rear contact + brakes pull it down
      const driveLever = Math.min(liftExcess, 1400) * COM_HEIGHT;
      const gravRestore =
        Math.sin(clamp(this.wheelie, 0, MAX_WHEELIE)) * MASS * G * (WHEELBASE * STATIC_REAR);
      let liftTorque = driveLever - gravRestore;
      if (brakeTotal > 0) liftTorque -= brakeTotal * COM_HEIGHT * (this.wheelie > 0.02 ? 0.85 : 1.0);
      const inertial = 250; // tuned pitch inertia about the rear contact (kg·m²)
      this.wheelieRate += (liftTorque / inertial) * h;
    } else {
      this.wheelieRate += -this.wheelieRate * 8 * h; // grounded: settle instantly
    }
    this.wheelieRate -= this.wheelieRate * 2.2 * h; // suspension damping
    this.wheelie += this.wheelieRate * h;
    if (this.wheelie <= 0) {
      this.wheelie = 0;
      if (this.wheelieRate < 0) this.wheelieRate = 0;
    }
    this.wheelie = Math.min(this.wheelie, MAX_WHEELIE);

    // ---- aero drag + rolling ----
    const cd = lerp(CD_UPRIGHT, CD_TUCK, this.tuck);
    const cda = cd * FRONTAL_A;
    const drag = 0.5 * RHO * cda * this.v * this.v;
    const rolling = ROLL_RES * MASS * G * (this.v > 0.2 ? 1 : 0);

    // ---- integrate longitudinal ----
    const force = driveForce - drag - rolling - brakeTotal;
    const a = force / MASS;
    const vPrev = this.v;
    this.v = Math.max(0, this.v + a * h);
    this.aLong = lerp(this.aLong, (this.v - vPrev) / h, 1 - Math.exp(-8 * h));

    // overrun backfire: throttle dump at high rpm
    if (this.lastThrottle > 0.62 && throttle < 0.16 && this.rpm > 8600) ev.backfire = true;
    this.lastThrottle = throttle;

    // ============================ lateral: roll-rate model ============================
    // SIGN CONVENTION (§4): input.steer -1 = LEFT, +1 = RIGHT (Input layer:
    // A/Left/stick-left → negative, D/Right/stick-right → positive).
    // rollAngle + = LEFT lean; lateral x + = LEFT. So a RIGHT command (+1)
    // must integrate rollAngle NEGATIVE — the input sign is negated exactly
    // once, here at the physics entry point, and never again downstream.
    const neutral = this.neutralLean(kappa, this.v);
    const rollCmdFromInput = -input.steer * this.maxRollRateAt(this.v);

    // self-righting: relax toward the stable lean (upright on a straight)
    const steerDead = Math.abs(input.steer) < 0.06;
    const selfRightGain = steerDead ? 3.4 : 0.2;
    const relaxRate = selfRightGain * (neutral - this.rollAngle);

    // target roll rate = rider command + geometry relaxation
    const targetRollRate = rollCmdFromInput + relaxRate;
    // first-order rider/bike roll response (~75 ms)
    this.rollRate = lerp(this.rollRate, targetRollRate, 1 - Math.exp(-13 * h));
    // gyroscopic rate ceiling — the faster we go, the harder to flip quickly
    const rateCap = this.maxRollRateAt(this.v) * 1.25;
    this.rollRate = clampAbs(this.rollRate, rateCap);
    this.rollAngle = clampAbs(this.rollAngle + this.rollRate * h, MAX_LEAN);

    // steering angle (visual/telemetry): fork + = LEFT. At crawl the bar turns
    // into the commanded direction; at speed counter-steer leads the lean
    // (leaning left, rollRate +, needs fork right first — same sign both cases).
    const hiFac = clamp((this.v - 8) / 30, 0, 1);
    this.steeringAngle = lerp(-input.steer * 0.34, -this.rollRate * 0.052, hiFac);

    // ---- lateral acceleration from lean (road frame) ----
    let aLat = G * Math.tan(clampAbs(this.rollAngle, 1.1)) - this.v * this.v * kappa;
    // low-speed handlebar authority (< 50 km/h): bar right → lateral right (−x)
    if (this.v < 13.9) aLat += -input.steer * 3.6 * (1 - this.v / 13.9);
    this.vx += aLat * h;
    // lateral tire scrub damping (rider micro-corrections + drag)
    this.vx *= Math.exp(-0.85 * h);
    this.vx = clampAbs(this.vx, 12);
    this.x += this.vx * h;

    // derived yaw rate of the bike heading (for camera & visuals)
    this.yawRate = this.v > 2 ? aLat / this.v : 0;

    // ============================ barriers ============================
    if (Math.abs(this.x) > road.driveHalf - 0.36) {
      this.x = clampAbs(this.x, road.driveHalf - 0.36);
      if (this.v > 8) {
        ev.barrierHit = true;
        return ev;
      }
      this.vx = -this.vx * 0.2;
    }

    // ============================ advance ============================
    this.s += this.v * h;

    // expansion joints → suspension impulses
    if (jointEvery > 0) {
      const jointIdx = Math.floor(this.s / jointEvery);
      const lastIdx = Math.floor((this.s - this.v * h) / jointEvery);
      if (jointIdx !== lastIdx && this.v > 2) {
        ev.jointCrossed = true;
        const kick = clamp(this.v * 0.16, 0.4, 11);
        this.suspFv -= kick;
        this.suspRv -= kick * 0.55;
      }
    }

    // suspension springs (front dives under braking, rear squats under power)
    const dive = clamp(-this.aLong * 0.028, -0.115, 0.115);
    this.suspF += this.suspFv * h;
    this.suspFv += (-90 * (this.suspF - dive) - 8.5 * this.suspFv) * h;
    this.suspF = clampAbs(this.suspF, 0.12);
    const squat = clamp(this.aLong * 0.02, -0.12, 0.12);
    this.suspR += this.suspRv * h;
    this.suspRv += (-80 * (this.suspR - squat) - 7.5 * this.suspRv) * h;
    this.suspR = clampAbs(this.suspR, 0.13);

    return ev;
  }

  // -------------------------------------------------------------- helpers ----
  /** force a shift with torque cut (manual or quickshifter) */
  forceShift(dir: 1 | -1): boolean {
    if (this.shiftTimer > 0) return false;
    const g = this.gear + dir;
    if (g < 0 || g > 6) return false;
    this.gear = g;
    this.shiftTimer = SHIFT_CUT_SEC;
    return true;
  }

  gearLabel(): string {
    return this.gear === 0 ? 'N' : String(this.gear);
  }
  /** hard reset for respawn: rolling 80 km/h in the given gear */
  respawnRolling(s: number, x: number, gear = 4): void {
    this.s = s;
    this.x = x;
    this.v = 22.22;
    this.vx = 0;
    this.rollAngle = 0;
    this.rollRate = 0;
    this.gear = gear;
    this.tuck = 0;
    this.rpm = clamp((this.v / WHEEL_R) * GEAR_RATIO[gear - 1] * (60 / (Math.PI * 2)), RPM_IDLE, RPM_MAX_MODEL);
    this.limiterCut = false;
    this.speedLimitCut = false;
    this.shiftTimer = 0;
    this.suspF = 0;
    this.suspR = 0;
    this.aLong = 0;
    this.wheelie = 0;
    this.wheelieRate = 0;
  }

  /** rhythm-run start: already at the given pace (default 240 km/h) in top
   *  gear so gate s positions are reachable from the very first note. */
  respawnAtPace(s: number, x: number, v: number): void {
    this.respawnRolling(s, x, 6);
    this.v = v;
    this.rpm = clamp((v / WHEEL_R) * GEAR_RATIO[5] * (60 / (Math.PI * 2)), RPM_IDLE, RPM_MAX_MODEL);
  }
}

/** gear-top speeds at the 15 200 limiter, for the dashboard/debug */
export const GEAR_TOPS_MS = GEAR_RATIO.map((r) => (LIMITER_RPM / 60) * ((Math.PI * 2) / r) * WHEEL_R);
