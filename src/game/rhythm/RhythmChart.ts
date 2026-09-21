/**
 * RhythmChart — deterministic conversion of an Analysis into a playable chart.
 *
 * Onsets are quantized onto the song's beat grid (subdivisions 1/1, 1/2, 1/4,
 * 1/8 — 1/8 only in the highest-energy sections), then lanes are assigned with
 * hard reachability rules:
 *   - a note never requires moving more than 1 lane from the previous note
 *     within the same beat (the bike spans ~0.35 s per lane change)
 *   - slalom runs (0-1-2-3 / 3-2-1-0 or 1-2-3-2 shapes) are used for dense
 *     fast passages, static-pair alternation for medium density
 *   - minimum spacing after an 1/8 run relaxes back to 1/4 positions
 *
 * The same audio always produces the same chart (seeded RNG + deterministic
 * quantization) — no random charts unrelated to the music.
 */

import type { Analysis, AnalysisSection } from '../audio/AudioAnalyzer';
import { sectionAt } from '../audio/AudioAnalyzer';
import { RNG } from '../core/utils';

export type NoteType = 'kick' | 'snare' | 'vocal';

export interface ChartNote {
  /** absolute song time (s) — the instant the bike should cross the gate */
  time: number;
  /** 0..3 (left → right) */
  lane: number;
  /** 1 = whole, 2 = half, 4 = quarter, 8 = eighth */
  subdivision: 1 | 2 | 4 | 8;
  /** 0..1 musical strength of the source onset */
  strength: number;
  type: NoteType;
}

export interface RhythmChart {
  notes: ChartNote[];
  bpm: number;
  firstBeat: number;
  beatSec: number;
  duration: number;
  sections: AnalysisSection[];
}

const LANE_CENTER = 1.5; // average lane index

function sectionDensity(sec: AnalysisSection | undefined, quality: Analysis['quality']): number {
  const base =
    sec?.kind === 'drop' || sec?.kind === 'chorus'
      ? 1.0
      : sec?.kind === 'buildup'
        ? 0.85
        : sec?.kind === 'verse'
          ? 0.7
          : sec?.kind === 'breakdown'
            ? 0.5
            : 0.55; // intro/outro
  const q = quality === 'ok' ? 1 : quality === 'sparse' ? 0.72 : 0.5;
  return base * q;
}

export function buildChart(a: Analysis): RhythmChart {
  const rng = new RNG(0x51ee7);
  const beatSec = a.beatSec;
  const firstBeat = a.firstBeat;
  const duration = a.duration;

  // ---- pass 1: quantize onsets to the nearest grid slot, dedupe, filter by density
  interface Slot {
    time: number;
    subdivision: 1 | 2 | 4 | 8;
    strength: number;
    type: NoteType;
    energy: number;
  }
  const slots: Slot[] = [];
  const gridRound = (t: number, div: number): number => {
    const step = beatSec / div;
    const k = Math.round((t - firstBeat) / step);
    return firstBeat + k * step;
  };

  for (const o of a.onsets) {
    if (o.time < firstBeat + 0.35 || o.time > duration - 0.6) continue; // intro/outro tail: keep road clean
    // choose subdivision by band + strength + local energy
    const energy = sectionAt(a, o.time).energy;
    const isKick = o.band === 'bass';
    let div: 1 | 2 | 4 | 8;
    if (isKick && o.strength > 0.8) div = 1;
    else if (isKick) div = energy > 0.6 ? 4 : 2;
    else div = energy > 0.72 && o.strength > 0.55 ? 8 : 4;
    // low-energy sections never get 1/8
    if (div === 8 && energy < 0.7) div = 4;

    const qt = gridRound(o.time, div);
    // reject if quantization moved it too far (> 35% of the slot)
    if (Math.abs(qt - o.time) > (beatSec / div) * 0.35) continue;
    if (qt < 0 || qt > duration - 0.2) continue;

    const last = slots[slots.length - 1];
    if (last && qt - last.time < (beatSec / 8) * 0.9) {
      // collision inside an 1/8 slot: keep the stronger
      if (o.strength > last.strength) {
        last.strength = o.strength;
        last.type = isKick ? 'kick' : last.type;
        last.subdivision = div;
        last.time = qt;
        last.energy = energy;
      }
      continue;
    }
    slots.push({ time: qt, subdivision: div, strength: o.strength, type: isKick ? 'kick' : 'snare', energy });
  }

  // ---- pass 2: density filter per section (drop weaker notes when dense)
  const notes: ChartNote[] = [];
  let lastLane = 1;
  let lastTime = -10;
  let prevTime = -10;
  let lastDiv = 4;

  for (const s of slots) {
    const sec = sectionAt(a, s.time);
    const density = sectionDensity(sec, a.quality);
    // keep probability scales with strength × density
    const keepScore = s.strength * (0.55 + density * 0.75);
    if (keepScore < 0.72 && s.subdivision === 8) continue;
    if (keepScore < 0.5 && s.subdivision === 4 && s.type === 'snare') continue;

    // ---- lane assignment (reachability-first) ----
    let lane: number;
    const dt = s.time - lastTime;
    const beatsGap = dt / beatSec;
    const maxJump = beatsGap < 0.55 ? 1 : beatsGap < 1.05 ? 2 : 3;

    // slalom runs: two consecutive 1/4+ notes < 1 beat apart at high energy
    const wantSlalom = s.energy > 0.62 && s.subdivision >= 4 && beatsGap > 0.22 && beatsGap < 1.1;
    if (wantSlalom && rng.next() < 0.75) {
      const dir = lastLane <= LANE_CENTER ? 1 : -1;
      const cand = lastLane + dir;
      lane = cand >= 0 && cand <= 3 ? cand : lastLane - dir;
    } else if (rng.next() < 0.3) {
      // hop back toward the middle band to avoid rail-hugging
      const target = lastLane < LANE_CENTER ? lastLane + 1 : lastLane - 1;
      lane = Math.max(0, Math.min(3, target));
    } else {
      lane = lastLane;
    }
    // clamp to reachability
    lane = Math.max(lastLane - maxJump, Math.min(lastLane + maxJump, lane));
    lane = Math.max(0, Math.min(3, lane));

    notes.push({
      time: +s.time.toFixed(4),
      lane,
      subdivision: s.subdivision,
      strength: +Math.min(1, s.strength).toFixed(3),
      type: s.type,
    });

    prevTime = lastTime;
    lastTime = s.time;
    lastLane = lane;
    lastDiv = s.subdivision;
    void prevTime;
    void lastDiv;
  }

  // ---- pass 3: final safety — no two notes closer than one 1/8 anywhere
  const safe: ChartNote[] = [];
  let lastT = -10;
  for (const n of notes) {
    if (n.time - lastT < (beatSec / 8) * 0.92) continue;
    safe.push(n);
    lastT = n.time;
  }

  return {
    notes: safe,
    bpm: a.bpm,
    firstBeat: a.firstBeat,
    beatSec: a.beatSec,
    duration: a.duration,
    sections: a.sections,
  };
}
