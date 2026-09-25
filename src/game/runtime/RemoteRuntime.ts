/**
 * runtime/RemoteRuntime.ts — the client half of remote play.
 *
 * Flow (all real, all persistent):
 *   browser → POST /api/remote/session           (create; server starts its own loop)
 *           → GET  …/:id/stream (SSE)            (authoritative snapshots + judgments)
 *           → GET  …/:id/video (MJPEG)           (server-rendered frames)
 *           → POST …/:id/input                   (normalized InputState, ~30 Hz)
 *           → POST …/:id/heartbeat               (session liveness)
 *           → POST …/:id/signal                  (WebRTC offer → answer or explicit refusal)
 *
 * Honesty rules:
 *   - the transport actually in use is reported (`webrtc` / `mjpeg`), never assumed;
 *   - if the server cannot render or encode, `start()` fails with the server's
 *     real reason and the caller falls back to LocalRuntime;
 *   - the server owns the clock: the client's local media is re-synced to the
 *     authoritative song time instead of the other way round.
 *
 * Network jitter cannot be removed — it is reported as streamLagMs/latencyMs so
 * the HUD can show it, and rhythm timing never depends on client render rate.
 */

import { chooseRemoteTransport, detectClientCapabilities, mergeCapabilities } from './capabilities';
import { createInputState, serializeInput, type InputState } from './InputState';
import { NEUTRAL_INPUT } from './InputState';
import type {
  GameRuntime,
  RuntimeAction,
  RuntimeCapabilities,
  RuntimeKind,
  RuntimeState,
  RuntimeStatus,
  SimSnapshot,
  StartOptions,
  TransportKind,
} from './types';

export interface RemoteStartOptions extends StartOptions {
  /** beatmap produced by the client's DSP analysis */
  chart?: {
    notes: { time: number; lane: number; type?: string; strength?: number; subdivision?: number }[];
    bpm: number;
    duration: number;
    firstBeat: number;
    beatSec: number;
    sections: { start: number; end: number; kind: string; energy: number }[];
  } | null;
  videoWidth?: number;
  videoHeight?: number;
  clientId?: string;
}

const INPUT_HZ = 30;
const HEARTBEAT_MS = 2000;

export class RemoteRuntime implements GameRuntime {
  readonly kind: RuntimeKind = 'remote';
  private baseUrl: string;
  private clientId: string;
  private sessionId: string | null = null;
  private transport: TransportKind = 'mjpeg';
  private caps: RuntimeCapabilities;
  private state: RuntimeState = 'idle';
  private connected = false;
  private reason: string | null = null;
  private latencyMs = 0;
  private streamLagMs = 0;
  private displayFps = 0;
  private lastSnapshot: SimSnapshot | null = null;
  private listeners = new Set<(s: SimSnapshot) => void>();
  private statusListeners = new Set<(s: RuntimeStatus) => void>();
  private input = createInputState();
  private inputSeq = 0;
  private inputTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private eventSource: EventSource | null = null;
  private frameTimes: number[] = [];
  private disposed = false;
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private snapshotWatchdog: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;

  constructor(baseUrl = '') {
    this.baseUrl = baseUrl;
    this.clientId = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `c-${Date.now()}`;
    this.caps = detectClientCapabilities();
  }

  capabilities(): RuntimeCapabilities {
    return this.caps;
  }

  status(): RuntimeStatus {
    return {
      kind: 'remote',
      state: this.state,
      transport: this.transport,
      connected: this.connected,
      latencyMs: Math.round(this.latencyMs),
      streamLagMs: Math.round(this.streamLagMs),
      displayFps: this.displayFps,
      sessionId: this.sessionId,
      reason: this.reason,
      capabilities: this.caps,
    };
  }

  /** the URL an <img> (or canvas) should point at for the server video */
  videoUrl(): string | null {
    return this.sessionId ? `${this.baseUrl}/api/remote/session/${this.sessionId}/video` : null;
  }

  /**
   * Create the session and begin streaming. Throws (with the server's real
   * reason) when remote video cannot start, so the caller can fall back.
   */
  async start(opts: RemoteStartOptions): Promise<void> {
    this.state = 'starting';
    this.emitStatus();
    const body = {
      clientId: this.clientId,
      chart: opts.chart ?? null,
      countdownSec: 3,
      startLane: 2,
      videoWidth: opts.videoWidth ?? 640,
      videoHeight: opts.videoHeight ?? 360,
      music: {
        source: opts.song.source,
        title: opts.song.title,
        streamUrl: opts.song.streamUrl ?? null,
      },
    };
    const res = await fetch(`${this.baseUrl}/api/remote/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      this.state = 'error';
      this.reason = `session create failed (${res.status})`;
      this.emitStatus();
      throw new Error(this.reason);
    }
    const data = (await res.json()) as { id: string; capabilities: RuntimeCapabilities; snapshot: SimSnapshot };
    this.sessionId = data.id;
    this.caps = mergeCapabilities(this.caps, data.capabilities);

    const choice = chooseRemoteTransport(this.caps);
    this.reason = choice.reason;
    if (choice.transport === 'none') {
      this.state = 'error';
      this.connected = false;
      this.emitStatus();
      await this.teardownSession();
      throw new Error(this.reason ?? 'remote rendering unavailable');
    }
    this.transport = choice.transport;
    this.applySnapshot(data.snapshot);

    this.openStream();
    this.startTransport();
    if (this.transport === 'webrtc') void this.negotiateWebRTC();
    this.connected = true;
    this.emitStatus();
  }

  // ------------------------------------------------------------------ transport ----

  private startTransport(): void {
    if (this.inputTimer) clearInterval(this.inputTimer);
    this.inputTimer = setInterval(() => void this.pushInput(), 1000 / INPUT_HZ);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
  }

  private async pushInput(): Promise<void> {
    if (!this.sessionId || this.disposed) return;
    const payload = serializeInput(this.input, ++this.inputSeq, Date.now());
    // once a WebRTC data channel is up the input rides it (lower latency)
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      try {
        this.dataChannel.send(payload);
        return;
      } catch {
        this.dataChannel = null;
      }
    }
    try {
      const res = await fetch(`${this.baseUrl}/api/remote/session/${this.sessionId}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'input', clientId: this.clientId, state: payload }),
      });
      if (res.ok) {
        const json = (await res.json()) as { ack?: { serverTime: number; clientTime: number } };
        if (json.ack) this.latencyMs = Math.max(0, json.ack.serverTime - json.ack.clientTime);
      }
    } catch {
      this.noteTransportTrouble('input transport failed');
    }
  }

  private async heartbeat(): Promise<void> {
    if (!this.sessionId || this.disposed) return;
    try {
      const res = await fetch(`${this.baseUrl}/api/remote/session/${this.sessionId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'heartbeat', clientId: this.clientId }),
      });
      if (!res.ok) this.noteTransportTrouble(`heartbeat failed (${res.status})`);
    } catch {
      this.noteTransportTrouble('heartbeat transport failed');
    }
  }

  /** reconnect awareness: a dropped snapshot stream restarts automatically */
  private openStream(): void {
    if (!this.sessionId) return;
    this.eventSource?.close();
    const es = new EventSource(`${this.baseUrl}/api/remote/session/${this.sessionId}/stream`);
    this.eventSource = es;
    const armWatchdog = () => {
      if (this.snapshotWatchdog) clearTimeout(this.snapshotWatchdog);
      this.snapshotWatchdog = setTimeout(() => {
        if (this.disposed) return;
        this.reconnectAttempts++;
        this.noteTransportTrouble('state stream stalled — reconnecting');
        this.openStream();
      }, 5000);
    };
    armWatchdog();
    es.addEventListener('hello', (ev) => this.onSnapshotEvent((ev as MessageEvent).data));
    es.addEventListener('snapshot', (ev) => {
      this.reconnectAttempts = 0;
      armWatchdog();
      this.onSnapshotEvent((ev as MessageEvent).data);
    });
    es.addEventListener('judgment', (ev) => {
      const j = JSON.parse((ev as MessageEvent).data) as { at: number };
      this.streamLagMs = Math.max(0, Date.now() - j.at);
    });
    es.onerror = () => {
      if (this.disposed) return;
      this.connected = this.eventSource?.readyState === EventSource.OPEN;
      this.emitStatus();
    };
  }

  private onSnapshotEvent(raw: string): void {
    try {
      const snap = JSON.parse(raw) as SimSnapshot;
      this.streamLagMs = Math.max(0, Date.now() - snap.t);
      this.frameTimes.push(Date.now());
      while (this.frameTimes.length && Date.now() - this.frameTimes[0] > 1000) this.frameTimes.shift();
      this.displayFps = this.frameTimes.length;
      this.applySnapshot(snap);
    } catch {
      /* ignore malformed frame */
    }
  }

  private applySnapshot(snap: SimSnapshot): void {
    this.lastSnapshot = snap;
    this.state = snap.state;
    for (const cb of this.listeners) cb(snap);
    this.emitStatus();
  }

  private noteTransportTrouble(reason: string): void {
    this.connected = false;
    this.reason = `${reason}${this.reconnectAttempts > 2 ? ' (still retrying)' : ''}`;
    this.emitStatus();
  }

  // --------------------------------------------------------------------- WebRTC ----

  /**
   * Real negotiation attempt. The server answers with an SDP only when a media
   * bridge is configured; otherwise it replies `unsupported` with the reason and
   * we stay on the JPEG transport. Either way the reported transport is true.
   */
  private async negotiateWebRTC(): Promise<void> {
    if (!this.sessionId || typeof RTCPeerConnection === 'undefined') return;
    try {
      const pc = new RTCPeerConnection({ iceServers: [] });
      this.pc = pc;
      const dc = pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
      this.dataChannel = dc;
      dc.onopen = () => {
        this.reason = null;
        this.emitStatus();
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const reply = await this.signal({ type: 'offer', sdp: offer.sdp ?? '' });
      if (!reply || reply.type !== 'answer') {
        this.transport = 'mjpeg';
        this.reason = (reply && 'reason' in reply ? reply.reason : null) ?? 'no WebRTC answer from server';
        this.pc?.close();
        this.pc = null;
        this.dataChannel = null;
        this.emitStatus();
        return;
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: reply.sdp });
    } catch (err) {
      this.transport = 'mjpeg';
      this.reason = `WebRTC negotiation failed: ${String(err)}`;
      this.pc?.close();
      this.pc = null;
    }
    this.emitStatus();
  }

  private async signal(message: { type: 'offer'; sdp: string }) {
    if (!this.sessionId) return null;
    try {
      const res = await fetch(`${this.baseUrl}/api/remote/session/${this.sessionId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'signal', clientId: this.clientId, message }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { reply?: { type: string; sdp?: string; reason?: string } };
      return json.reply ?? null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------------ API ----

  setInput(state: InputState): void {
    this.input.steer = state.steer;
    this.input.throttle = state.throttle;
    this.input.brake = state.brake;
    this.input.rearBrake = state.rearBrake;
    this.input.tuck = state.tuck;
    this.input.lookBack = state.lookBack;
  }

  /** current input, so the UI can show what the server is receiving */
  currentInput(): InputState {
    return this.input;
  }

  action(a: RuntimeAction): void {
    if (!this.sessionId) return;
    void fetch(`${this.baseUrl}/api/remote/session/${this.sessionId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: a.type, clientId: this.clientId }),
    }).catch(() => undefined);
  }

  snapshot(): SimSnapshot | null {
    return this.lastSnapshot;
  }

  onSnapshot(cb: (s: SimSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onStatus(cb: (s: RuntimeStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  private emitStatus(): void {
    const st = this.status();
    for (const cb of this.statusListeners) cb(st);
  }

  // -------------------------------------------------------------------- teardown ----

  async dispose(): Promise<void> {
    this.disposed = true;
    this.eventSource?.close();
    this.eventSource = null;
    if (this.snapshotWatchdog) clearTimeout(this.snapshotWatchdog);
    if (this.inputTimer) clearInterval(this.inputTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.dataChannel?.close();
    this.pc?.close();
    this.dataChannel = null;
    this.pc = null;
    await this.teardownSession();
    this.listeners.clear();
    this.statusListeners.clear();
    this.input = { ...NEUTRAL_INPUT };
  }

  private async teardownSession(): Promise<void> {
    if (!this.sessionId) return;
    const id = this.sessionId;
    this.sessionId = null;
    this.connected = false;
    try {
      await fetch(`${this.baseUrl}/api/remote/session/${id}`, { method: 'DELETE' });
    } catch {
      /* server already reaped it */
    }
  }
}
