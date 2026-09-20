/**
 * CueSheetParser — parses a JSON cue sheet (see cueSheet.ts for the schema)
 * into indexed, time-sorted structures for O(log n) / O(1) lookups by the
 * rhythm systems. Supports cue types: beat, downbeat, bar, drop, chorus,
 * gate, lyric, camera, preset.
 */

import type { Cue, CueSheetJson } from './cueSheet';

export class ParsedCueSheet {
  readonly title: string;
  readonly bpm: number;
  readonly offsetSec: number;
  readonly beatSec: number;
  readonly barSec: number;
  /** musical timeline length (s) — the demo loop OR the selected song duration */
  readonly loopSec: number;
  /** all cues sorted by time */
  readonly cues: readonly Cue[];
  /** cues filtered by type, each still time-sorted */
  private byType = new Map<Cue['type'], Cue[]>();

  constructor(json: CueSheetJson) {
    this.title = json.track_title;
    this.bpm = json.bpm;
    this.offsetSec = json.offset_sec ?? 0;
    this.beatSec = json.bpm > 0 ? 60 / json.bpm : Infinity;
    this.barSec = Number.isFinite(this.beatSec) ? this.beatSec * 4 : Infinity;
    this.cues = [...json.cues].sort((a, b) => a.time - b.time);
    this.loopSec = json.loop_sec ?? (this.cues.length ? this.cues[this.cues.length - 1].time + this.barSec : 0);

    for (const cue of this.cues) {
      const list = this.byType.get(cue.type) ?? [];
      list.push(cue);
      this.byType.set(cue.type, list);
      if (cue.type === 'downbeat') this.downbeats.push(cue.time);
      if (cue.type === 'beat') this.beats.push(cue.time);
    }
    this.allBeats = [...this.beats, ...this.downbeats].sort((a, b) => a - b);
    this.downbeats.sort((a, b) => a - b);
    for (const [type, list] of this.byType) {
      this.timesByType.set(type, list.map((c) => c.time));
    }
  }

  getCuesOfType(type: Cue['type']): readonly Cue[] {
    return this.byType.get(type) ?? [];
  }

  /** zero-copy sorted times for a cue type (for schedulers) */
  getTimesOfType(type: Cue['type']): readonly number[] {
    return this.timesByType.get(type) ?? EMPTY_TIMES;
  }
  private timesByType = new Map<Cue['type'], number[]>();
  private downbeats: number[] = [];
  private beats: number[] = [];
  private allBeats: number[] = [];

  /** binary search: index of the last cue with time <= t (per array) */
  private static lastIndexAtOrBefore(arr: readonly { time: number }[], t: number): number {
    let lo = 0;
    let hi = arr.length - 1;
    let res = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].time <= t) {
        res = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return res;
  }

  /** next cue strictly after t from a sorted time array */
  private static nextAfter(arr: { time: number }[] | number[], t: number): number | null {
    let lo = 0;
    let hi = arr.length - 1;
    let res: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const time = typeof arr[mid] === 'number' ? (arr[mid] as number) : (arr[mid] as { time: number }).time;
      if (time > t) {
        res = time;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return res;
  }
  nextBeatTime(t: number): number | null {
    return ParsedCueSheet.nextAfter(this.allBeats, t);
  }

  nextDownbeatTime(t: number): number | null {
    return ParsedCueSheet.nextAfter(this.downbeats, t);
  }

  /** last lyric cue whose time <= t */
  currentLyric(t: number): Cue | null {
    const list = this.getCuesOfType('lyric');
    const i = ParsedCueSheet.lastIndexAtOrBefore(list, t);
    return i >= 0 ? list[i] : null;
  }

  /** last preset cue whose time <= t */
  currentPreset(t: number): Cue | null {
    const list = this.getCuesOfType('preset');
    const i = ParsedCueSheet.lastIndexAtOrBefore(list, t);
    return i >= 0 ? list[i] : null;
  }
}

/** parse from a raw JSON object (typed at runtime boundaries) */
export function parseCueSheet(json: unknown): ParsedCueSheet {
  const sheet = json as CueSheetJson;
  if (!sheet || typeof sheet.bpm !== 'number' || sheet.bpm < 0 || !Array.isArray(sheet.cues)) {
    throw new Error('Invalid cue sheet: missing bpm or cues');
  }
  return new ParsedCueSheet(sheet);
}

const EMPTY_TIMES: number[] = [];
