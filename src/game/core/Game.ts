/**
 * GameManager — the game.
 *
 * State machine (deterministic):
 *   BOOT → MAIN_MENU → SEARCH → LOADING_AUDIO → ANALYZING → COUNTDOWN → PLAYING
 *          → PAUSED | FAILED | VICTORY (→ COUNTDOWN on retry, → MAIN_MENU)
 *
 * Timing architecture:
 *   - RENDER: requestAnimationFrame
 *   - PHYSICS: fixed 1/120 s accumulator with CCD substeps
 *   - MUSIC / GATES / JUDGMENTS / LYRICS / BIOMES: AudioDspClock
 *     (AudioContext.currentTime) — the ONLY authoritative timeline.
 *
 * Selected song flow: /api/stream (yt-dlp) → decodeAudioData → deterministic
 * DSP analysis (AudioAnalyzer) → chart (RhythmChart) → lane gates
 * (RhythmGates) reconciled against the audio clock every frame. A hard pause
 * suspends the AudioContext itself, so playback and the rhythm timeline can
 * never drift apart across a pause/resume.
 */

import * as THREE from 'three';
import { InputHandler } from './Input';
import { Highway } from '../environment/Highway';
import { WeatherController } from '../environment/Weather';
import { BiomeController, BIOME_NAMES } from '../environment/Biomes';
import { TrafficManager, NearMissEvent } from '../traffic/TrafficManager';
import { BikeController } from '../vehicle/BikeController';
import { MotorcycleAudio } from '../vehicle/BikeAudio';
import { DashboardDisplay } from '../vehicle/Dashboard';
import { CameraController } from '../camera/CameraController';
import { PostFX } from '../fx/PostFX';
import { TrafficLights } from '../traffic/TrafficLights';
import { StreetLights } from '../environment/StreetLights';
import { clamp, damp, kmh } from './utils';
import { Scoring, multiplierForCombo } from './Scoring';

import { AudioDspClock } from '../audio/AudioDspClock';
import { MusicEngine } from '../audio/MusicEngine';
import { AudioRhythm } from '../audio/AudioRhythm';
import { BufferPlayer } from '../audio/BufferPlayer';
import { SongLoader, SongLoadError, type LoadedSong } from '../audio/SongLoader';
import { analyzeBuffer, energyAt, sectionAt, type Analysis, type AnalysisSection } from '../audio/AudioAnalyzer';
import { buildChart, type RhythmChart } from '../rhythm/RhythmChart';
import { RhythmGates, type GateEvent } from '../rhythm/RhythmGates';
import { parseCueSheet, type ParsedCueSheet } from '../audio/CueSheetParser';
import { buildCueSheet, LOOP_SEC } from '../audio/cueSheet';
import {
  fetchLyrics,
  splitTitle,
  type SongMetadata,
  type TimedLyrics,
} from '../audio/SongResolver';
import { KineticLyricManager, type LyricCue } from '../rhythm/KineticLyricManager';

export type GameState =
  | 'boot'
  | 'menu'
  | 'search'
  | 'loading'
  | 'analyzing'
  | 'countdown'
  | 'playing'
  | 'paused'
  | 'failed'
  | 'victory';

export interface SongSelection {
  source: 'youtube' | 'upload' | 'demo';
  videoId: string;
  title: string;
  channel: string;
}

export interface Telemetry {
  state: GameState;
  speedKmh: number;
  rpm: number;
  gear: number;
  gearLabel: string;
  leanDeg: number;
  score: number;
  combo: number;
  multiplier: number;
  hp: number;
  hpFlash: boolean;
  perfects: number;
  goods: number;
  misses: number;
  crashes: number;
  bestCombo: number;
  accuracy: number;
  musicTime: number;
  songDuration: number;
  bpm: number;
  section: string;
  biome: string;
  fps: number;
  cameraMode: string;
  gamepad: boolean;
  countdown: number | null;
  song: SongSelection;
  analysisQuality: string;
  debug: {
    audioTime: number;
    beatPhase: number;
    subdivision: number;
    playerS: number;
    laneX: number;
    activeGates: number;
    nextGateTime: number;
    gateDelta: number;
    distanceKm: number;
    nearMisses: number;
  };
}

export interface GameCallbacks {
  onTelemetry?: (t: Telemetry) => void;
  onPopup?: (text: string, points: number, kind: string) => void;
  onStateChange?: (s: GameState) => void;
  onProgress?: (p: { phase: string; fraction: number; detail: string }) => void;
  onAnalysis?: (a: { bpm: number; duration: number; sections: number; quality: string; notes: number }) => void;
  getLyricContainer?: () => HTMLElement | null;
}

const PHYSICS_H = 1 / 120;
/** 3-2-1-GO: 2 bars @128 BPM — the demo synth's bar grid lands exactly on song t=0 */
const COUNTDOWN_SEC = 3.75;

/** section-kind → biome order for song mode (cycled per section) */
const SECTION_BIOME_CYCLE: Array<0 | 1 | 2 | 3> = [0, 2, 1, 3];

export class GameManager {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private input = new InputHandler();
  private highway: Highway;
  private weather: WeatherController;
  private biomes: BiomeController;
  private traffic: TrafficManager;
  private bike: BikeController;
  private audio = new MotorcycleAudio();
  private dashboard = new DashboardDisplay();
  private cam: CameraController;
  private postfx: PostFX;

  // ---- audio/rhythm stack ----
  private dspClock = new AudioDspClock();
  private music = new MusicEngine(this.dspClock);
  private rhythm: AudioRhythm | null = null;
  private bufferPlayer: BufferPlayer | null = null;
  private loader: SongLoader | null = null;
  private analysis: Analysis | null = null;
  private chart: RhythmChart | null = null;
  private gates: RhythmGates;
  private scoring = new Scoring();
  private lyrics: KineticLyricManager | null = null;
  private lyricContainer: HTMLElement | null = null;

  // ---- session (selected song identity) ----
  private sessionToken = 0;
  private loadedSong: LoadedSong | null = null;
  private songMeta: SongMetadata | null = null;
  private songLyrics: TimedLyrics | null = null;
  private selection: SongSelection = {
    source: 'demo',
    videoId: '',
    title: 'MIDNIGHT RUNNER — C1 Inner Loop',
    channel: 'built-in synthwave',
  };
  private nearMissCount = 0;

  state: GameState = 'boot';
  /** recent state transitions (debug/smoke-test aid) */
  readonly stateLog: Array<{ t: number; from: string; to: string }> = [];

  // crash / fail choreography
  private failTimer = 0;
  private crashingOut = false;

  // loop
  private rafId = 0;
  private lastT = 0;
  private lastAudioT = 0; // DSP-clock sim-time baseline
  private time = 0;
  private fps = 60;
  private telemetryTimer = 0;
  private running = false;
  private physicsAccum = 0;

  private appliedBiome = -1;
  private appliedPreset = -1;
  private lastSectionIndex = -1;
  private menuBiomeTimer = 0;

  private qualityTier = 2;
  private lowFpsTimer = 0;

  private tmpVel = new THREE.Vector3();
  private tmpFwd = new THREE.Vector3(0, 0, 1);
  private trafficLights: TrafficLights;
  private streetLights: StreetLights;
  private demoLyricCues: LyricCue[] = [];

  constructor(private canvas: HTMLCanvasElement, private callbacks: GameCallbacks = {}) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.highway = new Highway(this.scene);
    this.weather = new WeatherController(this.renderer, this.scene, this.highway.mats);
    this.biomes = new BiomeController(this.scene, this.highway, this.weather);
    this.biomes.buildPools();
    this.traffic = new TrafficManager(this.highway, this.scene);
    this.trafficLights = new TrafficLights(this.scene);
    this.streetLights = new StreetLights(this.scene);
    this.bike = new BikeController(this.highway, this.scene);
    this.cam = new CameraController(this.scene, window.innerWidth / Math.max(1, window.innerHeight));
    this.cam.attachMirrors(this.bike);
    this.weather.setRainLayer(this.cam.camera);
    this.postfx = new PostFX(this.renderer, this.scene, this.cam.camera, window.innerWidth, window.innerHeight);

    const dashMat = new THREE.MeshBasicMaterial({ map: this.dashboard.texture });
    this.bike.joints.dashboard.material = dashMat;

    // lane rhythm gates
    this.gates = new RhythmGates(this.scene, this.highway);

    // traffic ↔ game wiring (+ gate de-confliction §28)
    this.traffic.onNearMiss = (e) => this.handleNearMiss(e);
    this.traffic.onCollision = () => this.handleImpact();
    this.traffic.gateGuard = (lane, s, playerS, playerV) => this.gateZoneFree(lane, s, playerS, playerV);

    this.lyricContainer = callbacks.getLyricContainer?.() ?? null;
    if (this.lyricContainer) {
      this.lyrics = new KineticLyricManager(this.lyricContainer);
      this.lyrics.onWordHighlight = () => this.postfx.bloomPulse(0.35);
    }

    // demo rhythm sheet (synth track) — also drives menu attract world
    this.attachDemoRhythm();

    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);

    this.traffic.reset(this.bike.s);
    this.weather.setPreset(0, true);
    this.appliedPreset = 0;
    this.biomes.setBiome(2, true); // sakura twilight menu backdrop
    this.appliedBiome = 2;

    if (process.env.NODE_ENV === 'development') {
      (window as unknown as { __game: GameManager }).__game = this;
    }
    this.setState('menu');
    this.startAttract();
  }

  // ------------------------------------------------------------------ prep ----
  private attachDemoRhythm(): void {
    const sheet = parseCueSheet(buildCueSheet());
    this.rhythm = new AudioRhythm(sheet, this.dspClock);
    this.demoLyricCues = sheet.getCuesOfType('lyric').map((c) => ({
      time: c.time,
      text: c.text ?? '',
      stagger: true,
    }));
    this.lyrics?.build(this.demoLyricCues);
    this.chart = null;
    this.gates.setChart(null, this.dspClock.getAudioTime());
    this.analysis = null;
  }

  /** fabricate a deterministic Analysis from the authored demo cue sheet so the
   *  SAME chart pipeline (quantize → lanes) powers the demo track. */
  private demoAnalysis(): Analysis {
    const sheet = parseCueSheet(buildCueSheet());
    const beatSec = 60 / 128;
    const duration = LOOP_SEC;
    const onsets: Analysis['onsets'] = [];
    const sectionEnergy = (t: number) => {
      const bar = Math.floor(t / (beatSec * 4));
      const secs = [
        { start: 0, e: 0.3 },
        { start: 16, e: 0.62 },
        { start: 44, e: 1.0 },
        { start: 68, e: 0.92 },
        { start: 88, e: 0.3 },
      ];
      let e = 0.3;
      for (let i = 0; i < secs.length; i++) {
        if (bar >= secs[i].start) e = secs[i].e;
      }
      return e;
    };
    for (let bar = 0; bar < 88; bar++) {
      const barT = bar * beatSec * 4;
      const e = sectionEnergy(barT);
      for (let q = 0; q < 8; q++) {
        const t = barT + q * (beatSec / 2);
        if (q % 2 === 0) {
          onsets.push({ time: t, strength: (q === 0 ? 1.0 : 0.65) * (0.4 + e), band: 'bass' });
        } else if (e > 0.55) {
          onsets.push({ time: t, strength: 0.5 * e, band: 'mid' });
        }
      }
    }
    onsets.sort((a, b) => a.time - b.time);
    const energy = new Float32Array(Math.ceil(duration / 0.1));
    for (let i = 0; i < energy.length; i++) energy[i] = sectionEnergy(i * 0.1);
    const sections: AnalysisSection[] = [
      { start: 0, end: 30, energy: 0.3, kind: 'intro' },
      { start: 30, end: 82.5, energy: 0.62, kind: 'verse' },
      { start: 82.5, end: 126, energy: 1.0, kind: 'drop' },
      { start: 126, end: 165, energy: 0.92, kind: 'chorus' },
    ];
    return {
      duration,
      sampleRate: 44100,
      bpm: 128,
      firstBeat: 0,
      beatSec,
      onsets,
      energy,
      energyDt: 0.1,
      sections,
      quality: 'ok',
    };
  }

  /** MAIN_MENU → search overlay (pure UI state; world keeps attract mode) */
  openSearch(): void {
    if (this.state === 'menu') this.setState('search');
  }
  closeSearch(): void {
    if (this.state === 'search') this.setState('menu');
  }

  /** quick start: built-in synthwave demo track */
  async startDemo(): Promise<void> {
    this.sessionToken++;
    this.clearSongSession();
    this.selection = { source: 'demo', videoId: '', title: 'MIDNIGHT RUNNER — C1 Inner Loop', channel: 'built-in synthwave' };
    this.analysis = this.demoAnalysis();
    this.chart = buildChart(this.analysis);
    this.emitAnalysis(this.chart);
    this.gates.setChart(this.chart, 0);
    await this.unlockAudio();
    if (!this.musicStarted) {
      this.dspClock.attach(this.audio.context!);
      this.musicStarted = true;
    }
    this.beginCountdown();
  }

  /** search result picked → load + decode + analyze → countdown */
  async startYouTube(videoId: string): Promise<void> {
    const token = ++this.sessionToken;
    this.clearSongSession();
    this.selection = { source: 'youtube', videoId, title: 'Loading…', channel: '' };
    this.setState('loading');
    await this.unlockAudio();
    const ctx = this.audio.context;
    if (!ctx) {
      this.failPrep('Audio context unavailable — click the page and retry.');
      return;
    }
    this.loader = new SongLoader(ctx);
    let song: LoadedSong;
    try {
      song = await this.loader.loadYouTube(videoId, (p) => {
        if (token !== this.sessionToken) return;
        this.callbacks.onProgress?.({
          phase: p.phase,
          fraction: p.fraction,
          detail: p.phase === 'fetch' ? `streaming ${(p.received / 1048576).toFixed(1)} MB` : 'decoding audio…',
        });
      });
    } catch (e) {
      if (token !== this.sessionToken) return;
      const msg = e instanceof SongLoadError ? e.message : 'unknown load error';
      this.failPrep(`Song load failed — ${msg}`);
      return;
    }
    if (token !== this.sessionToken) return;
    this.loadedSong = song;
    this.selection.title = song.title || `YouTube · ${videoId}`;
    this.selection.channel = song.channel;

    await this.analyzeAndChart(song, token);
  }

  /** uploaded file picked → decode + analyze → countdown */
  async startUpload(file: File): Promise<void> {
    const token = ++this.sessionToken;
    this.clearSongSession();
    this.selection = { source: 'upload', videoId: '', title: file.name, channel: 'local upload' };
    this.setState('loading');
    await this.unlockAudio();
    const ctx = this.audio.context;
    if (!ctx) {
      this.failPrep('Audio context unavailable — click the page and retry.');
      return;
    }
    this.loader = new SongLoader(ctx);
    try {
      const song = await this.loader.loadUpload(file, (p) => {
        if (token !== this.sessionToken) return;
        this.callbacks.onProgress?.({
          phase: p.phase,
          fraction: p.fraction,
          detail: p.phase === 'fetch' ? `reading ${(p.received / 1048576).toFixed(1)} MB` : 'decoding audio…',
        });
      });
      if (token !== this.sessionToken) return;
      this.loadedSong = song;
      this.selection.title = song.title;
      await this.analyzeAndChart(song, token);
    } catch (e) {
      if (token !== this.sessionToken) return;
      const msg = e instanceof SongLoadError ? e.message : 'unknown load error';
      this.failPrep(`Upload failed — ${msg}`);
    }
  }

  /** decode → deterministic analysis → chart → lyric fetch → countdown */
  private async analyzeAndChart(song: LoadedSong, token: number): Promise<void> {
    this.setState('analyzing');
    this.callbacks.onProgress?.({ phase: 'analyze', fraction: 0.35, detail: 'analyzing beats & onsets…' });
    // yield a frame so the overlay paints before the (heavy, synchronous) FFT
    await new Promise((r) => setTimeout(r, 30));
    if (token !== this.sessionToken) return;

    const analysis = analyzeBuffer(song.buffer);
    if (token !== this.sessionToken) return;
    this.analysis = analysis;
    this.chart = buildChart(analysis);
    this.gates.setChart(this.chart, 0);
    this.emitAnalysis(this.chart);

    // song metadata + synced lyrics (never invented — resolved or unavailable)
    const meta: SongMetadata = {
      videoId: song.videoId,
      title: song.title,
      channel: song.channel,
      artist: '',
      track: song.title,
      duration: song.duration,
      durationResolved: true,
    };
    const parts = splitTitle(song.title, song.channel);
    meta.artist = parts.artist;
    meta.track = parts.track;
    this.songMeta = meta;
    void this.resolveLyrics(token);

    this.callbacks.onProgress?.({ phase: 'analyze', fraction: 1, detail: 'ready' });
    this.beginCountdown();
  }

  private emitAnalysis(chart: RhythmChart): void {
    this.callbacks.onAnalysis?.({
      bpm: chart.bpm,
      duration: chart.duration,
      sections: chart.sections.length,
      quality: this.analysis?.quality ?? 'ok',
      notes: chart.notes.length,
    });
  }

  private async resolveLyrics(token: number): Promise<void> {
    const meta = this.songMeta;
    if (!meta) return;
    const resolved = await fetchLyrics(meta);
    if (token !== this.sessionToken) return;
    this.songLyrics = resolved;
    if (resolved.source === 'unavailable') {
      this.lyrics?.build([]);
    } else {
      const cues: LyricCue[] = resolved.lines.map((l) => ({
        time: l.start,
        end: l.end,
        text: l.text,
        words: l.words ? l.words.map((w) => ({ start: w.start, text: w.text })) : undefined,
        stagger: false,
      }));
      this.lyrics?.build(cues);
    }
  }

  private failPrep(message: string): void {
    this.callbacks.onPopup?.(message, 0, 'songError');
    this.setState('menu');
  }

  private musicStarted = false;

  private async unlockAudio(): Promise<void> {
    this.audio.start();
    this.audio.resume();
    if (this.audio.context) {
      this.dspClock.attach(this.audio.context);
      if (!this.bufferPlayer) {
        this.bufferPlayer = new BufferPlayer(this.dspClock);
        this.bufferPlayer.onEnded = () => this.onSongEnded();
      }
      this.bufferPlayer.attach(this.audio.context, this.audio.context.destination, this.songVolume);
      if (!this.loader) this.loader = new SongLoader(this.audio.context);
    }
  }

  private songVolume = 0.9;

  // ------------------------------------------------------------ countdown ----
  private beginCountdown(): void {
    this.audio.context?.resume(); // restart/retry from pause: clock must run again
    // reset run + world
    this.resetRun();
    this.setState('countdown');
    if (!this.running) {
      this.running = true;
      this.lastT = performance.now();
      this.rafId = requestAnimationFrame(this.loop);
    }
    const ctx = this.audio.context;
    if (!ctx) return;
    // epoch anchored so the timeline reads −COUNTDOWN_SEC now; music starts at t=0
    if (this.selection.source === 'demo') {
      this.dspClock.setEpochTo(-COUNTDOWN_SEC);
      if (!this.musicStarted) {
        this.dspClock.attach(ctx);
        this.musicStarted = true;
      }
      if (!this.demoMusicOn) {
        // aligns the synth's step grid to the (already re-anchored) clock:
        // bars land exactly on song t=0 because the countdown is 2 whole bars
        this.music.start(ctx, ctx.destination);
        this.demoMusicOn = true;
      }
      this.music.setVolume(this.musicEnabled ? this.songVolume : 0);
      this.music.setEnabled(this.musicEnabled);
      this.music.setPaused(false);
    } else if (this.loadedSong && this.bufferPlayer) {
      this.bufferPlayer.load(this.loadedSong.buffer);
      this.bufferPlayer.setVolume(this.musicEnabled ? this.songVolume : 0);
      // song t=0 lands exactly when the countdown expires (DSP-anchored)
      this.bufferPlayer.playScheduled(COUNTDOWN_SEC - 0.12);
    }
    this.gates.reset(this.dspClock.getAudioTime());
    this.lastAudioT = this.dspClock.getAudioTime(); // sim-time baseline for the run
  }

  private startPlaybackAtZero(): void {
    // safety net: if the demo synth was never started during the countdown,
    // start it now (grid offset ≤ half a beat — still beat-aligned)
    if (this.selection.source === 'demo' && !this.demoMusicOn && this.audio.context) {
      this.music.start(this.audio.context, this.audio.context.destination);
      this.demoMusicOn = true;
      this.music.setVolume(this.musicEnabled ? this.songVolume : 0);
      this.music.setEnabled(this.musicEnabled);
    }
  }
  private demoMusicOn = false;
  private musicEnabled = true;

  // ------------------------------------------------------------- run reset ----
  private resetRun(): void {
    this.bike.respawn(60, 2);
    this.traffic.reset(this.bike.s);
    this.scoring.reset();
    this.nearMissCount = 0;
    this.crashingOut = false;
    this.failTimer = 0;
    this.physicsAccum = 0;
    this.appliedBiome = -1;
    this.appliedPreset = -1;
    this.lastSectionIndex = -1;
    this.postfx.setFade(0);
    this.postfx.flash(0.25, new THREE.Color(0.2, 0.2, 0.3));
  }

  // ------------------------------------------------------------ song session ----
  private clearSongSession(): void {
    this.bufferPlayer?.pause();
    this.loadedSong = null;
    this.songMeta = null;
    this.songLyrics = null;
    this.analysis = null;
    this.chart = null;
    this.music.setEnabled(true);
    if (this.selection.source === 'demo' || this.state === 'menu' || this.state === 'search') {
      this.attachDemoRhythm();
    }
  }

  // --------------------------------------------------------------- public ----
  /** attract mode: render world behind the menu (auto cruise, no scoring) */
  startAttract(): void {
    if (this.running) return;
    this.running = true;
    this.lastT = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  togglePause(): void {
    if (this.state === 'playing') {
      this.setState('paused');
      this.audio.context?.suspend(); // freezes the DSP clock + every source
    } else if (this.state === 'paused') {
      this.setState('playing');
      this.audio.context?.resume();
    }
    // note: pause is intentionally unavailable during countdown — the scheduled
    // song start + epoch are aligned to the countdown; resuming mid-countdown
    // would need a re-schedule. Countdown is 3.3 s.
  }

  setCamera(): void {
    this.cam.toggle();
  }

  setMusicVolume(v: number): void {
    this.songVolume = v;
    if (this.selection.source === 'demo') {
      this.music.setVolume(v);
    } else {
      this.bufferPlayer?.setVolume(this.musicEnabled ? v : 0);
    }
    this.audio.setVolume(v);
  }

  setMusicEnabled(on: boolean): void {
    this.musicEnabled = on;
    if (this.selection.source === 'demo') this.music.setEnabled(on);
    else this.bufferPlayer?.setVolume(on ? this.songVolume : 0);
  }

  retry(): void {
    if (this.state === 'failed' || this.state === 'victory') this.beginCountdown();
  }

  /** R key: restart the current run from the countdown (any active state) */
  restart(): void {
    if (this.state === 'playing' || this.state === 'paused' || this.state === 'failed' || this.state === 'victory') {
      this.beginCountdown();
    }
  }

  backToMenu(): void {
    this.sessionToken++;
    this.bufferPlayer?.pause();
    this.setState('menu');
    this.resetRun();
    this.traffic.reset(this.bike.s);
  }

  get currentSelection(): SongSelection {
    return this.selection;
  }

  getState(): GameState {
    return this.state;
  }

  // ------------------------------------------------------------------ private ----
  private setState(s: GameState) {
    if (s !== this.state) {
      this.stateLog.push({ t: this.time, from: this.state, to: s });
      if (this.stateLog.length > 24) this.stateLog.shift();
    }
    this.state = s;
    this.callbacks.onStateChange?.(s);
  }

  /** §28: is (lane, s) clear of an upcoming gate's target lane/time window? */
  private gateZoneFree(lane: number, s: number, playerS: number, playerV: number): boolean {
    const chart = this.chart;
    if (!chart || playerV < 1) return true;
    const lead = (s - playerS) / Math.max(8, playerV);
    const window = 1.5; // ±1.5 s of a gate's intended crossing time
    // notes are sorted; binary-search-ish scan near the candidate time
    const tNow = this.dspClock.getAudioTime();
    const tCand = tNow + lead;
    for (const n of chart.notes) {
      if (n.time < tCand - window) continue;
      if (n.time > tCand + window) break;
      if (n.lane === lane) return false;
    }
    return true;
  }

  private handleNearMiss(e: NearMissEvent) {
    if (this.state !== 'playing') return;
    this.nearMissCount++;
    const pts = Math.round(e.points * this.scoring.multiplier);
    this.scoring.score += pts;
    const label = e.kind === 'laneSplit' ? 'LANE SPLIT' : e.kind === 'close' ? 'CLOSE CALL' : 'NEAR MISS';
    this.callbacks.onPopup?.(label, pts, e.kind);
    this.audio.whoosh(e.side, e.heavy, e.strong ? 1 : 0.5);
    this.cam.addTrauma(e.strong ? 0.32 : 0.1);
    if (e.strong) {
      this.postfx.bloomPulse(0.25);
      this.cam.addFovKick(1.5, 0.15);
    }
  }

  /** civilian collision: damage + speed cut + 1.2 s invulnerability (§19) */
  private handleImpact(): void {
    if (this.state !== 'playing') return;
    const damaged = this.scoring.applyCrash(0.4);
    if (!damaged) return; // invulnerable — ignore repeat hits
    this.bike.model.v *= 0.4; // speed × 0.40
    this.audio.crash();
    this.cam.addTrauma(1.0);
    this.postfx.flash(0.7, new THREE.Color(1.0, 0.15, 0.08));
    this.postfx.chromaBurst(0.8);
    this.callbacks.onPopup?.('CRASH −25 HP', 0, 'crash');
    if (this.scoring.dead) this.enterFailed();
  }

  private handleGateEvents(events: GateEvent[]): void {
    for (const ev of events) {
      if (ev.judgment === 'perfect') {
        this.scoring.addJudgment('perfect');
        this.audio.gatePing(true);
        if (this.selection.source === 'demo') (this.music as unknown as { duck?: (a: number, s: number) => void }).duck?.(0.3, 0.4);
        else this.bufferPlayer?.duck(0.3, 0.4);
        this.postfx.bloomPulse(0.55);
        this.postfx.flash(0.16, new THREE.Color(0.5, 0.8, 1.2));
        this.cam.addFovKick(3, 0.12);
        this.cam.addTrauma(0.14);
        this.callbacks.onPopup?.(
          this.scoring.combo > 1 ? `PERFECT +${1000}` : 'PERFECT',
          Math.round(1000 * this.scoring.multiplier),
          'gatePerfect',
        );
      } else if (ev.judgment === 'good') {
        this.scoring.addJudgment('good');
        this.audio.gatePing(false);
        this.postfx.bloomPulse(0.2);
        this.callbacks.onPopup?.('GOOD', Math.round(500 * this.scoring.multiplier), 'gateGood');
      } else {
        this.scoring.addJudgment('miss');
        this.callbacks.onPopup?.('MISS −4 HP', 0, 'gateMiss');
        this.cam.addTrauma(0.18);
      }
      if (this.scoring.dead) this.enterFailed();
    }
  }

  private enterFailed(): void {
    if (this.state !== 'playing' && this.state !== 'countdown') return;
    this.crashingOut = true;
    this.failTimer = 0;
    this.bike.crash();
    this.setState('failed');
    this.audio.context?.resume(); // ensure audio graph runs for the crash sfx
  }

  private onSongEnded(): void {
    if (this.state === 'playing' || this.state === 'countdown') {
      if (this.scoring.hp > 0) {
        this.setState('victory');
      } else {
        this.enterFailed();
      }
    }
  }

  private updateRespawnlessFail(dt: number): void {
    this.failTimer += dt;
    if (this.failTimer > 1.2 && this.failTimer - dt <= 1.2) {
      this.postfx.setFade(0.55);
    }
  }

  private onResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.cam.resize(w / Math.max(1, h));
    this.postfx.resize(w, h);
  };

  private onVisibility = () => {
    if (document.hidden && this.state === 'playing') this.togglePause();
  };

  private loop = (t: number) => {
    this.rafId = requestAnimationFrame(this.loop);
    const rawDt = (t - this.lastT) / 1000;
    this.lastT = t;
    // §8: gameplay time derives from the DSP hardware clock, NOT rAF deltas —
    // physics can never fall behind the music timeline at low render FPS.
    let dt: number;
    const audioNow = this.dspClock.getAudioTime();
    if (this.dspClock.isRunning && Number.isFinite(audioNow)) {
      dt = clamp(audioNow - this.lastAudioT, 0, 1.0);
      this.lastAudioT = audioNow;
    } else {
      // no timeline yet (boot/menu before first run): fall back to real time
      dt = clamp(rawDt, 0.0005, 0.25);
    }
    if (rawDt > 0) this.fps = damp(this.fps, 1 / rawDt, 3, dt);
    this.time += dt;

    this.adaptQuality(clamp(rawDt, 0, 1));
    if (this.state === 'paused') {
      // input must keep polling while paused so ESC can resume
      const ev = this.input.update(dt);
      if (ev.togglePause) this.togglePause();
      if (ev.restart) this.restart();
    } else {
      this.tick(dt);
    }
    this.render();
  };

  private adaptQuality(realDt: number) {
    if (this.qualityTier <= 0) return;
    if (this.fps < 28 && this.running) {
      this.lowFpsTimer += realDt;
      if (this.lowFpsTimer > 2.0) {
        this.lowFpsTimer = 0;
        this.qualityTier--;
        const w = window.innerWidth;
        const h = window.innerHeight;
        if (this.qualityTier === 1) {
          this.renderer.setPixelRatio(1);
          this.renderer.setSize(w, h, false);
          this.renderer.shadowMap.enabled = false;
          this.weather.setShadowsEnabled(false);
          this.weather.envEnabled = false;
          this.postfx.rebuild(this.renderer, w, h, 0);
          this.cam.mirrorEvery = 3;
        } else if (this.qualityTier === 0) {
          this.renderer.setPixelRatio(0.75);
          this.renderer.setSize(w, h, false);
          this.postfx.rebuild(this.renderer, w, h, 0);
          this.cam.mirrorEvery = 4;
        }
      }
    } else {
      this.lowFpsTimer = Math.max(0, this.lowFpsTimer - realDt * 0.5);
    }
  }

  // ------------------------------------------------------------- main tick ----
  private tick(dt: number): void {
    const events = this.input.update(dt);

    if (events.toggleCamera && this.state === 'playing') this.cam.toggle();
    if (events.togglePause && (this.state === 'playing' || this.state === 'paused')) this.togglePause();
    if (events.restart) this.restart();

    // §8: read the DSP clock AFTER event handling — a same-frame restart
    // re-anchors the epoch, and the countdown branch must see the fresh value
    // (a stale positive audioT here would instantly skip the countdown and
    // desync the music grid from the reset chart).
    const audioT = this.dspClock.getAudioTime();

    // ---- countdown tick ----
    if (this.state === 'countdown') {
      const cd = Math.ceil(-audioT);
      if (audioT >= -0.06) {
        this.startPlaybackAtZero();
        this.setState('playing');
      } else {
        // hold the bike steady, revving
        this.physicsAccum += dt;
        let steps = 0;
        while (this.physicsAccum >= PHYSICS_H && steps < 12) {
          this.bike.step(PHYSICS_H, { throttle: 0.25, brake: 1, rearBrake: 0, steer: 0, tuck: false, lookBack: false });
          this.physicsAccum -= PHYSICS_H;
          steps++;
        }
        void cd;
      }
    }

    const snapshot = {
      throttle: this.input.throttle,
      brake: this.input.brake,
      rearBrake: this.input.rearBrake,
      steer: this.input.steer,
      tuck: this.input.tuckActive,
      lookBack: this.input.lookBack,
    };

    let ev: ReturnType<typeof this.bike.step> | undefined;
    if (this.state === 'playing' || this.state === 'failed' || this.state === 'victory') {
      // failed/victory: coast to a stop (no input)
      const frozen = this.state !== 'playing';
      const snap = frozen ? { throttle: 0, brake: 0.4, rearBrake: 0.6, steer: 0, tuck: false, lookBack: false } : snapshot;

      this.physicsAccum += dt;
      let steps = 0;
      // step cap must cover the sim-dt clamp (1.0 s → 120 steps): a lower cap
      // silently desyncs bike.s from the audio timeline at low frame rates.
      while (this.physicsAccum >= PHYSICS_H && steps < 120) {
        const stepEv = this.bike.step(PHYSICS_H, snap);
        ev = stepEv;
        this.physicsAccum -= PHYSICS_H;
        steps++;
        if (!frozen && stepEv.barrierHit) this.handleImpact();
        if (!frozen && this.traffic.collideAndScore(this.bike, PHYSICS_H)) break;
      }
      if (steps === 120) this.physicsAccum = 0;

      if (this.state === 'playing') {
        this.scoring.tick(dt);
        // score trickle: distance + speed bonus
        this.scoring.score += dt * this.bike.v * 0.6 * (this.bike.v > 55.6 ? 1.5 : 1);

        // ---- rhythm: gates judged against the DSP clock ----
        const gateEvents = this.gates.update(dt, audioT, this.bike.s, this.bike.v, this.bike.x);
        this.handleGateEvents(gateEvents);

        // ---- biome switching on musical sections (§25/§26) ----
        this.updateBiomes(audioT);

        // ---- beat-reactive world (FOV kicks, light pulses, embers) ----
        this.tickBeatReactions(audioT);

        // ---- lyrics ----
        const lyricT = this.selection.source === 'demo' ? ((audioT % LOOP_SEC) + LOOP_SEC) % LOOP_SEC : audioT;
        this.lyrics?.update(lyricT);

        // song end detection (buffer playback) — onEnded also covers it
        if (this.selection.source !== 'demo' && this.analysis && audioT >= this.analysis.duration - 0.05 && this.bike.v < 1) {
          this.onSongEnded();
        }
      }
    } else if (this.state === 'menu' || this.state === 'search' || this.state === 'loading' || this.state === 'analyzing') {
      // attract mode: gentle cruise
      this.physicsAccum += dt;
      let steps = 0;
      while (this.physicsAccum >= PHYSICS_H && steps < 12) {
        this.bike.step(PHYSICS_H, { ...snapshot, throttle: 0.42, brake: 0, rearBrake: 0 });
        this.physicsAccum -= PHYSICS_H;
        steps++;
      }
      this.traffic.collideAndScore(this.bike, dt);
      this.menuBiomeTimer += dt;
      if (this.menuBiomeTimer > 22) {
        this.menuBiomeTimer = 0;
        const next = (this.appliedBiome + 1) % 4;
        this.biomes.setBiome(next, true);
        this.appliedBiome = next;
      }
    } else if ((this.state as GameState) === 'failed') {
      this.updateRespawnlessFail(dt);
    }

    // shared world update (everything except paused)
    this.traffic.update(dt, this.bike.s, this.bike.v);
    this.highway.update(this.bike.s, dt);
    this.highway.tick(this.time);
    this.bike.updateVisuals(dt, this.time, this.cam.mode === 'cockpit');

    this.tmpFwd.set(Math.sin(this.bike.worldYaw), 0, Math.cos(this.bike.worldYaw));
    this.tmpVel.copy(this.tmpFwd).multiplyScalar(this.bike.v);
    this.weather.cacheTrafficSpray(this.traffic);
    this.weather.frameIdx++;
    this.traffic.rainBoost = this.weather.rainAmount;
    this.biomes.update(dt, this.bike.s, this.bike.worldPos, this.cam.camera.position.y);
    this.weather.update(dt, this.bike.worldPos, this.tmpFwd, this.tmpVel, this.bike, this.traffic, this.highway, this.cam.camera);
    // real dynamic lights (§7/§30): nearest traffic + streetlamp pools
    this.trafficLights.intensity = this.weather.headlightsOn ? 1 : 0;
    this.trafficLights.update(dt, this.bike.worldPos, this.traffic);
    this.streetLights.intensity = this.weather.headlightsOn ? 1 : 0;
    this.streetLights.update(dt, this.highway, this.bike.s);

    const tel = this.bike.telemetry();
    this.dashboard.update(dt, tel.rpm, tel.speedKmh, tel.gear, this.scoring.combo, tel.rpm > 14200 && this.input.throttle > 0.4);
    this.audio.update(dt, {
      rpm: tel.rpm,
      throttle: this.state === 'playing' ? snapshot.throttle : this.state === 'countdown' ? 0.25 : 0,
      speedKmh: tel.speedKmh,
      tuck: this.bike.tuck,
      limiter: this.bike.limiterCut,
      rain: this.weather.rainAmount,
      crashed: this.crashingOut,
      shifting: this.bike.model.shiftTimer > 0,
      gear: tel.gear,
    });
    this.renderer.toneMappingExposure = damp(this.renderer.toneMappingExposure, this.weather.postState().exposure, 4, dt);

    this.cam.update(dt, this.bike, {
      lookBack: this.input.lookBack,
      tuck: this.input.tuckActive,
      accel: this.bike.model.aLong,
      brakeInput: this.input.brake,
    });

    const post = this.weather.postState();
    this.postfx.update(dt, {
      speedKmh: this.crashingOut ? 0 : kmh(this.bike.v),
      bloom: post.bloom,
      saturation: post.saturation,
      contrast: post.contrast,
      rain: post.rain,
      vignette: post.vignette,
    });

    // demo synth beat scheduling (demo mode only)
    if (this.selection.source === 'demo' && this.demoMusicOn && this.state === 'playing') this.music.pump();

    // telemetry to React at 12 Hz
    this.telemetryTimer += dt;
    if (this.telemetryTimer > 1 / 12) {
      this.telemetryTimer = 0;
      this.emitTelemetry(tel, audioT);
    }
  }

  /** FOV kicks on beats + weather preset tracking for demo mode */
  private tickBeatReactions(audioT: number): void {
    if (!this.rhythm) return;
    this.rhythm.update();
    const beats = this.rhythm.drainBeatEvents();
    const energy = this.selection.source === 'demo' ? this.rhythm.getEnergy() : this.analysis ? energyAt(this.analysis, audioT) : 0.6;
    for (const beat of beats) {
      const kick = beat.major ? 3 : 1.6;
      this.cam.addFovKick(kick * (0.5 + energy * 0.5), 0.12);
      this.weather.pulse(0.08);
      if (beat.major && energy > 0.8) this.cam.addTrauma(0.08);
    }
    this.weather.emberBoost = energy > 0.8 ? 4.0 : 1.0;
    this.weather.emberFloor = energy > 0.8 ? 0.22 : 0;

    // demo mode: weather hard cuts ride the authored cue sheet
    if (this.selection.source === 'demo') {
      const loopSec = this.rhythm.loopSec > 0 ? this.rhythm.loopSec : LOOP_SEC;
      const tLoop = ((audioT % loopSec) + loopSec) % loopSec;
      const presetTimes = this.rhythm.getTypeTimes('preset');
      let presetIdx = -1;
      for (let i = presetTimes.length - 1; i >= 0; i--) {
        if (presetTimes[i] <= tLoop) {
          presetIdx = i;
          break;
        }
      }
      if (presetIdx >= 0 && presetIdx !== this.appliedPreset) {
        this.appliedPreset = presetIdx;
        this.weather.setPreset(presetIdx, true);
        const biomeForPreset = [2, 3, 1, 0][presetIdx] as 0 | 1 | 2 | 3;
        this.biomes.setBiome(biomeForPreset, true);
        this.appliedBiome = biomeForPreset;
      }
    }
  }

  /** song mode: switch biome on analysis section changes (cycled, deterministic) */
  private updateBiomes(audioT: number): void {
    if (this.selection.source === 'demo' || !this.analysis) return;
    const secs = this.analysis.sections;
    let idx = 0;
    for (let i = 0; i < secs.length; i++) {
      if (audioT >= secs[i].start) idx = i;
      else break;
    }
    if (idx !== this.lastSectionIndex) {
      const first = this.lastSectionIndex === -1;
      this.lastSectionIndex = idx;
      if (!first) {
        const biome = SECTION_BIOME_CYCLE[idx % SECTION_BIOME_CYCLE.length];
        this.biomes.setBiome(biome, true); // musical, instantaneous cut (§26)
        this.appliedBiome = biome;
        this.callbacks.onPopup?.(`⟹ ${BIOME_NAMES[biome]}`, 0, 'biome');
      } else {
        this.appliedBiome = SECTION_BIOME_CYCLE[0];
        this.biomes.setBiome(this.appliedBiome, true);
      }
    }
  }

  private emitTelemetry(tel: ReturnType<typeof this.bike.telemetry>, audioT: number): void {
    const s = this.scoring;
    const total = s.perfects + s.goods + s.misses;
    const sectionName =
      this.selection.source === 'demo'
        ? (this.rhythm?.getSectionName() ?? '—')
        : this.analysis
          ? sectionAt(this.analysis, Math.max(0, audioT)).kind
          : '—';
    this.callbacks.onTelemetry?.({
      state: this.state,
      speedKmh: tel.speedKmh,
      rpm: tel.rpm,
      gear: tel.gear,
      gearLabel: tel.gearLabel,
      leanDeg: tel.leanDeg,
      score: Math.floor(s.score),
      combo: s.combo,
      multiplier: multiplierForCombo(s.combo),
      hp: Math.max(0, s.hp),
      hpFlash: s.hpFlash > 0,
      perfects: s.perfects,
      goods: s.goods,
      misses: s.misses,
      crashes: s.crashes,
      bestCombo: s.bestCombo,
      accuracy: total > 0 ? (s.perfects + s.goods) / total : 0,
      musicTime: Math.max(0, audioT),
      songDuration: this.analysis?.duration ?? LOOP_SEC,
      bpm: this.analysis?.bpm ?? 128,
      section: sectionName,
      biome: BIOME_NAMES[Math.max(0, this.appliedBiome)],
      fps: this.fps,
      cameraMode: this.cam.mode,
      gamepad: this.input.gamepadConnected,
      countdown: this.state === 'countdown' ? Math.min(3, Math.max(1, Math.ceil(-audioT))) : null,
      song: { ...this.selection },
      analysisQuality: this.analysis?.quality ?? '—',
      debug: {
        audioTime: +audioT.toFixed(3),
        beatPhase: this.rhythm ? +this.rhythm.getBeatPhase().toFixed(3) : 0,
        subdivision: this.chart ? 4 : 0,
        playerS: Math.round(this.bike.s),
        laneX: +this.bike.x.toFixed(2),
        activeGates: this.gates.activeCount(),
        nextGateTime: +this.gates.nextNoteTime(audioT).toFixed(3),
        gateDelta: +this.gates.stats.lastDelta.toFixed(4),
        distanceKm: tel.distanceKm,
        nearMisses: this.nearMissCount,
      },
    });
  }

  private render() {
    this.cam.renderMirror(this.renderer, this.bike);
    this.postfx.render();
  }

  dispose() {
    cancelAnimationFrame(this.rafId);
    this.running = false;
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.input.dispose();
    this.music.dispose();
    this.bufferPlayer?.dispose();
    this.loader?.cancel();
    this.audio.dispose();
    this.dashboard.dispose();
    this.lyrics?.dispose();
    this.cam.dispose();
    this.postfx.dispose();
    this.weather.dispose();
    this.biomes.dispose();
    this.trafficLights.dispose();
    this.streetLights.dispose();
    this.gates.dispose(this.scene);
    this.traffic.dispose(this.scene);
    this.scene.remove(this.bike.group);
    this.bike.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.highway.dispose();
    this.renderer.dispose();
  }
}
