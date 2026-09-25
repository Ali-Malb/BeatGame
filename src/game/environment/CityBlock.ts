/**
 * CityBlock — MIDGROUND LAYER: parallel elevated expressways with live distant
 * traffic. Complements the chunk builder's roadside/horizon dressing with a
 * mid-depth band of infrastructure the player rides PAST rather than ON:
 *
 *   foreground  → mainline deck (chunkBuilder)
 *   midground   → parallel elevated expressway decks + moving traffic (THIS)
 *   horizon     → skyline composites + light ribbons (chunkBuilder)
 *
 * Design constraints:
 *  - DETERMINISTIC: which sides carry decks, deck elevation/width, pillar
 *    rhythm, lamp cadence and the traffic arrangement all derive from the cell
 *    index via hash01, so the same song/ride reproduces identically.
 *  - SHARED MATERIALS: all geometry uses the highway's HighwayMaterials
 *    palette, so the weather controller keeps styling the whole world through
 *    the same buckets (wet asphalt look, lamp glow, blink beacons).
 *  - DRAW-CALL BUDGET: each visible deck is ONE merged concrete mesh + ONE
 *    merged rail mesh + ONE additive lamp-head mesh; distant cars share two
 *    geometries. 4 visible decks ≈ +12 draw calls at tier 2.
 *  - COVERAGE MATCHES THE STREAM: the mainline streams chunks to +700 m and
 *    the road spline only extends that far, so cells beyond the generated
 *    spline stay PENDING (hidden) until the spline grows — deck segments are
 *    never clamped onto the spline end.
 *  - STAGGERED REBUILDS: at most one cell rebuild per frame (slots marked
 *    dirty are hidden until rebuilt), so rolling the 300 m window never
 *    hitches a frame on weak devices.
 *  - TIER 0 HIDES EVERYTHING: the software-renderer silhouette is untouched.
 *  - NO GAMEPLAY COUPLING: nothing here touches collision, judgment, gates or
 *    the rhythm clock; it is presentation the player rides past.
 */

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Highway } from './Highway';
import type { RoadPoint } from './roadSpline';
import { ms } from '../core/utils';

/** cheap deterministic hash → [0,1) (same convention as districts.ts) */
function hash01(n: number, salt: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35);
  x ^= x >>> 15;
  x = Math.imul(x, 0x2545f491);
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

/** length of one deck cell (m) — each cell spans ~3 chunk lengths */
const CELL = 300;
/** pooled slots: window covers ≈ −450 m … +1050 m (far slots build only once
 * the road spline has actually grown past them) */
const CELLS = 5;
/** per-cell margin the spline must cover before a cell may build */
const SPLINE_MARGIN = 40;

/** per-side plan for one cell (all derived deterministically from the index) */
interface CellSidePlan {
  active: boolean;
  side: number; // −1 left, +1 right of the mainline
  lateral: number; // signed lateral distance of deck center from mainline
  deckY: number; // deck surface height above the local mainline deck
  width: number; // parallel deck width (2–3 lanes)
  pillarCount: number;
}

interface DistantCar {
  mesh: THREE.Mesh;
  tail: THREE.Mesh;
  lat: number; // resolved lateral position on its deck
  deckY: number;
  s: number;
  v: number;
}

interface DeckCell {
  index: number;
  group: THREE.Group;
  deckMesh: THREE.Mesh | null;
  railMesh: THREE.Mesh | null;
  glowMesh: THREE.Mesh | null;
  cars: DistantCar[];
  /** index assigned but geometry not (re)built yet */
  dirty: boolean;
  /** build deferred because the spline has not grown this far yet */
  pending: boolean;
  built: boolean;
}

function planSide(cell: number, sideIdx: number): CellSidePlan {
  const side = sideIdx === 0 ? -1 : 1;
  const present = hash01(cell, 40 + sideIdx * 7) > 0.18; // ~82% of sides carry a deck
  return {
    active: present,
    side,
    lateral: side * (52 + hash01(cell, 60 + sideIdx * 13) * 42),
    deckY: 8.5 + hash01(cell, 70 + sideIdx * 17) * 9,
    width: 14 + hash01(cell, 50 + sideIdx * 11) * 8,
    pillarCount: Math.max(4, Math.floor(CELL / (26 + hash01(cell, 80 + sideIdx * 19) * 10))),
  };
}

export class CityBlock {
  private cells: DeckCell[] = [];
  private lastCenter = NaN;
  private tier: 0 | 1 | 2 = 2;
  private pt: RoadPoint;
  private carGeo: THREE.BufferGeometry;
  private carTailGeo: THREE.BufferGeometry;

  constructor(private scene: THREE.Scene, private highway: Highway) {
    this.pt = { x: 0, y: 0, z: 0, yaw: 0, rx: 1, rz: 0, kappa: 0, s: 0, slope: 0 };
    // shared distant-car geometry (one box + one tail-light bar for all cars)
    this.carGeo = new THREE.BoxGeometry(1.7, 1.15, 4.3);
    this.carGeo.translate(0, 0.75, 0); // sit on the deck surface
    this.carTailGeo = new THREE.BoxGeometry(1.55, 0.16, 0.1);
    for (let i = 0; i < CELLS; i++) {
      const group = new THREE.Group();
      group.visible = false;
      scene.add(group);
      this.cells.push({
        index: NaN, group, deckMesh: null, railMesh: null, glowMesh: null,
        cars: [], dirty: false, pending: false, built: false,
      });
    }
  }

  /** visual budget only — streaming coverage and determinism never change */
  setQualityTier(tier: 0 | 1 | 2): void {
    const wasHidden = this.tier === 0;
    this.tier = tier;
    if (tier === 0) {
      for (const cell of this.cells) cell.group.visible = false;
      return;
    }
    if (wasHidden) {
      // returning from tier 0: cells may be stale relative to the player —
      // force a full reassignment on the next update
      this.lastCenter = NaN;
      return;
    }
    for (const cell of this.cells) {
      cell.group.visible = cell.built && !cell.dirty;
    }
  }

  update(playerS: number, dt: number): void {
    if (this.tier === 0) return; // hidden entirely; nothing to stream or move
    const center = Math.round(playerS / CELL);
    if (center !== this.lastCenter) {
      this.lastCenter = center;
      for (let i = 0; i < CELLS; i++) {
        const cell = this.cells[i];
        const index = center + i - 1;
        if (cell.index !== index) {
          cell.index = index;
          cell.dirty = true;
          cell.pending = false;
          cell.group.visible = false; // stale/absent content stays hidden
        } else if (cell.built && !cell.dirty) {
          // covers the return-from-tier-0 path: intact cells become visible
          // again without waiting for their index to roll over
          cell.group.visible = true;
        }
      }
    }

    // rebuild at most ONE dirty cell per frame (staggered cost); pending cells
    // that the spline has since covered rejoin the build rotation
    const splineLen = this.highway.spline.totalLength;
    let rebuilt = false;
    let pendingCount = 0;
    for (const cell of this.cells) {
      if (!cell.dirty) continue;
      const covers = (cell.index + 1) * CELL + SPLINE_MARGIN <= splineLen;
      if (!covers) {
        cell.pending = true;
        pendingCount++;
        continue;
      }
      if (rebuilt) continue; // one per frame
      cell.pending = false;
      this.buildCell(cell);
      rebuilt = true;
    }
    // wake pending cells once the spline grows past them (checked cheaply)
    if (pendingCount > 0 && !rebuilt) {
      for (const cell of this.cells) {
        if (!cell.pending) continue;
        if ((cell.index + 1) * CELL + SPLINE_MARGIN <= splineLen) {
          cell.pending = false;
          this.buildCell(cell);
          break; // one per frame
        }
      }
    }

    this.updateTraffic(playerS, dt);
  }

  // ------------------------------------------------------------------ build ----
  private buildCell(cell: DeckCell): void {
    cell.dirty = false;
    cell.built = true;
    const s0 = cell.index * CELL;
    const plans = [planSide(cell.index, 0), planSide(cell.index, 1)];

    // drop previous meshes
    if (cell.deckMesh) { cell.group.remove(cell.deckMesh); cell.deckMesh.geometry.dispose(); cell.deckMesh = null; }
    if (cell.railMesh) { cell.group.remove(cell.railMesh); cell.railMesh.geometry.dispose(); cell.railMesh = null; }
    if (cell.glowMesh) { cell.group.remove(cell.glowMesh); cell.glowMesh.geometry.dispose(); cell.glowMesh = null; }
    for (const car of cell.cars) {
      cell.group.remove(car.mesh);
      cell.group.remove(car.tail);
    }
    cell.cars.length = 0;

    const deckGeos: THREE.BufferGeometry[] = [];
    const railGeos: THREE.BufferGeometry[] = [];
    const glowGeos: THREE.BufferGeometry[] = [];
    const mats = this.highway.mats;
    const spline = this.highway.spline;
    const pt = this.pt;
    const deckThick = 0.85;
    const sEnd = Math.min(s0 + CELL, spline.totalLength - SPLINE_MARGIN);

    for (const p of plans) {
      if (!p.active) continue;
      const halfW = p.width / 2;
      for (let s = s0; s < sEnd; s += 10) {
        spline.get(s, pt);
        const nx = Math.cos(pt.yaw); // right-normal (rx, rz) of the mainline
        const nz = -Math.sin(pt.yaw);
        const cx = pt.x + nx * p.lateral;
        const cy = pt.y + p.deckY - deckThick / 2;
        const cz = pt.z + nz * p.lateral;
        // deck slab segment (slightly long to hide seams between samples)
        const slab = new THREE.BoxGeometry(p.width, deckThick, 10.1);
        slab.rotateY(pt.yaw);
        slab.translate(cx, cy, cz);
        deckGeos.push(slab);
        // parapet rails on both edges
        for (const r of [-halfW, halfW]) {
          const rail = new THREE.BoxGeometry(0.3, 1.05, 10.1);
          rail.rotateY(pt.yaw);
          rail.translate(cx + nx * r, cy + deckThick / 2 + 0.5, cz + nz * r);
          railGeos.push(rail);
        }
        // lamp pole + head on the outer edge every 30 m
        if (Math.round(s - s0) % 30 === 0) {
          const lx = p.lateral + p.side * (halfW + 0.35);
          const pole = new THREE.BoxGeometry(0.14, 2.6, 0.14);
          pole.rotateY(pt.yaw);
          pole.translate(pt.x + nx * lx, pt.y + p.deckY + 1.3, pt.z + nz * lx);
          railGeos.push(pole);
          const head = new THREE.BoxGeometry(0.7, 0.16, 0.3);
          head.rotateY(pt.yaw);
          head.translate(pt.x + nx * lx, pt.y + p.deckY + 2.6, pt.z + nz * lx);
          glowGeos.push(head);
        }
      }
      // support pillars down to the ground plane
      for (let k = 0; k < p.pillarCount; k++) {
        const s = s0 + ((k + 0.5) / p.pillarCount) * CELL;
        if (s > sEnd) break;
        spline.get(s, pt);
        const nx = Math.cos(pt.yaw);
        const nz = -Math.sin(pt.yaw);
        const topY = pt.y + p.deckY - deckThick;
        const h = Math.max(3, topY);
        const pillar = new THREE.CylinderGeometry(1.1, 1.4, h, 8);
        pillar.translate(pt.x + nx * p.lateral, h / 2, pt.z + nz * p.lateral);
        deckGeos.push(pillar);
      }
    }

    if (deckGeos.length) {
      const merged = BufferGeometryUtils.mergeGeometries(deckGeos, false);
      for (const g of deckGeos) if (g !== merged) g.dispose();
      if (merged) {
        cell.deckMesh = new THREE.Mesh(merged, mats.concrete);
        cell.group.add(cell.deckMesh);
      }
    }
    if (railGeos.length) {
      const merged = BufferGeometryUtils.mergeGeometries(railGeos, false);
      for (const g of railGeos) if (g !== merged) g.dispose();
      if (merged) {
        cell.railMesh = new THREE.Mesh(merged, mats.railing);
        cell.group.add(cell.railMesh);
      }
    }
    if (glowGeos.length) {
      const merged = BufferGeometryUtils.mergeGeometries(glowGeos, false);
      for (const g of glowGeos) if (g !== merged) g.dispose();
      if (merged) {
        cell.glowMesh = new THREE.Mesh(merged, mats.lampHead);
        cell.group.add(cell.glowMesh);
      }
    }

    // deterministic distant traffic: one car per active deck side
    for (let k = 0; k < plans.length; k++) {
      const plan = plans[k];
      if (!plan.active) continue;
      const laneOff = (hash01(cell.index, 300 + k * 31) - 0.5) * (plan.width - 3.5);
      const mesh = new THREE.Mesh(this.carGeo, mats.darkMetal);
      const tail = new THREE.Mesh(this.carTailGeo, mats.blinkRed);
      cell.group.add(mesh, tail);
      cell.cars.push({
        mesh,
        tail,
        lat: plan.lateral + laneOff,
        deckY: plan.deckY,
        s: s0 + hash01(cell.index, 500 + k * 41) * CELL,
        v: ms(75 + hash01(cell.index, 400 + k * 37) * 40),
      });
    }

    cell.group.visible = this.tier > 0;
  }

  // ---------------------------------------------------------------- traffic ----
  private updateTraffic(playerS: number, dt: number): void {
    const spline = this.highway.spline;
    const pt = this.pt;
    const visible = this.tier > 0;
    for (const cell of this.cells) {
      if (!cell.built || cell.dirty) continue;
      for (const car of cell.cars) {
        car.s += car.v * dt;
        const rel = car.s - playerS;
        if (rel < -CELL * 1.4 || rel > CELL * 2.4) {
          car.mesh.visible = false;
          car.tail.visible = false;
          continue;
        }
        spline.get(car.s, pt);
        const nx = Math.cos(pt.yaw);
        const nz = -Math.sin(pt.yaw);
        const fwdX = Math.sin(pt.yaw);
        const fwdZ = Math.cos(pt.yaw);
        const x = pt.x + nx * car.lat;
        const y = pt.y + car.deckY;
        const z = pt.z + nz * car.lat;
        car.mesh.position.set(x, y, z);
        car.mesh.rotation.y = pt.yaw;
        car.mesh.visible = visible;
        // tail lights at the rear (−2.2 m along forward; local +Z is forward)
        car.tail.position.set(x - fwdX * 2.2, y + 0.95, z - fwdZ * 2.2);
        car.tail.rotation.y = pt.yaw;
        car.tail.visible = visible;
      }
    }
  }

  dispose(): void {
    for (const cell of this.cells) {
      this.scene.remove(cell.group);
      cell.group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    }
    this.carGeo.dispose();
    this.carTailGeo.dispose();
  }
}
