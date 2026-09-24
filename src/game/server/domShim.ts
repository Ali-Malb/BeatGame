/**
 * server/domShim.ts — the smallest DOM surface the simulation modules need.
 *
 * The authoritative server session runs the SAME world/simulation code as the
 * browser (roadSpline, BikeController, TrafficManager, RhythmGates, camera).
 * Those modules build procedural textures through `makeCanvas`, which needs
 * `document.createElement('canvas')`. On the server we never upload a texture
 * to a GPU, so a recording no-op canvas is enough: geometry, physics and
 * timing are all untouched by it.
 */

interface FakeCtx {
  [key: string]: unknown;
}

const gradient = { addColorStop(): void {} };

function makeCtx(canvas: FakeCanvas): FakeCtx {
  const target: Record<string, unknown> = {
    canvas,
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => null,
    measureText: () => ({ width: 8, actualBoundingBoxAscent: 6, actualBoundingBoxDescent: 2 }),
    getImageData: (_x = 0, _y = 0, w = 1, h = 1) => ({
      data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
      width: w,
      height: h,
    }),
    putImageData: () => {},
    getLineDash: () => [],
    isPointInPath: () => false,
  };
  return new Proxy(target, {
    get(t, key) {
      if (typeof key === 'string' && key in t) return t[key];
      // any other 2D method is a no-op that returns undefined
      const noop = () => undefined;
      Reflect.set(t, key, noop);
      return noop;
    },
    set(t, key, value) {
      Reflect.set(t, key, value);
      return true;
    },
  });
}

export class FakeCanvas {
  width = 1;
  height = 1;
  style: Record<string, unknown> = {};
  private ctx: FakeCtx | null = null;

  getContext(kind: string): FakeCtx | null {
    if (kind !== '2d' && kind !== 'webgl' && kind !== 'webgl2') return null;
    if (kind !== '2d') return null; // no GL on the server
    this.ctx ??= makeCtx(this);
    return this.ctx;
  }

  toDataURL(): string {
    return 'data:,';
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  getBoundingClientRect() {
    return { x: 0, y: 0, width: this.width, height: this.height, top: 0, left: 0, right: this.width, bottom: this.height };
  }
}

let installed = false;

/**
 * Install the shim. Idempotent, and a no-op when a real DOM is present (so it
 * can also be imported from a browser bundle without doing any harm).
 */
export function installDomShim(): boolean {
  if (installed) return true;
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.document === 'undefined') {
    const documentShim = {
      createElement: (tag: string) => (tag === 'canvas' ? new FakeCanvas() : { style: {}, appendChild() {}, addEventListener() {} }),
      createElementNS: (_ns: string, tag: string) => (tag === 'canvas' ? new FakeCanvas() : { style: {}, appendChild() {} }),
      addEventListener(): void {},
      removeEventListener(): void {},
      body: { appendChild(): void {}, style: {} },
      hidden: false,
    };
    g.document = documentShim;
  }
  if (typeof g.window === 'undefined') {
    g.window = {
      innerWidth: 1280,
      innerHeight: 720,
      devicePixelRatio: 1,
      addEventListener(): void {},
      removeEventListener(): void {},
      requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16) as unknown as number,
      cancelAnimationFrame: (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
      document: g.document,
    };
  }
  if (typeof g.requestAnimationFrame === 'undefined') {
    g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16) as unknown as number;
    g.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  }
  installed = true;
  return true;
}
