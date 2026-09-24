/**
 * BufferPlayer — plays a decoded AudioBuffer ON the AudioDspClock timeline.
 *
 * The start is scheduled with source.start(when) on the hardware clock; song
 * position == AudioContext.currentTime − epoch (DSP-authoritative, no frame
 * integration). Pause/resume re-anchors the epoch and reschedules from the
 * paused offset; a soft-drift guard (±0.25 s) never engages for plain buffer
 * playback because the source IS the timeline.
 */

import type { AudioDspClock } from './AudioDspClock';

export class BufferPlayer {
  private ctx: AudioContext | null = null;
  private clock: AudioDspClock;
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private buffer: AudioBuffer | null = null;
  private offset = 0; // song position at schedule time
  private playing = false;
  private ended = false;

  /** called once when playback reaches the end of the buffer */
  onEnded: (() => void) | null = null;

  constructor(clock: AudioDspClock) {
    this.clock = clock;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** prime the player with a decoded buffer (stops any current playback) */
  load(buffer: AudioBuffer): void {
    this.stop();
    this.buffer = buffer;
    this.offset = 0;
    this.ended = false;
  }

  /** begin playback from the current epoch anchor (audio must be unlocked) */
  play(): void {
    this.playScheduled(0);
  }

  /**
   * Schedule playback so song t=0 lands `delay` seconds from NOW, re-anchoring
   * the DSP epoch accordingly. Used by the countdown: the music and the rhythm
   * timeline both begin at t=0 exactly when the countdown expires.
   */
  playScheduled(delay: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.buffer || !this.gain || this.playing) return;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    src.onended = () => {
      // only a natural end (not our stop()) marks the song finished
      if (this.playing) {
        this.playing = false;
        this.ended = true;
        this.onEnded?.();
      }
    };
    const when = this.clock.getHardwareTime() + 0.12 + Math.max(0, delay);
    src.start(when, this.offset);
    this.clock.setEpochTo(-0.12 - Math.max(0, delay));
    this.src = src;
    this.playing = true;
  }

  /** restart from t=0 */
  restart(): void {
    if (this.buffer) {
      this.stop();
      this.offset = 0;
      this.ended = false;
      this.play();
    }
  }

  /** stop playback; the song position is retained for resume */
  pause(): void {
    if (!this.playing || !this.ctx) return;
    this.offset = Math.max(0, this.clock.getAudioTime());
    this.stop();
  }

  /** resume from the paused offset */
  resume(): void {
    if (this.buffer && !this.playing && !this.ended) this.play();
  }

  private stop(): void {
    if (this.src) {
      const s = this.src;
      s.onended = null;
      try {
        s.stop();
      } catch {
        // already stopped
      }
      s.disconnect();
      this.src = null;
    }
    this.playing = false;
  }

  /** attach audio hardware + output gain (call once, after user gesture) */
  attach(ctx: AudioContext, destination: AudioNode, volume = 0.9): void {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = volume;
    this.gain.connect(destination);
  }

  setVolume(v: number): void {
    if (this.gain && this.ctx) {
      this.gain.gain.setTargetAtTime(Math.max(0, Math.min(1.5, v)), this.ctx.currentTime, 0.05);
    }
  }

  /** brief dip so pings/impacts cut through */
  duck(amount = 0.3, sec = 0.4): void {
    if (!this.gain || !this.ctx) return;
    const g = this.gain.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    const cur = g.value;
    g.setValueAtTime(cur, now);
    g.linearRampToValueAtTime(cur * (1 - amount), now + 0.05);
    g.linearRampToValueAtTime(cur, now + sec);
  }

  dispose(): void {
    this.stop();
    if (this.gain) {
      this.gain.disconnect();
      this.gain = null;
    }
    this.buffer = null;
  }
}
