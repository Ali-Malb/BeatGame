/**
 * runtime/index.ts — the runtime layer's public surface.
 *
 * LocalRuntime and RemoteRuntime both implement GameRuntime and consume the same
 * normalized InputState, so the shell can switch between them without knowing
 * where the simulation runs.
 */

export * from './types';
export * from './InputState';
export { detectClientCapabilities, detectHardwareDecode, chooseRemoteTransport, mergeCapabilities } from './capabilities';
export { LocalRuntime } from './LocalRuntime';
export { RemoteRuntime } from './RemoteRuntime';
export type { RemoteStartOptions } from './RemoteRuntime';
