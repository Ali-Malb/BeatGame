/**
 * server/SoftwareRenderer.ts — the server-side renderer.
 *
 * This is a real renderer, not a screenshot mode: it walks the LIVE scene graph
 * the authoritative simulation already built (streamed highway chunks with all
 * their district geometry, traffic models, gate portals, the motorcycle) and
 * rasterizes it with a scanline triangle rasterizer — near-plane clipping,
 * perspective-correct depth, flat shading, exponential fog, emissive second
 * pass with additive blending. The sky is analytic.
 *
 * Surface appearance is approximated (per-material albedo + flat lighting)
 * because a CPU rasterizer has no texture sampling: geometry, world state and
 * the camera are exact, surfaces are indicative. That trade-off is what makes a
 * software renderer reach a streamable frame rate, and it is exactly why the
 * runtime reports `serverRenderer: 'software'` instead of claiming a GPU.
 *
 * Cost control: a per-frame triangle budget plus distance LOD by mesh name
 * (road markings, reflector posts and additive pools drop out first).
 */

import * as THREE from 'three';
import type { AuthoritativeSim } from './AuthoritativeSim';

export interface Surface {
  r: number;
  g: number;
  b: number;
  /** unlit (emissive/basic) — rendered in a second additive pass */
  emissive: boolean;
  /** additive strength for glow surfaces (0 = opaque) */
  glow: number;
}

/** detail buckets that vanish first at distance */
const DETAIL_SKIP_FAR = new Set(['paint', 'paintEdge', 'reflector', 'reflectorHead', 'lampPool', 'lampCone']);
const DEFAULT_BUDGET = 24000;
const NEAR = 0.35;

export class SoftwareRenderer {
  width: number;
  height: number;
  private fb: Uint8Array;
  private zbuf: Float32Array;
  private surfaces = new WeakMap<THREE.Material, Surface>();
  private view = new THREE.Matrix4();
  private tmp = new THREE.Vector3();
  private budget = DEFAULT_BUDGET;
  private halfW = 0;
  private halfH = 0;
  private triCount = 0;
  private light = new THREE.Vector3(0.35, 0.86, 0.36).normalize();
  lastStats = { tris: 0, meshes: 0, ms: 0 };

  constructor(width = 640, height = 360) {
    this.width = width;
    this.height = height;
    this.fb = new Uint8Array(width * height * 4);
    this.zbuf = new Float32Array(width * height);
    this.syncCenter();
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.fb = new Uint8Array(width * height * 4);
    this.zbuf = new Float32Array(width * height);
    this.syncCenter();
  }

  private syncCenter(): void {
    this.halfW = this.width / 2;
    this.halfH = this.height / 2;
  }

  /** approximate albedo + pass classification for every shared world material */
  registerSurfaces(mats: {
    asphalt: THREE.Material;
    asphaltOncoming: THREE.Material;
    concrete: THREE.Material;
    lampHead: THREE.Material;
    lampCone: THREE.Material;
    lampPool: THREE.Material;
    railing: THREE.Material;
    bridgePaint: THREE.Material;
    darkMetal: THREE.Material;
    sign: THREE.Material;
    windows: THREE.Material[];
    blinkRed: THREE.Material;
    blinkOrange: THREE.Material;
    paint: THREE.Material;
    paintEdge: THREE.Material;
    reflector: THREE.Material;
    reflectorHead: THREE.Material;
    containers: THREE.Material[];
    tank: THREE.Material;
    brick: THREE.Material;
    foliage: THREE.Material;
    water: THREE.Material;
  }): void {
    const set = (m: THREE.Material, s: Surface) => this.surfaces.set(m, s);
    set(mats.asphalt, { r: 0.18, g: 0.185, b: 0.195, emissive: false, glow: 0 });
    set(mats.asphaltOncoming, { r: 0.13, g: 0.135, b: 0.145, emissive: false, glow: 0 });
    set(mats.concrete, { r: 0.65, g: 0.65, b: 0.63, emissive: false, glow: 0 });
    set(mats.lampHead, { r: 1, g: 0.9, b: 0.69, emissive: true, glow: 0.9 });
    set(mats.lampCone, { r: 1, g: 0.85, b: 0.63, emissive: true, glow: 0.1 });
    set(mats.lampPool, { r: 1, g: 0.85, b: 0.63, emissive: true, glow: 0.3 });
    set(mats.railing, { r: 0.55, g: 0.58, b: 0.61, emissive: false, glow: 0 });
    set(mats.bridgePaint, { r: 0.76, g: 0.34, b: 0.12, emissive: false, glow: 0 });
    set(mats.darkMetal, { r: 0.19, g: 0.21, b: 0.23, emissive: false, glow: 0 });
    set(mats.sign, { r: 0.72, g: 0.74, b: 0.72, emissive: false, glow: 0 });
    mats.windows.forEach((m, i) =>
      set(m, { r: 0.38 + i * 0.03, g: 0.41 + i * 0.03, b: 0.47 + i * 0.03, emissive: false, glow: 0 })
    );
    set(mats.blinkRed, { r: 1, g: 0.15, b: 0.08, emissive: true, glow: 0.85 });
    set(mats.blinkOrange, { r: 1, g: 0.55, b: 0.1, emissive: true, glow: 0.85 });
    set(mats.paint, { r: 0.85, g: 0.84, b: 0.78, emissive: false, glow: 0 });
    set(mats.paintEdge, { r: 0.9, g: 0.89, b: 0.85, emissive: false, glow: 0 });
    set(mats.reflector, { r: 0.85, g: 0.85, b: 0.83, emissive: false, glow: 0 });
    set(mats.reflectorHead, { r: 1, g: 0.97, b: 0.88, emissive: true, glow: 0.7 });
    const containerColors: Surface[] = [
      { r: 0.72, g: 0.27, b: 0.18, emissive: false, glow: 0 },
      { r: 0.18, g: 0.42, b: 0.72, emissive: false, glow: 0 },
      { r: 0.25, g: 0.56, b: 0.29, emissive: false, glow: 0 },
      { r: 0.79, g: 0.54, b: 0.14, emissive: false, glow: 0 },
      { r: 0.49, g: 0.5, b: 0.53, emissive: false, glow: 0 },
    ];
    mats.containers.forEach((m, i) => set(m, containerColors[i] ?? containerColors[0]));
    set(mats.tank, { r: 0.73, g: 0.75, b: 0.77, emissive: false, glow: 0 });
    set(mats.brick, { r: 0.36, g: 0.29, b: 0.25, emissive: false, glow: 0 });
    set(mats.foliage, { r: 0.11, g: 0.2, b: 0.14, emissive: false, glow: 0 });
    set(mats.water, { r: 0.05, g: 0.1, b: 0.14, emissive: false, glow: 0 });
  }

  private surfaceFor(mat: THREE.Material): Surface {
    const known = this.surfaces.get(mat);
    if (known) return known;
    const std = mat as THREE.MeshStandardMaterial;
    const basic = mat as THREE.MeshBasicMaterial;
    const emissive = mat instanceof THREE.MeshBasicMaterial;
    const color = (basic.color ?? std.color) as THREE.Color | undefined;
    const hasMap = !!(std.map || basic.map);
    let r = color ? color.r : 1;
    let g = color ? color.g : 1;
    let b = color ? color.b : 1;
    if (hasMap && Math.abs(r - 1) < 1e-3 && Math.abs(g - 1) < 1e-3 && Math.abs(b - 1) < 1e-3) {
      r = g = b = 0.55; // mapped material with no palette entry
    }
    const opacity = typeof mat.opacity === 'number' ? mat.opacity : 1;
    const surface: Surface = { r, g, b, emissive, glow: emissive ? Math.max(0.15, Math.min(1, opacity)) : 0 };
    this.surfaces.set(mat, surface);
    return surface;
  }

  // ------------------------------------------------------------------ frame ----

  /** render one frame of the live sim; returns RGBA pixels */
  render(sim: AuthoritativeSim, budget = DEFAULT_BUDGET): Uint8Array {
    const t0 = performance.now();
    this.budget = budget;
    this.triCount = 0;
    let meshes = 0;

    const cam = sim.cam.camera;
    const scene = sim.scene;
    scene.updateMatrixWorld(true);
    this.view.copy(cam.matrixWorld).invert();

    const fovRad = (cam.fov * Math.PI) / 180;
    const focal = this.height / 2 / Math.tan(fovRad / 2);
    const fog = scene.fog as THREE.FogExp2 | null;
    const fogColor = fog ? fog.color : _defaultFog;
    const fogDensity = fog ? fog.density : 0.0025;

    this.drawSky(sim, cam, focal);
    this.zbuf.fill(Infinity);

    const emissiveQueue: { mesh: THREE.Mesh; surface: Surface }[] = [];
    for (const child of scene.children) {
      if (!child.visible) continue;
      child.traverseVisible((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!(mesh as { isMesh?: boolean }).isMesh) return;
        const geo = mesh.geometry as THREE.BufferGeometry;
        if (!geo || !geo.attributes || !geo.attributes.position) return;
        const mat = mesh.material as THREE.Material;
        if (!mat) return;
        if (mat.transparent && mat.opacity < 0.05) return;
        const surface = this.surfaceFor(mat);
        meshes++;
        if (surface.emissive) {
          emissiveQueue.push({ mesh, surface });
          return;
        }
        const dist = this.meshDistance(mesh, cam);
        if (dist > 420 && DETAIL_SKIP_FAR.has(mesh.name)) return;
        this.rasterMesh(mesh, surface, focal, fogColor, fogDensity, false);
      });
    }
    for (const item of emissiveQueue) {
      this.rasterMesh(item.mesh, item.surface, focal, fogColor, fogDensity, true);
    }

    this.lastStats = { tris: this.triCount, meshes, ms: +(performance.now() - t0).toFixed(2) };
    return this.fb;
  }

  private drawSky(sim: AuthoritativeSim, cam: THREE.PerspectiveCamera, focal: number): void {
    const W = this.width;
    const H = this.height;
    const preset = sim.weatherPreset;
    // palettes track the four client weather presets
    const palettes: number[][][] = [
      [[26, 22, 48], [92, 66, 96], [168, 108, 96]], // deep twilight
      [[6, 8, 20], [12, 16, 36], [30, 34, 58]], // starry night
      [[72, 44, 40], [214, 128, 58], [246, 196, 120]], // fiery golden hour
      [[10, 14, 20], [26, 34, 44], [54, 66, 78]], // wet rainy night
    ];
    const pal = palettes[Math.max(0, Math.min(3, preset))];
    const up = _up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const forward = _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const glowStrength = preset === 2 ? 0.9 : preset === 0 ? 0.42 : 0.16;
    const horizon = pal[2];
    const mid = pal[1];
    const zenith = pal[0];

    for (let y = 0; y < H; y++) {
      const ndc = (H / 2 - y) / focal;
      const ry = forward.y + up.y * ndc;
      const horiz = Math.hypot(forward.x + up.x * ndc, forward.z + up.z * ndc);
      const elev = Math.atan2(ry, Math.max(1e-4, horiz));
      const t = Math.max(0, Math.min(1, (elev + 0.1) / 0.85));
      const c = mix3(horizon, mid, Math.min(1, t * 1.6));
      const c2 = mix3(c, zenith, Math.pow(t, 0.7));
      const band = Math.exp(-Math.pow((elev - 0.02) / 0.075, 2)) * glowStrength;
      const r = clamp255(c2[0] + band * 46);
      const g = clamp255(c2[1] + band * 40);
      const b = clamp255(c2[2] + band * 26);
      const rowBase = y * W * 4;
      for (let x = 0; x < W; x++) {
        const i = rowBase + x * 4;
        this.fb[i] = r;
        this.fb[i + 1] = g;
        this.fb[i + 2] = b;
        this.fb[i + 3] = 255;
      }
    }
  }

  // --------------------------------------------------------------- rasterize ----

  private meshDistance(mesh: THREE.Mesh, cam: THREE.PerspectiveCamera): number {
    const geo = mesh.geometry as THREE.BufferGeometry;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const bs = geo.boundingSphere;
    if (!bs) return 0;
    this.tmp.copy(bs.center).applyMatrix4(mesh.matrixWorld);
    return this.tmp.distanceTo(cam.position) - bs.radius;
  }

  private rasterMesh(
    mesh: THREE.Mesh,
    surface: Surface,
    focal: number,
    fogColor: THREE.Color,
    fogDensity: number,
    glowPass: boolean
  ): void {
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const index = geo.index;
    const triN = index ? index.count / 3 : pos.count / 3;
    if (triN < 1) return;
    const e = mesh.matrixWorld.elements;
    const ve = this.view.elements;
    const stride = triN > this.budget / 3 ? 2 : 1;

    for (let t = 0; t < triN; t += stride) {
      if (this.triCount > this.budget) return;
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      const px0 = pos.getX(i0), py0 = pos.getY(i0), pz0 = pos.getZ(i0);
      const px1 = pos.getX(i1), py1 = pos.getY(i1), pz1 = pos.getZ(i1);
      const px2 = pos.getX(i2), py2 = pos.getY(i2), pz2 = pos.getZ(i2);
      const ax = px0 * e[0] + py0 * e[4] + pz0 * e[8] + e[12];
      const ay = px0 * e[1] + py0 * e[5] + pz0 * e[9] + e[13];
      const az = px0 * e[2] + py0 * e[6] + pz0 * e[10] + e[14];
      const bx = px1 * e[0] + py1 * e[4] + pz1 * e[8] + e[12];
      const by = px1 * e[1] + py1 * e[5] + pz1 * e[9] + e[13];
      const bz = px1 * e[2] + py1 * e[6] + pz1 * e[10] + e[14];
      const cx = px2 * e[0] + py2 * e[4] + pz2 * e[8] + e[12];
      const cy = px2 * e[1] + py2 * e[5] + pz2 * e[9] + e[13];
      const cz = px2 * e[2] + py2 * e[6] + pz2 * e[10] + e[14];

      // world-space face normal → flat lambert
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const wx = cx - ax, wy = cy - ay, wz = cz - az;
      const nx = uy * wz - uz * wy;
      const ny = uz * wx - ux * wz;
      const nz = ux * wy - uy * wx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      const lambert = Math.abs((nx * this.light.x + ny * this.light.y + nz * this.light.z) / nl);

      // camera space
      const v0x = ve[0] * ax + ve[4] * ay + ve[8] * az + ve[12];
      const v0y = ve[1] * ax + ve[5] * ay + ve[9] * az + ve[13];
      const v0z = ve[2] * ax + ve[6] * ay + ve[10] * az + ve[14];
      const v1x = ve[0] * bx + ve[4] * by + ve[8] * bz + ve[12];
      const v1y = ve[1] * bx + ve[5] * by + ve[9] * bz + ve[13];
      const v1z = ve[2] * bx + ve[6] * by + ve[10] * bz + ve[14];
      const v2x = ve[0] * cx + ve[4] * cy + ve[8] * cz + ve[12];
      const v2y = ve[1] * cx + ve[5] * cy + ve[9] * cz + ve[13];
      const v2z = ve[2] * cx + ve[6] * cy + ve[10] * cz + ve[14];
      const d0 = -v0z, d1 = -v1z, d2 = -v2z;

      if (d0 < NEAR || d1 < NEAR || d2 < NEAR) {
        const clipped = this.clipNear(
          [v0x, v0y, d0, v1x, v1y, d1, v2x, v2y, d2],
          focal
        );
        for (let k = 0; k < clipped.length; k += 3) {
          this.fillTri(clipped[k], clipped[k + 1], clipped[k + 2], surface, lambert, fogColor, fogDensity, glowPass);
          this.triCount++;
        }
        continue;
      }

      const w0 = 1 / d0, w1 = 1 / d1, w2 = 1 / d2;
      this.fillTri(
        [v0x * focal * w0 + this.halfW, this.halfH - v0y * focal * w0, d0, w0],
        [v1x * focal * w1 + this.halfW, this.halfH - v1y * focal * w1, d1, w1],
        [v2x * focal * w2 + this.halfW, this.halfH - v2y * focal * w2, d2, w2],
        surface,
        lambert,
        fogColor,
        fogDensity,
        glowPass
      );
      this.triCount++;
    }
  }

  /** clip in camera space against the near plane → flat list of screen triangles */
  private clipNear(v: number[], focal: number): number[][] {
    const out: number[][] = [];
    const inPlane: number[][] = [];
    for (let i = 0; i < 3; i++) {
      const x = v[i * 3], y = v[i * 3 + 1], d = v[i * 3 + 2];
      const nxt = (i + 1) % 3;
      const nxp = v[nxt * 3], nyp = v[nxt * 3 + 1], ndp = v[nxt * 3 + 2];
      const curIn = d >= NEAR;
      const nxtIn = ndp >= NEAR;
      if (curIn) inPlane.push([x, y, d]);
      if (curIn !== nxtIn) {
        const t = (NEAR - d) / (ndp - d);
        inPlane.push([x + (nxp - x) * t, y + (nyp - y) * t, NEAR]);
      }
    }
    if (inPlane.length < 3) return out;
    const screen = (p: number[]): number[] => {
      const w = 1 / p[2];
      return [p[0] * focal * w + this.halfW, this.halfH - p[1] * focal * w, p[2], w];
    };
    const s0 = screen(inPlane[0]);
    for (let i = 1; i + 1 < inPlane.length; i++) {
      out.push(s0, screen(inPlane[i]), screen(inPlane[i + 1]));
    }
    return out;
  }

  /** screen-space fill with perspective-correct depth, fog and glow blending */
  private fillTri(
    a: number[],
    b: number[],
    c: number[],
    surface: Surface,
    lambert: number,
    fogColor: THREE.Color,
    fogDensity: number,
    glowPass: boolean
  ): void {
    const W = this.width;
    const H = this.height;
    const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    if (minX > maxX || minY > maxY) return;
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(area) < 0.6) return;
    const inv = 1 / area;
    const fogK = 1 - Math.exp(-fogDensity * fogDensity * a[2] * a[2]);

    let kr: number;
    let kg: number;
    let kb: number;
    if (surface.emissive) {
      kr = clamp255(surface.r * 255);
      kg = clamp255(surface.g * 255);
      kb = clamp255(surface.b * 255);
    } else {
      const k = 0.42 + 0.75 * lambert;
      const keep = 1 - fogK;
      kr = clamp255((surface.r * k * keep + fogColor.r * fogK) * 255);
      kg = clamp255((surface.g * k * keep + fogColor.g * fogK) * 255);
      kb = clamp255((surface.b * k * keep + fogColor.b * fogK) * 255);
    }
    const glow = surface.glow;

    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const w0 = ((b[0] - a[0]) * (py - a[1]) - (px - a[0]) * (b[1] - a[1])) * inv;
        if (w0 < 0) continue;
        const w1 = ((px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1])) * inv;
        if (w1 < 0) continue;
        const w2 = 1 - w0 - w1;
        if (w2 < 0) continue;
        const idx = y * W + x;
        const wz = a[3] * w2 + b[3] * w1 + c[3] * w0;
        const zc = wz > 1e-6 ? 1 / wz : 1e6;
        if (zc >= this.zbuf[idx]) continue;
        if (!glowPass) this.zbuf[idx] = zc;
        const i = idx * 4;
        if (glow > 0) {
          this.fb[i] = clamp255(this.fb[i] + kr * glow);
          this.fb[i + 1] = clamp255(this.fb[i + 1] + kg * glow);
          this.fb[i + 2] = clamp255(this.fb[i + 2] + kb * glow);
        } else {
          this.fb[i] = kr;
          this.fb[i + 1] = kg;
          this.fb[i + 2] = kb;
        }
        this.fb[i + 3] = 255;
      }
    }
  }
}

const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _defaultFog = new THREE.Color(0x0a0d14);

function mix3(a: number[], b: number[], t: number): number[] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
