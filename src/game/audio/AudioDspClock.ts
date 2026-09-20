/**
 * AudioDspClock — the AUTHORITATIVE timeline for all music/rhythm systems.
 *
 * Wraps the Web Audio hardware clock (AudioContext.currentTime). Rendering may
 * interpolate from it, physics keeps its fixed timestep, but every beat, cue,
 * lyric and gate deadline in this game is derived from THIS clock so that the
 * game stays synchronized to the music even when the render FPS drops below 60.
 *
 * Song mode (§7/§15): when a selected YouTube song plays, the epoch is
 * re-anchored so getAudioTime() == the selected song's playback seconds —
 * lyrics, gates and rhythm automatically follow the SONG timeline. The
 * hardware clock always remains authoritative; nudge()/setEpochTo() only
 * re-anchor the epoch, they never advance time from frame data.
 *
 * Forbidden as authoritative music time: performance.now(), RAF deltas,
 * Three.js clocks, React state timing. Those all drift relative to the DSP
 * hardware timeline; this does not.
 */

export class AudioDspClock {
  private ctx: AudioContext | null = null;
  /** ctx.currentTime when the musical timeline t=0 landed */
  private epoch = 0;
  private running = false;

  /** attach the audio hardware context (created on user gesture) */
  attach(ctx: AudioContext): void {
    this.ctx = ctx;
  }

  /** mark t=0 — the exact DSP time the track starts */
  start(): void {
    if (!this.ctx) return;
    // 120 ms output-latency headroom so the first sample lands on schedule
    this.epoch = this.ctx.currentTime + 0.12;
    this.running = true;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Authoritative musical time in seconds (negative before the track starts).
   * This is THE value every rhythm system must reference.
   */
  getAudioTime(): number {
    if (!this.ctx) return 0;
    return this.ctx.currentTime - this.epoch;
  }

  /** raw hardware time (for scheduling audio events with lookahead) */
  getHardwareTime(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** seconds until the DSP timeline reaches t (negative if past) */
  timeUntil(t: number): number {
    return t - this.getAudioTime();
  }

  /** hard re-anchor: make the timeline read songT right now (song sync §7) */
  setEpochTo(songT: number): void {
    if (!this.ctx) return;
    this.epoch = this.ctx.currentTime - songT;
    this.running = true;
  }

  /**
   * Soft drift correction toward a desired musical time. `error` is
   * desiredTime - currentAudioTime. A positive error advances the musical
   * timeline by moving the epoch backwards; a negative error does the inverse.
   */
  nudgeToward(error: number, fraction: number): void {
    if (!this.ctx) return;
    this.epoch -= error * Math.max(0, Math.min(1, fraction));
  }

  get context(): AudioContext | null {
    return this.ctx;
  }
}
