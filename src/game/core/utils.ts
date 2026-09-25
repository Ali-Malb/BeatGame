/**
 * Shared math / helper utilities for the motorcycle simulation.
 */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clampAbs(v: number, max: number): number {
  return clamp(v, -max, max);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** exponential smoothing that is framerate independent (lambda = fraction per 1s) */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function smoothstep(t: number): number {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
}

/** frame-rate independent lerp factor: e.g. lerpFactor(12, dt) */
export function lerpFactor(lambda: number, dt: number): number {
  return 1 - Math.exp(-lambda * dt);
}

export function sign(v: number): number {
  return v < 0 ? -1 : v > 0 ? 1 : 0;
}

export function kmh(ms: number): number {
  return ms * 3.6;
}

export function ms(kmhV: number): number {
  return kmhV / 3.6;
}

/** deterministic pseudo random generator (mulberry32) */
export class RNG {
  private state: number;
  constructor(seed = 1337) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
  int(min: number, maxInclusive: number): number {
    return Math.floor(this.range(min, maxInclusive + 1 - 1e-9));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))];
  }
}

/** cheap value noise for camera shake / wind buffet */
export function noise1(t: number, seed = 0): number {
  const x = Math.sin(t * 1.7 + seed * 13.13) * 43758.5453;
  const f = x - Math.floor(x);
  const x2 = Math.sin(t * 0.31 + seed * 7.7) * 12345.6789;
  const f2 = x2 - Math.floor(x2);
  return f * 0.7 + f2 * 0.3;
}

import { headlessCanvas } from './headlessCanvas';

/** 1D smooth periodic noise approximated from summed sines */
export function smoothNoise(t: number, seed = 0): number {
  return (
    Math.sin(t * 1.0 + seed * 12.9) * 0.5 +
    Math.sin(t * 2.17 + seed * 78.2) * 0.28 +
    Math.sin(t * 4.31 + seed * 37.7) * 0.15 +
    Math.sin(t * 8.9 + seed * 3.3) * 0.07
  );
}

/**
 * Helper to build a canvas and draw on it.
 *
 * Headless (server-side remote simulation) there is no DOM: the same
 * procedural-texture code still runs so geometry and physics are identical,
 * it just records onto a no-op canvas instead of a real one.
 */
export function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  if (typeof document === 'undefined') {
    const fake = headlessCanvas(w, h);
    return { canvas: fake as unknown as HTMLCanvasElement, ctx: fake.getContext('2d') as CanvasRenderingContext2D };
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return { canvas, ctx };
}

/** pre-emptive promise-ish timeout helper */
export function delay(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
