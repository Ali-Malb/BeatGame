/**
 * YouTubeSongHost — hidden YT IFrame player + song-time synchronization to the
 * AudioDspClock (§7/§15).
 *
 * The IFrame API is the only legitimate way to play a selected YouTube song in
 * the browser. Its audio cannot be routed through the Web Audio graph, so the
 * DSP clock is RE-ANCHORED to the player's playback clock instead:
 *
 *   getSongTime() ≡ AudioContext.currentTime − epoch   (hardware-authoritative)
 *
 * The player's getCurrentTime() (fractional, ~sample-accurate per IFrame API)
 * is compared against the interpolated song time every frame:
 *   |error| > RESYNC_SEC  → hard re-anchor (seek/state jump)
 *   else                  → soft nudge (a fraction of the error per second)
 * The musical timeline never advances from frame data — it integrates on the
 * hardware clock and is only CORRECTED toward the player clock.
 *
 * Also: ENDED → loop (endless run), pause/resume re-anchoring, and duck()
 * volume dips so PERFECT-SYNC pings / engine moments cut through the mix (§26
 * equivalent mixing for an unroutable source).
 */

import type { AudioDspClock } from './AudioDspClock';

const RESYNC_SEC = 0.3;
const SOFT_NUDGE_PER_SEC = 0.35;
const YT_API = 'https://www.youtube.com/iframe_api';

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  setVolume(v: number): void;
  destroy(): void;
  loadVideoById(id: string): void;
  getPlayerState(): number;
  getVideoData?: () => { title?: string; author?: string; video_id?: string };
}

interface YTNamespace {
  Player: new (
    el: HTMLElement | string,
    opts: {
      videoId?: string;
      width?: number;
      height?: number;
      host?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (e: { target: YTPlayer }) => void;
        onStateChange?: (e: { data: number; target: YTPlayer }) => void;
        onError?: (e: { data: number }) => void;
      };
    }
  ) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YTNamespace> | null = null;

function loadYTApi(): Promise<YTNamespace> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<YTNamespace>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('YT IFrame API timeout')), 12000);
    if (window.YT?.Player) {
      clearTimeout(timeout);
      resolve(window.YT);
      return;
    }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      clearTimeout(timeout);
      if (window.YT) resolve(window.YT);
      else reject(new Error('YT namespace missing'));
    };
    const s = document.createElement('script');
    s.src = YT_API;
    s.async = true;
    s.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('YT IFrame API load failed'));
    };
    document.head.appendChild(s);
  });
  return apiPromise;
}

export interface SongHostCallbacks {
  onReady?: (title: string, duration: number) => void;
  onError?: (code: number) => void;
}

export class YouTubeSongHost {
  private player: YTPlayer | null = null;
  private el: HTMLDivElement | null = null;
  private clock: AudioDspClock;
  private ctx: AudioContext | null = null;

  private ready = false;
  private videoId = '';
  private baseVolume = 60; // player volume 0..100
  private duckTimer = 0;

  /** callbacks for the session (identity readout §33) */
  cb: SongHostCallbacks = {};

  constructor(clock: AudioDspClock) {
    this.clock = clock;
  }

  get isReady(): boolean {
    return this.ready;
  }
  get loadedVideoId(): string {
    return this.videoId;
  }

  /**
   * Attach the hardware context and create the hidden player. Call after a
   * user gesture (start button) so autoplay is honored.
   */
  async attach(ctx: AudioContext, videoId: string): Promise<void> {
    this.ctx = ctx;
    const YT = await loadYTApi();

    // The YouTube embed must keep the provider's minimum 200×200 viewport.
    // It stays off-screen so the game canvas owns the presentation.
    this.el = document.createElement('div');
    this.el.setAttribute('aria-hidden', 'true');
    this.el.style.cssText = 'position:fixed;left:-220px;top:0;width:200px;height:200px;opacity:0.01;pointer-events:none;';
    document.body.appendChild(this.el);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const succeed = () => {
        if (settled) return false;
        settled = true;
        clearTimeout(timeout);
        resolve();
        return true;
      };
      const timeout = setTimeout(() => fail(new Error('player create timeout')), 12000);
      const mount = this.el;
      if (!mount) {
        fail(new Error('player element missing'));
        return;
      }
      this.player = new YT.Player(mount, {
        videoId,
        width: 200,
        height: 200,
        playerVars: {
          autoplay: 1,
          controls: 0,
          disablekb: 1,
          enablejsapi: 1,
          origin: window.location.origin,
          playsinline: 1,
          rel: 0,
          fs: 0,
          iv_load_policy: 3,
          loop: 1,
          playlist: videoId,
        },
        events: {
          onReady: (e) => {
            clearTimeout(timeout);
            this.player = e.target;
            this.ready = true;
            this.videoId = videoId;
            e.target.setVolume(this.baseVolume);
            e.target.playVideo();

            // YouTube can report duration=0 and incomplete video metadata at
            // onReady. Wait briefly for the authoritative title/author/duration
            // before resolving the attach promise, so lyrics lookup does not
            // race against an empty identity.
            const started = performance.now();
            const poll = () => {
              if (!this.player || this.player !== e.target) {
                fail(new Error('player disposed during metadata resolve'));
                return;
              }
              const dur = e.target.getDuration() || 0;
              const data = e.target.getVideoData?.();
              const title = data?.title ?? '';
              if ((dur > 0 && title) || performance.now() - started >= 5000) {
                this.cb.onReady?.(title, dur);
                succeed();
                return;
              }
              window.setTimeout(poll, 200);
            };
            poll();
          },
          onStateChange: (e) => {
            // ENDED = 0 → loop the endless run; re-anchor the clock
            if (e.data === 0 && this.player) {
              this.player.seekTo(0, true);
              this.player.playVideo();
              if (this.ctx) this.clock.setEpochTo(0);
            }
          },
          onError: (e) => {
            this.cb.onError?.(e.data);
            fail(new Error(`YouTube player error ${e.data}`));
          },
        },
      });
    });
  }

  /** per-frame sync — call from the game loop (dt = frame delta) */
  sync(dt: number): void {
    if (!this.ready || !this.player || !this.ctx) return;
    // Do not pull the timeline toward a paused/buffering player. Once playback
    // is actually running, the provider clock is the selected-song reference.
    if (this.player.getPlayerState() !== 1) return;
    const songNow = this.clock.getAudioTime();
    const playerTime = this.player.getCurrentTime();
    let err = playerTime - songNow;
    // song loop boundary: a jump of ~duration means ENDED just re-anchored
    const dur = this.player.getDuration();
    if (dur > 0 && Math.abs(err) > dur - 1.5) err -= Math.sign(err) * dur;
    if (Math.abs(err) > RESYNC_SEC) {
      this.clock.setEpochTo(this.player.getCurrentTime());
    } else {
      this.clock.nudgeToward(err, Math.min(1, SOFT_NUDGE_PER_SEC * dt));
    }
    // music duck recovery (§26)
    if (this.duckTimer > 0) {
      this.duckTimer -= dt;
      if (this.duckTimer <= 0 && this.player) this.player.setVolume(this.baseVolume);
    }
  }

  getSongTime(): number {
    return this.clock.getAudioTime();
  }

  /** actual YouTube playback position, used for pause/restart re-anchoring */
  getPlayerTime(): number {
    return this.ready && this.player ? this.player.getCurrentTime() : 0;
  }

  reanchorClock(): void {
    if (this.ready && this.player) this.clock.setEpochTo(this.player.getCurrentTime());
  }

  restart(): void {
    if (!this.ready || !this.player) return;
    this.player.seekTo(0, true);
    this.player.playVideo();
    this.clock.setEpochTo(0);
  }

  /** resolved duration in seconds (0 until the player reports it) */
  getDuration(): number {
    return this.ready && this.player ? this.player.getDuration() : 0;
  }

  /** title as reported by the PLAYER (authoritative identity, §33) */
  getVideoData(): { title: string; author: string; duration: number } {
    if (!this.ready || !this.player) return { title: '', author: '', duration: 0 };
    const data = this.player.getVideoData?.();
    return { title: data?.title ?? '', author: data?.author ?? '', duration: this.player.getDuration() };
  }

  setVolume(v: number): void {
    this.baseVolume = Math.round(Math.max(0, Math.min(100, v * 100)));
    if (this.ready && this.player && this.duckTimer <= 0) this.player.setVolume(this.baseVolume);
  }

  /** brief music dip so game-side audio (gate ping, whoosh) cuts through (§26) */
  duck(amount = 0.3, sec = 0.45): void {
    if (!this.ready || !this.player) return;
    this.duckTimer = sec;
    this.player.setVolume(Math.round(this.baseVolume * (1 - amount)));
  }

  pause(): void {
    if (this.ready && this.player) this.player.pauseVideo();
  }

  play(): void {
    if (this.ready && this.player) this.player.playVideo();
  }

  dispose(): void {
    try {
      this.player?.destroy();
    } catch {
      // player already gone
    }
    this.el?.remove();
    this.el = null;
    this.player = null;
    this.ready = false;
  }
}
