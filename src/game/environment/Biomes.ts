/**
 * BiomeController — four visual biomes driven by musical sections.
 *
 *   0  MIDNIGHT RAINY EXPRESSWAY   — wet city, lightning       (weather preset 3)
 *   1  SUSPENSION BRIDGE SUNSET    — towers, cables, amber sky (preset 2)
 *   2  TWILIGHT SAKURA HIGHWAY     — blossom canopies, petals  (preset 0)
 *   3  FOGGY MOUNTAIN PASS         — fog, pines, turbines      (preset 1)
 *
 * A biome switch is a HARD VISUAL CUT: weather.setPreset(i, true) touches only
 * environmental state — the player position, speed, lane, score, combo, HP,
 * the rhythm chart and the audio all continue untouched (§26).
 *
 * Scenery pools are prebuilt, parented to a tracking group that follows the
 * player along the spline; individual items recycle behind → ahead.
 */

import * as THREE from 'three';
import type { Highway } from './Highway';
import type { WeatherController } from './Weather';
import { RNG, clamp } from '../core/utils';

export const BIOME_NAMES = ['MIDNIGHT RAIN', 'BRIDGE SUNSET', 'SAKURA TWILIGHT', 'FOG MOUNTAIN'] as const;

const BIOME_PRESET = [3, 2, 0, 1]; // weather preset index per biome

interface SceneryItem {
  obj: THREE.Object3D;
  kind: 'tower' | 'pine' | 'turbine' | 'tree' | 'pylon' | 'cable';
  s: number;
  side: number;
  spin: number;
}

export class BiomeController {
  current = 0;
  private weather: WeatherController;
  private highway: Highway;
  private scene: THREE.Scene;
  private root = new THREE.Group();
  private items: SceneryItem[] = [];
  private free: SceneryItem[] = [];
  private turbines: THREE.Object3D[] = [];
  private lightningTimer = 3;
  private rng = new RNG(0xb10be);

  // shared geometries/materials
  private geoTower: THREE.BoxGeometry;
  private geoTowerTop: THREE.BoxGeometry;
  private geoPine: THREE.ConeGeometry;
  private geoTrunk: THREE.CylinderGeometry;
  private geoBlossom: THREE.IcosahedronGeometry;
  private geoPetal: THREE.PlaneGeometry;
  private geoBlade: THREE.BoxGeometry;
  private geoRidge: THREE.ConeGeometry;
  private matTower: THREE.MeshStandardMaterial;
  private matTowerLit: THREE.MeshBasicMaterial;
  private matPine: THREE.MeshStandardMaterial;
  private matTrunk: THREE.MeshStandardMaterial;
  private matBlossom: THREE.MeshStandardMaterial;
  private matBlossomLit: THREE.MeshBasicMaterial;
  private matBlade: THREE.MeshStandardMaterial;
  private matRidge: THREE.MeshStandardMaterial;
  private matPetal: THREE.MeshBasicMaterial;

  private petals: THREE.Points | null = null;
  private petalPos: Float32Array | null = null;

  constructor(scene: THREE.Scene, highway: Highway, weather: WeatherController) {
    this.scene = scene;
    this.highway = highway;
    this.weather = weather;

    // ---- shared assets ----
    this.geoTower = new THREE.BoxGeometry(1, 1, 1);
    this.geoTowerTop = new THREE.BoxGeometry(0.7, 0.5, 0.7);
    this.geoPine = new THREE.ConeGeometry(1, 1, 7);
    this.geoTrunk = new THREE.CylinderGeometry(0.16, 0.22, 1, 6);
    this.geoBlossom = new THREE.IcosahedronGeometry(1, 1);
    this.geoPetal = new THREE.PlaneGeometry(0.14, 0.14);
    this.geoBlade = new THREE.BoxGeometry(0.5, 11, 0.14);
    this.geoBlade.translate(0, 5.5, 0);
    this.geoRidge = new THREE.ConeGeometry(1, 1, 5);
    this.matTower = new THREE.MeshStandardMaterial({ color: 0x1b2030, roughness: 0.8, metalness: 0.25 });
    this.matTowerLit = new THREE.MeshBasicMaterial({ color: 0xffd28a });
    this.matPine = new THREE.MeshStandardMaterial({ color: 0x16281e, roughness: 0.95 });
    this.matTrunk = new THREE.MeshStandardMaterial({ color: 0x3a2a20, roughness: 0.95 });
    this.matBlossom = new THREE.MeshStandardMaterial({ color: 0x2a1f38, roughness: 0.9 });
    this.matBlossomLit = new THREE.MeshBasicMaterial({ color: 0xff7ad9 });
    this.matBlade = new THREE.MeshStandardMaterial({ color: 0xdde4ea, roughness: 0.6 });
    this.matRidge = new THREE.MeshStandardMaterial({ color: 0x2b3340, roughness: 1 });
    this.matPetal = new THREE.MeshBasicMaterial({ color: 0xff9ade, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });

    scene.add(this.root);
    this.buildPetals();
  }

  // ---------------------------------------------------------------- setup ----
  /** pre-build pooled scenery items for every biome (cheap at boot) */
  buildPools(): void {
    // city towers (biome 0)
    for (let i = 0; i < 26; i++) {
      const g = new THREE.Group();
      const h = 18 + this.rng.next() * 55;
      const w = 7 + this.rng.next() * 12;
      const body = new THREE.Mesh(this.geoTower, this.matTower);
      body.scale.set(w, h, w * (0.7 + this.rng.next() * 0.6));
      body.position.y = h / 2;
      g.add(body);
      // window strips (emissive)
      const strips = 3 + Math.floor(this.rng.next() * 4);
      for (let k = 0; k < strips; k++) {
        const strip = new THREE.Mesh(this.geoTower, this.matTowerLit);
        strip.scale.set(w * 0.82, 0.25, 0.3);
        strip.position.set(0, (h / (strips + 1)) * (k + 1), w * 0.51);
        g.add(strip);
      }
      const cap = new THREE.Mesh(this.geoTowerTop, this.matTowerLit);
      cap.position.y = h + 0.3;
      g.add(cap);
      this.root.add(g);
      const item: SceneryItem = { obj: g, kind: 'tower', s: 0, side: 1, spin: 0 };
      this.items.push(item);
      this.free.push(item);
    }
    // suspension pylons + cables (biome 1)
    for (let i = 0; i < 10; i++) {
      const g = new THREE.Group();
      const h = 34 + this.rng.next() * 10;
      const legGeo = new THREE.BoxGeometry(1.6, h, 1.6);
      for (const side of [-1, 1]) {
        const leg = new THREE.Mesh(legGeo, this.matTower);
        leg.position.set(side * 12.5, h / 2, 0);
        g.add(leg);
      }
      const cross = new THREE.Mesh(new THREE.BoxGeometry(27, 1.4, 1.4), this.matTower);
      cross.position.y = h - 2;
      g.add(cross);
      // main cables as thin boxes angled down either side of the deck
      const cableMat = new THREE.MeshBasicMaterial({ color: 0x8a4b22 });
      for (const side of [-1, 1]) {
        const cable = new THREE.Mesh(new THREE.BoxGeometry(0.16, h * 1.5, 0.16), cableMat);
        cable.position.set(side * 11.2, h * 0.45, 0);
        cable.rotation.z = side * 0.45;
        g.add(cable);
        for (let k = 1; k <= 5; k++) {
          const hanger = new THREE.Mesh(new THREE.BoxGeometry(0.06, h * 0.55, 0.06), cableMat);
          hanger.position.set(side * (11.2 - k * 2.0), h * 0.32 + k * 1.2, 0);
          g.add(hanger);
        }
      }
      this.root.add(g);
      const item: SceneryItem = { obj: g, kind: 'pylon', s: 0, side: 0, spin: 0 };
      this.items.push(item);
      this.free.push(item);
    }
    // pine + blossom trees (biomes 2/3)
    for (let i = 0; i < 16; i++) {
      const pine = new THREE.Group();
      const h = 7 + this.rng.next() * 9;
      const cone = new THREE.Mesh(this.geoPine, this.matPine);
      cone.scale.set(2.2, h, 2.2);
      cone.position.y = h / 2 + 1;
      pine.add(cone);
      const trunk = new THREE.Mesh(this.geoTrunk, this.matTrunk);
      trunk.scale.set(1, 1.6, 1);
      trunk.position.y = 0.8;
      pine.add(trunk);
      this.root.add(pine);
      const item: SceneryItem = { obj: pine, kind: 'pine', s: 0, side: 1, spin: 0 };
      this.items.push(item);
      this.free.push(item);
    }
    for (let i = 0; i < 14; i++) {
      const tree = new THREE.Group();
      const trunk = new THREE.Mesh(this.geoTrunk, this.matTrunk);
      trunk.scale.set(1.2, 2.6, 1.2);
      trunk.position.y = 1.3;
      tree.add(trunk);
      const canopy = new THREE.Mesh(this.geoBlossom, this.matBlossom);
      canopy.scale.set(2.6, 2.1, 2.6);
      canopy.position.y = 3.6;
      tree.add(canopy);
      const glow = new THREE.Mesh(this.geoBlossom, this.matBlossomLit);
      glow.scale.set(2.75, 2.2, 2.75);
      glow.position.y = 3.6;
      glow.visible = false; // lit only in sakura biome
      tree.add(glow);
      this.root.add(tree);
      const item: SceneryItem = { obj: tree, kind: 'tree', s: 0, side: 1, spin: 0 };
      (item as SceneryItem & { glow?: THREE.Mesh }).glow = glow;
      this.items.push(item);
      this.free.push(item);
    }
    // wind turbines (biome 3)
    for (let i = 0; i < 6; i++) {
      const g = new THREE.Group();
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, 26, 8), this.matBlade);
      mast.position.y = 13;
      g.add(mast);
      const hub = new THREE.Group();
      for (let b = 0; b < 3; b++) {
        const blade = new THREE.Mesh(this.geoBlade, this.matBlade);
        blade.rotation.z = (b * Math.PI * 2) / 3;
        hub.add(blade);
      }
      hub.position.set(0, 26, 0.9);
      g.add(hub);
      this.root.add(g);
      const item: SceneryItem = { obj: g, kind: 'turbine', s: 0, side: 1, spin: this.rng.range(0.5, 1.1) };
      this.turbines.push(hub);
      this.items.push(item);
      this.free.push(item);
    }
  }

  private buildPetals(): void {
    const count = 220;
    this.petalPos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.petalPos[i * 3] = this.rng.range(-24, 24);
      this.petalPos[i * 3 + 1] = this.rng.range(0.5, 10);
      this.petalPos[i * 3 + 2] = this.rng.range(-120, 40);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.petalPos, 3));
    this.petals = new THREE.Points(geo, this.matPetal);
    this.petals.frustumCulled = false;
    this.petals.visible = false;
    this.scene.add(this.petals);
  }

  // ---------------------------------------------------------------- switch ----
  setBiome(index: number, instant = true): void {
    const idx = clamp(index, 0, 3);
    if (idx === this.current && instant) return;
    this.current = idx;
    this.weather.setPreset(BIOME_PRESET[idx], true); // hard visual cut (§26)
    this.reseed(this.rng.int(1, 1e9));
  }

  /** reposition every visible item around the player for the current biome */
  private reseed(seed: number): void {
    const rng = new RNG(seed);
    for (const it of this.items) {
      it.obj.visible = false;
      this.free.push(it);
    }
    this.free.length = 0;
    const wantTowers = this.current === 0;
    const wantPylons = this.current === 1;
    const wantPines = this.current === 3;
    const wantTrees = this.current === 2;
    const wantTurbines = this.current === 3;
    const take = (kind: SceneryItem['kind']): SceneryItem | null => {
      for (let i = 0; i < this.free.length; i++) {
        if (this.free[i].kind === kind) return this.free.splice(i, 1)[0];
      }
      return null;
    };
    const place = (kind: SceneryItem['kind'], count: number, sMin: number, sMax: number, minAbs: number, maxAbs: number) => {
      for (let i = 0; i < count; i++) {
        const it = take(kind);
        if (!it) return;
        it.obj.visible = true;
        it.s = rng.range(sMin, sMax);
        const side = rng.next() < 0.5 ? -1 : 1;
        it.side = side;
        const lat = side * rng.range(minAbs, maxAbs);
        (it as SceneryItem & { lat?: number }).lat = lat;
        this.free.push(it);
      }
    };
    place('tower', wantTowers ? 24 : 0, -80, 620, 22, 70);
    place('pylon', wantPylons ? 8 : 0, -40, 600, 0, 0);
    place('pine', wantPines ? 14 : 0, -60, 620, 10, 40);
    place('tree', wantTrees ? 12 : 0, -60, 620, 8, 26);
    place('turbine', wantTurbines ? 5 : 0, 60, 620, 55, 110);

    // blossom glow visibility + petals
    for (const it of this.items) {
      const glow = (it as SceneryItem & { glow?: THREE.Mesh }).glow;
      if (glow) glow.visible = this.current === 2 && it.obj.visible;
    }
    if (this.petals) this.petals.visible = this.current === 2;
    // fog gets heavy in the mountain biome (extra punch on top of preset 1)
    const fog = this.scene.fog as THREE.FogExp2 | null;
    if (fog) {
      fog.density = this.current === 3 ? 0.006 : (this.weather as unknown as { current: { fogDensity: number } }).current.fogDensity;
    }
  }

  /** keep scenery distributed around the player; animate turbines/petals/lightning */
  update(dt: number, playerS: number, playerPos: THREE.Vector3, cameraY: number): void {
    const pt = this.highway.frame(playerS);
    this.root.position.set(pt.x, pt.y, pt.z);
    this.root.rotation.y = -pt.yaw; // items are placed in world coords via spline frames

    for (const it of this.items) {
      if (!it.obj.visible) continue;
      const rel = it.s - playerS;
      if (rel < -70) {
        // recycle to the front
        it.s += this.rng.range(600, 700);
        const side = this.rng.next() < 0.5 ? -1 : 1;
        it.side = side;
        const kindRange: Record<SceneryItem['kind'], [number, number]> = {
          tower: [22, 70],
          pine: [10, 40],
          tree: [8, 26],
          turbine: [55, 110],
          pylon: [0, 0],
          cable: [0, 0],
        };
        const [minAbs, maxAbs] = kindRange[it.kind];
        const lat = it.kind === 'pylon' ? 0 : side * this.rng.range(minAbs, maxAbs);
        (it as SceneryItem & { lat?: number }).lat = lat;
      }
      const f = this.highway.frame(it.s);
      const lat = (it as SceneryItem & { lat?: number }).lat ?? 0;
      // position in WORLD space (root is only a container; use spline frames)
      it.obj.position.set(f.x + f.rx * lat, f.y - (it.kind === 'tower' ? 14 : 2.2), f.z + f.rz * lat);
      it.obj.rotation.y = f.yaw + (it.kind === 'tower' ? this.rng.int(0, 3) : 0);
    }

    // turbines spin
    for (const t of this.turbines) t.rotation.z += dt * 1.1;

    // petals drift (sakura)
    if (this.petals && this.petalPos && this.petals.visible) {
      const pos = this.petalPos;
      for (let i = 0; i < pos.length / 3; i++) {
        pos[i * 3 + 1] -= dt * (0.7 + (i % 5) * 0.16);
        pos[i * 3] += Math.sin(this.rng.next() * 0 + i + this.petalsGTime) * dt * 0.7;
        pos[i * 3 + 2] += dt * 1.4;
        if (pos[i * 3 + 1] < 0.2) pos[i * 3 + 1] = 9.5;
        if (pos[i * 3 + 2] > 45) pos[i * 3 + 2] = -120;
        const dx = pos[i * 3] - 0;
        if (Math.abs(dx) > 26) pos[i * 3] = -Math.sign(dx) * 25;
      }
      (this.petals.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      this.petals.position.set(pt.x, pt.y + 0.5, pt.z);
      this.petalsGTime += dt;
    }

    // lightning in the rain biome
    if (this.current === 0) {
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        this.lightningTimer = 3.5 + this.rng.next() * 7;
        this.lightning = 1;
      }
    }
    if (this.lightning > 0) {
      this.lightning = Math.max(0, this.lightning - dt * 3.2);
      const flashK = this.lightning * (0.55 + 0.45 * Math.sin(this.lightning * 40));
      const amb = this.weather as unknown as { ambient?: THREE.AmbientLight };
      if (amb.ambient) amb.ambient.intensity = 0.55 + flashK * 2.4;
    }
    void cameraY;
  }

  private lightning = 0;
  private petalsGTime = 0;

  dispose(): void {
    this.scene.remove(this.root);
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    if (this.petals) {
      this.scene.remove(this.petals);
      this.petals.geometry.dispose();
    }
    for (const m of [
      this.matTower, this.matTowerLit, this.matPine, this.matTrunk, this.matBlossom,
      this.matBlossomLit, this.matBlade, this.matRidge, this.matPetal,
    ])
      m.dispose();
    for (const g of [this.geoTower, this.geoTowerTop, this.geoPine, this.geoTrunk, this.geoBlossom, this.geoPetal, this.geoBlade, this.geoRidge])
      g.dispose();
  }
}
