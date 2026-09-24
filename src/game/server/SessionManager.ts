/**
 * server/SessionManager.ts — persistent remote-play sessions.
 *
 * A session owns:
 *   - an AuthoritativeSim (the SAME simulation modules as the local game),
 *   - a SoftwareRenderer + encoder producing real frames,
 *   - its own fixed-rate loop (setInterval), NOT an open HTTP request,
 *   - client records with heartbeat/reconnect/timeout handling,
 *   - a signaling channel for WebRTC negotiation,
 *   - adaptation of video resolution / quality / rate to measured cost.
 *
 * Lifecycle: create → connect → start → (heartbeat…) → disconnect → cleanup,
 * with a timeout that freezes and then destroys abandoned sessions.
 *
 * Process-scope storage is deliberate: this is a single-process persistent
 * session manager (the same shape a dedicated game-worker service would have).
 */

import { randomUUID } from 'node:crypto';
import { AuthoritativeSim, type SimChartPayload } from './AuthoritativeSim';
import { SoftwareRenderer } from './SoftwareRenderer';
import { getFrameEncoder, type FrameEncoder } from './FrameEncoder';
import { createInputState, type InputState } from '../runtime/InputState';
import type { RuntimeAction, RuntimeState, SimSnapshot, RuntimeCapabilities, SessionClientInfo } from '../runtime/types';

export const TICK_HZ = 60;
export const DEFAULT_TIMEOUT_MS = 8000;
/** abandoned (zero clients) sessions are reaped after this */
export const IDLE_REAP_MS = 90_000;
const SIGNAL_TIMEOUT_MS = 4000;

export interface CreateSessionOptions {
  chart?: SimChartPayload | null;
  countdownSec?: number;
  music?: { source: 'youtube' | 'upload' | 'demo' | 'none'; title: string; streamUrl: string | null };
  videoWidth?: number;
  videoHeight?: number;
  startLane?: number;
  startSpeed?: number;
}

export interface CreateSessionResult {
  id: string;
  capabilities: RuntimeCapabilities;
  snapshot: SimSnapshot;
}

interface ClientRecord extends SessionClientInfo {
  inputSeq: number;
  lastInputAt: number;
  pendingPongs: number;
}

export interface FramePacket {
  seq: number;
  buffer: Buffer;
  at: number;
  width: number;
  height: number;
}

export interface InputAck {
  seq: number;
  serverTime: number;
  clientTime: number;
  tick: number;
  songTime: number;
  state: RuntimeState;
}

export type SignalMessage =
  | { type: 'offer'; sdp: string }
  | { type: 'candidate'; candidate: unknown }
  | { type: 'bye' };

export type SignalReply =
  | { type: 'answer'; sdp: string }
  | { type: 'candidate'; candidate: unknown }
  | { type: 'unsupported'; reason: string };

const perfStub = { serverFps: 0, simMs: 0, renderMs: 0, encodeMs: 0, clients: 0, framesDropped: 0 };

export class RemoteSession {
  readonly id: string;
  readonly createdAt = Date.now();
  startedAt = 0;
  heartbeatAt = Date.now();
  timeoutMs = DEFAULT_TIMEOUT_MS;
  state: RuntimeState = 'idle';
  inputSeq = 0;
  videoBytes = 0;

  readonly sim: AuthoritativeSim;
  readonly renderer: SoftwareRenderer;

  private encoder: FrameEncoder | null = null;
  private clients = new Map<string, ClientRecord>();
  private frameWaiters: ((packet: FramePacket) => void)[] = [];
  private frameSeq = 0;
  private lastPacket: FramePacket | null = null;
  private framesDropped = 0;
  private lastRenderAt = 0;
  private lastTickAt = 0;
  private simMs = 0;
  private renderMs = 0;
  private encodeMs = 0;
  private fps = 0;
  private fpsWindow: number[] = [];
  private videoFps = 24;
  private jpegQuality = 74;
  private encodeBusy = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private adaptTimer = 0;
  private tickSeq = 0;
  private destroyed = false;
  /** the session paused itself (no clients / heartbeat timeout), not the user */
  private autoPaused = false;
  private capabilities: RuntimeCapabilities;

  /** reconnect semantics: resume only what the session itself froze */
  private resumeIfAutoPaused(): void {
    if (!this.autoPaused || this.clients.size === 0) return;
    this.autoPaused = false;
    if (this.sim.state === 'paused') this.sim.action({ type: 'resume' });
    this.state = this.sim.state;
  }

  /** snapshot subscribers (SSE streams, telemetry consumers) */
  private snapshotListeners = new Set<(snap: SimSnapshot) => void>();

  addSnapshotListener(cb: (snap: SimSnapshot) => void): () => void {
    this.snapshotListeners.add(cb);
    return () => this.snapshotListeners.delete(cb);
  }

  constructor(id: string, options: CreateSessionOptions, capabilities: RuntimeCapabilities) {
    this.id = id;
    this.capabilities = capabilities;
    this.sim = new AuthoritativeSim(90210 + id.length);
    this.sim.loadChart(options.chart ?? null);
    this.renderer = new SoftwareRenderer(options.videoWidth ?? 640, options.videoHeight ?? 360);
    this.renderer.registerSurfaces(this.sim.highway.mats);
    this.pendingStart = options;
    this.state = 'idle';
  }

  private pendingStart: CreateSessionOptions;

  async init(): Promise<void> {
    this.encoder = await getFrameEncoder();
    if (this.encoder.info.kind === 'none') {
      this.capabilities = { ...this.capabilities, serverEncoder: 'none', remoteVideoReason: this.encoder.info.reason };
    } else {
      this.capabilities = { ...this.capabilities, serverEncoder: this.encoder.info.kind as 'hardware' | 'libjpeg' };
    }
  }

  get capabilitiesSnapshot(): RuntimeCapabilities {
    return this.capabilities;
  }

  clientList(): SessionClientInfo[] {
    return [...this.clients.values()].map((c) => ({
      clientId: c.clientId,
      connectedAt: c.connectedAt,
      lastSeen: c.lastSeen,
      rttMs: c.rttMs,
    }));
  }

  // ------------------------------------------------------------------ lifecycle ----

  /** begin the run and start the self-driven loop (no HTTP request involved) */
  startRun(): void {
    const o = this.pendingStart;
    this.sim.start({
      countdownSec: o.countdownSec ?? 3,
      music: o.music ?? { source: 'none', title: '', streamUrl: null },
      startLane: o.startLane ?? 2,
      startSpeed: o.startSpeed,
    });
    this.startedAt = Date.now();
    this.state = this.sim.state;
    this.ensureLoop();
  }

  private ensureLoop(): void {
    if (this.timer || this.destroyed) return;
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => this.onTick(), 1000 / TICK_HZ);
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref();
    }
  }

  connect(clientId: string): SessionClientInfo {
    const now = Date.now();
    let rec = this.clients.get(clientId);
    if (!rec) {
      rec = { clientId, connectedAt: now, lastSeen: now, rttMs: 0, inputSeq: 0, lastInputAt: now, pendingPongs: 0 };
      this.clients.set(clientId, rec);
    } else {
      // reconnect: keep the simulation running, just re-attach the client
      rec.lastSeen = now;
    }
    this.heartbeatAt = now;
    this.resumeIfAutoPaused();
    this.ensureLoop();
    return { clientId: rec.clientId, connectedAt: rec.connectedAt, lastSeen: rec.lastSeen, rttMs: rec.rttMs };
  }

  disconnect(clientId: string): void {
    this.clients.delete(clientId);
    this.heartbeatAt = Date.now();
  }

  heartbeat(clientId: string): { ok: true; serverTime: number; clients: number; state: RuntimeState } {
    const rec = this.clients.get(clientId);
    const now = Date.now();
    if (rec) rec.lastSeen = now;
    this.heartbeatAt = now;
    // a reconnecting client resumes a session that the timeout/first-connect
    // pause froze — a deliberate user pause is NOT auto-resumed
    this.resumeIfAutoPaused();
    return { ok: true, serverTime: now, clients: this.clients.size, state: this.state };
  }

  /** raw normalized input from one client (keyboard/gamepad/touch/remote alike) */
  setInput(clientId: string, state: InputState, seq: number, clientTime: number): InputAck {
    const rec = this.clients.get(clientId);
    const now = Date.now();
    if (rec) {
      rec.lastSeen = now;
      rec.inputSeq = seq;
      rec.lastInputAt = now;
      rec.rttMs = Math.max(0, now - clientTime);
    }
    this.heartbeatAt = now;
    this.sim.setInput(state);
    this.inputSeq = Math.max(this.inputSeq, seq);
    return { seq, serverTime: now, clientTime, tick: this.sim.tick, songTime: this.sim.songTime, state: this.sim.state };
  }

  action(a: RuntimeAction): void {
    if (a.type === 'pause' || a.type === 'resume') this.autoPaused = false;
    this.sim.action(a);
    this.state = this.sim.state;
    if (this.sim.state !== 'idle' && this.sim.state !== 'ended') this.ensureLoop();
  }

  // ------------------------------------------------------------------------ loop ----

  private onTick(): void {
    if (this.destroyed) return;
    const now = Date.now();
    const dt = Math.min(0.25, (now - this.lastTickAt) / 1000);
    this.lastTickAt = now;
    this.tickSeq++;

    if (!this.shouldRun(now)) return;

    const t0 = performance.now();
    this.sim.step(dt);
    this.simMs = performance.now() - t0;
    this.state = this.sim.state;

    // fps window (1 s)
    this.fpsWindow.push(now);
    while (this.fpsWindow.length && now - this.fpsWindow[0] > 1000) this.fpsWindow.shift();
    this.fps = this.fpsWindow.length;

    this.adapt(now);

    const wantFrame = this.clients.size > 0 || this.frameWaiters.length > 0;
    if (wantFrame && now - this.lastRenderAt >= 1000 / Math.max(5, this.videoFps)) {
      this.lastRenderAt = now;
      this.renderAndEncode();
    }

    if (this.tickSeq % 3 === 0) this.emitSnapshot();
  }

  /** pause the sim when every client went away; reap when abandoned for long */
  private shouldRun(now: number): boolean {
    const abandoned = now - this.heartbeatAt > IDLE_REAP_MS * 4;
    if (abandoned) {
      this.state = 'ended';
      return false;
    }
    if (this.clients.size === 0) {
      if (this.state === 'playing' || this.state === 'countdown') {
        this.sim.action({ type: 'pause' });
        this.state = 'paused';
        this.autoPaused = true;
      }
      return false;
    }
    if (now - this.heartbeatAt > this.timeoutMs) {
      if (this.state !== 'paused') {
        this.sim.action({ type: 'pause' });
        this.state = 'paused';
      }
      this.autoPaused = true;
      return false;
    }
    return true;
  }

  private emitSnapshot(): void {
    if (this.snapshotListeners.size === 0) return;
    const snap = this.snapshot();
    for (const cb of this.snapshotListeners) {
      try {
        cb(snap);
      } catch {
        /* a dead subscriber must not stop the session loop */
      }
    }
  }

  snapshot(): SimSnapshot {
    return this.sim.snapshot({
      serverFps: this.fps,
      simMs: +this.simMs.toFixed(2),
      renderMs: this.renderMs,
      encodeMs: this.encodeMs,
      clients: this.clients.size,
      framesDropped: this.framesDropped,
    });
  }

  // ------------------------------------------------------------------- rendering ----

  private renderAndEncode(): void {
    if (this.encodeBusy || !this.encoder) {
      this.framesDropped++;
      return;
    }
    const t0 = performance.now();
    const rgba = this.renderer.render(this.sim);
    this.renderMs = +(performance.now() - t0).toFixed(2);
    const w = this.renderer.width;
    const h = this.renderer.height;
    const copy = new Uint8Array(rgba); // renderer reuses its buffer next frame
    this.encodeBusy = true;
    const t1 = performance.now();
    void this.encoder
      .encode(copy, w, h, this.jpegQuality)
      .then((jpeg) => {
        if (this.destroyed) return;
        this.encodeMs = +(performance.now() - t1).toFixed(2);
        this.videoBytes += jpeg.byteLength;
        const packet: FramePacket = { seq: ++this.frameSeq, buffer: jpeg, at: Date.now(), width: w, height: h };
        this.lastPacket = packet;
        const waiters = this.frameWaiters;
        this.frameWaiters = [];
        for (const resolve of waiters) resolve(packet);
      })
      .catch(() => {
        this.framesDropped++;
      })
      .finally(() => {
        this.encodeBusy = false;
      });
  }

  /** wait for the next encoded frame (MJPEG push stream) */
  nextFrame(timeoutMs = 2000): Promise<FramePacket | null> {
    if (this.lastPacket && Date.now() - this.lastPacket.at < 40) return Promise.resolve(this.lastPacket);
    return new Promise((resolve) => {
      const waiter = (p: FramePacket) => resolve(p);
      this.frameWaiters.push(waiter);
      setTimeout(() => {
        const i = this.frameWaiters.indexOf(waiter);
        if (i >= 0) this.frameWaiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
    });
  }

  lastFrame(): FramePacket | null {
    return this.lastPacket;
  }

  /**
   * Adaptation: keep the frame pipeline inside its budget by trading pixels for
   * frames. Driven by measured encode cost and client count, never by guessing.
   */
  private adapt(now: number): void {
    if (now - this.adaptTimer < 2000) return;
    this.adaptTimer = now;
    const cost = this.encodeMs + this.renderMs;
    if (cost > 34) {
      this.jpegQuality = Math.max(48, this.jpegQuality - 6);
      if (this.videoFps > 12) this.videoFps -= 3;
      else if (this.renderer.width > 384) this.renderer.resize(Math.round(this.renderer.width * 0.8), Math.round(this.renderer.height * 0.8));
    } else if (cost < 14) {
      this.jpegQuality = Math.min(84, this.jpegQuality + 4);
      if (this.videoFps < 30) this.videoFps += 2;
    }
  }

  get videoParams(): { fps: number; quality: number; width: number; height: number } {
    return { fps: this.videoFps, quality: this.jpegQuality, width: this.renderer.width, height: this.renderer.height };
  }

  // -------------------------------------------------------------------- signaling ----

  /**
   * WebRTC signaling. Answers only when a real media bridge is configured;
   * otherwise it says so explicitly, which is what makes the client fall back
   * to the JPEG transport instead of showing a fake "connected" state.
   */
  async signal(clientId: string, msg: SignalMessage): Promise<SignalReply> {
    const rec = this.clients.get(clientId);
    if (rec) rec.lastSeen = Date.now();
    const endpoint = process.env.REMOTE_WEBRTC_ENDPOINT;
    if (msg.type === 'bye') return { type: 'unsupported', reason: 'signaling closed by client' };
    if (!endpoint) {
      return {
        type: 'unsupported',
        reason: 'server has no WebRTC media stack (video is streamed as encoded JPEG frames)',
      };
    }
    try {
      const res = await fetch(`${endpoint.replace(/\/$/, '')}/signal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: this.id, message: msg }),
        signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS),
      });
      if (!res.ok) return { type: 'unsupported', reason: `media bridge returned ${res.status}` };
      return (await res.json()) as SignalReply;
    } catch (err) {
      return { type: 'unsupported', reason: `media bridge unreachable: ${String(err)}` };
    }
  }

  // ---------------------------------------------------------------------- teardown ----

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const waiters = this.frameWaiters;
    this.frameWaiters = [];
    for (const resolve of waiters) resolve(null as unknown as FramePacket);
    this.clients.clear();
    this.sim.dispose();
    this.state = 'ended';
  }

  get destroyedFlag(): boolean {
    return this.destroyed;
  }
}

// ============================================================== manager ====

export interface SessionSummary {
  id: string;
  createdAt: number;
  state: RuntimeState;
  clients: number;
  tick: number;
  videoBytes: number;
  videoParams: { fps: number; quality: number; width: number; height: number };
  capabilities: RuntimeCapabilities;
}

export class SessionManager {
  private sessions = new Map<string, RemoteSession>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private baseCapabilities: RuntimeCapabilities = {
    webgl2: false,
    gpuRenderer: null,
    hardwareEncode: false,
    rtcSupported: false,
    serverRenderer: 'software',
    serverEncoder: 'libjpeg',
    serverRtc: false,
    remoteVideoReason: null,
  };

  setBaseCapabilities(caps: Partial<RuntimeCapabilities>): void {
    this.baseCapabilities = { ...this.baseCapabilities, ...caps };
  }

  capabilities(): RuntimeCapabilities {
    const rtc = !!process.env.REMOTE_WEBRTC_ENDPOINT;
    return { ...this.baseCapabilities, serverRtc: rtc, remoteVideoReason: this.baseCapabilities.remoteVideoReason };
  }

  async create(options: CreateSessionOptions): Promise<RemoteSession> {
    const id = randomUUID();
    const session = new RemoteSession(id, options, this.capabilities());
    await session.init();
    this.sessions.set(id, session);
    this.ensureSweeper();
    return session;
  }

  get(id: string): RemoteSession | undefined {
    const s = this.sessions.get(id);
    if (s?.destroyedFlag) {
      this.sessions.delete(id);
      return undefined;
    }
    return s;
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      state: s.state,
      clients: s.clientList().length,
      tick: s.sim.tick,
      videoBytes: s.videoBytes,
      videoParams: s.videoParams,
      capabilities: s.capabilitiesSnapshot,
    }));
  }

  destroy(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.destroy();
    this.sessions.delete(id);
    return true;
  }

  destroyAll(): void {
    for (const s of this.sessions.values()) s.destroy();
    this.sessions.clear();
  }

  /** reap sessions that nobody has talked to for a long time */
  sweep(now = Date.now(), reapAfterMs = IDLE_REAP_MS): number {
    let reaped = 0;
    for (const [id, s] of this.sessions) {
      const idle = now - Math.max(s.heartbeatAt, s.createdAt);
      if (s.destroyedFlag || (s.clientList().length === 0 && idle > reapAfterMs)) {
        s.destroy();
        this.sessions.delete(id);
        reaped++;
      }
    }
    return reaped;
  }

  private ensureSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), 15_000);
    if (typeof (this.sweeper as { unref?: () => void }).unref === 'function') {
      (this.sweeper as { unref: () => void }).unref();
    }
  }

  get count(): number {
    return this.sessions.size;
  }
}

/** process-scope singleton: one persistent manager per server process */
const globalRef = globalThis as unknown as { __beatGameSessions?: SessionManager };
export function sessionManager(): SessionManager {
  if (!globalRef.__beatGameSessions) {
    const mgr = new SessionManager();
    const renderer = process.env.REMOTE_RENDERER;
    mgr.setBaseCapabilities({
      serverRenderer: renderer === 'none' ? 'none' : 'software',
      serverEncoder: 'libjpeg',
      remoteVideoReason:
        renderer === 'none' ? 'remote rendering disabled (REMOTE_RENDERER=none)' : null,
    });
    globalRef.__beatGameSessions = mgr;
  }
  return globalRef.__beatGameSessions;
}

export { createInputState };
export { perfStub };
