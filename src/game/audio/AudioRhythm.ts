/**
 * AudioRhythm — beat/cue/energy queries, all derived from the DSP clock.
 *
 * Exposes: getCurrentAudioTime(), getNextBeat(), getNextDownbeat(),
 * getBeatPhase(), getEnergy(), getCurrentCue().
 *
 * Nothing counts frames. Position within the track is computed analytically
 * from AudioContext.currentTime, so the system stays locked to the music even
 * when the render FPS drops.
 */

import { AudioDspClock } from './AudioDspClock';
import type { ParsedCueSheet } from './CueSheetParser';
import type { Cue } from './cueSheet';
import { LOOP_SEC, SECTIONS, TOTAL_BARS, BAR_SEC } from './cueSheet';

export interface BeatHit {
  /** absolute DSP time of the downbeat that was crossed */
  time: number;
  energy: number;
  /** true on phrase starts (every 4th bar) and section boundaries */
  major: boolean;
}

/**
 * Optional song-mode energy provider: when the sheet belongs to a selected
 * YouTube song (no authored sections), the session supplies an energy curve
 * derived from the song's own timeline instead of the demo section map.
 */
export type SectionEnergyFn = ((t: number) => number) | null;

export class AudioRhythm {
  private sheet: ParsedCueSheet;
  private clock: AudioDspClock;
  private cueCursor = 0;
  private lastDownbeatCount = -1;
  /** events produced by update() and consumed by the game each frame */
  pendingEvents: BeatHit[] = [];
  /** set in song mode (§13) — overrides the demo section map */
  songEnergyFn: SectionEnergyFn = null;

  constructor(sheet: ParsedCueSheet, clock: AudioDspClock) {
    this.sheet = sheet;
    this.clock = clock;
  }

  getCurrentAudioTime(): number {
    return this.clock.getAudioTime();
  }

  getNextBeat(): number | null {
    return this.sheet.nextBeatTime(this.getCurrentAudioTime());
  }

  getNextDownbeat(): number | null {
    return this.sheet.nextDownbeatTime(this.getCurrentAudioTime());
  }

  /** 0..1 position within the current beat (DSP-derived, sheet-driven bpm) */
  getBeatPhase(): number {
    const t = this.getCurrentAudioTime();
    if (t < 0 || !Number.isFinite(this.sheet.beatSec) || this.sheet.bpm <= 0) return 0;
    const beat = t / this.sheet.beatSec;
    return beat - Math.floor(beat);
  }

  /** musical energy 0..1 — song curve in song mode, demo sections otherwise */
  getEnergy(): number {
    const t = this.getCurrentAudioTime();
    if (t < 0) return 0;
    if (this.songEnergyFn) return this.songEnergyFn(t);
    const looped = t % LOOP_SEC;
    const bar = Math.floor(looped / BAR_SEC);
    const sec = sectionForBar(bar);
    let energy = sec.energy;
    const barInSec = bar - sec.startBar;
    if (sec.energy > 0.8 && barInSec < 2) {
      energy = 0.6 + (sec.energy - 0.6) * (barInSec / 2);
    }
    return energy;
  }

  /** name of the current musical section */
  getSectionName(): string {
    const t = this.getCurrentAudioTime();
    if (t < 0) return 'silence';
    if (this.songEnergyFn) return 'song';
    return sectionForBar(Math.floor((t % LOOP_SEC) / BAR_SEC)).name;
  }

  /** musical timeline length (s) — demo loop OR the selected song duration */
  get loopSec(): number {
    return this.sheet.loopSec;
  }
  get beatSec(): number {
    return this.sheet.beatSec;
  }
  get barSec(): number {
    return this.sheet.barSec;
  }
  get bpm(): number {
    return this.sheet.bpm;
  }

  /** the most recent cue at or before current DSP time */
  getCurrentCue(): Cue | null {
    const t = this.getCurrentAudioTime();
    const cues = this.sheet.cues;
    if (t < 0 || cues.length === 0) return null;
    if (this.cueCursor >= cues.length || cues[this.cueCursor].time > t) {
      this.cueCursor = 0;
    }
    while (this.cueCursor + 1 < cues.length && cues[this.cueCursor + 1].time <= t) {
      this.cueCursor++;
    }
    return cues[this.cueCursor];
  }

  /**
   * Frame update: detect downbeat crossings that happened since the last call
   * (in DSP time) and queue them as world-pulse events. Events carry their
   * TRUE DSP timestamps — never resampled to frame time.
   */
  update(): void {
    const t = this.getCurrentAudioTime();
    if (t < 0) return;
    const downbeats = this.sheet.getCuesOfType('downbeat');
    if (downbeats.length === 0) return;

    // absolute count of downbeats at-or-before t (loop-aware, sheet timeline)
    const loopSec = this.sheet.loopSec;
    const loopT = loopSec > 0 ? ((t % loopSec) + loopSec) % loopSec : t;
    const cycles = loopSec > 0 ? Math.floor(t / loopSec) : 0;
    let idx = 0;
    for (let i = 0; i < downbeats.length; i++) {
      if (downbeats[i].time <= loopT) idx = i;
      else break;
    }
    const count = cycles * downbeats.length + idx + 1;

    if (this.lastDownbeatCount === -1) {
      this.lastDownbeatCount = count;
      return;
    }
    if (count > this.lastDownbeatCount) {
      let n = count - this.lastDownbeatCount;
      if (n > 8) n = 8; // cap: don't flood after a stall
      for (let k = 0; k < n; k++) {
        const c = count - n + k; // 1-based absolute downbeat number
        const cue = downbeats[(c - 1) % downbeats.length];
        const abs = cue.time + Math.floor((c - 1) / downbeats.length) * loopSec;
        const bar = Math.floor(cue.time / this.sheet.barSec);
        const major = bar % 4 === 0 || bar === 0;
        this.pendingEvents.push({ time: abs, energy: cue.energy ?? 0.6, major });
      }
      this.lastDownbeatCount = count;
    } else if (count < this.lastDownbeatCount) {
      // time jumped backwards (restart) — resync
      this.lastDownbeatCount = count;
    }
  }

  /** consume pending beat events (call after update) */
  drainBeatEvents(): BeatHit[] {
    if (this.pendingEvents.length === 0) return EMPTY_EVENTS;
    const out = this.pendingEvents;
    this.pendingEvents = [];
    return out;
  }

  /** cue times of a type in [0, LOOP), sorted — zero-copy for schedulers */
  getTypeTimes(type: Cue['type']): readonly number[] {
    return this.sheet.getTimesOfType(type);
  }

  get totalBars(): number {
    return TOTAL_BARS;
  }
}

function sectionForBar(bar: number) {
  const b = ((bar % TOTAL_BARS) + TOTAL_BARS) % TOTAL_BARS;
  for (let i = SECTIONS.length - 1; i >= 0; i--) {
    if (b >= SECTIONS[i].startBar) return SECTIONS[i];
  }
  return SECTIONS[0];
}

const EMPTY_EVENTS: BeatHit[] = [];
