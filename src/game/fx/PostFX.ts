/**
 * PostFX — cinematic post-processing stack:
 *  UnrealBloom → custom final pass (quadratic radial speed blur above 180 km/h,
 *  ACES assist grading, vignette, screen-space rain droplet refraction on the
 *  lens, crash flash, respawn fade) → OutputPass (ACES tone mapping + sRGB).
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uSpeedBlur: { value: 0 },
    uRain: { value: 0 },
    uTime: { value: 0 },
    uSaturation: { value: 1.0 },
    uContrast: { value: 1.0 },
    uVignette: { value: 0.6 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
    uFade: { value: 0 },
    uWindSpeed: { value: 0 },
    uChroma: { value: 0 },
    uChromaRed: { value: 0 },
    // rhythm hit wash: lane-colored chromatic ring that rolls outward from the
    // PERFECT crossing — stronger visual distinction between PERFECT and GOOD
    uHitWash: { value: 0 },
    uHitColor: { value: new THREE.Color(0.35, 0.9, 1.2) },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uSpeedBlur, uRain, uTime, uSaturation, uContrast, uVignette, uFlash, uFade, uWindSpeed, uChroma, uChromaRed, uHitWash;
    uniform vec3 uFlashColor;
    uniform vec3 uHitColor;
    varying vec2 vUv;

    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    // screen-space rain droplets: cellular blobs that refract + streak with wind
    vec2 rainDistort(vec2 uv) {
      if (uRain < 0.01) return vec2(0.0);
      vec2 grid = vec2(26.0, 15.0);
      vec2 base = uv * grid;
      vec2 cell = floor(base);
      vec2 f = fract(base);
      float rnd = hash21(cell);
      // ~35% of cells carry a droplet
      if (rnd > 0.35) return vec2(0.0);
      // droplet center drifts: sideways with wind, slightly upward at speed
      float speed = 0.02 + uWindSpeed * 0.22;
      vec2 motion = vec2(uTime * (0.012 + rnd * 0.02), -uTime * speed * (0.5 + rnd));
      vec2 c = vec2(
        fract(hash21(cell + 3.7) + motion.x),
        fract(hash21(cell + 9.1) + motion.y)
      );
      vec2 d = f - c;
      // elongate vertically with wind speed
      d.y /= (1.0 + uWindSpeed * 3.5);
      float r = 0.12 + rnd * 0.12;
      float dist = length(d);
      if (dist > r) return vec2(0.0);
      // refraction normal: push outward from droplet center
      vec2 n = normalize(d + 1e-6) * (1.0 - dist / r);
      return n * 0.045 * uRain;
    }

    void main() {
      vec2 uv = vUv;

      // rain lens refraction
      uv += rainDistort(uv);

      // radial speed blur toward the horizon (screen center)
      vec3 col;
      if (uSpeedBlur > 0.001) {
        vec2 center = vec2(0.5, 0.52);
        vec2 dir = center - uv;
        float dist = length(dir);
        float strength = uSpeedBlur * dist * dist * 0.28;
        col = texture2D(tDiffuse, uv).rgb * 0.42;
        float total = 0.42;
        for (int i = 1; i <= 7; i++) {
          float t = float(i) / 7.0;
          vec2 suv = uv + dir * strength * t;
          float w = 0.42 * (1.0 - t * 0.55);
          col += texture2D(tDiffuse, suv).rgb * w;
          total += w;
        }
        col /= total;
      } else {
        col = texture2D(tDiffuse, uv).rgb;
      }

      // wet-lens droplet brightening (catch bloom highlights)
      if (uRain > 0.01) {
        vec2 dd = rainDistort(vUv);
        col += vec3(0.05, 0.07, 0.09) * length(dd) * 18.0 * uRain;
      }

      // crash chromatic aberration (§34): red-shifted channel split
      if (uChroma > 0.001) {
        vec2 dir = (vUv - vec2(0.5, 0.48)) * uChroma * 0.012;
        float rC = texture2D(tDiffuse, vUv + dir).r;
        float bC = texture2D(tDiffuse, vUv - dir).b;
        vec3 split = vec3(rC, col.g, bC);
        col = mix(col, split, clamp(uChroma, 0.0, 1.0));
        // red wash while the crash chroma is hot
        col.r += uChromaRed * 0.12 * uChroma;
      }

      // rhythm hit wash: lane-colored chromatic ring expanding from the hit —
      // red/blue channel split rolls outward so a PERFECT reads as an event,
      // while the wash stays additive and brief enough to never mask traffic
      if (uHitWash > 0.001) {
        float hd = distance(vUv, vec2(0.5, 0.44));
        float ring = smoothstep(0.62, 0.18, hd) * (1.0 - smoothstep(0.78, 0.34, hd * 0.5 + (1.0 - uHitWash) * 0.62));
        vec2 hdir = (vUv - vec2(0.5, 0.44)) * uHitWash * 0.008;
        vec3 hsplit = vec3(texture2D(tDiffuse, vUv + hdir).r, col.g, texture2D(tDiffuse, vUv - hdir).b);
        col = mix(col, hsplit, ring * 0.55);
        col += uHitColor * ring * uHitWash * 0.28;
      }

      // grading: saturation + contrast (linear space, pre-ACES)
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(lum), col, uSaturation);
      col = (col - 0.18) * uContrast + 0.18;

      // vignette — softened: road-critical bottom edge barely dimmed
      float vdist = distance(vUv, vec2(0.5, 0.44));
      float vig = 1.0 - uVignette * smoothstep(0.45, 1.05, vdist) * (1.0 - 0.55 * smoothstep(0.5, 0.0, vUv.y));
      col *= vig;

      // crash flash
      if (uFlash > 0.001) {
        col = mix(col, uFlashColor * (0.8 + uFlash), uFlash);
      }

      // respawn fade
      col = mix(col, vec3(0.0), clamp(uFade, 0.0, 1.0));

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class PostFX {
  composer: EffectComposer;
  /** settings toggles — actually gate the effects (§31) */
  bloomEnabled = true;
  motionBlurEnabled = true;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  /** Low tier bypasses the composer entirely; this is the single biggest
   * render-cost saving on software/weak GPUs. */
  private directRender = false;
  private bloom: UnrealBloomPass;
  private finalPass: ShaderPass;
  private renderPass: RenderPass;
  private outputPass: OutputPass;
  private flashValue = 0;
  private fadeTarget = 0;
  private fadeValue = 0;
  private chromaValue = 0;
  private bloomPulseValue = 0;
  private hitWashValue = 0;
  private bloomBase = 0.6;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, width: number, height: number) {
    this.scene = scene;
    this.camera = camera;
    this.renderPass = new RenderPass(scene, camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(width / 2, height / 2), 0.6, 0.5, 0.82);
    this.finalPass = new ShaderPass(FinalShader);
    this.outputPass = new OutputPass();
    this.composer = this.buildComposer(renderer, width, height, 4);
  }

  private buildComposer(renderer: THREE.WebGLRenderer, bufW: number, bufH: number, samples: number): EffectComposer {
    const target = new THREE.WebGLRenderTarget(Math.max(2, bufW), Math.max(2, bufH), {
      type: THREE.HalfFloatType,
      samples,
    });
    const composer = new EffectComposer(renderer, target);
    composer.addPass(this.renderPass);
    composer.addPass(this.bloom);
    composer.addPass(this.finalPass);
    composer.addPass(this.outputPass);
    return composer;
  }

  /** Select the low-cost render path before rebuilding targets. */
  setQualityTier(tier: 0 | 1 | 2): void {
    this.directRender = tier === 0;
    this.bloom.enabled = !this.directRender && this.bloomEnabled;
    this.finalPass.enabled = !this.directRender;
    this.outputPass.enabled = !this.directRender;
  }

  /** rebuild render targets at a new resolution / MSAA level (adaptive quality) */
  rebuild(renderer: THREE.WebGLRenderer, cssW: number, cssH: number, samples: number) {
    // The low tier renders directly to the canvas.  Keep the dormant composer
    // sized for a later upgrade, but do not allocate MSAA targets on the hot
    // path while it is unused.
    if (this.directRender) {
      this.composer.setPixelRatio(renderer.getPixelRatio());
      this.composer.setSize(cssW, cssH);
      return;
    }
    const pr = renderer.getPixelRatio();
    const old = this.composer;
    this.composer = this.buildComposer(renderer, Math.floor(cssW * pr), Math.floor(cssH * pr), samples);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(cssW, cssH);
    old.dispose();
  }

  flash(strength: number, color: THREE.Color) {
    this.flashValue = Math.max(this.flashValue, strength);
    (this.finalPass.uniforms.uFlashColor.value as THREE.Color).copy(color);
  }

  /** red-tinted chromatic aberration burst (crash) */
  chromaBurst(amount: number) {
    this.chromaValue = Math.max(this.chromaValue, amount);
  }

  /** short bloom burst (PERFECT SYNC gates, lyric word highlights) */
  bloomPulse(amount: number) {
    this.bloomPulseValue = Math.max(this.bloomPulseValue, amount);
  }

  /** lane-colored hit wash + chromatic ring (PERFECT gate crossing) */
  hitWash(amount: number, laneColor: THREE.Color) {
    this.hitWashValue = Math.max(this.hitWashValue, amount);
    (this.finalPass.uniforms.uHitColor.value as THREE.Color).copy(laneColor);
  }

  setFade(v: number) {
    this.fadeTarget = clamp01(v);
    if (v >= 0.999) this.fadeValue = 1; // snap when fully black
  }

  update(dt: number, params: { speedKmh: number; bloom: number; saturation: number; contrast: number; rain: number; vignette: number }) {
    this.flashValue = Math.max(0, this.flashValue - dt * 2.4);
    this.fadeValue += (this.fadeTarget - this.fadeValue) * (this.fadeTarget > this.fadeValue ? 1 : Math.min(1, dt * 2.2));
    this.chromaValue = Math.max(0, this.chromaValue - dt * 1.8);
    this.bloomPulseValue = Math.max(0, this.bloomPulseValue - dt * 3.2);
    // hit wash is intentionally FASTER than the crash chroma: a percussive
    // accent, decayed hard so it never lingers over the next gate
    this.hitWashValue = Math.max(0, this.hitWashValue - dt * 4.5);
    const u = this.finalPass.uniforms;
    const blurK = this.motionBlurEnabled && params.speedKmh > 180 ? Math.pow(Math.min(1, (params.speedKmh - 180) / 120), 2) : 0;
    u.uSpeedBlur.value = blurK;
    u.uRain.value = params.rain;
    u.uTime.value += dt;
    u.uSaturation.value = params.saturation;
    u.uContrast.value = params.contrast;
    u.uVignette.value = params.vignette;
    u.uFlash.value = this.flashValue;
    u.uFade.value = this.fadeValue;
    u.uWindSpeed.value = Math.min(1, params.speedKmh / 300);
    u.uChroma.value = this.chromaValue;
    u.uChromaRed.value = this.chromaValue > 0.01 ? 1 : 0;
    u.uHitWash.value = this.hitWashValue;
    this.bloomBase = params.bloom;
    this.bloom.strength = this.bloomEnabled ? params.bloom + this.bloomPulseValue : 0;
    // disabled bloom skips its render cost entirely; low tier also bypasses
    // the whole composer in render().
    this.bloom.enabled = !this.directRender && this.bloomEnabled;
  }

  resize(width: number, height: number) {
    this.composer.setPixelRatio(this.composer.renderer.getPixelRatio());
    this.composer.setSize(width, height);
    this.bloom.setSize(width / 2, height / 2);
  }

  render() {
    if (this.directRender) {
      this.composer.renderer.render(this.scene, this.camera);
      return;
    }
    this.composer.render();
  }

  dispose() {
    this.composer.dispose();
    (this.finalPass.uniforms.tDiffuse.value as THREE.Texture | null)?.dispose();
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
