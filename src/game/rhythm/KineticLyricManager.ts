/**
 * KineticLyricManager — upper-third cinematic lyrics.
 *
 * Timing is driven by the DSP audio clock (§7): the manager is called from
 * the game loop with rhythm.getCurrentAudioTime() and decides line
 * entrance/exit and word highlight activation analytically from that value —
 * never from React state or CSS animation timing. DOM styles are written
 * imperatively each frame; lyrics stay lip-synced even if FPS drops.
 *
 * Data honesty (§10):
 *   - word timing supplied by the source (A2 enhanced LRC) → each word
 *     activates at its TRUE timestamp — no interpolation, no pretending
 *   - line-only timing (standard synced LRC) → the line animates as a whole
 *     (klyric-line-only emphasis); word highlights are DISABLED
 *   - authored demo color-tag cues → explicit DEMO mode (§12), stagger kept
 *
 * Semantics:
 *   - bold modern sans (Inter fallback), white, subtle black shadow, centered
 *   - inline coloring: <color=#FF3B30>WORD</color> (demo/authored only)
 *   - highlighted word: scale ≈ 1.15× + short bloom burst, settle over 120 ms
 *   - line entrance: opacity 0→1 over 0.08 s, ≈3 px upward spring
 *   - line exit: opacity 1→0 over 0.12 s
 */

export interface LyricCue {
  time: number;
  text: string;
  /** explicit line end (resolved song data); else derived from the next line */
  end?: number;
  /** word-level timing ONLY when the source actually carries it (§10) */
  words?: { start: number; text: string }[];
  /** authored demo mode only: stagger highlights across the line (§12) */
  stagger?: boolean;
}

export interface LyricWord {
  text: string;
  color: string | null;
  /** DSP time this word becomes highlighted — null = NO word timing (§10) */
  highlightAt: number | null;
  element: HTMLSpanElement;
}

export interface LyricLine {
  startTime: number;
  endTime: number;
  words: LyricWord[];
  element: HTMLDivElement;
  /** render state */
  state: 'hidden' | 'entering' | 'shown' | 'exiting';
  stateT: number;
}

const COLOR_TAG_RE = /<color=#([0-9A-Fa-f]{6})>([^<]*)<\/color>/g;

/** entrance / exit constants (seconds) */
const ENTER_SEC = 0.08;
const EXIT_SEC = 0.12;
const SETTLE_MS = 120;
void SETTLE_MS;

export class KineticLyricManager {
  private lines: LyricLine[] = [];
  private activeIdx = -1;
  private container: HTMLElement;
  private prevAudioTime = 0;

  /** fired when a colored word activates (for bloom burst) */
  onWordHighlight: ((color: string) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /** build the DOM once from lyric cues [{time, text, end?, words?, stagger?}] */
  build(cues: LyricCue[], defaultDur = 6.5): void {
    this.container.innerHTML = '';
    this.lines = [];
    this.activeIdx = -1;

    cues.forEach((cue, i) => {
      const endTime =
        cue.end != null
          ? cue.end
          : i + 1 < cues.length
          ? Math.min(cues[i + 1].time - 0.15, cue.time + defaultDur)
          : cue.time + defaultDur;
      const line = document.createElement('div');
      line.className = 'klyric-line';
      line.style.opacity = '0';
      // line-only timing: whole-line emphasis instead of word highlights (§10)
      if (!cue.words && !cue.stagger) line.classList.add('klyric-line-only');

      // split to plain-word tokens (color tags may wrap demo words)
      const parsed: { text: string; color: string | null }[] = [];
      let lastIdx = 0;
      COLOR_TAG_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = COLOR_TAG_RE.exec(cue.text)) !== null) {
        if (m.index > lastIdx) parsed.push(...splitPlain(cue.text.slice(lastIdx, m.index)));
        for (const w of m[2].split(/\s+/)) {
          if (w.length) parsed.push({ text: w, color: `#${m[1]}` });
        }
        lastIdx = m.index + m[0].length;
      }
      if (lastIdx < cue.text.length) parsed.push(...splitPlain(cue.text.slice(lastIdx)));

      const n = parsed.length;
      const spanDur = ((endTime - cue.time) * 0.7) / Math.max(1, n);
      // greedy matcher for REAL word timestamps (§10: match tokens to the
      // source's timed segments; unmatched tokens get NO highlight timing)
      const words: LyricWord[] = [];
      let wordPtr = 0;
      const norm = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
      parsed.forEach((w, wi) => {
        const span = document.createElement('span');
        span.className = 'klyric-word';
        span.textContent = w.text;
        if (w.color) span.style.color = w.color;
        line.appendChild(span);
        if (wi < n - 1) line.appendChild(document.createTextNode(' '));

        let highlightAt: number | null = null;
        if (cue.words && !cue.stagger) {
          const token = norm(w.text);
          for (let k = wordPtr; k < cue.words.length; k++) {
            const seg = norm(cue.words[k].text);
            if (!token || !seg || seg.includes(token) || token.includes(seg)) {
              highlightAt = cue.words[k].start;
              wordPtr = k + 1;
              break;
            }
          }
        } else if (cue.stagger) {
          // authored demo mode: stagger highlights across ~70% of the line
          highlightAt = cue.time + spanDur * (wi + 1);
        }
        words.push({ text: w.text, color: w.color, highlightAt, element: span });
      });

      this.container.appendChild(line);
      this.lines.push({
        startTime: cue.time,
        endTime,
        words,
        element: line,
        state: 'hidden',
        stateT: 0,
      });
    });
  }

  /**
   * Frame update — pass rhythm.getCurrentAudioTime(). All timing derives from
   * this value (DSP clock), so lyrics never drift from the music.
   */
  update(audioTime: number): void {
    if (this.lines.length === 0) return;
    // time advanced since last frame (DSP-clock delta, guarded)
    let dt = audioTime - this.prevAudioTime;
    if (dt < 0) {
      // backwards time (restart): rebuild states
      this.resetStates();
      dt = 0.016;
    }
    dt = Math.min(0.25, dt);
    this.prevAudioTime = audioTime;

    // ---- find the active line ----
    let idx = -1;
    for (let i = 0; i < this.lines.length; i++) {
      const l = this.lines[i];
      if (audioTime >= l.startTime && audioTime < l.endTime) {
        idx = i;
        break;
      }
    }

    // ---- deactivate other lines (exit fade) ----
    for (let i = 0; i < this.lines.length; i++) {
      if (i === idx) continue;
      const l = this.lines[i];
      if (l.state === 'shown' || l.state === 'entering') {
        l.state = 'exiting';
        l.stateT = 0;
      }
      if (l.state === 'exiting') {
        l.stateT += dt;
        const k = clamp01(l.stateT / EXIT_SEC);
        l.element.style.opacity = String(1 - k);
        if (k >= 1) {
          l.state = 'hidden';
          l.element.style.opacity = '0';
          l.element.style.transform = 'translateY(0)';
          for (const w of l.words) w.element.classList.remove('klyric-hl');
        }
      }
    }

    // ---- activate the current line ----
    if (idx >= 0) {
      const l = this.lines[idx];
      if (l.state === 'hidden' || l.state === 'exiting') {
        l.state = 'entering';
        l.stateT = 0;
        // reset word highlights for a fresh entrance
        for (const w of l.words) w.element.classList.remove('klyric-hl');
      }
      // entrance progress (0.08 s, 3 px spring upward)
      if (l.state === 'entering') {
        l.stateT += dt;
        const k = clamp01(l.stateT / ENTER_SEC);
        l.element.style.opacity = String(k);
        const spring = 3 * (1 - k) * (1 - k); // 3px → 0 with ease-out
        l.element.style.transform = `translateY(${spring.toFixed(2)}px)`;
        if (k >= 1) l.state = 'shown';
      } else {
        l.element.style.opacity = '1';
      }

      // ---- word highlight activation (DSP-time driven, REAL timestamps only;
      // lines without word timing animate as a whole and never highlight) ----
      for (const w of l.words) {
        if (w.highlightAt == null) continue;
        if (audioTime >= w.highlightAt && !w.element.classList.contains('klyric-hl')) {
          w.element.classList.add('klyric-hl');
          // scale pops to 1.15× then settles via CSS transition (120 ms)
          if (w.color) this.onWordHighlight?.(w.color);
        }
      }
    }
  }

  private resetStates(): void {
    for (const l of this.lines) {
      l.state = 'hidden';
      l.stateT = 0;
      l.element.style.opacity = '0';
      l.element.style.transform = 'translateY(0)';
      for (const w of l.words) w.element.classList.remove('klyric-hl');
    }
    this.activeIdx = -1;
  }

  dispose(): void {
    this.container.innerHTML = '';
    this.lines = [];
  }
}

function splitPlain(text: string): { text: string; color: string | null }[] {
  return text
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => ({ text: w, color: null }));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
