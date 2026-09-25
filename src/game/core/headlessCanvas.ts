/**
 * core/headlessCanvas.ts — a DOM-free stand-in for `HTMLCanvasElement`.
 *
 * The world modules build procedural textures through `makeCanvas`. Running the
 * SAME modules inside a server process (the remote session's authoritative
 * simulation) has no `document`, and no frame is ever uploaded to a GPU there,
 * so a recording no-op canvas is the whole requirement: geometry, physics and
 * timing are untouched by texture pixels.
 *
 * Deliberately NOT installed as a global `window`/`document`: faking those in a
 * Node server breaks framework internals that branch on `typeof window`, which
 * is a far worse failure than a blank texture nobody samples.
 */

interface CtxRecord {
  [key: string]: unknown;
}

const gradient = { addColorStop(): void {} };

/** any 2D method we do not model becomes a no-op */
function makeCtx(canvas: HeadlessCanvas): unknown {
  const target: CtxRecord = {
    canvas,
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => null,
    measureText: () => ({ width: 8, actualBoundingBoxAscent: 6, actualBoundingBoxDescent: 2 }),
    getImageData: (x = 0, y = 0, w = 1, h = 1) => ({
      data: new Uint8ClampedArray(Math.max(4, w * h * 4)),
      width: w,
      height: h,
      x,
      y,
    }),
    putImageData: () => {},
    getLineDash: () => [],
    isPointInPath: () => false,
  };
  return new Proxy(target, {
    get(t, key) {
      if (typeof key === 'string' && key in t) return t[key];
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

export class HeadlessCanvas {
  width = 1;
  height = 1;
  style: Record<string, unknown> = {};
  private ctx: unknown = null;

  getContext(kind: string): unknown {
    if (kind !== '2d') return null; // there is no GL without a browser
    this.ctx ??= makeCtx(this);
    return this.ctx;
  }

  toDataURL(): string {
    return 'data:,';
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  getBoundingClientRect() {
    return {
      x: 0,
      y: 0,
      width: this.width,
      height: this.height,
      top: 0,
      left: 0,
      right: this.width,
      bottom: this.height,
    };
  }
}

/** true when procedural canvases must be faked */
export function isHeadless(): boolean {
  return typeof document === 'undefined';
}

export function headlessCanvas(w: number, h: number): HeadlessCanvas {
  const c = new HeadlessCanvas();
  c.width = w;
  c.height = h;
  return c;
}
