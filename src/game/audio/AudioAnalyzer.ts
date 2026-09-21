/**
 * AudioAnalyzer — deterministic offline analysis of a decoded AudioBuffer.
 *
 * Pipeline (pure functions of the samples — same audio ⇒ same result):
 *   1. mono mixdown
 *   2. STFT (hann window, 1024 pt, hop 512) → per-frame band flux:
 *        bass 40–120 Hz  (kicks / downbeats)
 *        mid  1–5 kHz    (snares / vocal onsets)
 *      plus full-band RMS energy
 *   3. ODF normalization (local mean subtraction, half-wave rectify)
 *   4. onset picking with adaptive threshold, per band, merged
 *   5. BPM via autocorrelation of the novelty envelope (tempo-weighted),
 *      beat phase via comb-filter alignment
 *   6. energy curve (10 Hz) + section segmentation (sustained level changes)
 *
 * Frame timing derives ONLY from sampleRate and hop — never wall clock.
 */

export interface AnalysisOnset {
  time: number;
  /** 0..1+ normalized strength within its band */
  strength: number;
  band: 'bass' | 'mid';
}

export type SectionKind = 'intro' | 'verse' | 'buildup' | 'drop' | 'chorus' | 'breakdown' | 'outro';

export interface AnalysisSection {
  start: number;
  end: number;
  /** 0..1 mean energy */
  energy: number;
  kind: SectionKind;
}

export interface Analysis {
  duration: number;
  sampleRate: number;
  bpm: number;
  /** DSP time of the first beat of the fitted grid */
  firstBeat: number;
  beatSec: number;
  onsets: AnalysisOnset[];
  /** ~10 Hz energy curve (smoothed RMS, 0..1) */
  energy: Float32Array;
  energyDt: number;
  sections: AnalysisSection[];
  /** overall loudness percentile of each frame — useful for gating */
  quality: 'ok' | 'sparse' | 'very-sparse';
}

const FFT_SIZE = 1024;
const HOP = 512;

// ------------------------------------------------------------------- FFT ----
// iterative radix-2, precomputed tables (allocated once per process)
let fftRe = new Float32Array(0);
let fftIm = new Float32Array(0);
let revTable: Uint16Array | null = null;
let cosTable: Float32Array | null = null;
let sinTable: Float32Array | null = null;

function ensureFft(n: number): void {
  if (revTable && fftRe.length === n) return;
  fftRe = new Float32Array(n);
  fftIm = new Float32Array(n);
  revTable = new Uint16Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    revTable[i] = r;
  }
  cosTable = new Float32Array(n / 2);
  sinTable = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cosTable[i] = Math.cos((-2 * Math.PI * i) / n);
    sinTable[i] = Math.sin((-2 * Math.PI * i) / n);
  }
}

/** in-place complex FFT (re/im length must equal the table size) */
function transform(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  const rev = revTable;
  const cosT = cosTable;
  const sinT = sinTable;
  if (!rev || !cosT || !sinT) return;
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0; j < half; j++) {
        const k = j * step;
        const tre = re[i + j + half] * cosT[k] - im[i + j + half] * sinT[k];
        const tim = re[i + j + half] * sinT[k] + im[i + j + half] * cosT[k];
        re[i + j + half] = re[i + j] - tre;
        im[i + j + half] = im[i + j] - tim;
        re[i + j] += tre;
        im[i + j] += tim;
      }
    }
  }
}

function median(arr: Float32Array, from: number, to: number): number {
  const n = to - from;
  if (n <= 0) return 0;
  const copy = Array.from(arr.subarray(from, to)).sort((a, b) => a - b);
  const mid = n >> 1;
  return n % 2 ? copy[mid] : 0.5 * (copy[mid - 1] + copy[mid]);
}

export function analyzeBuffer(buffer: AudioBuffer): Analysis {
  const sampleRate = buffer.sampleRate;
  const duration = buffer.duration;
  const L = buffer.length;
  // mono mixdown
  const mono = new Float32Array(L);
  const chans = Math.min(2, buffer.numberOfChannels);
  for (let c = 0; c < chans; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < L; i++) mono[i] += d[i];
  }
  if (chans > 1) for (let i = 0; i < L; i++) mono[i] /= chans;

  const frames = Math.max(1, Math.floor((L - FFT_SIZE) / HOP));
  const frameDt = HOP / sampleRate;

  ensureFft(FFT_SIZE);
  const win = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));

  const binHz = sampleRate / FFT_SIZE;
  const bassLo = Math.max(1, Math.floor(40 / binHz));
  const bassHi = Math.ceil(120 / binHz);
  const midLo = Math.max(1, Math.floor(1000 / binHz));
  const midHi = Math.min(FFT_SIZE / 2 - 1, Math.ceil(5000 / binHz));

  const bassFlux = new Float32Array(frames);
  const midFlux = new Float32Array(frames);
  const rms = new Float32Array(frames);
  const prevMag = new Float32Array(FFT_SIZE / 2);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);

  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    let sum = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = mono[off + i] ?? 0;
      sum += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(sum / FFT_SIZE);
    transform(re, im);
    let bf = 0;
    let mf = 0;
    for (let k = 1; k < FFT_SIZE / 2; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const d = mag - prevMag[k];
      if (d > 0) {
        if (k >= bassLo && k <= bassHi) bf += d;
        else if (k >= midLo && k <= midHi) mf += d;
      }
      prevMag[k] = mag;
    }
    bassFlux[f] = bf;
    midFlux[f] = mf;
  }

  // ------- ODF normalization: subtract local mean (±1 s), rectify -------
  const normODF = (src: Float32Array): Float32Array => {
    const out = new Float32Array(frames);
    const w = Math.round(1 / frameDt);
    for (let f = 0; f < frames; f++) {
      const a = Math.max(0, f - w);
      const b = Math.min(frames, f + w + 1);
      let s = 0;
      for (let i = a; i < b; i++) s += src[i];
      const mean = s / (b - a);
      out[f] = Math.max(0, src[f] - mean);
    }
    // global scale by std
    let s2 = 0;
    for (let f = 0; f < frames; f++) s2 += out[f] * out[f];
    const std = Math.sqrt(s2 / Math.max(1, frames)) || 1;
    for (let f = 0; f < frames; f++) out[f] /= std;
    return out;
  };
  const bassODF = normODF(bassFlux);
  const midODF = normODF(midFlux);

  // ------- onset picking: adaptive threshold peaks -------
  const pickOnsets = (odf: Float32Array, band: 'bass' | 'mid', thresh: number): AnalysisOnset[] => {
    const out: AnalysisOnset[] = [];
    const w = Math.round(0.08 / frameDt); // ±80 ms peak window
    const prew = Math.round(0.25 / frameDt); // pre-mean for adaptive gate
    for (let f = 2; f < frames - 2; f++) {
      const v = odf[f];
      if (v < thresh) continue;
      let isPeak = true;
      for (let i = Math.max(0, f - w); i <= Math.min(frames - 1, f + w); i++) {
        if (odf[i] > v) { isPeak = false; break; }
      }
      if (!isPeak) continue;
      const a = Math.max(0, f - prew);
      const b = Math.min(frames, f);
      let s = 0;
      for (let i = a; i < b; i++) s += odf[i];
      const localMean = s / Math.max(1, b - a);
      if (v < localMean + thresh * 0.75) continue; // require a real jump
      out.push({ time: f * frameDt, strength: Math.min(2, v / (thresh * 2)), band });
    }
    return out;
  };
  const bassThreshold = 1.1;
  const midThreshold = 1.25;
  const onsets = [...pickOnsets(bassODF, 'bass', bassThreshold), ...pickOnsets(midODF, 'mid', midThreshold)];
  onsets.sort((a, b) => a.time - b.time);
  // merge simultaneous (same frame within 30 ms): keep stronger
  const merged: AnalysisOnset[] = [];
  for (const o of onsets) {
    const last = merged[merged.length - 1];
    if (last && o.time - last.time < 0.03) {
      if (o.strength > last.strength) {
        last.strength = o.strength;
        last.band = o.band;
      }
      continue;
    }
    merged.push(o);
  }

  // ------- novelty envelope for tempo -------
  const novRate = 100; // Hz
  const novLen = Math.max(8, Math.floor(duration * novRate));
  const nov = new Float32Array(novLen);
  const novAll = new Float32Array(frames);
  for (let f = 0; f < frames; f++) novAll[f] = bassODF[f] + 0.6 * midODF[f];
  for (let f = 0; f < frames; f++) {
    const idx = Math.min(novLen - 1, Math.round((f * frameDt) * novRate));
    nov[idx] = Math.max(nov[idx], novAll[f]);
  }
  // smooth 80 ms
  const novSm = new Float32Array(novLen);
  const sw = Math.round(0.08 * novRate);
  for (let i = 0; i < novLen; i++) {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - sw); j <= Math.min(novLen - 1, i + sw); j++) { s += nov[j]; c++; }
    novSm[i] = s / Math.max(1, c);
  }

  // ------- BPM: autocorrelation with log-tempo weighting -------
  let bestBpm = 120;
  let bestScore = -1;
  const minLag = Math.max(2, Math.round(novRate * (60 / 200))); // 200 bpm
  const maxLag = Math.min(novLen - 2, Math.round(novRate * (60 / 60))); // 60 bpm
  const mean = (() => { let s = 0; for (let i = 0; i < novLen; i++) s += novSm[i]; return s / novLen; })();
  const centered = new Float32Array(novLen);
  for (let i = 0; i < novLen; i++) centered[i] = novSm[i] - mean;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < novLen; i += 2) s += centered[i] * centered[i + lag];
    s /= (novLen - lag) / 2;
    const bpm = 60 / (lag / novRate);
    // prefer a musically central tempo (log-normal around 118 bpm)
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 118) / 0.75, 2));
    const score = Math.max(0, s) * w;
    if (score > bestScore) { bestScore = score; bestBpm = bpm; }
  }
  let bpm = bestBpm;
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  bpm = +bpm.toFixed(1);
  const beatSec = 60 / bpm;

  // ------- beat phase: comb alignment on the novelty envelope -------
  let firstBeat = 0;
  let bestPhaseScore = -1;
  const phaseSteps = Math.max(8, Math.round(beatSec * novRate));
  for (let p = 0; p < phaseSteps; p++) {
    const phase = p / novRate;
    let s = 0;
    for (let t = phase; t < duration - 0.05; t += beatSec) {
      const i = Math.round(t * novRate);
      if (i >= 0 && i < novLen) s += novSm[i];
    }
    if (s > bestPhaseScore) { bestPhaseScore = s; firstBeat = phase; }
  }
  // nudge phase to the nearest strong onset (±120 ms)
  let bestNudge = firstBeat;
  let bestNudgeScore = -1;
  for (const o of merged) {
    if (o.band !== 'bass') continue;
    const d = o.time - firstBeat;
    const rel = ((d % beatSec) + beatSec) % beatSec;
    const shift = rel > beatSec / 2 ? rel - beatSec : rel;
    if (Math.abs(shift) < 0.12) {
      const cand = firstBeat + shift;
      if (o.strength > bestNudgeScore) { bestNudgeScore = o.strength; bestNudge = cand; }
    }
  }
  firstBeat = Math.max(0, bestNudge);

  // ------- energy curve @10 Hz -------
  const energyDt = 0.1;
  const energyLen = Math.max(1, Math.floor(duration / energyDt));
  const energy = new Float32Array(energyLen);
  for (let f = 0; f < frames; f++) {
    const idx = Math.min(energyLen - 1, Math.floor((f * frameDt) / energyDt));
    energy[idx] = Math.max(energy[idx], rms[f]);
  }
  // normalize by 95th percentile; smooth 1 s
  const rmsSorted = Array.from(rms).sort((a, b) => a - b);
  const p95 = rmsSorted[Math.floor(rmsSorted.length * 0.95)] || 1;
  for (let i = 0; i < energyLen; i++) energy[i] = Math.min(1, energy[i] / (p95 * 0.8));
  const smE = new Float32Array(energyLen);
  const esw = Math.round(0.5 / energyDt);
  for (let i = 0; i < energyLen; i++) {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - esw); j <= Math.min(energyLen - 1, i + esw); j++) { s += energy[j]; c++; }
    smE[i] = s / Math.max(1, c);
  }
  smE.set(energy); // keep raw + smoothed combined: 50% raw
  for (let i = 0; i < energyLen; i++) energy[i] = 0.5 * energy[i] + 0.5 * smE[i];

  // ------- sections: sustained energy level changes -------
  const sections: AnalysisSection[] = [];
  {
    const winSec = 2.5;
    const win = Math.max(2, Math.round(winSec / energyDt));
    // candidate boundaries where forward/backward means diverge strongly
    const cands: number[] = [];
    for (let i = win; i < energyLen - win; i++) {
      let a = 0;
      let b = 0;
      for (let j = i - win; j < i; j++) a += energy[j];
      for (let j = i; j < i + win; j++) b += energy[j];
      const d = Math.abs(b - a) / win;
      if (d > 0.16) cands.push(i * energyDt);
    }
    // cluster candidates closer than 8 s
    const boundaries: number[] = [0];
    const minGap = 9;
    for (const t of cands) {
      if (t - boundaries[boundaries.length - 1] < minGap) {
        boundaries[boundaries.length - 1] = t; // move boundary forward to latest evidence
        continue;
      }
      boundaries.push(t);
    }
    const meanAll = (() => { let s = 0; for (let i = 0; i < energyLen; i++) s += energy[i]; return s / energyLen; })();
    for (let i = 0; i < boundaries.length; i++) {
      const start = boundaries[i];
      const end = i + 1 < boundaries.length ? boundaries[i + 1] : duration;
      if (end - start < 4) continue;
      const i0 = Math.floor(start / energyDt);
      const i1 = Math.min(energyLen, Math.floor(end / energyDt));
      let s = 0;
      for (let j = i0; j < i1; j++) s += energy[j];
      const e = s / Math.max(1, i1 - i0);
      const rel = start / Math.max(1, duration);
      let kind: SectionKind;
      if (rel < 0.06 && e < meanAll + 0.1) kind = 'intro';
      else if (rel > 0.92 && e < meanAll + 0.12) kind = 'outro';
      else if (e < meanAll - 0.16) kind = 'breakdown';
      else if (e > meanAll + 0.22) kind = 'drop';
      else if (e > meanAll + 0.08) kind = 'chorus';
      else if (e < meanAll) kind = 'verse';
      else kind = 'buildup';
      sections.push({ start, end, energy: +Math.min(1, e).toFixed(3), kind });
    }
    if (sections.length === 0) {
      sections.push({ start: 0, end: duration, energy: +meanAll.toFixed(3), kind: meanAll > 0.7 ? 'chorus' : 'verse' });
    }
  }

  const onsetRate = onsets.length / Math.max(1, duration);
  const quality: Analysis['quality'] = onsetRate > 1.2 ? 'ok' : onsetRate > 0.45 ? 'sparse' : 'very-sparse';

  return {
    duration,
    sampleRate,
    bpm,
    firstBeat,
    beatSec,
    onsets: merged,
    energy,
    energyDt,
    sections,
    quality,
  };
}

/** sample the energy curve at arbitrary time t (clamped) */
export function energyAt(a: Analysis, t: number): number {
  if (t < 0) t = 0;
  const i = Math.min(a.energy.length - 1, Math.floor(t / a.energyDt));
  return a.energy[i] ?? 0;
}

/** section containing time t */
export function sectionAt(a: Analysis, t: number): AnalysisSection {
  for (const s of a.sections) {
    if (t >= s.start && t < s.end) return s;
  }
  return a.sections[a.sections.length - 1];
}
