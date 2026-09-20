/**
 * GameManager — state machine (menu / riding / crashing / paused).
 *
 * Timing architecture (§36):
 *   - RENDER: requestAnimationFrame, interpolates everything
 *   - PHYSICS: fixed 1/120 s accumulator with CCD substeps
 *   - MUSIC/RHYTHM/LYRICS/GATES: AudioDspClock (AudioContext.currentTime) —
 *     the authoritative timeline; stays locked even when FPS drops below 60
 *
 * Beat-reactive world (§6): FOV +3° kick (0.12 s decay), 80 ms ×1.25 lighting
 * pulse, +300% embers in chorus/drop. Weather hard cuts ride the cue sheet.
 * Rhythm combo tracked separately from the near-miss score combo.
 */

import * as THREE from 'three';
import { InputHandler } from './Input';
import { Highway } from '../environment/Highway';
import { WeatherController } from '../environment/Weather';
import { TrafficManager, NearMissEvent } from '../traffic/TrafficManager';
import { BikeController } from '../vehicle/BikeController';
import { MotorcycleAudio } from '../vehicle/BikeAudio';
import { DashboardDisplay } from '../vehicle/Dashboard';
import { CameraController } from '../camera/CameraController';
import { PostFX } from '../fx/PostFX';
import { clamp, damp, kmh } from './utils';

import { AudioDspClock } from '../audio/AudioDspClock';
import { MusicEngine } from '../audio/MusicEngine';
import { AudioRhythm } from '../audio/AudioRhythm';
import { parseCueSheet } from '../audio/CueSheetParser';
import { buildCueSheet, LOOP_SEC } from '../audio/cueSheet';
import {
  parseYouTubeId,
  fetchSongMeta,
  splitTitle,
  fetchLyrics,
  fetchSongTempo,
  buildSongCueSheet,
  type SongMetadata,
  type TimedLyrics,
} from '../audio/SongResolver';
import { YouTubeSongHost } from '../audio/YouTubeSongHost';
import { RhythmGateSpawner } from '../rhythm/RhythmGateSpawner';
import { KineticLyricManager, type LyricCue } from '../rhythm/KineticLyricManager';
import { GameTestHarness } from './GameTestHarness';

export type GameState = 'menu' | 'riding' | 'crashing' | 'paused';

/** song identity readout (§33 debug — telemetry carries it to React) */
export interface SongInfo {
  mode: 'demo' | 'song';
  title: string;
  artist: string;
  videoId: string;
  duration: number;
  bpm: number;
  bpmCalibrated: boolean;
  bpmSource: 'auto-catalog' | 'manual-tap' | 'unresolved';
  lyricSource: string;
  currentLyric: string;
  audioTime: number;
}

export interface GameCallbacks {
  onTelemetry?: (t: {
    speedKmh: number;
    rpm: number;
    gear: number;
    gearLabel: string;
    leanDeg: number;
    wheelieDeg: number;
    score: number;
    combo: number;
    rhythmCombo: number;
    gatePerfects: number;
    distanceKm: number;
    topSpeedKmh: number;
    nearMisses: number;
    state: GameState;
    weather: string;
    section: string;
    musicTime: number;
    fps: number;
    cameraMode: string;
    gamepad: boolean;
    song: SongInfo;
  }) => void;
  onPopup?: (text: string, points: number, kind: string) => void;
  onCrash?: () => void;
  onRespawn?: () => void;
  onStateChange?: (s: GameState) => void;
  /** DOM container for the DSP-driven kinetic lyrics (upper third) */
  getLyricContainer?: () => HTMLElement | null;
}

const PHYSICS_H = 1 / 120; // fixed physics timestep

export class GameManager {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private input = new InputHandler();
  private highway: Highway;
  private weather: WeatherController;
  private traffic: TrafficManager;
  private bike: BikeController;
  private audio = new MotorcycleAudio();
  private dashboard = new DashboardDisplay();
  private cam: CameraController;
  private postfx: PostFX;

  // ---- music/rhythm stack (DSP-authoritative) ----
  private dspClock = new AudioDspClock();
  private music = new MusicEngine(this.dspClock);
  private rhythm: AudioRhythm | null = null;
  private musicStarted = false;
  private lyricContainer: HTMLElement | null = null;
  private lyrics: KineticLyricManager | null = null;
  private gates: RhythmGateSpawner;

  // ---- selected-song session (§6/§7: YouTube song drives EVERYTHING) ----
  private songMode = false;
  private songHost: YouTubeSongHost | null = null;
  private songMeta: SongMetadata | null = null;
  private songLyrics: TimedLyrics | null = null;
  private songBpm = 0; // 0 = not yet calibrated — rhythm disabled until T taps
  private songFirstBeat = 0;
  private songTaps: number[] = [];
  private songTempoLockedByUser = false;
  /** increments on every new run so stale async metadata cannot mutate a new session */
  private songSessionToken = 0;
  private songMusicVolume = 0.6;
  private songMusicOn = true;

  state: GameState = 'menu';

  // scoring
  private score = 0;
  private combo = 1;
  private comboTimer = 0;
  private rhythmCombo = 0; // §33: separate from normal score combo
  private bestRhythmCombo = 0;
  private nearMisses = 0;
  private topSpeed = 0;
  private bestCombo = 1;

  // crash/respawn
  private crashTimer = 0;
  private respawnPending = false;

  // loop
  private rafId = 0;
  private lastT = 0;
  private time = 0;
  private fps = 60;
  private telemetryTimer = 0;
  private running = false;
  private physicsAccum = 0;

  // weather cue tracking (hard cuts)
  private appliedPreset = -1;

  // adaptive quality (downgrades only)
  private qualityTier = 2;
  private lowFpsTimer = 0;

  private tmpVel = new THREE.Vector3();
  private tmpFwd = new THREE.Vector3(0, 0, 1);
  /** authored demo lyric cues (rebuild source when a song session ends) */
  private demoLyricCues: LyricCue[] = [];

  constructor(private canvas: HTMLCanvasElement, private callbacks: GameCallbacks = {}) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // MSAA handled by composer target
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
    this.traffic = new TrafficManager(this.highway, this.scene);
    this.bike = new BikeController(this.highway, this.scene);
    this.cam = new CameraController(this.scene, window.innerWidth / Math.max(1, window.innerHeight));
    this.cam.attachMirrors(this.bike);
    this.weather.setRainLayer(this.cam.camera);

    this.postfx = new PostFX(this.renderer, this.scene, this.cam.camera, window.innerWidth, window.innerHeight);

    // diegetic dashboard texture onto the bike's cluster plane
    const dashMat = new THREE.MeshBasicMaterial({ map: this.dashboard.texture });
    this.bike.joints.dashboard.material = dashMat;

    // rhythm systems (need the scene; music clock starts on user gesture)
    const sheet = parseCueSheet(buildCueSheet());
    this.rhythm = new AudioRhythm(sheet, this.dspClock);
    this.gates = new RhythmGateSpawner(this.scene, this.highway, this.rhythm);
    // demo lyric cues kept for lyric rebuilds (song swap-in overwrites)
    this.demoLyricCues = sheet.getCuesOfType('lyric').map((c) => ({
      time: c.time,
      text: c.text ?? '',
      stagger: true, // authored demo color-tag cues (explicit DEMO mode §12)
    }));

    // kinetic lyrics attach to a DOM container supplied by React
    this.lyricContainer = callbacks.getLyricContainer?.() ?? null;
    if (this.lyricContainer) {
      this.lyrics = new KineticLyricManager(this.lyricContainer);
      this.lyrics.build(this.demoLyricCues);
      this.lyrics.onWordHighlight = () => this.postfx.bloomPulse(0.35);
    }

    // traffic ↔ scoring wiring
    this.traffic.onNearMiss = (e) => this.handleNearMiss(e);
    this.traffic.onCollision = () => this.triggerCrash();

    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);

    // initial world population
    this.traffic.reset(this.bike.s);
    this.weather.setPreset(0, true);

    // debug handle (dev only) — includes the acceptance harness (§37)
    if (process.env.NODE_ENV === 'development') {
      (window as unknown as { __game: GameManager }).__game = this;
      (window as unknown as { __gameTest: GameTestHarness }).__gameTest = new GameTestHarness(this);
    }
  }

  // ------------------------------------------------------------------ public ----
  /** start options: demo soundtrack (default) or a selected YouTube song */
  async start(opts?: { songUrl?: string }): Promise<void> {
    // A new launch is always a fresh soundtrack session. Dispose the previous
    // YouTube host and clear all song-specific state before resolving the new one.
    // This prevents stale metadata/lyrics from leaking across runs.
    this.clearSongSession();
    // user gesture: unlock audio, start the music, begin the run
    this.audio.start();
    this.audio.resume();
    if (!this.musicStarted && this.audio.context && this.rhythm) {
      this.dspClock.attach(this.audio.context);
      this.dspClock.start();
      this.musicStarted = true;
      this.gates.reset(this.dspClock.getAudioTime());
    }

    // ---- selected-song mode (§7): the YouTube song IS the session identity ----
    const videoId = opts?.songUrl ? parseYouTubeId(opts.songUrl) : null;
    if (opts?.songUrl && !videoId) {
      this.callbacks.onPopup?.('INVALID YOUTUBE URL', 0, 'songError');
    }
    if (videoId && this.audio.context) {
      const sessionToken = this.songSessionToken;
      this.songMode = true;
      this.songBpm = 0;
      this.songTaps = [];
      this.songTempoLockedByUser = false;
      this.songLyrics = null;
      this.songMeta = await fetchSongMeta(videoId);
      this.rhythm!.songEnergyFn = null;
      // provisional sheet: lyric-less + rhythm-less until player + taps resolve
      this.swapSongSheet();
      this.lyrics?.build([]); // clear demo lyrics immediately (§12)
      try {
        const host = new YouTubeSongHost(this.dspClock);
        this.songHost = host;
        host.cb = {
          onReady: (playerTitle, playerDuration) => {
            if (this.songSessionToken !== sessionToken || this.songHost !== host || !this.songMode) return;
            // PLAYER-REPORTED identity is authoritative (§9)
            const data = host.getVideoData();
            const title = playerTitle || data.title || this.songMeta?.title || '';
            const meta = this.songMeta;
            if (meta && playerDuration > 0) {
              meta.duration = playerDuration;
              meta.durationResolved = true;
            }
            if (meta && title) {
              meta.title = title;
              const channel = data.author || meta.channel;
              const parts = splitTitle(title, channel);
              meta.artist = parts.artist;
              meta.track = parts.track;
            }

            this.callbacks.onPopup?.(`SONG · ${title || 'loading…'}`, 0, 'songInfo');
            // Resolve catalog tempo + exact-song lyrics independently. Both
            // operations are guarded against stale async results and session IDs.
            void this.resolveSongTempo();
            void this.resolveSongLyrics();
          },
          onError: (code) => {
            if (this.songSessionToken !== sessionToken || this.songHost !== host || !this.songMode) return;
            this.callbacks.onPopup?.('SONG UNPLAYABLE · CHECK VIDEO', 0, 'songError');
            void code;
          },
        };
        await host.attach(this.audio.context, videoId);
        this.dspClock.setEpochTo(0);
      } catch {
        host.dispose();
        this.songMode = false;
        this.songHost = null;
        this.callbacks.onPopup?.('SONG LOAD FAILED · DEMO TRACK', 0, 'songError');
        this.lyrics?.build(this.demoLyricCues);
      }
    }

    if (this.songMode && this.songHost == null) this.songMode = false;
    if (!this.songMode) {
      // demo/generated soundtrack mode (fallback, §12)
      if (this.audio.context) this.music.start(this.audio.context, this.audio.context.destination);
      this.lyrics?.build(this.demoLyricCues);
    } else {
      // the synth track stays OFF in song mode — no fake BPM, no demo lyrics
      this.music.setEnabled(false);
      this.weather.autoCycle = true; // sky still evolves across the run
      this.songHost?.setVolume(this.songMusicOn ? this.songMusicVolume : 0);
    }
    this.resetRun();
    this.setState('riding');
    if (!this.running) {
      this.running = true;
      this.lastT = performance.now();
      this.rafId = requestAnimationFrame(this.loop);
    }
  }

  private clearSongSession(): void {
    this.songSessionToken++;
    this.songHost?.dispose();
    this.songHost = null;
    this.songMode = false;
    this.songMeta = null;
    this.songLyrics = null;
    this.songBpm = 0;
    this.songFirstBeat = 0;
    this.songTaps = [];
    this.songTempoLockedByUser = false;

    // Restore the authored demo rhythm as well as the demo lyrics. A previous
    // song session may have replaced this.rhythm with a zero-BPM/provisional
    // song sheet; leaving that object alive would silently disable rhythm on
    // the next demo launch.
    const sheet = parseCueSheet(buildCueSheet());
    const r = new AudioRhythm(sheet, this.dspClock);
    this.rhythm = r;
    this.gates.attachRhythm(r, this.dspClock.getAudioTime());
    this.lyrics?.build(this.demoLyricCues);
    this.music.setEnabled(true);
  }

  /** Resolve an external catalog BPM for the exact selected song. */
  private async resolveSongTempo(): Promise<void> {
    const meta = this.songMeta;
    const sessionToken = this.songSessionToken;
    if (!meta || this.songTempoLockedByUser) return;
    const bpm = await fetchSongTempo(meta);
    if (!this.songMode || this.songMeta !== meta || this.songSessionToken !== sessionToken || this.songTempoLockedByUser || bpm == null) return;
    this.songBpm = +bpm.toFixed(1);
    // BPM metadata gives us the grid spacing. Beat phase is deliberately kept
    // at zero until the player taps T/Select, because a catalog BPM does not
    // prove where beat 1 falls in a particular YouTube upload.
    this.songFirstBeat = 0;
    this.swapSongSheet();
    this.callbacks.onPopup?.(`BPM ${this.songBpm} · AUTO · TAP T TO PHASE-LOCK`, 0, 'songInfo');
  }

  /** resolve lyrics + rebuild lyric display for THE selected song (§8) */
  private async resolveSongLyrics(): Promise<void> {
    const meta = this.songMeta;
    const sessionToken = this.songSessionToken;
    if (!meta) return;
    const resolved = await fetchLyrics(meta);
    if (!this.songMode || this.songMeta !== meta || this.songSessionToken !== sessionToken) return;
    this.songLyrics = resolved;
    // Plain lyrics without source-authored timestamps stay unavailable.
    // Never reconstruct a timeline from duration alone: that would create
    // plausible-looking but musically false synchronization.
    this.rebuildSongLyricDisplay();
    this.swapSongSheet();
    if (this.songLyrics.source === 'unavailable') {
      this.callbacks.onPopup?.('LYRICS UNAVAILABLE', 0, 'songInfo');
    } else {
      this.callbacks.onPopup?.(
        this.songLyrics.source === 'lrclib-synced-word' ? 'LYRICS · SYNCED (WORD)' : 'LYRICS · SYNCED',
        0,
        'songInfo'
      );
    }
  }

  /** feed resolved TimedLyrics into the KineticLyricManager (real timestamps) */
  private rebuildSongLyricDisplay(): void {
    const ly = this.songLyrics;
    if (!ly || ly.source === 'unavailable' || !this.lyrics) {
      this.lyrics?.build([]); // LYRICS UNAVAILABLE — no fake text (§8)
      return;
    }
    const cues: LyricCue[] = ly.lines.map((l) => ({
      time: l.start,
      end: l.end,
      text: l.text,
      words: l.words ? l.words.map((w) => ({ start: w.start, text: w.text })) : undefined,
      stagger: false,
    }));
    this.lyrics.build(cues);
  }

  /**
   * (Re)build the ACTIVE rhythm sheet from the selected song (§13/§14):
   * lyric cues = resolved timestamps, beats/gates = calibrated BPM + phase.
   * bpm == 0 → no beat cues; gates stay disabled until calibration.
   */
  private swapSongSheet(): void {
    if (!this.songMode || !this.songMeta || !this.rhythm) return;
    const meta = this.songMeta;
    const duration = meta.durationResolved ? meta.duration : 480;
    const energy = (t: number) => {
      // visual-reactivity curve over the song's own timeline (estimated; not
      // claimed metadata) — intro <45 s, outro last 30 s
      if (t < Math.min(45, duration * 0.1)) return 0.45;
      if (t > duration - 30) return 0.75;
      return 0.8;
    };
    const json = buildSongCueSheet(meta, this.songLyrics, this.songBpm, this.songFirstBeat, energy);
    const sheet = parseCueSheet(json as Parameters<typeof parseCueSheet>[0]);
    const r = new AudioRhythm(sheet, this.dspClock);
    r.songEnergyFn = energy;
    this.rhythm = r;
    this.gates.attachRhythm(r, this.dspClock.getAudioTime());
  }

  /**
   * Tap-tempo calibration (§13): the player taps T / Select along to the beat
   * of the SELECTED song; BPM + phase are fitted from the taps and the whole
   * rhythm system (beats, gates, FOV kicks) re-derives from the SONG at that
   * BPM. No hardcoded BPM is ever assumed.
   */
  private handleTapTempo(): void {
    if (!this.songMode || !this.rhythm || !this.musicStarted) return;
    const t = this.rhythm.getCurrentAudioTime();
    if (t < 0) return;
    this.songTaps.push(t);
    if (this.songTaps.length > 12) this.songTaps.shift();
    if (this.songTaps.length < 4) return;

    const intervals: number[] = [];
    for (let i = 1; i < this.songTaps.length; i++) {
      const d = this.songTaps[i] - this.songTaps[i - 1];
      if (d > 0.12 && d < 2.5) intervals.push(d); // plausible beat gaps
    }
    if (intervals.length < 2) return;
    intervals.sort((a, b) => a - b);
    let median = intervals[Math.floor(intervals.length / 2)];
    // drop outliers (> 1.6× the median), recompute
    const kept = intervals.filter((d) => d < median * 1.6 && d > median / 1.6);
    median = kept.length >= 2 ? kept.reduce((a, b) => a + b, 0) / kept.length : median;
    let bpm = 60 / median;
    // snap into a sane musical range
    while (bpm < 65) bpm *= 2;
    while (bpm > 200) bpm /= 2;
    this.songTempoLockedByUser = true;
    this.songBpm = +bpm.toFixed(1);
    this.songFirstBeat = this.songTaps[this.songTaps.length - 1] % (60 / this.songBpm);
    this.swapSongSheet();
    this.callbacks.onPopup?.(`BPM ${this.songBpm} · MANUAL RHYTHM LOCKED`, 0, 'songInfo');
  }

  /** song identity readout for telemetry (§33) */
  songInfo(): SongInfo {
    const meta = this.songMeta;
    const t = this.rhythm && this.musicStarted ? this.rhythm.getCurrentAudioTime() : -1;
    let currentLyric = '';
    if (this.songMode && meta) {
      const ly = this.songLyrics;
      if (ly && ly.source !== 'unavailable' && t >= 0) {
        for (const line of ly.lines) {
          if (t >= line.start && t < (line.end ?? line.start + 6)) {
            currentLyric = line.text;
            break;
          }
        }
      } else if (t >= 0) {
        currentLyric = '—'; // resolved: no line active right now (instrumental)
      }
    } else {
      // demo mode: current authored lyric from the sheet
      const cues = this.demoLyricCues;
      if (t >= 0) {
        for (const c of cues) {
          if (t >= c.time && t < c.time + 6.5) {
            currentLyric = c.text.replace(/<[^>]*>/g, '');
            break;
          }
        }
      }
    }
    return {
      mode: this.songMode ? 'song' : 'demo',
      title: meta?.title ?? 'MIDNIGHT RUNNER — C1 Inner Loop',
      artist: meta?.artist ?? '',
      videoId: meta?.videoId ?? '',
      duration: meta?.duration ?? LOOP_SEC,
      bpm: this.songMode ? this.songBpm : (this.rhythm?.bpm ?? 128),
      bpmCalibrated: !this.songMode || this.songBpm > 0,
      bpmSource: !this.songMode ? 'auto-catalog' : this.songBpm > 0 ? (this.songTempoLockedByUser ? 'manual-tap' : 'auto-catalog') : 'unresolved',
      lyricSource: this.songMode ? (this.songLyrics?.source ?? 'resolving…') : 'authored-demo',
      currentLyric,
      audioTime: +Math.max(0, t).toFixed(2),
    };
  }

  /** true once the start pipeline finished (React await) */
  get isSongMode(): boolean {
    return this.songMode;
  }

  /** attract mode: render world behind the menu (auto cruise, no scoring) */
  startAttract() {
    if (this.running) return;
    this.running = true;
    this.lastT = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  togglePause() {
    if (this.state === 'riding') {
      this.setState('paused');
      this.audio.suspend();
      this.music.setPaused(true);
      this.songHost?.pause();
    } else if (this.state === 'paused') {
      this.setState('riding');
      this.audio.resume();
      this.music.setPaused(false);
      this.songHost?.play();
      // re-anchor the DSP timeline to the song's own playback clock
      this.songHost?.reanchorClock();
    }
  }

  setWeather(index: number) {
    this.weather.setPreset(index, true); // manual = hard cut
    this.appliedPreset = index;
    this.weather.autoCycle = false;
  }

  setAutoCycle(on: boolean) {
    this.weather.autoCycle = on;
  }

  setVolume(v: number) {
    this.audio.setVolume(v);
  }

  setMusicVolume(v: number) {
    if (this.songMode) {
      this.songMusicVolume = v;
      this.songHost?.setVolume(this.songMusicOn ? v : 0);
    } else {
      this.music.setVolume(v);
    }
  }

  setMusicEnabled(on: boolean) {
    if (this.songMode) {
      this.songMusicOn = on;
      this.songHost?.setVolume(on ? this.songMusicVolume : 0);
    } else {
      this.music.setEnabled(on);
    }
  }

  restart() {
    if (this.songMode && this.songHost?.isReady) this.songHost.restart();
    this.resetRun();
    this.setState('riding');
    if (this.rhythm) this.rhythm.update();
  }

  getState(): GameState {
    return this.state;
  }

  // ------------------------------------------------------------------ private ----
  private setState(s: GameState) {
    this.state = s;
    this.callbacks.onStateChange?.(s);
  }

  private resetRun() {
    this.bike.respawn(60, 2);
    this.traffic.reset(this.bike.s);
    this.score = 0;
    this.combo = 1;
    this.comboTimer = 0;
    this.rhythmCombo = 0;
    this.bestRhythmCombo = 0;
    this.nearMisses = 0;
    this.topSpeed = 0;
    this.bestCombo = 1;
    this.crashTimer = 0;
    this.respawnPending = false;
    this.physicsAccum = 0;
    this.postfx.setFade(0);
    this.postfx.flash(0.25, new THREE.Color(0.2, 0.2, 0.3));
    if (this.musicStarted) {
      this.gates.reset(this.dspClock.getAudioTime());
    }
  }

  private handleNearMiss(e: NearMissEvent) {
    if (this.state !== 'riding') return;
    this.combo = Math.min(10, this.combo + 0.5);
    this.comboTimer = 4;
    const pts = Math.round(e.points * this.combo);
    this.score += pts;
    this.nearMisses++;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    const label = e.kind === 'laneSplit' ? 'LANE SPLIT' : e.kind === 'close' ? 'CLOSE CALL' : 'NEAR MISS';
    this.callbacks.onPopup?.(label, pts, e.kind);
    this.audio.whoosh(e.side, e.heavy, e.strong ? 1 : 0.5);
    // strong near-miss (≤0.8 m @ >180 km/h): punchy feedback (§32)
    this.cam.addTrauma(e.strong ? 0.32 : 0.1);
    if (e.strong) {
      this.postfx.bloomPulse(0.25);
      this.cam.addFovKick(1.5, 0.15);
    }
  }

  private handleGateEvents(dt: number) {
    if (!this.gates || this.state !== 'riding') return;
    const events = this.gates.update(dt, this.bike.s, this.bike.v);
    for (const ev of events) {
      if (ev.kind === 'perfect') {
        this.rhythmCombo++;
        this.bestRhythmCombo = Math.max(this.bestRhythmCombo, this.rhythmCombo);
        const pts = 250;
        this.score += pts;
        this.audio.gatePing(true);
        this.songHost?.duck(0.35, 0.5); // music dips so the ping cuts through (§26)
        this.postfx.bloomPulse(0.55);
        this.postfx.flash(0.16, new THREE.Color(0.5, 0.8, 1.2));
        this.cam.addFovKick(3.5, 0.14);
        this.cam.addTrauma(0.14);
        this.callbacks.onPopup?.(
          this.rhythmCombo > 1 ? `PERFECT SYNC · COMBO x${this.rhythmCombo}` : 'PERFECT SYNC',
          pts,
          'gatePerfect'
        );
      } else if (ev.kind === 'good') {
        this.score += 100;
        this.audio.gatePing(false);
        this.postfx.bloomPulse(0.2);
        this.callbacks.onPopup?.('GOOD SYNC', 100, 'gateGood');
      } else {
        // miss breaks the rhythm combo
        if (this.rhythmCombo > 3) {
          this.callbacks.onPopup?.('COMBO LOST', 0, 'gateMiss');
        }
        this.rhythmCombo = 0;
      }
    }
  }

  private triggerCrash() {
    if (this.state !== 'riding') return;
    this.bike.crash();
    this.setState('crashing');
    this.crashTimer = 0;
    this.combo = 1;
    this.comboTimer = 0;
    this.rhythmCombo = 0;
    this.audio.crash();
    this.cam.addTrauma(1.3);
    this.postfx.flash(0.85, new THREE.Color(1.0, 0.15, 0.08));
    this.postfx.chromaBurst(1.0); // red chromatic aberration (§34)
    this.callbacks.onCrash?.();
  }

  private updateRespawn(dt: number) {
    this.crashTimer += dt;
    // black-out at the end of the wipeout
    if (this.crashTimer > 1.0 && !this.respawnPending) {
      this.respawnPending = true;
      this.postfx.setFade(1);
    }
    if (this.crashTimer >= 1.55) {
      // find clear lane ahead and reposition ≥50 m behind nearest traffic
      const lane = this.traffic.findClearLane(this.bike.s + 90);
      this.traffic.clearCorridor(this.bike.s + 90, lane, 80);
      this.bike.respawn(this.bike.s + 90, lane);
      this.physicsAccum = 0;
      this.postfx.setFade(0);
      this.respawnPending = false;
      this.setState('riding');
      this.callbacks.onRespawn?.();
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
    if (document.hidden && this.state === 'riding') this.togglePause();
  };

  private loop = (t: number) => {
    this.rafId = requestAnimationFrame(this.loop);
    const rawDt = (t - this.lastT) / 1000;
    this.lastT = t;
    const dt = clamp(rawDt, 0.0005, 0.1); // 10 FPS floor — sim time tracks real time (§36)
    if (rawDt > 0) this.fps = damp(this.fps, 1 / rawDt, 3, dt);
    this.time += dt;

    this.adaptQuality(clamp(rawDt, 0, 1));
    if (this.running) {
      this.tick(dt);
    }
    this.render();
  };

  /** dev/verification helpers: stop the world but keep rendering */
  debugFreeze() {
    this.running = false;
  }
  debugUnfreeze() {
    this.running = true;
    this.lastT = performance.now();
  }

  /** step down render quality if the GPU can't keep up (real-time based) */
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

  // ------------------------------------------------------------- rhythm tick ----
  /**
   * All music-driven world reactions. Reads DSP time; never frame time.
   */
  private tickRhythm(dt: number) {
    if (!this.rhythm || !this.musicStarted) return;
    const audioT = this.rhythm.getCurrentAudioTime();
    if (audioT < 0) return;

    // lookahead music scheduling on the hardware timeline
    this.music.pump();

    // beat-phase queries + downbeat crossing detection
    this.rhythm.update();
    const beats = this.rhythm.drainBeatEvents();
    const energy = this.rhythm.getEnergy();

    for (const beat of beats) {
      // ---- camera: +3° FOV kick decaying 0.12 s on downbeats ----
      const kick = beat.major ? 3 : 1.6;
      this.cam.addFovKick(kick * (0.5 + energy * 0.5), 0.12);
      // ---- lighting: 80 ms ×1.25 pulse on emissives ----
      this.weather.pulse(0.08);
      if (beat.major && energy > 0.8) {
        this.cam.addTrauma(0.08); // subtle impact on big hits only
      }
    }

    // ---- embers: +300% during chorus / drop / high energy ----
    this.weather.emberBoost = energy > 0.8 ? 4.0 : 1.0;
    this.weather.emberFloor = energy > 0.8 ? 0.22 : 0;

    // ---- weather hard cuts from the cue sheet (loop-aware; demo sheet only —
    // a selected song has no authored preset cues, autoCycle evolves instead) ----
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
      this.weather.setPreset(presetIdx, true); // HARD CUT — visuals only
    }

    // ---- lyrics (DSP-driven) ----
    this.lyrics?.update(tLoop);

    // ---- rhythm gates (scheduled against the DSP clock) ----
    this.handleGateEvents(dt);
  }

  private tick(dt: number) {
    const events = this.input.update(dt);

    // global one-shots
    if (events.toggleCamera) this.cam.toggle();
    if (events.togglePause) this.togglePause();
    if (events.restart && this.state !== 'menu') this.restart();
    if (events.tapTempo) this.handleTapTempo();
    if (events.weather > 0) this.setWeather(events.weather - 1);
    if (events.gearUp && this.state === 'riding') this.bike.forceShift(1);
    if (events.gearDown && this.state === 'riding') this.bike.forceShift(-1);

    const snapshot = {
      throttle: this.input.throttle,
      brake: this.input.brake,
      rearBrake: this.input.rearBrake,
      steer: this.input.steer,
      tuck: this.input.tuckActive,
      lookBack: this.input.lookBack,
    };

    let ev: ReturnType<typeof this.bike.step> | undefined;
    if (this.state === 'riding') {
      // ---- physics: FIXED 1/120 s accumulator (§36) ----
      this.physicsAccum += dt;
      let steps = 0;
      while (this.physicsAccum >= PHYSICS_H && steps < 12 && this.state === 'riding') {
        const stepEv = this.bike.step(PHYSICS_H, snapshot);
        ev = stepEv;
        this.physicsAccum -= PHYSICS_H;
        steps++;
        if (stepEv.barrierHit) {
          this.triggerCrash();
          break;
        }
        if (this.traffic.collideAndScore(this.bike, PHYSICS_H)) {
          break; // crash triggered inside
        }
      }
      if (steps === 12) this.physicsAccum = 0; // spiral-of-death guard
      // audio events
      if (ev?.backfire) this.audio.backfire();
      if (ev && (ev.shiftedUp || ev.shiftedDown)) {
        this.audio.shiftClack();
        this.audio.shiftDuck();
      }
      if (ev?.jointCrossed) {
        this.audio.jointThump(kmh(this.bike.v));
        this.cam.addTrauma(clamp(this.bike.v * 0.0035, 0.03, 0.14));
      }
      // score trickle: distance + speed bonus
      this.score += dt * this.bike.v * 0.6 * (this.bike.v > 55.6 ? 1.5 : 1);
      this.topSpeed = Math.max(this.topSpeed, kmh(this.bike.v));
      // combo decay
      if (this.comboTimer > 0) {
        this.comboTimer -= dt;
        if (this.comboTimer <= 0) this.combo = 1;
      }
    } else if (this.state === 'menu') {
      // attract mode: gentle cruise
      this.physicsAccum += dt;
      while (this.physicsAccum >= PHYSICS_H) {
        this.bike.step(PHYSICS_H, { ...snapshot, throttle: 0.42, brake: 0, rearBrake: 0 });
        this.physicsAccum -= PHYSICS_H;
      }
      this.traffic.collideAndScore(this.bike, dt);
    } else if (this.state === 'crashing') {
      this.updateRespawn(dt);
    }

    // rhythm (music pump + beat reactions + gates + lyrics) — even while crashing
    this.tickRhythm(dt);
    if (this.musicStarted) this.songHost?.sync(dt);

    if (this.state === 'paused') {
      // world frozen; only camera micro-motion
    } else {
      this.traffic.update(dt, this.bike.s, this.bike.v);
      this.highway.update(this.bike.s, dt);
      this.highway.tick(this.time);
      this.bike.updateVisuals(dt, this.time, this.cam.mode === 'cockpit');
      // weather
      this.tmpFwd.set(Math.sin(this.bike.worldYaw), 0, Math.cos(this.bike.worldYaw));
      this.tmpVel.copy(this.tmpFwd).multiplyScalar(this.bike.v);
      this.weather.cacheTrafficSpray(this.traffic);
      this.weather.frameIdx++;
      this.traffic.rainBoost = this.weather.rainAmount;
      this.weather.update(dt, this.bike.worldPos, this.tmpFwd, this.tmpVel, this.bike, this.traffic, this.highway, this.cam.camera);
      // dashboard + audio
      const tel = this.bike.telemetry();
      this.dashboard.update(dt, tel.rpm, tel.speedKmh, tel.gear, this.combo, tel.rpm > 14200 && this.input.throttle > 0.4);
      this.audio.update(dt, {
        rpm: tel.rpm,
        throttle: this.state === 'riding' ? snapshot.throttle : 0,
        speedKmh: tel.speedKmh,
        tuck: this.bike.tuck,
        limiter: this.bike.limiterCut,
        rain: this.weather.rainAmount,
        crashed: this.state === 'crashing',
        shifting: this.bike.model.shiftTimer > 0,
        gear: tel.gear,
      });
      this.renderer.toneMappingExposure = damp(this.renderer.toneMappingExposure, this.weather.postState().exposure, 4, dt);
    }

    // camera always (even paused, for subtle motion? no — frozen in pause)
    if (this.state !== 'paused') {
      this.cam.update(dt, this.bike, {
        lookBack: this.input.lookBack,
        tuck: this.input.tuckActive,
        accel: this.bike.model.aLong,
        brakeInput: this.input.brake,
      });
    }

    // postfx params
    const post = this.weather.postState();
    this.postfx.update(dt, {
      speedKmh: this.state === 'crashing' ? 0 : kmh(this.bike.v),
      bloom: post.bloom,
      saturation: post.saturation,
      contrast: post.contrast,
      rain: post.rain,
      vignette: post.vignette,
    });

    // telemetry to React at 12 Hz
    this.telemetryTimer += dt;
    if (this.telemetryTimer > 1 / 12) {
      this.telemetryTimer = 0;
      const tel = this.bike.telemetry();
      this.callbacks.onTelemetry?.({
        speedKmh: tel.speedKmh,
        rpm: tel.rpm,
        gear: tel.gear,
        gearLabel: tel.gearLabel,
        leanDeg: tel.leanDeg,
        wheelieDeg: tel.wheelieDeg,
        score: Math.floor(this.score),
        combo: this.combo,
        rhythmCombo: this.rhythmCombo,
        gatePerfects: this.gates.stats.perfect,
        distanceKm: tel.distanceKm,
        topSpeedKmh: this.topSpeed,
        nearMisses: this.nearMisses,
        state: this.state,
        weather: this.weather.presetName,
        section: this.rhythm ? this.rhythm.getSectionName() : '—',
        musicTime: this.rhythm ? this.rhythm.getCurrentAudioTime() : 0,
        fps: this.fps,
        cameraMode: this.cam.mode,
        gamepad: this.input.gamepadConnected,
        song: this.songInfo(),
      });
    }
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
    this.songHost?.dispose();
    this.audio.dispose();
    this.dashboard.dispose();
    this.lyrics?.dispose();
    this.cam.dispose();
    this.postfx.dispose();
    this.weather.dispose();
    this.traffic.dispose(this.scene);
    this.scene.remove(this.bike.group);
    this.bike.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.highway.dispose();
    this.renderer.dispose();
  }
}
