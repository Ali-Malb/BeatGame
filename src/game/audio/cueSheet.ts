/**
 * Cue sheet for the built-in synthesized track "MIDNIGHT RUNNER — C1 Inner Loop".
 *
 * Structure (128 BPM · 4/4 · 88-bar loop = 165 s):
 *   bars 0–15   0:00–0:30   TWILIGHT DUSK     energy 0.30  (intro: pad + filtered arp)
 *   bars 16–43  0:30–1:22   STARRY NIGHT      energy 0.62  (build: bass + hats, verses)
 *   bars 44–67  1:22–2:07   GOLDEN SUNSET     energy 1.00  (chorus: full kit + lead hook)
 *   bars 68–87  2:07–2:45   WET RAINY NIGHT   energy 0.92  (drop: rolling 16th bass + stabs)
 * then the loop restarts with a hard weather cut back to TWILIGHT.
 *
 * The cue list is generated deterministically from this structure (downbeats,
 * gates, drops, lyric lines, camera impacts, weather preset changes) so the
 * CueSheetParser consumes a plain JSON object exactly like an authored sheet.
 */

export interface Cue {
  /** DSP-track time in seconds */
  time: number;
  type: 'beat' | 'downbeat' | 'bar' | 'drop' | 'chorus' | 'gate' | 'lyric' | 'camera' | 'preset';
  /** optional camera hint on the cue */
  camera?: 'impact' | 'shake' | 'none';
  /** weather preset index for `preset` cues */
  preset?: number;
  /** inline-colored lyric text for `lyric` cues: uses <color=#RRGGBB>WORD</color> */
  text?: string;
  /** musical strength 0..1 (used for world pulse amplitude) */
  energy?: number;
}

export interface CueSheetJson {
  track_title: string;
  bpm: number;
  offset_sec: number;
  /** musical timeline length in seconds (song mode: the SONG duration §13) */
  loop_sec?: number;
  cues: Cue[];
}

export const BPM = 128;
export const TRACK_TITLE = 'MIDNIGHT RUNNER — C1 Inner Loop';
/** DSP seconds per beat / bar */
export const BEAT_SEC = 60 / BPM;
export const BAR_SEC = BEAT_SEC * 4;

export interface TrackSection {
  name: string;
  startBar: number;
  bars: number;
  energy: number;
  preset: number;
}

export const SECTIONS: TrackSection[] = [
  { name: 'twilight', startBar: 0, bars: 16, energy: 0.3, preset: 0 },
  { name: 'starry', startBar: 16, bars: 28, energy: 0.62, preset: 1 },
  { name: 'golden', startBar: 44, bars: 24, energy: 1.0, preset: 2 },
  { name: 'rain', startBar: 68, bars: 20, energy: 0.92, preset: 3 },
];

export const TOTAL_BARS = 88;
export const LOOP_SEC = TOTAL_BARS * BAR_SEC;

/** lyric lines with DSP-timed entrances (and the beat they exit on) */
const LYRIC_LINES: { startBar: number; endBar: number; text: string }[] = [
  // — twilight intro —
  { startBar: 2, endBar: 6, text: 'INDIGO SKY OVER THE <color=#FF3B30>BAY</color>' },
  { startBar: 6, endBar: 10, text: 'CITY <color=#FF3B30>BREATHING</color> IN THE DARK' },
  { startBar: 10, endBar: 14, text: 'THROTTLE OPEN · <color=#FF3B30>RUN</color>' },
  // — starry night verses —
  { startBar: 18, endBar: 22, text: 'SODIUM LIGHTS ON <color=#41D6FF>WET</color> STEEL' },
  { startBar: 22, endBar: 26, text: 'EMBERS <color=#FF3B30>RISE</color> BEHIND ME' },
  { startBar: 26, endBar: 30, text: 'MIRRORS FULL OF <color=#FF3B30>HEADLIGHTS</color>' },
  { startBar: 30, endBar: 34, text: 'ONE GAP · <color=#FFD60A>NO BRAKES</color>' },
  { startBar: 34, endBar: 38, text: 'FOURTEEN THOUSAND <color=#FF3B30>SCREAMING</color>' },
  { startBar: 38, endBar: 42, text: 'CUTTING THROUGH THE <color=#FFD60A>NIGHT</color>' },
  // — golden chorus —
  { startBar: 44, endBar: 48, text: '<color=#FF9F0A>BURN</color> THROUGH THE GOLDEN HOUR' },
  { startBar: 48, endBar: 52, text: 'WE <color=#FFD60A>RIDE</color> THE LIGHT' },
  { startBar: 52, endBar: 56, text: 'THREE HUNDRED ON THE <color=#FF3B30>DIAL</color>' },
  { startBar: 56, endBar: 60, text: 'LEAN UNTIL THE <color=#FF9F0A>SPARKS</color> FLY' },
  { startBar: 60, endBar: 64, text: 'NO TOMORROW · <color=#FFD60A>ONLY NOW</color>' },
  { startBar: 64, endBar: 68, text: 'WE <color=#FFD60A>RIDE</color> THE LIGHT' },
  // — rain drop —
  { startBar: 68, endBar: 72, text: 'RAIN ON <color=#41D6FF>GLASS</color> AND STEEL' },
  { startBar: 72, endBar: 76, text: 'TAIL LIGHTS <color=#FF3B30>SMEAR</color> THE DARK' },
  { startBar: 76, endBar: 80, text: 'NEVER <color=#FF3B30>SLOW DOWN</color>' },
  { startBar: 80, endBar: 84, text: 'CHASE THE <color=#41D6FF>STORM</color> HOME' },
  { startBar: 84, endBar: 88, text: 'MIDNIGHT <color=#FFD60A>RUNNER</color>' },
];

function sectionAtBar(bar: number): TrackSection {
  const b = ((bar % TOTAL_BARS) + TOTAL_BARS) % TOTAL_BARS;
  for (let i = SECTIONS.length - 1; i >= 0; i--) {
    if (b >= SECTIONS[i].startBar) return SECTIONS[i];
  }
  return SECTIONS[0];
}

/**
 * Build the full cue sheet JSON. Deterministic — same output every call.
 */
export function buildCueSheet(): CueSheetJson {
  const cues: Cue[] = [];
  const offset = 0.031;

  const barTime = (bar: number) => offset + bar * BAR_SEC;

  // ---- section-level cues: presets, drops, chorus ----
  for (const sec of SECTIONS) {
    cues.push({
      time: barTime(sec.startBar),
      type: 'preset',
      preset: sec.preset,
      energy: sec.energy,
    });
    if (sec.name === 'golden') {
      cues.push({ time: barTime(sec.startBar), type: 'drop', camera: 'impact', energy: 1.0 });
      cues.push({ time: barTime(sec.startBar), type: 'chorus', energy: 1.0 });
    }
    if (sec.name === 'rain') {
      cues.push({ time: barTime(sec.startBar), type: 'drop', camera: 'impact', energy: 0.92 });
    }
  }

  // ---- bars & downbeats ----
  for (let bar = 0; bar < TOTAL_BARS; bar++) {
    const sec = sectionAtBar(bar);
    cues.push({ time: barTime(bar), type: 'downbeat', energy: sec.energy });
    // beats inside the bar (skip the downbeat itself)
    for (let b = 1; b < 4; b++) {
      cues.push({ time: barTime(bar) + b * BEAT_SEC, type: 'beat', energy: sec.energy });
    }
    // bar marker every 4 bars (phrase level)
    if (bar % 4 === 0) cues.push({ time: barTime(bar), type: 'bar', energy: sec.energy });
  }

  // ---- rhythm gates: every 2 bars, on downbeats (every 4 bars in the intro) ----
  for (let bar = 0; bar < TOTAL_BARS; bar++) {
    const sec = sectionAtBar(bar);
    const step = sec.name === 'twilight' ? 4 : 2;
    if (bar % step === 0) {
      cues.push({ time: barTime(bar), type: 'gate', energy: sec.energy });
    }
  }

  // ---- lyric lines ----
  for (const line of LYRIC_LINES) {
    cues.push({
      time: barTime(line.startBar),
      type: 'lyric',
      text: line.text,
      energy: sectionAtBar(line.startBar).energy,
    });
  }

  // ---- camera accents at phrase turns in the chorus/drop ----
  for (let bar = 44; bar < TOTAL_BARS; bar += 8) {
    cues.push({ time: barTime(bar), type: 'camera', camera: 'impact', energy: 0.8 });
  }

  cues.sort((a, b) => a.time - b.time);
  return { track_title: TRACK_TITLE, bpm: BPM, offset_sec: offset, loop_sec: LOOP_SEC, cues };
}

export { sectionAtBar };
