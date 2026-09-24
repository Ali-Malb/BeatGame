/**
 * runtime/types.ts — the runtime contract shared by LocalRuntime and
 * RemoteRuntime.
 *
 * Both runtimes expose the same surface, so the React shell (HUD, menus,
 * popups, settings) never needs to know whether the simulation is running in
 * this tab or in a persistent server session. The simulation itself is the
 * SAME code in both cases (bike physics, traffic, rhythm gates, scoring) —
 * RemoteRuntime only changes *who steps it* and *where frames come from*.
 *
 * Authoritative-timeline rule: the music/rhythm clock belongs to whichever
 * runtime owns the simulation. The client never re-derives rhythm timing from
 * its own render frames.
 */

import type { InputState } from './InputState';

export type RuntimeKind = 'local' | 'remote';

/** lifecycle of a (possibly remote) play session */
export type RuntimeState =
  | 'idle'
  | 'starting'
  | 'countdown'
  | 'playing'
  | 'paused'
  | 'failed'
  | 'victory'
  | 'ended'
  | 'error';

export type TransportKind =
  /** everything in this tab */
  | 'local'
  /** JPEG frame stream over HTTP (server software renderer) */
  | 'mjpeg'
  /** WebRTC media + data channel (requires a media-capable server) */
  | 'webrtc';

export type Judgment = 'perfect' | 'good' | 'miss';

export interface JudgmentEvent {
  judgment: Judgment;
  /** crossing time − note time (s, + = late) */
  delta: number;
  lane: number;
  /** server wall clock when the judgment was produced (ms) */
  at: number;
}

// ------------------------------------------------------------------ snapshot ----

export interface SnapshotBike {
  s: number;
  x: number;
  v: number;
  rpm: number;
  gear: number;
  lean: number;
  wheelie: number;
  tuck: number;
  crashed: boolean;
  lane: number;
}

export interface SnapshotCar {
  s: number;
  x: number;
  v: number;
  lane: number;
  kind: string;
  halfL: number;
  halfW: number;
  heavy: boolean;
  braking: boolean;
  blinker: number;
}

export interface SnapshotGate {
  id: number;
  s: number;
  lane: number;
  color: string;
  judged: boolean;
  judgment: Judgment | null;
}

export interface SnapshotScoring {
  score: number;
  combo: number;
  multiplier: number;
  hp: number;
  perfects: number;
  goods: number;
  misses: number;
  crashes: number;
  bestCombo: number;
  dead: boolean;
}

export interface SnapshotEnvironment {
  biome: number;
  biomeName: string;
  weather: number;
  district: string;
  districtName: string;
  section: string;
}

export interface SnapshotLyrics {
  /** current line text ('' when nothing is showing) */
  line: string;
  /** next line's start time on the song clock (NaN when none) */
  nextTime: number;
}

export interface SnapshotMusic {
  source: 'youtube' | 'upload' | 'demo' | 'none';
  title: string;
  bpm: number;
  duration: number;
  /** URL the client should play to stay on the authoritative clock */
  streamUrl: string | null;
}

export interface SnapshotPerf {
  /** server-side simulation loop rate */
  serverFps: number;
  simMs: number;
  renderMs: number;
  encodeMs: number;
  /** connected clients on this session */
  clients: number;
  /** frames dropped because no client was reading */
  framesDropped: number;
}

/** authoritative simulated world + rhythm state */
export interface SimSnapshot {
  /** server epoch ms — the client maps this to its own clock for latency */
  t: number;
  /** monotonic simulation tick */
  tick: number;
  state: RuntimeState;
  /** authoritative music time in seconds (negative during countdown) */
  songTime: number;
  songDuration: number;
  bike: SnapshotBike;
  traffic: SnapshotCar[];
  gates: SnapshotGate[];
  scoring: SnapshotScoring;
  /** newest judgment (for client feedback), or null */
  judgment: JudgmentEvent | null;
  environment: SnapshotEnvironment;
  lyrics: SnapshotLyrics;
  camera: { mode: string; fov: number };
  music: SnapshotMusic;
  perf: SnapshotPerf;
}

// --------------------------------------------------------------- capabilities ----

export interface RuntimeCapabilities {
  /** client side */
  webgl2: boolean;
  gpuRenderer: string | null;
  hardwareEncode: boolean;
  rtcSupported: boolean;
  /** server side (probed by the session API) */
  serverRenderer: 'gpu' | 'software' | 'none';
  serverEncoder: 'hardware' | 'libjpeg' | 'none';
  serverRtc: boolean;
  /** human-readable reason when remote video cannot start */
  remoteVideoReason: string | null;
}

export interface RuntimeStatus {
  kind: RuntimeKind;
  state: RuntimeState;
  transport: TransportKind;
  /** true once frames/telemetry are flowing */
  connected: boolean;
  /** round-trip time of the last input→snapshot exchange (ms) */
  latencyMs: number;
  /** snapshot→render delta measured on the client (ms) */
  streamLagMs: number;
  /** frames per second actually displayed on the client */
  displayFps: number;
  sessionId: string | null;
  /** why remote mode is not active (or null) */
  reason: string | null;
  capabilities: RuntimeCapabilities;
}

/** one active connection on a server session */
export interface SessionClientInfo {
  clientId: string;
  connectedAt: number;
  lastSeen: number;
  rttMs: number;
}

export interface SessionInfo {
  id: string;
  createdAt: number;
  startedAt: number;
  state: RuntimeState;
  heartbeatAt: number;
  timeoutMs: number;
  clients: SessionClientInfo[];
  tick: number;
  inputSeq: number;
  capabilities: RuntimeCapabilities;
  /** bytes of encoded video produced so far */
  videoBytes: number;
  music: SnapshotMusic;
}

// ------------------------------------------------------------------- runtime ----

export interface StartOptions {
  /** song the server/client should run — mirrors GameManager's selection */
  song: { source: 'youtube' | 'upload' | 'demo'; id: string; title: string; streamUrl?: string | null };
  /** graphics/pacing knobs the runtime understands (quality, fov, …) */
  settings?: Record<string, number | string | boolean>;
  /** requested video size in remote mode */
  videoWidth?: number;
  videoHeight?: number;
}

/**
 * A play runtime. `setInput` accepts the SAME normalized InputState for
 * keyboard, gamepad, touch and remote input.
 */
export interface GameRuntime {
  readonly kind: RuntimeKind;
  status(): RuntimeStatus;
  capabilities(): RuntimeCapabilities;
  start(opts: StartOptions): Promise<void>;
  setInput(state: InputState): void;
  /** structured action channel (camera/pause/restart) */
  action(name: RuntimeAction): void;
  snapshot(): SimSnapshot | null;
  onSnapshot(cb: (snap: SimSnapshot) => void): () => void;
  onStatus(cb: (status: RuntimeStatus) => void): () => void;
  dispose(): Promise<void>;
}

export type RuntimeAction =
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'restart' }
  | { type: 'camera' }
  | { type: 'menu' };
