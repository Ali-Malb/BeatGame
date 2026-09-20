/**
 * Highway — streaming manager for road chunks + global scenery (ground plane,
 * passing elevated train). Keeps chunks alive within [playerS - 150, playerS + 700]
 * and disposes the rest, guaranteeing a pop-in-free horizon via fog culling.
 */

import * as THREE from 'three';
import { RoadSpline } from './roadSpline';
import { buildChunk, CHUNK_LEN, HighwayMaterials } from './chunkBuilder';
import { ms } from '../core/utils';

interface Chunk {
  index: number;
  group: THREE.Group;
  geometries: THREE.BufferGeometry[];
}

export class Highway {
  readonly spline = new RoadSpline(90210);
  readonly mats = new HighwayMaterials();
  private chunks = new Map<number, Chunk>();
  private scene: THREE.Scene;
  private rng = Math.random;

  // global scenery
  private ground: THREE.Mesh;
  private trainGroup: THREE.Group;
  private trainS = 0;
  private trainDir = 1;
  private trainSpeed = 0;
  private trainActive = false;
  private nextTrainAt = 300;
  private trainMat: THREE.MeshStandardMaterial;
  private trainEmissive: THREE.MeshBasicMaterial;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    // dark city ground far below
    const groundGeo = new THREE.PlaneGeometry(2400, 2400);
    groundGeo.rotateX(-Math.PI / 2);
    this.ground = new THREE.Mesh(
      groundGeo,
      new THREE.MeshBasicMaterial({ color: 0x07080a })
    );
    this.ground.position.y = 0.0;
    this.ground.frustumCulled = false;
    scene.add(this.ground);

    // elevated train (single consist that shuttles along the right-side viaduct)
    this.trainGroup = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x9aa2ab, roughness: 0.4, metalness: 0.6 });
    this.trainMat = bodyMat;
    this.trainEmissive = new THREE.MeshBasicMaterial({ color: 0xd8ecff });
    for (let c = 0; c < 3; c++) {
      const body = new THREE.Mesh(new THREE.BoxGeometry(2.9, 3.1, 19), bodyMat);
      body.position.z = c * 20.5;
      body.castShadow = false;
      this.trainGroup.add(body);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(3.1, 0.3, 19.4), bodyMat);
      roof.position.set(0, 1.7, c * 20.5);
      this.trainGroup.add(roof);
      // lit window strips
      for (const side of [-1, 1]) {
        const strip = new THREE.Mesh(new THREE.PlaneGeometry(18, 1.2), this.trainEmissive);
        strip.position.set(side * 1.46, 0.3, c * 20.5);
        strip.rotation.y = (side * Math.PI) / 2;
        this.trainGroup.add(strip);
      }
    }
    this.trainGroup.visible = false;
    scene.add(this.trainGroup);
  }

  /** ensure chunks around the player exist; drop far ones */
  update(playerS: number, dt: number) {
    const minChunk = Math.floor((playerS - 160) / CHUNK_LEN);
    const maxChunk = Math.floor((playerS + 700) / CHUNK_LEN);
    for (let i = minChunk; i <= maxChunk; i++) {
      if (!this.chunks.has(i)) {
        const { group, geometries } = buildChunk(this.spline, this.mats, i, (i * 2654435761) % 2147483647);
        this.scene.add(group);
        this.chunks.set(i, { index: i, group, geometries });
      }
    }
    for (const [idx, chunk] of this.chunks) {
      if (idx < minChunk || idx > maxChunk) {
        this.scene.remove(chunk.group);
        for (const g of chunk.geometries) g.dispose();
        this.chunks.delete(idx);
      }
    }

    // ground follows player (keeps infinite feel, no texture so no swim)
    const p = this.frame(playerS);
    this.ground.position.set(p.x, 0, p.z);

    this.updateTrain(playerS, dt);
  }

  private pt = { x: 0, y: 0, z: 0, yaw: 0, rx: 1, rz: 0, kappa: 0, s: 0, slope: 0 };
  frame(s: number) {
    this.spline.get(s, this.pt);
    return this.pt;
  }

  private updateTrain(playerS: number, dt: number) {
    if (!this.trainActive) {
      if (playerS + 350 > this.nextTrainAt) {
        this.trainActive = true;
        this.trainDir = this.rng() < 0.5 ? 1 : -1;
        this.trainSpeed = ms(this.trainDir === 1 ? 96 : 88) + this.rng() * 8;
        this.trainS = this.trainDir === 1 ? playerS + 640 : playerS + 700;
        this.nextTrainAt = playerS + 900 + this.rng() * 1400;
        this.trainGroup.visible = true;
      }
      return;
    }
    this.trainS += this.trainSpeed * dt;
    const rel = this.trainS - playerS;
    if (rel < -260 || rel > 780) {
      this.trainActive = false;
      this.trainGroup.visible = false;
      return;
    }
    const p = this.frame(this.trainS);
    const rX = Math.cos(p.yaw);
    const rZ = -Math.sin(p.yaw);
    const lat = 29.5;
    this.trainGroup.position.set(p.x + rX * lat, p.y - 1.6, p.z + rZ * lat);
    this.trainGroup.rotation.y = p.yaw + (this.trainDir === 1 ? 0 : Math.PI);
  }

  /** ambient world animation (beacons, subtle material pulses) */
  tick(time: number) {
    const blink = (Math.sin(time * 3.4) > 0.6 ? 1 : 0.08);
    this.mats.blinkRed.color.setRGB(1 * blink, 0.15 * blink, 0.08 * blink);
    const blinkO = Math.sin(time * 2.6 + 1.2) > 0.5 ? 1 : 0.1;
    this.mats.blinkOrange.color.setRGB(1 * blinkO, 0.55 * blinkO, 0.1 * blinkO);
  }

  dispose() {
    for (const [idx, chunk] of this.chunks) {
      this.scene.remove(chunk.group);
      for (const g of chunk.geometries) g.dispose();
      this.chunks.delete(idx);
    }
    this.scene.remove(this.ground);
    (this.ground.geometry as THREE.BufferGeometry).dispose();
    (this.ground.material as THREE.Material).dispose();
    this.scene.remove(this.trainGroup);
    this.trainGroup.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
      }
    });
    this.trainMat.dispose();
    this.trainEmissive.dispose();
    this.spline.dispose();
    this.mats.dispose();
  }
}
