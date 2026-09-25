/**
 * runtime/LocalRuntime.ts — the in-tab runtime.
 *
 * This is a thin adapter, not a second game: it exposes the existing
 * GameManager (same physics, traffic, rhythm gates, scoring, audio) through the
 * shared GameRuntime contract so the UI can treat local and remote play
 * identically. Nothing about local simulation behaviour changes.
 */

import type { GameManager, GameState } from '../core/Game';
import { detectClientCapabilities } from './capabilities';
import { createInputState, type InputState } from './InputState';
import type {
  GameRuntime,
  RuntimeAction,
  RuntimeCapabilities,
  RuntimeKind,
  RuntimeState,
  RuntimeStatus,
  SimSnapshot,
  StartOptions,
} from './types';

function mapState(s: GameState): RuntimeState {
  switch (s) {
    case 'boot':
    case 'menu':
    case 'search':
      return 'idle';
    case 'loading':
    case 'analyzing':
      return 'starting';
    case 'countdown':
      return 'countdown';
    case 'playing':
      return 'playing';
    case 'paused':
      return 'paused';
    case 'failed':
      return 'failed';
    case 'victory':
      return 'victory';
    default:
      return 'idle';
  }
}

export class LocalRuntime implements GameRuntime {
  readonly kind: RuntimeKind = 'local';
  private listeners = new Set<(s: SimSnapshot) => void>();
  private statusListeners = new Set<(s: RuntimeStatus) => void>();
  private input = createInputState();
  private lastSnapshot: SimSnapshot | null = null;
  private caps: RuntimeCapabilities;
  private lastKey = '';

  constructor(private game: GameManager) {
    this.caps = detectClientCapabilities();
  }

  capabilities(): RuntimeCapabilities {
    return this.caps;
  }

  status(): RuntimeStatus {
    return {
      kind: 'local',
      state: mapState(this.game.getState()),
      transport: 'local',
      connected: true,
      latencyMs: 0,
      streamLagMs: 0,
      displayFps: this.game.runtimeState().fps,
      sessionId: null,
      reason: null,
      capabilities: this.caps,
    };
  }

  async start(opts: StartOptions): Promise<void> {
    if (opts.song.source === 'youtube') {
      await this.game.startYouTube(opts.song.id);
      return;
    }
    if (opts.song.source === 'upload') return; // the UI owns the upload handle
    await this.game.startDemo();
  }

  setInput(state: InputState): void {
    this.input.steer = state.steer;
    this.input.throttle = state.throttle;
    this.input.brake = state.brake;
    this.input.rearBrake = state.rearBrake;
    this.input.tuck = state.tuck;
    this.input.lookBack = state.lookBack;
    this.game.setExternalInput(this.input);
  }

  action(a: RuntimeAction): void {
    switch (a.type) {
      case 'pause':
      case 'resume':
        this.game.togglePause();
        break;
      case 'restart':
        this.game.restart();
        break;
      case 'camera':
        this.game.setCamera();
        break;
      case 'menu':
        this.game.backToMenu();
        break;
    }
  }

  snapshot(): SimSnapshot {
    const snap = this.buildSnapshot();
    const key = `${snap.state}|${snap.scoring.score}|${snap.scoring.combo}|${Math.round(snap.bike.v)}|${snap.tick}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.lastSnapshot = snap;
      for (const cb of this.listeners) cb(snap);
      const status = this.status();
      for (const cb of this.statusListeners) cb(status);
    }
    return snap;
  }

  onSnapshot(cb: (snap: SimSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onStatus(cb: (s: RuntimeStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
    this.statusListeners.clear();
  }

  get last(): SimSnapshot | null {
    return this.lastSnapshot;
  }

  // ------------------------------------------------------------------ mapping ----

  private buildSnapshot(): SimSnapshot {
    const st = this.game.runtimeState();
    return {
      t: Date.now(),
      tick: st.tick,
      state: mapState(this.game.getState()),
      songTime: st.songTime,
      songDuration: st.songDuration,
      bike: st.bike,
      traffic: st.traffic,
      gates: st.gates,
      scoring: st.scoring,
      judgment: st.judgment,
      environment: {
        biome: st.biome,
        biomeName: st.biomeName,
        weather: st.weather,
        district: st.district,
        districtName: st.districtName,
        section: st.section,
      },
      lyrics: { line: '', nextTime: NaN },
      camera: { mode: st.cameraMode, fov: st.fov },
      music: {
        source: st.song.source,
        title: st.song.title,
        bpm: st.bpm,
        duration: st.songDuration,
        streamUrl: null,
      },
      perf: {
        serverFps: st.fps,
        simMs: 0,
        renderMs: 0,
        encodeMs: 0,
        clients: 1,
        framesDropped: 0,
      },
    };
  }
}
