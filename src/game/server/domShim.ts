/**
 * server/domShim.ts — the *minimal* environment patch a Node game session needs.
 *
 * Only timers are provided, and only when the runtime lacks them. `window` and
 * `document` are deliberately NOT faked: procedurally generated textures fall
 * back to a no-op canvas inside `makeCanvas` (see core/headlessCanvas.ts), while
 * faking browser globals in a Node server breaks framework code that branches
 * on `typeof window` — which is exactly the bug that made sessions 500 on the
 * first working version of this module.
 */

export function installRuntimeShims(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.requestAnimationFrame === 'undefined') {
    g.requestAnimationFrame = (cb: (t: number) => void) =>
      setTimeout(() => cb(Date.now()), 16) as unknown as number;
    g.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  }
}

installRuntimeShims();
