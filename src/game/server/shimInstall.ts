/**
 * server/shimInstall.ts — installs the headless DOM shim as a side effect at
 * module evaluation time.
 *
 * Import this BEFORE any world/simulation module: ESM evaluates dependencies in
 * import order, so `import './shimInstall'` placed first guarantees the canvas
 * shim exists before e.g. environment/textures.ts builds its procedural
 * textures at module scope.
 */

import { installDomShim } from './domShim';

installDomShim();

export {};
