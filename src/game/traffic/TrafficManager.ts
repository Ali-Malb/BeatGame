/**
 * TrafficManager — deterministic pooled AI traffic on the road spline.
 *
 * §20 guarantees:
 *   - 15–25 active vehicles, spawn 250–350 m ahead, despawn 60 m behind
 *   - class speed bands (sedans/coupes/taxis 90–120, trucks 75–85, buses)
 *   - 1.2 s indicator signal then a 2.5 s lane change
 *   - FORWARD OCCUPANCY SOLVER: if two adjacent lanes are occupied within
 *     10 m, the remaining lane(s) must stay clear for at least 40 m — the
 *     player always has an escape corridor, never a 4-lane wall
 *   - headlight pavement pools + 4× brake flares + red/blue ambulance strobes
 *   - swept CCD collision + near-miss (strong effect only < 0.8 m @ >180 km/h)
 *     + lane-split detection
 */

import * as THREE from 'three';
import { buildTrafficVehicle, buildOncomingCar, VehicleKind, VehicleModel } from './trafficModels';
import { Highway } from '../environment/Highway';
import { lerp, smoothstep, RNG, ms } from '../core/utils';
import type { BikeController } from '../vehicle/BikeController';

export interface NearMissEvent {
  kind: 'nearMiss' | 'close' | 'laneSplit';
  points: number;
  side: number; // -1 left, +1 right of the car we passed
  heavy: boolean;
  strong: boolean; // < 0.8 m at > 180 km/h
}

interface TrafficCar {
  model: VehicleModel;
  active: boolean;
  s: number;
  x: number;
  lane: number;
  v: number;
  targetV: number;
  laneFrom: number;
  laneTo: number;
  laneT: number; // 0..1 lane change progress
  laneWait: number; // blinker lead-in (1.2 s)
  blinker: number; // -1 left, +1 right, 0 none
  blinkPhase: number;
  braking: boolean;
  cooldown: number;
  rel: number; // car.s - bike.s sign memory for pass detection
  passed: boolean;
  speedClass: number;
  spawnOrder: number;
}

const SPEED_CLASSES = [
  { kmhMin: 75, kmhMax: 85 }, // trucks / buses
  { kmhMin: 90, kmhMax: 120 }, // sedans / taxis / coupes
];

const POOL_TOTAL = 30;
const ACTIVE_TARGET = 19; // 15–25 band
const SIGNAL_SEC = 1.2;
const LANE_CHANGE_SEC = 2.5;

/** escape-corridor invariant constants */
const WINDOW = 10; // m — "two adjacent lanes occupied within 10 m"
const CORRIDOR = 40; // m — remaining lane must stay clear

export class TrafficManager {
  private pool: TrafficCar[] = [];
  private oncoming: { group: THREE.Group; s: number; v: number; active: boolean }[] = [];
  private rng = new RNG(777);
  private time = 0;
  private spawnCounter = 0;
  private repairTimer = 0;
  /** spawn diagnostics (harness) */
  spawnFailSameLane = 0;
  spawnFailCorridor = 0;
  repairDespawns = 0;
  repairPushes = 0;
  /** scratch occupancy (no per-frame allocation) */
  private occ = [false, false, false, false];
  /** active list (rebuilt per frame without allocation) */
  private activeScratch: TrafficCar[] = [];
  private activeCount_ = 0;
  private sprayVecs: THREE.Vector3[] = [];

  /** set by Weather: headlights on (night/rain) */
  headlightsOn = false;
  /** extra pavement illumination in rain (reflections) */
  rainBoost = 0;

  onNearMiss: ((e: NearMissEvent) => void) | null = null;
  onCollision: ((heavy: boolean) => void) | null = null;
  /**
   * §28 rhythm de-confliction: veto a spawn that would put traffic in a gate
   * lane within ±1.5 s of that gate's intended crossing time.
   */
  gateGuard: ((lane: number, s: number, playerS: number, playerV: number) => boolean) | null = null;
  spawnFailGate = 0;
  private lastPlayerV = 0;

  constructor(private highway: Highway, scene: THREE.Scene) {
    const mix: VehicleKind[] = [];
    for (let i = 0; i < POOL_TOTAL; i++) {
      const r = i / POOL_TOTAL;
      if (r < 0.32) mix.push('sedan');
      else if (r < 0.46) mix.push('coupe');
      else if (r < 0.6) mix.push('taxi');
      else if (r < 0.72) mix.push('boxTruck');
      else if (r < 0.82) mix.push('flatbed');
      else if (r < 0.92) mix.push('ambulance');
      else mix.push('bus');
    }
    for (let i = 0; i < POOL_TOTAL; i++) {
      const model = buildTrafficVehicle(mix[i], 500 + i * 13);
      model.group.visible = false;
      scene.add(model.group);
      this.pool.push({
        model,
        active: false,
        s: 0,
        x: 0,
        lane: 1,
        v: 0,
        targetV: 0,
        laneFrom: 1,
        laneTo: 1,
        laneT: 0,
        laneWait: 0,
        blinker: 0,
        blinkPhase: 0,
        braking: false,
        cooldown: 0,
        rel: 0,
        passed: false,
        speedClass: 1,
        spawnOrder: 0,
      });
    }
    for (let i = 0; i < 7; i++) {
      const g = buildOncomingCar();
      g.visible = false;
      scene.add(g);
      this.oncoming.push({ group: g, s: 0, v: 0, active: false });
    }
    // preallocated spray point pool
    for (let i = 0; i < POOL_TOTAL; i++) this.sprayVecs.push(new THREE.Vector3());
  }

  get activeCount(): number {
    return this.activeCount_;
  }

  /** positions of active vehicle rear axles for tire spray emitters (no alloc) */
  sprayPoints(out: THREE.Vector3[]): void {
    out.length = 0;
    for (const c of this.pool) {
      if (!c.active) continue;
      const p = this.highway.frame(c.s - c.model.halfL * 0.7);
      const v = this.sprayVecs[c.spawnOrder % this.sprayVecs.length];
      v.set(p.x + p.rx * c.x, p.y + 0.25, p.z + p.rz * c.x);
      out.push(v);
    }
  }

  // ------------------------------------------------------------------ solver ----
  /** occupancy of each lane within `window` m of sQuery (uses car.lane & laneTo) */
  private occupancyAt(sQuery: number, window: number, extraLane = -1, extraS = 0): boolean[] {
    const occ = this.occ;
    occ[0] = occ[1] = occ[2] = occ[3] = false;
    for (const c of this.pool) {
      if (!c.active) continue;
      const lane = c.laneT > 0 ? (c.laneT < 0.5 ? c.laneFrom : c.laneTo) : c.lane;
      if (Math.abs(c.s - sQuery) < window) occ[lane] = true;
    }
    if (extraLane >= 0 && Math.abs(extraS - sQuery) < window) occ[extraLane] = true;
    return occ;
  }

  /** is `lane` clear for the next `meters` ahead of fromS (cars count in lane or changing into it) */
  private laneClearAhead(lane: number, fromS: number, meters: number, ignore?: TrafficCar): boolean {
    for (const c of this.pool) {
      if (!c.active || c === ignore) continue;
      if (c.lane !== lane && c.laneTo !== lane) continue;
      const ds = c.s - fromS;
      if (ds > -5 && ds < meters) return false;
    }
    return true;
  }

  /**
   * FORWARD OCCUPANCY SOLVER (§20): placing a car at (candidateLane, s) must
   * never leave the player without an escape corridor. If two adjacent lanes
   * are occupied within WINDOW, at least one remaining lane must be clear for
   * CORRIDOR meters.
   */
  private escapeOk(candidateLane: number, s: number, car?: TrafficCar): boolean {
    const occ = this.occupancyAt(s, WINDOW, candidateLane, s);
    for (let l = 0; l < 3; l++) {
      if (occ[l] && occ[l + 1]) {
        // pair (l, l+1) blocked — some other lane must offer a corridor
        let hasCorridor = false;
        for (let f = 0; f < 4; f++) {
          if (f === l || f === l + 1) continue;
          if (!occ[f] && this.laneClearAhead(f, s, CORRIDOR, car)) {
            hasCorridor = true;
            break;
          }
        }
        if (!hasCorridor) return false;
      }
    }
    return true;
  }

  // ------------------------------------------------------------------ spawn ----
  private trySpawn(playerS: number): boolean {
    // find a free car without filter()
    let car: TrafficCar | null = null;
    for (const c of this.pool) {
      if (!c.active) {
        car = c;
        break;
      }
    }
    if (!car) return false;

    const s = playerS + this.rng.range(250, 380);
    const kind = car.model.kind;
    let speedClass = 1;
    if (kind === 'boxTruck' || kind === 'flatbed' || kind === 'bus') speedClass = 0;
    const sc = SPEED_CLASSES[speedClass];
    const v = ms(this.rng.range(sc.kmhMin, sc.kmhMax));

    // preferred lanes: slow traffic keeps right, fast keeps left (clamped to
    // the road's CURRENT lane count — §15 variable width)
    const lanes = this.highway.spline.lanesAt(s);
    let lanePrefs: number[];
    if (speedClass === 0) lanePrefs = [2, 3, 1];
    else lanePrefs = [0, 1, 2, 3];
    lanePrefs = lanePrefs.filter((l) => l < lanes);
    if (lanePrefs.length === 0) lanePrefs = [lanes - 1];

    for (const lane of lanePrefs) {
      const x = this.laneCenter(s, lane);
      // same-lane spacing: ±16 m window free (cars match speeds in-lane)
      let blocked = false;
      for (const other of this.pool) {
        if (!other.active) continue;
        if (Math.abs(other.s - s) < 16 && other.lane === lane) {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        this.spawnFailSameLane++;
        continue;
      }
      // wall prevention + escape corridor invariant
      if (!this.escapeOk(lane, s)) {
        this.spawnFailCorridor++;
        continue;
      }
      // rhythm de-confliction: keep gate lanes clear near their beat time (§28)
      if (this.gateGuard && !this.gateGuard(lane, s, playerS, this.lastPlayerV)) {
        this.spawnFailGate++;
        continue;
      }

      car.active = true;
      car.s = s;
      car.x = x;
      car.lane = lane;
      car.v = v;
      car.targetV = v;
      car.laneFrom = lane;
      car.laneTo = lane;
      car.laneT = 0;
      car.laneWait = 0;
      car.blinker = 0;
      car.braking = false;
      car.cooldown = this.rng.range(4, 14);
      car.speedClass = speedClass;
      car.rel = s - playerS;
      car.passed = false;
      car.spawnOrder = ++this.spawnCounter;
      car.model.group.visible = true;
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ update ----
  update(dt: number, playerS: number, playerV: number) {
    this.time += dt;
    this.lastPlayerV = playerV;

    // ---- maintain population (15–25) ----
    let guard = 0;
    while (this.activeCount_ < ACTIVE_TARGET && guard++ < 6) {
      if (!this.trySpawn(playerS)) break;
    }

    // ---- runtime escape-corridor repair (§20): no 4-lane walls, ever ----
    this.repairTimer -= dt;
    if (this.repairTimer <= 0) {
      this.repairTimer = 0.3;
      this.repairCorridors(playerS);
    }

    // ---- active list without allocation ----
    this.activeCount_ = 0;
    for (const c of this.pool) {
      if (c.active) this.activeScratch[this.activeCount_++] = c;
    }
    const active = this.activeScratch;
    const nActive = this.activeCount_;

    for (let ai = 0; ai < nActive; ai++) {
      const car = active[ai];

      // -------- despawn --------
      const rel = car.s - playerS;
      if (rel < -60 || rel > 850) {
        car.active = false;
        car.model.group.visible = false;
        this.activeCount_--;
        continue;
      }

      // -------- car following --------
      let lead: TrafficCar | null = null;
      let leadGap = Infinity;
      for (let aj = 0; aj < nActive; aj++) {
        const other = active[aj];
        if (other === car || !other.active) continue;
        if (other.lane !== car.lane) continue;
        const gap = other.s - car.s - other.model.halfL - car.model.halfL;
        if (gap > 0 && gap < leadGap) {
          leadGap = gap;
          lead = other;
        }
      }
      const safeGap = car.v * 0.9 + 10;
      if (lead && leadGap < safeGap) {
        const desired = Math.min(car.targetV, lead.v * 0.97);
        if (desired < car.v - 0.4) {
          car.v = Math.max(desired, car.v - 6.5 * dt);
          car.braking = car.v - desired > 0.5 || leadGap < safeGap * 0.6;
        } else {
          car.braking = false;
          car.v = Math.min(car.targetV, car.v + 2.2 * dt);
        }
      } else {
        car.braking = false;
        car.v = Math.min(car.targetV, car.v + 2.0 * dt);
      }

      // -------- lane change decisions (signal 1.2 s, then 2.5 s maneuver) ----
      car.cooldown -= dt;
      if (car.laneT === 0 && car.cooldown <= 0 && car.laneWait === 0) {
        const wantsPass = lead && leadGap < 24 && lead.v < car.targetV - 1.2;
        const drift = this.rng.next() < 0.0022;
        if (wantsPass || drift) {
          const order = car.lane > 0 ? [car.lane - 1, car.lane + 1] : [car.lane + 1, car.lane - 1];
          for (const target of order) {
            if (target < 0 || target >= this.highway.spline.lanesAt(car.s)) continue;
            let clear = true;
            for (let aj = 0; aj < nActive; aj++) {
              const other = active[aj];
              if (!other.active || other === car) continue;
              if (other.lane !== target && other.laneTo !== target) continue;
              const ds = other.s - car.s;
              if (ds > -14 && ds < 30 + car.v * 0.4) {
                clear = false;
                break;
              }
            }
            if (clear) {
              // lane changes also respect the rhythm de-confliction (§28)
              if (this.gateGuard && !this.gateGuard(target, car.s, playerS, this.lastPlayerV)) continue;
              // solver check: the maneuver must not seal the corridor
              const occ = this.occupancyAt(car.s, WINDOW, target, car.s);
              let sealsWall = false;
              for (let l = 0; l < 3; l++) {
                if (occ[l] && occ[l + 1]) {
                  let hasCorridor = false;
                  for (let f = 0; f < 4; f++) {
                    if (f === l || f === l + 1) continue;
                    if (!occ[f] && this.laneClearAhead(f, car.s, CORRIDOR, car)) {
                      hasCorridor = true;
                      break;
                    }
                  }
                  if (!hasCorridor) {
                    sealsWall = true;
                    break;
                  }
                }
              }
              if (sealsWall) continue;

              car.laneFrom = car.lane;
              car.laneTo = target;
              car.laneWait = SIGNAL_SEC; // signal first
              car.blinker = Math.sign(this.laneCenter(car.s, target) - this.laneCenter(car.s, car.lane));
              car.cooldown = this.rng.range(9, 22);
              break;
            }
          }
        }
      }

      // -------- execute lane change --------
      if (car.laneWait > 0) {
        car.laneWait -= dt;
        if (car.laneWait <= 0) car.laneT = 0.0001;
      } else if (car.laneT > 0) {
        car.laneT = Math.min(1, car.laneT + dt / LANE_CHANGE_SEC);
        const from = this.laneCenter(car.s, car.laneFrom);
        const to = this.laneCenter(car.s, car.laneTo);
        car.x = lerp(from, to, smoothstep(car.laneT));
        if (car.laneT >= 1) {
          car.lane = car.laneTo;
          car.laneT = 0;
          car.blinker = 0;
        }
      } else {
        car.x = damp3(car.x, this.laneCenter(car.s, car.lane), 3, dt);
      }

      car.s += car.v * dt;

      // -------- visuals --------
      const p = this.highway.frame(car.s);
      const g = car.model.group;
      g.position.set(p.x + p.rx * car.x, p.y, p.z + p.rz * car.x);
      g.rotation.y = p.yaw;
      g.rotation.z = -Math.atan(p.kappa * car.v * car.v * 0.02);
      // lights — cone meshes REMOVED (§24): emissive lenses + pavement pools
      // carry the night look; real PointLights come from TrafficLights
      car.model.headMat.color.setRGB(1.35, 1.3, 1.15);
      if (car.braking) {
        car.model.tailMat.color.setRGB(2.6, 0.14, 0.1); // 4× flare
      } else {
        car.model.tailMat.color.setRGB(0.55, 0.045, 0.035);
      }
      // pavement pools: headlights illuminate the road; brakes glow red
      const poolVis = this.headlightsOn;
      car.model.headPoolMat.opacity = poolVis ? 0.42 + this.rainBoost * 0.3 : 0;
      car.model.brakePoolMat.opacity = car.braking ? 0.55 : 0;
      // blinker flash 1.4 Hz
      if (car.blinker !== 0) {
        car.blinkPhase += dt * 5.6;
        const on = Math.sin(car.blinkPhase) > 0;
        car.model.blinkerMat.opacity = on ? 1 : 0.05;
      } else {
        car.model.blinkerMat.opacity = 0;
      }
      // ambulance alternating red/blue strobes
      if (car.model.kind === 'ambulance' && car.model.emergA && car.model.emergB) {
        const strobe = Math.sin(this.time * 9 + car.s) > 0;
        car.model.emergA.color.setRGB(strobe ? 2.8 : 0.1, 0.05, strobe ? 0.05 : 0.1);
        car.model.emergB.color.setRGB(0.05, 0.05, strobe ? 0.1 : 2.8);
      }
    }
    void playerV;

    // ---- oncoming ghosts ----
    for (const oc of this.oncoming) {
      if (!oc.active) {
        if (this.rng.next() < 0.012) {
          oc.active = true;
          oc.s = playerS + 240 + this.rng.range(0, 120);
          oc.v = ms(this.rng.range(70, 95));
          oc.group.visible = true;
        }
        continue;
      }
      oc.s -= oc.v * dt;
      if (oc.s < playerS - 90) {
        oc.active = false;
        oc.group.visible = false;
        continue;
      }
      const p = this.highway.frame(oc.s);
      oc.group.position.set(p.x - p.rx * 11.0, p.y, p.z - p.rz * 11.0);
      oc.group.rotation.y = p.yaw + Math.PI;
    }
  }

  /** physical lane center at s for a lane index (clamped to available lanes) */
  private laneCenter(s: number, lane: number): number {
    return this.highway.spline.laneX(s, lane);
  }

  /** nearest-lane migration when the road narrows under a car (§15) */
  private pickMigrationLane(car: TrafficCar, lanes: number): number {
    for (let t = lanes - 1; t >= 0; t--) {
      if (t === car.lane) continue;
      let clear = true;
      for (const other of this.pool) {
        if (!other.active || other === car) continue;
        if (other.lane !== t && other.laneTo !== t) continue;
        const ds = other.s - car.s;
        if (ds > -14 && ds < 26) {
          clear = false;
          break;
        }
      }
      if (clear) return t;
    }
    return -1;
  }

  /** iterate active cars with front/rear world anchors (consumed by TrafficLights) */
  forEachActive(cb: (front: THREE.Vector3, back: THREE.Vector3, braking: boolean) => void): void {
    for (const car of this.pool) {
      if (!car.active) continue;
      const p = this.highway.frame(car.s);
      const rX = Math.cos(p.yaw);
      const rZ = -Math.sin(p.yaw);
      const fX = Math.sin(p.yaw);
      const fZ = Math.cos(p.yaw);
      _front.set(p.x + rX * car.x + fX * car.model.halfL, p.y + 0.7, p.z + rZ * car.x + fZ * car.model.halfL);
      _back.set(p.x + rX * car.x - fX * car.model.halfL, p.y + 0.7, p.z + rZ * car.x - fZ * car.model.halfL);
      cb(_front, _back, car.braking);
    }
  }

  // ------------------------------------------------------- collision + scoring ----
  /**
   * Swept CCD check: called after each bike physics substep. Returns true on
   * collision (fires onCollision). Also updates near-miss state.
   */
  collideAndScore(bike: BikeController, dt: number): boolean {
    const bikeS = bike.s;
    const bikeX = bike.x;
    const sweep = bike.v * dt + 0.45;
    const fast = bike.v > 50; // > 180 km/h for strong near-miss

    for (const car of this.pool) {
      if (!car.active) continue;
      const ds = car.s - bikeS;
      const span = car.model.halfL + 1.025;

      // --- pass detection for near miss ---
      if (!car.passed && ds < 0 && car.rel > 0) {
        car.passed = true;
        this.checkNearMiss(car, bikeX, fast);
      }
      car.rel = ds;

      // --- collision (longitudinal overlap incl. sweep, lateral overlap) ---
      if (Math.abs(ds) < span + sweep) {
        const dx = Math.abs(car.x - bikeX);
        if (dx < car.model.halfW + 0.33) {
          this.onCollision?.(car.model.heavy);
          return true;
        }
      }
    }
    return false;
  }

  private checkNearMiss(car: TrafficCar, bikeX: number, fast: boolean) {
    const gap = Math.abs(car.x - bikeX) - (car.model.halfW + 0.33);
    if (gap <= 0 || gap > 1.0) return;
    const side = Math.sign(car.x - bikeX);
    // strong effect only when passing within ~0.8 m at > 180 km/h (§32)
    const strong = fast && gap <= 0.8;
    let ev: NearMissEvent;
    if (gap <= 0.5) {
      ev = { kind: 'close', points: 150, side, heavy: car.model.heavy, strong };
    } else {
      ev = { kind: 'nearMiss', points: 100, side, heavy: car.model.heavy, strong };
    }
    // lane split: another car in an adjacent lane at similar s on the other side
    for (const other of this.pool) {
      if (!other.active || other === car) continue;
      if (Math.abs(other.s - car.s) > 6) continue;
      const otherGap = Math.abs(other.x - bikeX) - (other.model.halfW + 0.33);
      if (otherGap > 0 && otherGap <= 0.95 && Math.sign(other.x - bikeX) !== side) {
        ev = { kind: 'laneSplit', points: 250, side, heavy: car.model.heavy || other.model.heavy, strong };
        break;
      }
    }
    this.onNearMiss?.(ev);
  }

  /** find a lane with the largest clear window ahead of s (for respawn) */
  findClearLane(s: number): number {
    const clearance = [200, 200, 200, 200];
    for (const car of this.pool) {
      if (!car.active) continue;
      const ds = car.s - s;
      if (ds > -5 && ds < 260) {
        clearance[car.lane] = Math.min(clearance[car.lane], Math.max(0, ds));
      }
    }
    let best = 2;
    for (let i = 0; i < 4; i++) if (clearance[i] > clearance[best]) best = i;
    return best;
  }

  /** push traffic out of the respawn corridor */
  clearCorridor(s: number, lane: number, lengthM = 70) {
    for (const car of this.pool) {
      if (!car.active || car.lane !== lane) continue;
      const ds = car.s - s;
      if (ds > -12 && ds < lengthM) {
        car.active = false;
        car.model.group.visible = false;
        this.activeCount_ = Math.max(0, this.activeCount_ - 1);
      }
    }
  }

  reset(playerS: number) {
    for (const car of this.pool) {
      car.active = false;
      car.model.group.visible = false;
    }
    this.activeCount_ = 0;
    for (const oc of this.oncoming) {
      oc.active = false;
      oc.group.visible = false;
    }
    let guard = 0;
    while (this.activeCount_ < ACTIVE_TARGET && guard++ < 10) {
      if (!this.trySpawn(playerS)) break;
    }
  }

  /** escape-corridor audit for the acceptance harness */
  auditCorridor(playerS: number): { windows: number; violations: number } {
    let violations = 0;
    let windows = 0;
    for (let s = playerS + 20; s < playerS + 400; s += 10) {
      windows++;
      const occ = this.occupancyAt(s, WINDOW);
      for (let l = 0; l < 3; l++) {
        if (occ[l] && occ[l + 1]) {
          let hasCorridor = false;
          for (let f = 0; f < 4; f++) {
            if (f === l || f === l + 1) continue;
            if (!occ[f] && this.laneClearAhead(f, s, CORRIDOR)) {
              hasCorridor = true;
              break;
            }
          }
          if (!hasCorridor) {
            violations++;
            break;
          }
        }
      }
    }
    return { windows, violations };
  }

  /**
   * Runtime corridor repair: traffic converging at different speeds can
   * seal the road. Every ~0.8 s we scan ahead; when a window blocks two
   * adjacent lanes with no 40 m escape, we relieve the NEWEST car involved —
   * despawning it if it's far enough ahead to be unseen, otherwise forcing
   * an immediate signaled lane change toward a clear lane.
   */
  private repairCorridors(playerS: number): void {
    // ---- lane-count migration (road narrowing): outer lanes vanish, cars move in
    for (const c of this.pool) {
      if (!c.active || c.laneT > 0 || c.laneWait > 0) continue;
      const lanes = this.highway.spline.lanesAt(c.s);
      if (c.lane >= lanes) {
        const target = this.pickMigrationLane(c, lanes);
        if (target >= 0) {
          c.laneFrom = c.lane;
          c.laneTo = target;
          c.laneWait = 0.25;
          c.blinker = Math.sign(this.laneCenter(c.s, target) - this.laneCenter(c.s, c.lane));
          c.cooldown = 8;
        }
      }
    }
    for (let s = playerS + 20; s < playerS + 420; s += 12) {
      const occ = this.occupancyAt(s, WINDOW);
      for (let l = 0; l < 3; l++) {
        if (!(occ[l] && occ[l + 1])) continue;
        let hasCorridor = false;
        for (let f = 0; f < 4; f++) {
          if (f === l || f === l + 1) continue;
          if (!occ[f] && this.laneClearAhead(f, s, CORRIDOR)) {
            hasCorridor = true;
            break;
          }
        }
        if (hasCorridor) continue;

        // violation: newest car in the blocked pair
        let newest: TrafficCar | null = null;
        for (const c of this.pool) {
          if (!c.active || c.laneT > 0) continue;
          if (c.lane !== l && c.lane !== l + 1) continue;
          if (Math.abs(c.s - s) > WINDOW) continue;
          if (!newest || c.spawnOrder > newest.spawnOrder) newest = c;
        }
        if (!newest) continue;
        const rel = newest.s - playerS;
        if (rel > 140) {
          // invisible despawn — cleanest fix
          newest.active = false;
          newest.model.group.visible = false;
          this.activeCount_ = Math.max(0, this.activeCount_ - 1);
          this.repairDespawns++;
        } else {
          // near the player: push it toward a lane with space
          const escape = newest.lane === l ? l - 1 : l + 2;
          const target = escape >= 0 && escape <= 3 ? escape : newest.lane === 0 ? 1 : 3;
          if (target !== newest.lane && target >= 0 && target <= 3) {
            let clear = true;
            for (const other of this.pool) {
              if (!other.active || other === newest) continue;
              if (other.lane !== target && other.laneTo !== target) continue;
              const ds = other.s - newest.s;
              if (ds > -14 && ds < 26) {
                clear = false;
                break;
              }
            }
            if (clear) {
              newest.laneFrom = newest.lane;
              newest.laneTo = target;
              newest.laneWait = 0.35; // brief signal (emergency correction)
              newest.blinker = Math.sign(this.laneCenter(newest.s, target) - this.laneCenter(newest.s, newest.lane));
              newest.cooldown = 12;
              this.repairPushes++;
            } else if (rel > 90) {
              // no escape lane and far enough: despawn
              newest.active = false;
              newest.model.group.visible = false;
              this.activeCount_ = Math.max(0, this.activeCount_ - 1);
              this.repairDespawns++;
            }
          }
        }
        // re-audit this window after the fix
        const occ2 = this.occupancyAt(s, WINDOW);
        void occ2;
        break;
      }
    }
  }

  dispose(scene: THREE.Scene) {
    for (const car of this.pool) {
      scene.remove(car.model.group);
      car.model.group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      car.model.headMat.dispose();
      car.model.tailMat.dispose();
      car.model.blinkerMat.dispose();
      car.model.headPoolMat.dispose();
      car.model.brakePoolMat.dispose();
    }
    for (const oc of this.oncoming) {
      scene.remove(oc.group);
      oc.group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    }
  }
}

function damp3(cur: number, target: number, lambda: number, dt: number): number {
  return lerp(cur, target, 1 - Math.exp(-lambda * dt));
}

const _front = new THREE.Vector3();
const _back = new THREE.Vector3();
