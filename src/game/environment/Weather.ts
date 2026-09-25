/**
 * WeatherController — four cinematic presets (Deep Twilight, Starry Night with
 * Embers, Fiery Golden Hour, Wet Rainy Night) with 2.5 s smooth blending of
 * sky shader, fog, lights, bloom, wet asphalt (PMREM env reflections), lamp
 * intensity, rain streaks, ember drift and tire spray.
 */

import * as THREE from 'three';
import type { Highway } from './Highway';
import { HighwayMaterials } from './chunkBuilder';
import { softDotTexture, glowTexture } from './textures';
import { clamp, damp, lerp, RNG } from '../core/utils';
import type { TrafficManager } from '../traffic/TrafficManager';
import type { BikeController } from '../vehicle/BikeController';

export interface WeatherParams {
  name: string;
  zenith: THREE.Color;
  mid: THREE.Color;
  horizon: THREE.Color;
  sunDir: THREE.Vector3; // normalized-ish
  sunColor: THREE.Color;
  sunDisc: number;
  sunGlow: number;
  starIntensity: number;
  cloudTint: THREE.Color;
  fogColor: THREE.Color;
  fogDensity: number;
  sunLightColor: THREE.Color;
  sunLightIntensity: number;
  ambientColor: THREE.Color;
  ambientIntensity: number;
  lampCone: number;
  lampPool: number;
  windowEmissive: number;
  signEmissive: number;
  bloom: number;
  exposure: number;
  saturation: number;
  contrast: number;
  rain: number;
  wetness: number;
  embers: number;
  headlights: number; // bike spot intensity
  headlightCones: boolean;
  glare: number; // sun sprite intensity
  vignette: number;
}

const PRESETS: WeatherParams[] = [
  {
    name: 'Deep Twilight',
    zenith: new THREE.Color(0.09, 0.06, 0.28),
    mid: new THREE.Color(0.3, 0.13, 0.45),
    horizon: new THREE.Color(0.85, 0.4, 0.55),
    sunDir: new THREE.Vector3(-0.72, 0.06, 0.69),
    sunColor: new THREE.Color(1.0, 0.5, 0.42),
    sunDisc: 0.0,
    sunGlow: 0.35,
    starIntensity: 0.12,
    cloudTint: new THREE.Color(0.5, 0.3, 0.55),
    fogColor: new THREE.Color(0.13, 0.09, 0.2),
    fogDensity: 0.0011,
    sunLightColor: new THREE.Color(1.0, 0.72, 0.85),
    sunLightIntensity: 0.55,
    ambientColor: new THREE.Color(0.38, 0.32, 0.5),
    ambientIntensity: 0.5,
    lampCone: 0.1,
    lampPool: 0.3,
    windowEmissive: 1.0,
    signEmissive: 0.5,
    bloom: 0.55,
    exposure: 1.0,
    saturation: 1.05,
    contrast: 1.04,
    rain: 0,
    wetness: 0,
    embers: 0,
    headlights: 90,
    headlightCones: true,
    glare: 0.35,
    vignette: 0.55,
  },
  {
    name: 'Starry Night · Embers',
    zenith: new THREE.Color(0.008, 0.015, 0.055),
    mid: new THREE.Color(0.03, 0.05, 0.14),
    horizon: new THREE.Color(0.1, 0.14, 0.26),
    sunDir: new THREE.Vector3(0.3, 0.75, -0.59), // moon
    sunColor: new THREE.Color(0.7, 0.8, 1.0),
    sunDisc: 0.012,
    sunGlow: 0.12,
    starIntensity: 1.0,
    cloudTint: new THREE.Color(0.06, 0.08, 0.16),
    fogColor: new THREE.Color(0.02, 0.03, 0.07),
    fogDensity: 0.0012,
    sunLightColor: new THREE.Color(0.3, 0.38, 0.55),
    sunLightIntensity: 0.3,
    ambientColor: new THREE.Color(0.16, 0.2, 0.32),
    ambientIntensity: 0.62,
    lampCone: 0.15,
    lampPool: 0.44,
    windowEmissive: 1.35,
    signEmissive: 0.7,
    bloom: 0.85,
    exposure: 1.05,
    saturation: 1.1,
    contrast: 1.1,
    rain: 0,
    wetness: 0,
    embers: 0.28,
    headlights: 240,
    headlightCones: true,
    glare: 0.12,
    vignette: 0.7,
  },
  {
    name: 'Fiery Golden Hour',
    zenith: new THREE.Color(0.2, 0.1, 0.28),
    mid: new THREE.Color(0.85, 0.32, 0.16),
    horizon: new THREE.Color(1.0, 0.58, 0.22),
    sunDir: new THREE.Vector3(0.82, 0.055, 0.57),
    sunColor: new THREE.Color(1.6, 0.9, 0.45),
    sunDisc: 0.014,
    sunGlow: 0.55,
    starIntensity: 0,
    cloudTint: new THREE.Color(1.0, 0.5, 0.3),
    fogColor: new THREE.Color(0.55, 0.27, 0.18),
    fogDensity: 0.0012,
    sunLightColor: new THREE.Color(1.4, 0.85, 0.5),
    sunLightIntensity: 1.7,
    ambientColor: new THREE.Color(0.55, 0.4, 0.38),
    ambientIntensity: 0.6,
    lampCone: 0.03,
    lampPool: 0.1,
    windowEmissive: 0.5,
    signEmissive: 0.22,
    bloom: 0.58,
    exposure: 1.08,
    saturation: 1.18,
    contrast: 1.08,
    rain: 0,
    wetness: 0,
    embers: 0,
    headlights: 0,
    headlightCones: false,
    glare: 0.9,
    vignette: 0.5,
  },
  {
    name: 'Wet Rainy Night',
    zenith: new THREE.Color(0.015, 0.025, 0.04),
    mid: new THREE.Color(0.04, 0.055, 0.075),
    horizon: new THREE.Color(0.1, 0.13, 0.18),
    sunDir: new THREE.Vector3(0.1, 0.9, 0.2),
    sunColor: new THREE.Color(0.25, 0.3, 0.4),
    sunDisc: 0,
    sunGlow: 0.05,
    starIntensity: 0,
    cloudTint: new THREE.Color(0.05, 0.06, 0.08),
    fogColor: new THREE.Color(0.045, 0.055, 0.075),
    fogDensity: 0.0032,
    sunLightColor: new THREE.Color(0.35, 0.42, 0.55),
    sunLightIntensity: 0.35,
    ambientColor: new THREE.Color(0.2, 0.24, 0.32),
    ambientIntensity: 0.55,
    lampCone: 0.24,
    lampPool: 0.55,
    windowEmissive: 1.2,
    signEmissive: 0.65,
    bloom: 0.95,
    exposure: 1.02,
    saturation: 0.95,
    contrast: 1.12,
    rain: 1,
    wetness: 1,
    embers: 0,
    headlights: 320,
    headlightCones: true,
    glare: 0.0,
    vignette: 0.8,
  },
];

export class WeatherController {
  current: WeatherParams = cloneParams(PRESETS[0]);
  private target: WeatherParams = cloneParams(PRESETS[0]);
  private transitionT = 1;
  presetIndex = 0;
  autoCycle = false;
  private autoTimer = 0;

  private sky: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;
  private skyScene = new THREE.Scene();
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envRefreshTimer = 0;

  private sun: THREE.DirectionalLight;
  private ambient: THREE.AmbientLight;
  private hemi: THREE.HemisphereLight;
  private sunGlare: THREE.Sprite;

  // particles
  private rainLines: THREE.LineSegments;
  private rainPos: Float32Array;
  private rainVel: Float32Array;
  private rainCount = 700;
  private embers: THREE.Points;
  private emberPos: Float32Array;
  private emberMeta: Float32Array;
  private emberCount = 340;
  private spray: THREE.Points;
  private sprayPos: Float32Array;
  private sprayVel: Float32Array;
  private sprayLife: Float32Array;
  private sprayCount = 420;
  private sprayCursor = 0;

  private rng = new RNG(4242);
  private time = 0;
  private renderer: THREE.WebGLRenderer;
  /** PMREM env generation is expensive on weak GPUs — disabled at low quality */
  envEnabled = true;
  private detailTier: 0 | 1 | 2 = 2;
  private lowSkyColor = new THREE.Color();

  constructor(
    renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private mats: HighwayMaterials
  ) {
    this.renderer = renderer;
    scene.fog = new THREE.FogExp2(this.current.fogColor.getHex(), this.current.fogDensity);

    // ---------- sky dome ----------
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        zenith: { value: this.current.zenith.clone() },
        mid: { value: this.current.mid.clone() },
        horizon: { value: this.current.horizon.clone() },
        sunDir: { value: this.current.sunDir.clone().normalize() },
        sunColor: { value: this.current.sunColor.clone() },
        sunDisc: { value: this.current.sunDisc },
        sunGlow: { value: this.current.sunGlow },
        stars: { value: this.current.starIntensity },
        cloudTint: { value: this.current.cloudTint.clone() },
        time: { value: 0 },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying vec3 vDir;
        uniform vec3 zenith, mid, horizon, sunDir, sunColor, cloudTint;
        uniform float sunDisc, sunGlow, stars, time;
        float hash(vec3 p) {
          p = fract(p * 0.3183099 + 0.1);
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, -1.0, 1.0);
          vec3 col = mix(horizon, mid, smoothstep(-0.02, 0.28, h));
          col = mix(col, zenith, smoothstep(0.22, 0.75, h));
          // sun / moon
          float sd = dot(d, sunDir);
          float disc = smoothstep(1.0 - sunDisc * 40.0 - 0.0008, 1.0 - sunDisc * 40.0, sd);
          float glow = pow(max(sd, 0.0), 24.0) * sunGlow * 0.55 + pow(max(sd, 0.0), 350.0) * sunGlow;
          col += sunColor * (disc * 2.4 + glow);
          // stars
          if (stars > 0.001) {
            vec3 sp = d * 420.0;
            vec3 cell = floor(sp);
            vec3 f = fract(sp) - 0.5;
            float rnd = hash(cell);
            float star = smoothstep(0.993, 1.0, rnd) * (1.0 - smoothstep(0.05, 0.16, h));
            float tw = 0.6 + 0.4 * sin(time * 2.0 + rnd * 40.0);
            col += vec3(0.9, 0.95, 1.0) * star * tw * stars * smoothstep(0.08, 0.14, length(f));
          }
          // low stratus bands
          float band = sin(d.y * 26.0 + sin(d.x * 3.0 + time * 0.02) * 2.0) * 0.5 + 0.5;
          float cloudMask = smoothstep(0.02, 0.16, h) * (1.0 - smoothstep(0.2, 0.5, h));
          col = mix(col, cloudTint, cloudMask * band * 0.22);
          // horizon haze lift
          col += horizon * 0.12 * (1.0 - smoothstep(0.0, 0.14, abs(h)));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(2800, 40, 24), this.skyMat);
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    // mini sky for PMREM capture
    const mini = new THREE.Mesh(new THREE.SphereGeometry(10, 24, 16), this.skyMat);
    this.skyScene.add(mini);

    // ---------- lights ----------
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1536, 1536);
    this.sun.shadow.camera.near = 20;
    this.sun.shadow.camera.far = 400;
    this.sun.shadow.camera.left = -70;
    this.sun.shadow.camera.right = 70;
    this.sun.shadow.camera.top = 70;
    this.sun.shadow.camera.bottom = -70;
    this.sun.shadow.bias = -0.0006;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(this.ambient);
    // sky/ground bounce: gives asphalt a grazing-angle floor term so the
    // road reads as a surface, not a black void, when the sun is at the
    // horizon (N·L ≈ 0 for a flat deck)
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x101014, 0.35);
    scene.add(this.hemi);

    this.pmrem = new THREE.PMREMGenerator(renderer);

    // ---------- sun glare sprite ----------
    const glareMat = new THREE.SpriteMaterial({
      map: glowTexture(),
      color: 0xffc07a,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    this.sunGlare = new THREE.Sprite(glareMat);
    this.sunGlare.scale.set(500, 500, 1);
    this.sunGlare.frustumCulled = false;
    scene.add(this.sunGlare);

    // ---------- rain ----------
    this.rainPos = new Float32Array(this.rainCount * 6);
    this.rainVel = new Float32Array(this.rainCount * 2);
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    const rainMat = new THREE.LineBasicMaterial({
      color: 0x9fb4c8,
      transparent: true,
      opacity: 0.34,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.rainLines = new THREE.LineSegments(rainGeo, rainMat);
    this.rainLines.frustumCulled = false;
    this.rainLines.visible = false;
    scene.add(this.rainLines);

    // ---------- embers ----------
    this.emberPos = new Float32Array(this.emberCount * 3);
    this.emberMeta = new Float32Array(this.emberCount * 2); // speed, phase
    for (let i = 0; i < this.emberCount; i++) {
      this.emberPos[i * 3] = this.rng.range(-28, 28);
      this.emberPos[i * 3 + 1] = this.rng.range(0.2, 11);
      this.emberPos[i * 3 + 2] = this.rng.range(-140, 60);
      this.emberMeta[i * 2] = this.rng.range(0.4, 1.6);
      this.emberMeta[i * 2 + 1] = this.rng.range(0, Math.PI * 2);
    }
    const emberColors = new Float32Array(this.emberCount * 3);
    const emberSizes = new Float32Array(this.emberCount);
    for (let i = 0; i < this.emberCount; i++) {
      const gold = this.rng.next() < 0.5;
      if (gold) {
        emberColors[i * 3] = 1.0;
        emberColors[i * 3 + 1] = 0.65;
        emberColors[i * 3 + 2] = 0.18;
      } else {
        emberColors[i * 3] = 1.0;
        emberColors[i * 3 + 1] = 0.16;
        emberColors[i * 3 + 2] = 0.85;
      }
      emberSizes[i] = this.rng.range(0.5, 1.6);
    }
    const emberGeo = new THREE.BufferGeometry();
    emberGeo.setAttribute('position', new THREE.BufferAttribute(this.emberPos, 3));
    emberGeo.setAttribute('color', new THREE.BufferAttribute(emberColors, 3));
    const emberMat = new THREE.PointsMaterial({
      size: 0.16,
      map: softDotTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.embers = new THREE.Points(emberGeo, emberMat);
    this.embers.frustumCulled = false;
    this.embers.visible = false;
    scene.add(this.embers);
    void emberSizes;

    // ---------- tire spray ----------
    this.sprayPos = new Float32Array(this.sprayCount * 3);
    this.sprayVel = new Float32Array(this.sprayCount * 3);
    this.sprayLife = new Float32Array(this.sprayCount); // 0 dead
    const sprayGeo = new THREE.BufferGeometry();
    sprayGeo.setAttribute('position', new THREE.BufferAttribute(this.sprayPos, 3));
    sprayGeo.setAttribute('aLife', new THREE.BufferAttribute(this.sprayLife, 1));
    const sprayMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { map: { value: softDotTexture() } },
      vertexShader: `
        attribute float aLife;
        varying float vLife;
        void main() {
          vLife = aLife;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float size = (0.25 + (1.0 - aLife) * 1.5) * step(0.001, aLife);
          gl_PointSize = size * (240.0 / max(1.0, -mv.z));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform sampler2D map;
        varying float vLife;
        void main() {
          vec4 t = texture2D(map, gl_PointCoord);
          gl_FragColor = vec4(0.62, 0.68, 0.78, t.a * vLife * 0.4);
        }
      `,
    });
    this.spray = new THREE.Points(sprayGeo, sprayMat);
    this.spray.frustumCulled = false;
    scene.add(this.spray);

    this.applyAll();
    this.refreshEnv();
  }

  setPreset(index: number, instant = false) {
    index = clamp(index, 0, 3);
    this.presetIndex = index;
    this.target = cloneParams(PRESETS[index]);
    this.transitionT = instant ? 1 : 0;
    if (instant) {
      // HARD CUT (§23): visual/environmental state only — speed, RPM, lean,
      // traffic coordinates and player position are never touched here.
      this.current = cloneParams(this.target);
      this.applyAll();
      this.refreshEnv();
    }
  }

  /** beat pulse: transient ≈×1.25 on streetlight/window/sign emission for ~80 ms */
  pulse(duration = 0.08) {
    this.pulseTimer = Math.max(this.pulseTimer, duration);
  }
  private pulseTimer = 0;

  /** ember density multiplier (chorus/drop ⇒ 4.0 = +300%) */
  emberBoost = 1;
  /** forced minimum ember amount during high-energy sections */
  emberFloor = 0;
  private emberShown = -1;

  /** rain streaks render on layer 1 so the mirror camera ignores them */
  setRainLayer(camera: THREE.Camera) {
    this.rainLines.layers.set(1);
    camera.layers.enable(1);
  }

  /** adaptive quality hook */
  setShadowsEnabled(on: boolean) {
    this.sun.castShadow = on && this.current.sunLightIntensity > 0.5;
  }

  setQualityTier(tier: 0 | 1 | 2): void {
    this.detailTier = tier;
    if (tier === 0) {
      this.rainLines.visible = false;
      this.embers.visible = false;
      this.spray.visible = false;
      this.sky.visible = false;
      this.sunGlare.visible = false;
      this.lowSkyColor.copy(this.current.horizon).lerp(this.current.mid, 0.45);
      this.scene.background = this.lowSkyColor;
    } else {
      this.sky.visible = true;
      this.sunGlare.visible = true;
      this.scene.background = null;
    }
  }

  /** Disable PMREM and release its render target on weak GPUs. */
  setEnvironmentEnabled(enabled: boolean): void {
    this.envEnabled = enabled;
    if (enabled) {
      this.refreshEnv();
      return;
    }
    this.scene.environment = null;
    const old = this.envRT;
    this.envRT = null;
    old?.dispose();
  }

  get presetName(): string {
    return PRESETS[this.presetIndex].name;
  }

  get rainAmount(): number {
    return this.current.rain;
  }

  get wetness(): number {
    return this.current.wetness;
  }

  get headlightsOn(): boolean {
    return this.current.headlightCones || this.current.rain > 0.3;
  }

  /** main per-frame update */
  update(
    dt: number,
    playerPos: THREE.Vector3,
    playerForward: THREE.Vector3,
    playerVel: THREE.Vector3,
    bike: BikeController,
    traffic: TrafficManager,
    highway: Highway,
    camera: THREE.Camera
  ) {
    this.time += dt;

    // auto cycle
    if (this.autoCycle) {
      this.autoTimer += dt;
      if (this.autoTimer > 75) {
        this.autoTimer = 0;
        this.setPreset((this.presetIndex + 1) % 4);
      }
    }

    // transition blending
    if (this.transitionT < 1) {
      this.transitionT = Math.min(1, this.transitionT + dt / 2.5);
      const t = this.transitionT;
      blendParams(this.current, this.target, t);
      this.applyAll();
    }

    // ---- beat-reactive lighting pulse (§6): ≈80 ms ×1.25 on emissives ----
    // recompute bases every frame first so the pulse never accumulates
    this.mats.lampHead.color.setRGB(
      clamp(0.55 + this.current.windowEmissive * 0.45, 0, 1.6),
      clamp(0.42 + this.current.windowEmissive * 0.22, 0, 1.2),
      clamp(0.28 + this.current.windowEmissive * 0.1, 0, 0.9)
    );
    for (const w of this.mats.windows) w.emissiveIntensity = this.current.windowEmissive;
    this.mats.sign.emissiveIntensity = this.current.signEmissive;
    if (this.pulseTimer > 0) {
      this.pulseTimer = Math.max(0, this.pulseTimer - dt);
      const k = 1.25 * clamp(this.pulseTimer / 0.08, 0, 1);
      this.mats.lampHead.color.multiplyScalar(k);
      for (const w of this.mats.windows) w.emissiveIntensity *= k;
      this.mats.sign.emissiveIntensity *= k;
    }

    // ---- ember density boost in high-energy sections (+300%) ----
    if (this.emberShown < 0) this.emberShown = Math.floor(this.emberCount * 0.25);
    const emberAmt = clamp(Math.max(this.current.embers, this.emberFloor) * this.emberBoost, 0, 1);
    const emberTarget = emberAmt > 0.02 ? Math.max(12, Math.floor(this.emberCount * emberAmt)) : 0;
    if (emberTarget !== this.emberShown) {
      this.emberShown = emberTarget;
      this.embers.geometry.setDrawRange(0, emberTarget);
    }

    // sky follows camera
    this.sky.position.copy(camera.position);
    this.skyMat.uniforms.time.value = this.time;

    // sun light placement (relative to player so shadows follow)
    const sd = this.current.sunDir;
    this.sun.position.set(playerPos.x + sd.x * 180, playerPos.y + sd.y * 180, playerPos.z + sd.z * 180);
    this.sun.target.position.copy(playerPos);
    this.sun.target.updateMatrixWorld();
    this.sunGlare.position.set(playerPos.x + sd.x * 2300, playerPos.y + sd.y * 2300, playerPos.z + sd.z * 2300);
    (this.sunGlare.material as THREE.SpriteMaterial).opacity = clamp(this.current.glare, 0, 1);
    (this.sunGlare.material as THREE.SpriteMaterial).color.copy(this.current.sunColor);

    // traffic headlight cones + wet asphalt + lamp emission (cheap global tweaks)
    traffic.headlightsOn = this.headlightsOn;
    const wet = this.current.wetness;
    // wet asphalt: keep roughness believable (asphalt, not a mirror) — sharp
    // sheen comes from envMapIntensity + the light pools, not zero roughness
    this.mats.asphalt.roughness = lerp(0.93, 0.28, wet);
    this.mats.asphalt.metalness = lerp(0.02, 0.42, wet);
    this.mats.asphalt.envMapIntensity = lerp(0.25, 1.55, wet);
    this.mats.asphaltOncoming.roughness = lerp(0.95, 0.32, wet);
    this.mats.asphaltOncoming.metalness = lerp(0.0, 0.34, wet);
    this.mats.asphaltOncoming.envMapIntensity = lerp(0.2, 1.1, wet);

    // env refresh: only while the sky is transitioning, plus a rare top-up
    this.envRefreshTimer += dt;
    if (this.envRefreshTimer > 0.8 && (this.transitionT < 1 || this.envRefreshTimer > 30)) {
      this.envRefreshTimer = 0;
      this.refreshEnv();
    }

    // bike headlight
    bike.joints.headlightSpot.intensity = damp(bike.joints.headlightSpot.intensity, this.current.headlights, 3, dt);
    bike.joints.headlightSpot.visible = this.detailTier > 0 && this.current.headlights > 1;

    // -------- rain particles --------
    const rainAmt = this.current.rain;
    this.rainLines.visible = this.detailTier > 0 && rainAmt > 0.02;
    if (this.rainLines.visible) {
      this.updateRain(dt, camera, playerVel, rainAmt);
    }

    // -------- embers --------
    this.embers.visible = this.detailTier > 0 && Math.max(this.current.embers, this.emberFloor) > 0.02;
    if (this.embers.visible) {
      this.updateEmbers(dt, playerPos, playerForward);
    }

    // -------- tire spray --------
    this.spray.visible = this.detailTier > 0;
    if (this.spray.visible) this.updateSpray(dt, bike, traffic, highway, rainAmt);
  }

  private updateRain(dt: number, camera: THREE.Camera, playerVel: THREE.Vector3, amount: number) {
    const camPos = camera.position;
    // camera-space-ish wind: rain falls and streaks backward relative to motion
    const back = _rainVel.copy(playerVel).multiplyScalar(-0.75);
    const velX = back.x * 0.2;
    const velY = -21;
    const velZ = back.z * 0.2;
    const streak = 0.5 + playerVel.length() * 0.012;
    for (let i = 0; i < this.rainCount; i++) {
      let x = this.rainPos[i * 6];
      let y = this.rainPos[i * 6 + 1];
      let z = this.rainPos[i * 6 + 2];
      x += velX * dt;
      y += velY * dt;
      z += velZ * dt;
      // wrap in a 60×26×90 box around the camera
      if (y < camPos.y - 6) y += 26;
      if (y > camPos.y + 20) y -= 26;
      if (x < camPos.x - 30) x += 60;
      if (x > camPos.x + 30) x -= 60;
      if (z < camPos.z - 45) z += 90;
      if (z > camPos.z + 45) z -= 90;
      this.rainPos[i * 6] = x;
      this.rainPos[i * 6 + 1] = y;
      this.rainPos[i * 6 + 2] = z;
      // tail endpoint = velocity direction
      const vl = Math.hypot(velX, velY, velZ) + 1;
      this.rainPos[i * 6 + 3] = x - (velX / vl) * streak;
      this.rainPos[i * 6 + 4] = y - (velY / vl) * streak;
      this.rainPos[i * 6 + 5] = z - (velZ / vl) * streak;
    }
    (this.rainLines.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.rainLines.material as THREE.LineBasicMaterial).opacity = 0.3 * amount;
    // seed any zeroed drops
    for (let i = 0; i < this.rainCount; i++) {
      if (this.rainPos[i * 6] === 0 && this.rainPos[i * 6 + 1] === 0 && this.rainPos[i * 6 + 2] === 0) {
        this.rainPos[i * 6] = camPos.x + this.rng.range(-28, 28);
        this.rainPos[i * 6 + 1] = camPos.y + this.rng.range(-4, 18);
        this.rainPos[i * 6 + 2] = camPos.z + this.rng.range(-40, 40);
      }
    }
  }

  private updateEmbers(dt: number, playerPos: THREE.Vector3, playerForward: THREE.Vector3) {
    const drift = 2.2;
    for (let i = 0; i < this.emberCount; i++) {
      const spd = this.emberMeta[i * 2];
      const phase = this.emberMeta[i * 2 + 1];
      this.emberPos[i * 3] += (drift + Math.sin(this.time * 0.7 + phase) * 0.8) * spd * dt;
      this.emberPos[i * 3 + 1] += Math.sin(this.time * 1.3 + phase * 2) * 0.35 * dt + 0.05 * dt;
      this.emberPos[i * 3 + 2] += Math.cos(this.time * 0.5 + phase) * 0.5 * spd * dt;
      // wrap around player bubble (roughly aligned with travel)
      const dx = this.emberPos[i * 3] - playerPos.x;
      const dz = this.emberPos[i * 3 + 2] - playerPos.z;
      const fwd = playerForward;
      const along = dx * fwd.x + dz * fwd.z;
      const lat = dx * fwd.z - dz * fwd.x;
      if (along < -60) {
        this.emberPos[i * 3 + 2] += 200 * Math.sign(fwd.z || 1);
        this.emberPos[i * 3] += 200 * Math.sign(fwd.x || 1);
      }
      if (Math.abs(lat) > 32) {
        this.emberPos[i * 3] -= Math.sign(lat) * 0.4;
      }
      if (this.emberPos[i * 3 + 1] > 12) this.emberPos[i * 3 + 1] = 0.3;
    }
    (this.embers.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  private updateSpray(dt: number, bike: BikeController, traffic: TrafficManager, highway: Highway, rainAmt: number) {
    if (rainAmt < 0.05) {
      this.spray.visible = false;
      // kill all
      for (let i = 0; i < this.sprayCount; i++) this.sprayLife[i] = 0;
      (this.spray.geometry.attributes.aLife as THREE.BufferAttribute).needsUpdate = true;
      return;
    }
    // emit from player rear wheel
    const rate = clamp(bike.v / 30, 0, 1) * 90 * rainAmt;
    let n = Math.floor(rate * dt + (this.rng.next() < (rate * dt) % 1 ? 1 : 0));
    while (n-- > 0) this.emitSpray(bike.worldPos.x + (this.rng.next() - 0.5) * 0.5, bike.worldPos.y + 0.15, bike.worldPos.z, -bike.v * 0.3);
    // emit from traffic rear axles
    if (this.frameIdx % 2 === 0) {
      for (const p of this._sprayPts) {
        if (this.rng.next() < 0.5) this.emitSpray(p.x, p.y, p.z, -8);
      }
    }
    // integrate
    for (let i = 0; i < this.sprayCount; i++) {
      if (this.sprayLife[i] <= 0) continue;
      this.sprayLife[i] -= dt * 1.6;
      this.sprayPos[i * 3] += this.sprayVel[i * 3] * dt;
      this.sprayPos[i * 3 + 1] += this.sprayVel[i * 3 + 1] * dt;
      this.sprayPos[i * 3 + 2] += this.sprayVel[i * 3 + 2] * dt;
      this.sprayVel[i * 3 + 1] += 2.2 * dt; // mist rises slightly then
      if (this.sprayLife[i] < 0) this.sprayLife[i] = 0;
    }
    (this.spray.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.spray.geometry.attributes.aLife as THREE.BufferAttribute).needsUpdate = true;
    void highway;
    void traffic;
  }

  private _sprayPts: THREE.Vector3[] = [];
  frameIdx = 0;

  emitSpray(x: number, y: number, z: number, backVel: number) {
    const i = this.sprayCursor;
    this.sprayCursor = (this.sprayCursor + 1) % this.sprayCount;
    this.sprayPos[i * 3] = x;
    this.sprayPos[i * 3 + 1] = y;
    this.sprayPos[i * 3 + 2] = z;
    this.sprayVel[i * 3] = (this.rng.next() - 0.5) * 1.4;
    this.sprayVel[i * 3 + 1] = this.rng.range(0.5, 2.0);
    this.sprayVel[i * 3 + 2] = backVel * (0.5 + this.rng.next() * 0.5) + (this.rng.next() - 0.5);
    this.sprayLife[i] = 1;
  }

  /** traffic spray point cache (call before updateSpray) */
  cacheTrafficSpray(traffic: TrafficManager) {
    traffic.sprayPoints(this._sprayPts);
  }

  private refreshEnv() {
    if (!this.envEnabled) return;
    const old = this.envRT;
    this.envRT = this.pmrem.fromScene(this.skyScene, 0.03);
    this.scene.environment = this.envRT.texture;
    old?.dispose();
  }

  private applyAll() {
    const c = this.current;
    const u = this.skyMat.uniforms;
    (u.zenith.value as THREE.Color).copy(c.zenith);
    (u.mid.value as THREE.Color).copy(c.mid);
    (u.horizon.value as THREE.Color).copy(c.horizon);
    (u.sunDir.value as THREE.Vector3).copy(c.sunDir).normalize();
    (u.sunColor.value as THREE.Color).copy(c.sunColor);
    u.sunDisc.value = c.sunDisc;
    u.sunGlow.value = c.sunGlow;
    u.stars.value = c.starIntensity;
    (u.cloudTint.value as THREE.Color).copy(c.cloudTint);
    if (this.detailTier === 0) {
      this.lowSkyColor.copy(c.horizon).lerp(c.mid, 0.45);
      this.scene.background = this.lowSkyColor;
    }

    const scene = this.scene;
    if (scene.fog instanceof THREE.FogExp2) {
      scene.fog.color.copy(c.fogColor);
      scene.fog.density = c.fogDensity;
    }

    this.sun.color.copy(c.sunLightColor);
    // Grazing-angle compensation: when the sun sits near the horizon (dusk /
    // golden hour) a flat asphalt deck has N·L ≈ 0 and renders black. Blend
    // the directional intensity toward a floor term as elevation drops so the
    // road keeps a readable base level at every preset.
    const sunElev = clamp(c.sunDir.y, 0, 1);
    const grazingFloor = (1 - clamp(sunElev / 0.3, 0, 1)) * 0.5;
    this.sun.intensity = c.sunLightIntensity + grazingFloor;
    this.ambient.color.copy(c.ambientColor);
    this.ambient.intensity = c.ambientIntensity;
    // hemisphere sky/ground bounce tracks the ambient, scaled by sun height
    // (deep night leans on lamp pools + headlight instead of fake moonlight)
    this.hemi.color.copy(c.zenith).multiplyScalar(1.6);
    this.hemi.groundColor.copy(c.ambientColor).multiplyScalar(0.3);
    this.hemi.intensity = c.ambientIntensity * (0.35 + 0.65 * clamp(sunElev / 0.3, 0, 1)) * 0.5;
    this.sun.castShadow = c.sunLightIntensity > 0.5;

    // shared highway materials
    this.mats.lampCone.opacity = c.lampCone;
    this.mats.lampPool.opacity = c.lampPool * 1.7;
    this.mats.lampHead.color.setRGB(
      clamp(0.55 + c.windowEmissive * 0.45, 0, 1.6),
      clamp(0.42 + c.windowEmissive * 0.22, 0, 1.2),
      clamp(0.28 + c.windowEmissive * 0.1, 0, 0.9)
    );
    for (const w of this.mats.windows) w.emissiveIntensity = c.windowEmissive;
    this.mats.sign.emissiveIntensity = c.signEmissive;
    this.mats.concrete.color.setScalar(lerp(0.74, 0.4, clamp(c.fogDensity / 0.003, 0, 1)));
  }

  /** params consumed by PostFX each frame */
  postState() {
    return {
      bloom: this.current.bloom,
      exposure: this.current.exposure,
      saturation: this.current.saturation,
      contrast: this.current.contrast,
      rain: this.current.rain,
      vignette: this.current.vignette,
    };
  }

  dispose() {
    this.sky.geometry.dispose();
    this.skyMat.dispose();
    this.rainLines.geometry.dispose();
    (this.rainLines.material as THREE.Material).dispose();
    this.embers.geometry.dispose();
    (this.embers.material as THREE.Material).dispose();
    this.spray.geometry.dispose();
    (this.spray.material as THREE.Material).dispose();
    (this.sunGlare.material as THREE.Material).dispose();
    this.envRT?.dispose();
    this.pmrem.dispose();
  }
}

const _rainVel = new THREE.Vector3();

function cloneParams(p: WeatherParams): WeatherParams {
  return {
    ...p,
    zenith: p.zenith.clone(),
    mid: p.mid.clone(),
    horizon: p.horizon.clone(),
    sunDir: p.sunDir.clone(),
    sunColor: p.sunColor.clone(),
    cloudTint: p.cloudTint.clone(),
    fogColor: p.fogColor.clone(),
    sunLightColor: p.sunLightColor.clone(),
    ambientColor: p.ambientColor.clone(),
  };
}

function blendParams(cur: WeatherParams, target: WeatherParams, t: number) {
  const e = t * t * (3 - 2 * t);
  cur.zenith.lerp(target.zenith, e);
  cur.mid.lerp(target.mid, e);
  cur.horizon.lerp(target.horizon, e);
  cur.sunDir.lerp(target.sunDir, e);
  cur.sunColor.lerp(target.sunColor, e);
  cur.cloudTint.lerp(target.cloudTint, e);
  cur.fogColor.lerp(target.fogColor, e);
  cur.sunLightColor.lerp(target.sunLightColor, e);
  cur.ambientColor.lerp(target.ambientColor, e);
  cur.sunDisc = lerp(cur.sunDisc, target.sunDisc, e);
  cur.sunGlow = lerp(cur.sunGlow, target.sunGlow, e);
  cur.starIntensity = lerp(cur.starIntensity, target.starIntensity, e);
  cur.fogDensity = lerp(cur.fogDensity, target.fogDensity, e);
  cur.sunLightIntensity = lerp(cur.sunLightIntensity, target.sunLightIntensity, e);
  cur.ambientIntensity = lerp(cur.ambientIntensity, target.ambientIntensity, e);
  cur.lampCone = lerp(cur.lampCone, target.lampCone, e);
  cur.lampPool = lerp(cur.lampPool, target.lampPool, e);
  cur.windowEmissive = lerp(cur.windowEmissive, target.windowEmissive, e);
  cur.signEmissive = lerp(cur.signEmissive, target.signEmissive, e);
  cur.bloom = lerp(cur.bloom, target.bloom, e);
  cur.exposure = lerp(cur.exposure, target.exposure, e);
  cur.saturation = lerp(cur.saturation, target.saturation, e);
  cur.contrast = lerp(cur.contrast, target.contrast, e);
  cur.rain = lerp(cur.rain, target.rain, e);
  cur.wetness = lerp(cur.wetness, target.wetness, e);
  cur.embers = lerp(cur.embers, target.embers, e);
  cur.headlights = lerp(cur.headlights, target.headlights, e);
  cur.headlightCones = target.headlightCones && e > 0.5 ? true : cur.headlightCones;
  if (e > 0.999) cur.headlightCones = target.headlightCones;
  cur.glare = lerp(cur.glare, target.glare, e);
  cur.vignette = lerp(cur.vignette, target.vignette, e);
}
