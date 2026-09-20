/**
 * MusicEngine — the built-in synthwave track, fully synthesized in Web Audio.
 *
 * 128 BPM · 4/4 · 88-bar loop (165 s) in four sections matching the weather
 * presets (twilight / starry / golden / rain). Every note is scheduled with
 * sample-accurate `osc.start(t)` on the AudioContext hardware timeline with a
 * 350 ms lookahead pump — the pump cadence is irrelevant to timing accuracy,
 * so the music never drifts even when the render FPS drops.
 *
 * Instruments: kick, snare/clap, hats, sub/saw bass with acid filter envelope,
 * resonant arp through a shared energy-tracked filter + tempo delay, detuned
 * supersaw lead with vibrato, warm pads, risers, crash cymbal.
 */

import type { AudioDspClock } from './AudioDspClock';
import { BEAT_SEC, sectionAtBar, TOTAL_BARS } from './cueSheet';

const STEP_SEC = BEAT_SEC / 4; // 16th note
const STEPS_PER_BAR = 16;
const LOOKAHEAD = 0.35;

// midi helpers
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

// chord roots per bar (Am F C G loop)
const CHORD_ROOTS = [45, 41, 48, 43];
// chord tones (relative semitones) for pads/arp — minor, major, major, major
const CHORD_SHAPES: number[][] = [
  [0, 3, 7, 12],
  [0, 4, 7, 12],
  [0, 4, 7, 12],
  [0, 4, 7, 12],
];

// chorus lead motifs: [step, midi, durSteps] per 2-bar pair
const LEAD_MOTIFS: [number, number, number][][] = [
  [
    [0, 76, 2], [3, 72, 2], [6, 74, 2], [8, 76, 3], [12, 72, 2], [14, 74, 2],
  ],
  [
    [0, 79, 2], [3, 76, 2], [6, 74, 2], [8, 71, 3], [12, 76, 2], [14, 79, 4],
  ],
  [
    [0, 84, 4], [6, 81, 2], [8, 79, 2], [10, 76, 3], [14, 74, 2],
  ],
  [
    [0, 72, 2], [3, 74, 2], [6, 76, 4], [11, 79, 2], [14, 81, 2],
  ],
];

export class MusicEngine {
  private ctx: AudioContext | null = null;
  private clock: AudioDspClock;
  private bus!: GainNode;
  private delaySend!: GainNode;
  private arpFilter!: BiquadFilterNode;
  private noiseBuffer!: AudioBuffer;
  private started = false;
  private paused = false;
  private stepCounter = 0;
  private nextStepDsp = 0;
  private energySmooth = 0.3;

  enabled = true;
  volume = 0.6;

  constructor(clock: AudioDspClock) {
    this.clock = clock;
  }

  /** must be called after the DSP clock has an attached, running context */
  start(ctx: AudioContext, destination: AudioNode): void {
    if (this.started) {
      this.bus.connect(destination);
      return;
    }
    this.ctx = ctx;
    this.started = true;

    this.bus = ctx.createGain();
    this.bus.gain.value = this.enabled ? this.volume : 0;

    // gentle glue compression before the destination
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.004;
    comp.release.value = 0.24;
    this.bus.connect(comp);
    comp.connect(destination);

    // tempo-synced feedback delay (dotted 8th @128 = 0.3516 s)
    const delay = ctx.createDelay(1.0);
    delay.delayTime.value = BEAT_SEC * 0.75;
    const fb = ctx.createGain();
    fb.gain.value = 0.34;
    const dampen = ctx.createBiquadFilter();
    dampen.type = 'lowpass';
    dampen.frequency.value = 3200;
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    this.delaySend = ctx.createGain();
    this.delaySend.gain.value = 1;
    this.delaySend.connect(delay);
    delay.connect(dampen);
    dampen.connect(fb);
    fb.connect(delay);
    dampen.connect(wet);
    wet.connect(this.bus);

    // shared resonant arp filter (cutoff rides the section energy)
    this.arpFilter = ctx.createBiquadFilter();
    this.arpFilter.type = 'lowpass';
    this.arpFilter.frequency.value = 900;
    this.arpFilter.Q.value = 7;
    this.arpFilter.connect(this.bus);
    this.arpFilter.connect(this.delaySend);

    // noise buffer for drums
    const len = Math.floor(ctx.sampleRate * 1.2);
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // align step grid with the DSP clock epoch
    const epoch = ctx.currentTime - this.clock.getAudioTime();
    this.nextStepDsp = epoch + Math.ceil((ctx.currentTime - epoch) / STEP_SEC + 0.5) * STEP_SEC;
    // normalize so bar boundaries land on integer bar counts
    this.stepCounter = Math.round((this.nextStepDsp - epoch) / STEP_SEC);
    this.stepCounter -= this.stepCounter % STEPS_PER_BAR; // start on a bar
    this.nextStepDsp = epoch + this.stepCounter * STEP_SEC;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.bus) this.bus.gain.value = this.enabled ? v : 0;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.bus) this.bus.gain.value = on ? this.volume : 0;
  }

  setPaused(p: boolean): void {
    this.paused = p;
  }

  /**
   * Lookahead pump — call every frame. Schedules notes up to LOOKAHEAD ahead
   * on the hardware timeline. Timing accuracy is independent of pump rate.
   */
  pump(): void {
    if (!this.ctx || !this.started || this.paused || !this.enabled) return;
    const ctx = this.ctx;
    const epoch = ctx.currentTime - this.clock.getAudioTime();
    const horizon = ctx.currentTime + LOOKAHEAD;
    let guard = 96;
    while (this.nextStepDsp < horizon && guard-- > 0) {
      this.scheduleStep(this.stepCounter, this.nextStepDsp, epoch);
      this.stepCounter++;
      this.nextStepDsp += STEP_SEC;
    }
  }

  // ---------------------------------------------------------------- patterns ----
  private scheduleStep(step: number, t: number, epoch: number): void {
    const ctx = this.ctx!;
    const bar = Math.floor(step / STEPS_PER_BAR) % TOTAL_BARS;
    const s = step % STEPS_PER_BAR;
    const sec = sectionAtBar(bar);
    const barInSection = bar - sec.startBar;
    const isBarStart = s === 0;
    const chordIdx = bar % 4;
    const root = CHORD_ROOTS[chordIdx];
    const shape = CHORD_SHAPES[chordIdx];
    const musicT = t - epoch;

    // keep the shared arp filter tracking section energy
    if (isBarStart) {
      const target = sec.name === 'twilight' ? 750 : sec.name === 'starry' ? 1600 + barInSection * 60 : sec.name === 'golden' ? 5200 : 3400;
      this.arpFilter.frequency.setTargetAtTime(Math.min(target, 6500), t, 0.4);
    }

    // ---------------- drums ----------------
    if (sec.name === 'twilight') {
      if (s === 0 || s === 8) this.kick(t, 0.7);
    } else {
      if (s % 4 === 0) this.kick(t, 1.0);
      // ghost kick in the drop for drive
      if (sec.name === 'rain' && (s === 6 || s === 14)) this.kick(t, 0.35);
    }

    if (sec.name === 'starry' && bar >= 28 && (s === 4 || s === 12)) this.snare(t, 0.5);
    if (sec.name === 'golden' && (s === 4 || s === 12)) {
      this.snare(t, 0.85);
      this.clap(t, 0.5);
    }
    if (sec.name === 'rain' && (s === 4 || s === 12)) {
      this.snare(t, 0.75);
    }

    // hats
    const hatOpen = sec.name === 'golden' && s === 14;
    if (sec.name === 'starry' && s % 2 === 0 && s % 4 !== 0) this.hat(t, false, 0.5 + (s % 4 === 2 ? 0.3 : 0));
    if ((sec.name === 'golden' || sec.name === 'rain') && s % 2 === 1) this.hat(t, false, 0.55 + (s % 4 === 3 ? 0.25 : 0));
    if (sec.name === 'golden' && s % 2 === 0 && s % 4 !== 0) this.hat(t, false, 0.8);
    if (hatOpen) this.hat(t, true, 0.7);

    // crash + riser at section boundaries
    if (isBarStart && (bar === 44 || bar === 68 || bar === 0) && s === 0) {
      this.crash(t);
    }
    if (sec.name === 'starry' && bar >= 40 && isBarStart) {
      this.riser(t, BAR_SEC(sec, bar) * 2, 0.22 + (bar - 40) * 0.06);
    }
    if (sec.name === 'rain' && bar >= 84 && isBarStart) {
      this.riser(t, BAR_SEC(sec, bar) * 2, 0.3);
    }

    // ---------------- bass ----------------
    if (sec.name === 'starry' || sec.name === 'rain') {
      // rolling: 8ths in build (16ths late-build & drop), octave accents
      const sixteenth = sec.name === 'rain' || bar >= 32;
      if (sixteenth || s % 2 === 0) {
        const octaveJump = (s % 8 === 6 || s % 16 === 12) ? 12 : 0;
        const accent = s % 4 === 0 ? 1 : 0.62;
        const wobble = sec.name === 'rain' ? 1 + 0.45 * Math.sin(musicT * 2.2) : 1;
        this.bass(t, root + octaveJump, STEP_SEC * (sixteenth ? 0.9 : 1.8), 0.5 * accent * wobble);
      }
    } else if (sec.name === 'golden') {
      if (s % 2 === 0) {
        const octaveJump = s % 8 === 6 ? 12 : 0;
        this.bass(t, root + octaveJump, STEP_SEC * 1.8, s % 4 === 0 ? 0.55 : 0.34);
      }
    } else if (sec.name === 'twilight') {
      if (s === 0) this.bass(t, root, BEAT_SEC * 2, 0.4);
      if (s === 8) this.bass(t, root, BEAT_SEC * 1.5, 0.3);
    }

    // ---------------- arp ----------------
    {
      const pattern = [0, 2, 1, 3, 2, 1, 3, 0];
      const tone = root + 24 + shape[pattern[s % 8]];
      const accent = s % 4 === 0 ? 1 : s % 2 === 0 ? 0.7 : 0.45;
      const gain = sec.name === 'twilight' ? 0.09 : sec.name === 'starry' ? 0.12 : 0.16;
      this.arp(t, tone, gain * accent);
    }

    // ---------------- stabs (drop only) ----------------
    if (sec.name === 'rain' && (s === 3 || s === 11)) {
      this.stab(t, [root + 12, root + 15, root + 19]);
    }

    // ---------------- pads ----------------
    if (isBarStart) {
      const padGain = sec.name === 'twilight' ? 0.06 : sec.name === 'starry' ? 0.05 : sec.name === 'golden' ? 0.055 : 0.045;
      this.pad(t, [root, root + shape[1], root + shape[2], root + 12], 1.9, padGain);
    }

    // ---------------- lead (chorus) ----------------
    if (sec.name === 'golden') {
      const motif = LEAD_MOTIFS[Math.floor(bar / 2) % LEAD_MOTIFS.length];
      for (const [ms, midi, dur] of motif) {
        if (ms === s) this.lead(t, midi, dur * STEP_SEC * 0.92, 0.3);
      }
    }
  }

  // ------------------------------------------------------------- instruments ----
  private kick(t: number, g: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(41, t + 0.11);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.95 * g, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    osc.connect(gain);
    gain.connect(this.bus);
    osc.start(t);
    osc.stop(t + 0.3);
    // click transient
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 4200;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.12 * g, t);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
    src.connect(hp);
    hp.connect(g2);
    g2.connect(this.bus);
    src.start(t, Math.random() * 0.5, 0.03);
  }

  private snare(t: number, g: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1900;
    bp.Q.value = 0.9;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(g * 0.5, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
    src.connect(bp);
    bp.connect(gain);
    gain.connect(this.bus);
    gain.connect(this.delaySend);
    src.start(t, Math.random() * 0.6, 0.2);
    // body
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(196, t);
    osc.frequency.exponentialRampToValueAtTime(150, t + 0.08);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(g * 0.28, t);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    osc.connect(g2);
    g2.connect(this.bus);
    osc.start(t);
    osc.stop(t + 0.12);
  }

  private clap(t: number, g: number): void {
    const ctx = this.ctx!;
    for (let i = 0; i < 3; i++) {
      const tt = t + i * 0.011;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1300;
      bp.Q.value = 1.4;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(g * 0.28 * (i === 2 ? 1 : 0.6), tt);
      gain.gain.exponentialRampToValueAtTime(0.0001, tt + 0.06);
      src.connect(bp);
      bp.connect(gain);
      gain.connect(this.bus);
      src.start(tt, Math.random() * 0.6, 0.08);
    }
  }

  private hat(t: number, open: boolean, g: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7600;
    const gain = ctx.createGain();
    const dur = open ? 0.24 : 0.04;
    gain.gain.setValueAtTime(g * 0.14, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(hp);
    hp.connect(gain);
    gain.connect(this.bus);
    if (open) gain.connect(this.delaySend);
    src.start(t, Math.random() * 0.8, dur + 0.02);
  }

  private bass(t: number, midi: number, dur: number, g: number): void {
    const ctx = this.ctx!;
    const f = mtof(midi);
    // saw through acid-style filter envelope
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 7;
    lp.frequency.setValueAtTime(Math.min(f * 6, 160), t + 0.005);
    lp.frequency.exponentialRampToValueAtTime(Math.max(120, f * 1.4), t + 0.14);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(g, t + 0.006);
    gain.gain.setValueAtTime(g, t + dur * 0.6);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(lp);
    lp.connect(gain);
    gain.connect(this.bus);
    osc.start(t);
    osc.stop(t + dur + 0.05);
    // clean sub
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = f / 2;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.exponentialRampToValueAtTime(g * 0.8, t + 0.008);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    sub.connect(g2);
    g2.connect(this.bus);
    sub.start(t);
    sub.stop(t + dur + 0.05);
  }

  private arp(t: number, midi: number, g: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = mtof(midi);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(g, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
    osc.connect(gain);
    gain.connect(this.arpFilter);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  private stab(t: number, midis: number[]): void {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1500;
    lp.Q.value = 2;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.2, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    lp.connect(gain);
    gain.connect(this.bus);
    gain.connect(this.delaySend);
    for (const m of midis) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = mtof(m);
      osc.detune.value = (Math.random() - 0.5) * 14;
      osc.connect(lp);
      osc.start(t);
      osc.stop(t + 0.26);
    }
  }

  private pad(t: number, midis: number[], barDur: number, g: number): void {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 850;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(g, t + 0.5);
    gain.gain.setValueAtTime(g, t + barDur * 0.7);
    gain.gain.linearRampToValueAtTime(0.0001, t + barDur * 1.25);
    lp.connect(gain);
    gain.connect(this.bus);
    for (const m of midis) {
      for (const det of [-9, 9]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = mtof(m);
        osc.detune.value = det;
        osc.connect(lp);
        osc.start(t);
        osc.stop(t + barDur * 1.3);
      }
    }
  }

  private lead(t: number, midi: number, dur: number, g: number): void {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4600;
    lp.Q.value = 1.2;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(g, t + 0.015);
    gain.gain.setValueAtTime(g * 0.9, t + dur * 0.75);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
    lp.connect(gain);
    gain.connect(this.bus);
    gain.connect(this.delaySend);
    // vibrato
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.6;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 7; // cents
    lfo.connect(lfoGain);
    lfo.start(t);
    lfo.stop(t + dur + 0.1);
    for (const det of [-12, -5, 0, 5, 12]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = mtof(midi);
      osc.detune.value = det;
      lfoGain.connect(osc.detune);
      const og = ctx.createGain();
      og.gain.value = 0.2;
      osc.connect(og);
      og.connect(lp);
      osc.start(t);
      osc.stop(t + dur + 0.1);
    }
  }

  private riser(t: number, dur: number, g: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.6;
    bp.frequency.setValueAtTime(320, t);
    bp.frequency.exponentialRampToValueAtTime(5200, t + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(g, t + dur * 0.9);
    gain.gain.linearRampToValueAtTime(0.0001, t + dur);
    src.connect(bp);
    bp.connect(gain);
    gain.connect(this.bus);
    gain.connect(this.delaySend);
    src.start(t, Math.random() * 0.4, dur + 0.1);
  }

  private crash(t: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3800;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.22, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
    src.connect(hp);
    hp.connect(gain);
    gain.connect(this.bus);
    gain.connect(this.delaySend);
    src.start(t, Math.random() * 0.5, 1.4);
  }

  dispose(): void {
    if (this.bus && this.ctx) {
      this.bus.gain.value = 0;
      this.bus.disconnect();
    }
    this.started = false;
  }
}

// local helper — bar duration in seconds for a section/bar pair
function BAR_SEC(sec: { bars: number }, bar: number): number {
  void sec;
  void bar;
  return BEAT_SEC * 4;
}
