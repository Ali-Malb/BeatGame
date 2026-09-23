/**
 * MotorcycleAudio — layered 4-cylinder liter-bike engine synthesis.
 *
 * engineFrequency = (RPM / 60) × 2  (inline-4 4-stroke firing frequency)
 *
 * Coherent harmonic stack with a CONTINUOUS tonal identity:
 *   0.5f idle lope (triangle) · f fundamental (saw) · 2f (saw) · 3f (square)
 *   · 4f (saw) · 5f (triangle) — each band-limited and shaped by RPM & load,
 *   summed → soft waveshaper → exhaust-body peaking EQ (tracks 2f) → presence
 *   peak → RPM-tracked top LP.  Intake (BP noise + induction pulse) and
 *   mechanical (HP noise) ride alongside as TEXTURE, never the dominant voice.
 *
 * Region crossfades: idle lope (<3k) → low body (3–7k) → high scream (8–15.2k).
 * Throttle/load modulation, 70 ms shift duck, limiter gate + pitch flutter at
 * 15 200, transmission whine scaled to axle rotation, wind from 80 km/h
 * (tuck → 1.2 kHz low-pass enclosure), Doppler near-miss whooshes with mass
 * spectral profiles, wet-tire hiss, 60 m bridge double-thumps, crash slam.
 *
 * All scheduling references AudioContext.currentTime.
 */

import { clamp } from '../core/utils';

const FIRE = (rpm: number) => (rpm / 60) * 2;

export class MotorcycleAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineBus!: GainNode;
  private windBus!: GainNode;
  private fxBus!: GainNode;
  private noiseBuffer!: AudioBuffer;

  // harmonic stack
  private oscs: OscillatorNode[] = [];
  private oscGains: GainNode[] = [];
  private harmSum!: GainNode;
  private shaper!: WaveShaperNode;
  private exhaustEq!: BiquadFilterNode;
  private presenceEq!: BiquadFilterNode;
  private topLp!: BiquadFilterNode;
  private tuckLp!: BiquadFilterNode;
  private engineGain!: GainNode; // master engine level (load, regions)
  private limiterGate!: GainNode; // DSP-side square gate at limiter
  private limiterLfo!: OscillatorNode;
  private limiterLfoDepth!: GainNode;
  private flutterLfo!: OscillatorNode;
  private flutterDepth!: GainNode;

  // texture layers
  private intakeNoise!: AudioBufferSourceNode;
  private intakeFilter!: BiquadFilterNode;
  private intakeGain!: GainNode;
  private intakePulse!: OscillatorNode;
  private intakePulseGain!: GainNode;
  private mechNoise!: AudioBufferSourceNode;
  private mechFilter!: BiquadFilterNode;
  private mechGain!: GainNode;

  // drivetrain / wind / rain
  private whine!: OscillatorNode;
  private whineGain!: GainNode;
  private windNoise!: AudioBufferSourceNode;
  private windFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private rainNode: AudioBufferSourceNode | null = null;
  private rainGain!: GainNode;

  private started = false;
  private popCooldown = 0;
  private duckTimer = 0; // shift torque-interruption duck

  enabled = true;
  volume = 0.85;

  // ---- per-category volumes wired from Settings → Audio (§30) ----
  /** near-miss / crash / shatter level (already includes master) */
  sfxVolume = 0.9;
  /** UI blips level (already includes master) */
  uiVolume = 0.8;
  /** gate judgment ping level (already includes master) */
  hudVolume = 0.9;

  get context(): AudioContext | null {
    return this.ctx;
  }

  /**
   * Build the graph. Pass an external context to share the DSP clock with
   * the music engine (preferred); otherwise one is created here.
   */
  start(externalCtx?: AudioContext): boolean {
    if (this.started && this.ctx) {
      this.resume();
      return true;
    }
    try {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = externalCtx ?? new Ctor();
    } catch {
      return false;
    }
    const ctx = this.ctx;
    this.started = true;

    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);

    this.engineBus = ctx.createGain();
    this.windBus = ctx.createGain();
    this.fxBus = ctx.createGain();
    this.engineBus.gain.value = 1.0;
    this.windBus.gain.value = 1.0;
    this.fxBus.gain.value = 1.0;
    this.engineBus.connect(this.master);
    this.windBus.connect(this.master);
    this.fxBus.connect(this.master);

    // shared noise buffer
    const len = ctx.sampleRate * 2;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.buildEngine(ctx);
    this.buildTextures(ctx);
    this.buildWind(ctx);
    this.buildRain(ctx);
    return true;
  }

  // ---------------------------------------------------------------- engine ----
  private buildEngine(ctx: AudioContext): void {
    // level chain: harmonics → shaper → exhaust EQ → presence → top LP →
    // load gain → limiter gate → tuck LP → engine bus
    this.harmSum = ctx.createGain();
    this.harmSum.gain.value = 0.5;

    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = softCurve(2.2);
    this.shaper.oversample = '2x';

    this.exhaustEq = ctx.createBiquadFilter();
    this.exhaustEq.type = 'peaking';
    this.exhaustEq.frequency.value = 220;
    this.exhaustEq.Q.value = 1.25;
    this.exhaustEq.gain.value = 7.5;

    this.presenceEq = ctx.createBiquadFilter();
    this.presenceEq.type = 'peaking';
    this.presenceEq.frequency.value = 1750;
    this.presenceEq.Q.value = 0.9;
    this.presenceEq.gain.value = 3.5;

    this.topLp = ctx.createBiquadFilter();
    this.topLp.type = 'lowpass';
    this.topLp.frequency.value = 5000;
    this.topLp.Q.value = 0.7;

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;

    this.limiterGate = ctx.createGain();
    this.limiterGate.gain.value = 1;
    this.limiterLfo = ctx.createOscillator();
    this.limiterLfo.type = 'square';
    this.limiterLfo.frequency.value = 27;
    this.limiterLfoDepth = ctx.createGain();
    this.limiterLfoDepth.gain.value = 0; // engaged at limiter
    this.limiterLfo.connect(this.limiterLfoDepth);
    this.limiterLfoDepth.connect(this.limiterGate.gain);
    this.limiterLfo.start();

    this.tuckLp = ctx.createBiquadFilter();
    this.tuckLp.type = 'lowpass';
    this.tuckLp.frequency.value = 9500;

    this.harmSum.connect(this.shaper);
    this.shaper.connect(this.exhaustEq);
    this.exhaustEq.connect(this.presenceEq);
    this.presenceEq.connect(this.topLp);
    this.topLp.connect(this.engineGain);
    this.engineGain.connect(this.limiterGate);
    this.limiterGate.connect(this.tuckLp);
    this.tuckLp.connect(this.engineBus);

    // pitch flutter at limiter (detune modulation on every voice)
    this.flutterLfo = ctx.createOscillator();
    this.flutterLfo.type = 'triangle';
    this.flutterLfo.frequency.value = 13;
    this.flutterDepth = ctx.createGain();
    this.flutterDepth.gain.value = 0;
    this.flutterLfo.connect(this.flutterDepth);
    this.flutterLfo.start();

    // harmonic voices: 0.5f lope, f, 2f, 3f, 4f, 5f
    const specs: { type: OscillatorType; mul: number }[] = [
      { type: 'triangle', mul: 0.5 },
      { type: 'sawtooth', mul: 1 },
      { type: 'sawtooth', mul: 2 },
      { type: 'square', mul: 3 },
      { type: 'sawtooth', mul: 4 },
      { type: 'triangle', mul: 5 },
    ];
    for (const sp of specs) {
      const osc = ctx.createOscillator();
      osc.type = sp.type;
      osc.frequency.value = Math.max(18, 40 * sp.mul);
      this.flutterDepth.connect(osc.detune);
      const g = ctx.createGain();
      g.gain.value = 0;
      osc.connect(g);
      g.connect(this.harmSum);
      osc.start();
      this.oscs.push(osc);
      this.oscGains.push(g);
    }
  }

  // -------------------------------------------------------------- textures ----
  private buildTextures(ctx: AudioContext): void {
    // intake: band-passed roar noise
    this.intakeNoise = ctx.createBufferSource();
    this.intakeNoise.buffer = this.noiseBuffer;
    this.intakeNoise.loop = true;
    this.intakeFilter = ctx.createBiquadFilter();
    this.intakeFilter.type = 'bandpass';
    this.intakeFilter.frequency.value = 2300;
    this.intakeFilter.Q.value = 0.9;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    this.intakeNoise.connect(this.intakeFilter);
    this.intakeFilter.connect(this.intakeGain);
    this.intakeGain.connect(this.engineBus);
    this.intakeNoise.start();

    // induction pulse: fires with the engine, breathes with the throttle
    this.intakePulse = ctx.createOscillator();
    this.intakePulse.type = 'sawtooth';
    this.intakePulse.frequency.value = 80;
    const pulseLp = ctx.createBiquadFilter();
    pulseLp.type = 'lowpass';
    pulseLp.frequency.value = 1100;
    this.intakePulseGain = ctx.createGain();
    this.intakePulseGain.gain.value = 0;
    this.intakePulse.connect(pulseLp);
    pulseLp.connect(this.intakePulseGain);
    this.intakePulseGain.connect(this.engineBus);
    this.intakePulse.start();

    // mechanical: valvetrain / cam tick texture
    this.mechNoise = ctx.createBufferSource();
    this.mechNoise.buffer = this.noiseBuffer;
    this.mechNoise.loop = true;
    this.mechFilter = ctx.createBiquadFilter();
    this.mechFilter.type = 'highpass';
    this.mechFilter.frequency.value = 5800;
    this.mechGain = ctx.createGain();
    this.mechGain.gain.value = 0;
    this.mechNoise.connect(this.mechFilter);
    this.mechFilter.connect(this.mechGain);
    this.mechGain.connect(this.engineBus);
    this.mechNoise.start();

    // transmission whine — scales with axle rotation
    this.whine = ctx.createOscillator();
    this.whine.type = 'triangle';
    this.whine.frequency.value = 200;
    const whineLp = ctx.createBiquadFilter();
    whineLp.type = 'lowpass';
    whineLp.frequency.value = 5200;
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whine.connect(whineLp);
    whineLp.connect(this.whineGain);
    this.whineGain.connect(this.engineBus);
    this.whine.start();
  }

  private buildWind(ctx: AudioContext): void {
    this.windNoise = ctx.createBufferSource();
    this.windNoise.buffer = this.noiseBuffer;
    this.windNoise.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 240;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windNoise.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.windBus);
    this.windNoise.start();
  }

  private buildRain(ctx: AudioContext): void {
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    const rf = ctx.createBiquadFilter();
    rf.type = 'highpass';
    rf.frequency.value = 3600;
    this.rainNode = ctx.createBufferSource();
    this.rainNode.buffer = this.noiseBuffer;
    this.rainNode.loop = true;
    this.rainNode.connect(rf);
    rf.connect(this.rainGain);
    this.rainGain.connect(this.master);
    this.rainNode.start();
  }

  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  update(
    dt: number,
    params: {
      rpm: number;
      throttle: number;
      speedKmh: number;
      tuck: number;
      limiter: boolean;
      rain: number;
      crashed: boolean;
      shifting: boolean;
      gear: number; // 0 = N
    }
  ): void {
    if (!this.ctx || !this.started) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.popCooldown = Math.max(0, this.popCooldown - dt);
    if (this.duckTimer > 0) this.duckTimer -= dt;

    const fire = clamp(FIRE(params.rpm), 20, 620);
    const rpmFrac = clamp(params.rpm / 15200, 0, 1.04);
    const load = 0.42 + 0.58 * params.throttle;

    // ---- harmonic voice frequencies + region profiles ----
    const muls = [0.5, 1, 2, 3, 4, 5];
    // idle lope strong below 3k, gone by 5k; low body dominant midrange;
    // upper harmonics bloom into the top-end scream
    const lopeFade = clamp(1 - (params.rpm - 2600) / 2400, 0, 1);
    const profiles = [
      0.52 * lopeFade, // 0.5f
      0.95 - rpmFrac * 0.18, // f
      0.62 + rpmFrac * 0.3, // 2f
      0.22 + rpmFrac * rpmFrac * 0.55, // 3f
      0.1 + Math.pow(rpmFrac, 2.6) * 0.62, // 4f
      0.04 + Math.pow(rpmFrac, 3.0) * 0.58, // 5f
    ];
    for (let i = 0; i < this.oscs.length; i++) {
      this.oscs[i].frequency.setTargetAtTime(Math.max(14, fire * muls[i]), now, 0.018);
      this.oscGains[i].gain.setTargetAtTime(profiles[i] * load, now, 0.035);
    }

    // ---- tracking EQ ----
    this.exhaustEq.frequency.setTargetAtTime(clamp(fire * 2.2, 130, 760), now, 0.05);
    this.presenceEq.frequency.setTargetAtTime(1500 + rpmFrac * 1800, now, 0.08);
    this.topLp.frequency.setTargetAtTime(3200 + rpmFrac * 7400 + params.throttle * 1400, now, 0.07);
    this.exhaustEq.gain.setTargetAtTime(9 - lopeFade * 3, now, 0.1);

    // ---- master engine level: region + load + shift duck ----
    const idleQuiet = clamp(1 - (params.rpm - 1500) / 2500, 0.45, 1);
    let vol = (0.2 + 0.32 * params.throttle + rpmFrac * 0.16) * idleQuiet * load;
    if (params.crashed) vol = 0.03;
    if (params.shifting) vol *= 0.3; // 70 ms torque interruption
    if (this.duckTimer > 0) vol *= 0.55;
    this.engineGain.gain.setTargetAtTime(vol, now, params.shifting ? 0.012 : 0.045);

    // ---- limiter: gate + flutter engaged on the DSP side ----
    const limDepth = params.limiter ? 0.42 : 0;
    this.limiterLfoDepth.gain.setTargetAtTime(limDepth, now, 0.02);
    this.flutterDepth.gain.setTargetAtTime(params.limiter ? 34 : 0, now, 0.05);
    this.limiterLfo.frequency.setTargetAtTime(26 + Math.random() * 4, now, 0.1);

    // ---- intake ----
    this.intakeGain.gain.setTargetAtTime(
      params.crashed ? 0 : params.throttle * (0.035 + rpmFrac * 0.075),
      now,
      0.05
    );
    this.intakeFilter.frequency.setTargetAtTime(1500 + rpmFrac * 2600, now, 0.08);
    this.intakePulse.frequency.setTargetAtTime(clamp(fire * 2, 30, 900), now, 0.02);
    this.intakePulseGain.gain.setTargetAtTime(
      params.crashed ? 0 : params.throttle * (0.05 + rpmFrac * 0.1),
      now,
      0.05
    );

    // ---- mechanical ----
    this.mechGain.gain.setTargetAtTime(
      params.crashed ? 0 : 0.006 + rpmFrac * 0.02,
      now,
      0.08
    );

    // ---- transmission whine: scales with axle rotation ----
    const axleHz = params.speedKmh / 3.6 / 0.317;
    const meshMul = params.gear > 0 ? 16 - (params.gear - 1) * 1.7 : 12;
    this.whine.frequency.setTargetAtTime(clamp(axleHz * meshMul, 90, 3400), now, 0.05);
    this.whineGain.gain.setTargetAtTime(
      params.crashed ? 0 : (params.gear > 0 ? 0.012 : 0.006) + params.throttle * 0.026,
      now,
      0.09
    );

    // ---- wind: strong from 80 km/h; tucked = 1.2 kHz enclosure ----
    const wk = clamp((params.speedKmh - 78) / 205, 0, 1);
    this.windGain.gain.setTargetAtTime(Math.pow(wk, 1.5) * 0.34 * (1 - params.tuck * 0.32), now, 0.12);
    this.windFilter.frequency.setTargetAtTime(
      lerpNum(240 + Math.pow(wk, 0.8) * 2500, 1200, params.tuck),
      now,
      0.18
    );

    // ---- tuck muffles the engine compartment too (helmet behind screen) ----
    this.tuckLp.frequency.setTargetAtTime(lerpNum(9500, 3400, params.tuck), now, 0.16);

    // ---- rain hiss ----
    this.rainGain.gain.setTargetAtTime(params.rain * 0.085, now, 0.4);
  }

  /** shift torque-interruption duck bookkeeping (call on each shift event) */
  shiftDuck(): void {
    this.duckTimer = 0.07;
  }

  /** rhythm gate judgement ping — bright arp for PERFECT, soft tick for GOOD */
  gatePing(perfect: boolean): void {
    if (!this.ctx || !this.started) return;
    const vol = this.hudVolume;
    if (vol <= 0.001) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const notes = perfect ? [76, 83, 88] : [71, 76];
    notes.forEach((midi, i) => {
      const at = t + i * 0.045;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
      const g = ctx.createGain();
      const amp = (perfect ? 0.22 : 0.1) * vol;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp), at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);
      osc.connect(g);
      g.connect(this.fxBus);
      osc.start(at);
      osc.stop(at + 0.32);
    });
  }

  /**
   * Pure engine-voice profile for the acceptance harness (§25): the exact
   * frequencies/gains the synthesizer would schedule for an RPM/load pair.
   */
  static engineProfile(rpm: number, throttle: number): { fire: number; freqs: number[]; gains: number[]; topLpHz: number } {
    const fire = clamp(FIRE(rpm), 20, 620);
    const rpmFrac = clamp(rpm / 15200, 0, 1.04);
    const load = 0.42 + 0.58 * throttle;
    const lopeFade = clamp(1 - (rpm - 2600) / 2400, 0, 1);
    const profiles = [
      0.52 * lopeFade,
      0.95 - rpmFrac * 0.18,
      0.62 + rpmFrac * 0.3,
      0.22 + rpmFrac * rpmFrac * 0.55,
      0.1 + Math.pow(rpmFrac, 2.6) * 0.62,
      0.04 + Math.pow(rpmFrac, 3.0) * 0.58,
    ];
    const muls = [0.5, 1, 2, 3, 4, 5];
    return {
      fire,
      freqs: muls.map((m) => Math.max(14, fire * m)),
      gains: profiles.map((p) => p * load),
      topLpHz: 3200 + rpmFrac * 7400 + throttle * 1400,
    };
  }

  /** exhaust crackle / backfire burst on overrun */
  backfire(): void {
    if (!this.ctx || !this.started || this.popCooldown > 0) return;
    this.popCooldown = 0.55;
    const ctx = this.ctx;
    const n = 3 + Math.floor(Math.random() * 5);
    let t = ctx.currentTime;
    for (let i = 0; i < n; i++) {
      const dur = 0.03 + Math.random() * 0.05;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.playbackRate.value = 0.7 + Math.random() * 0.5;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 420 + Math.random() * 1300;
      bp.Q.value = 2.2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3 + Math.random() * 0.2, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(bp);
      bp.connect(g);
      g.connect(this.fxBus);
      src.start(t, Math.random() * 1.5, dur + 0.05);
      t += 0.05 + Math.random() * 0.09;
    }
  }

  /** gear shift clack (shift cut) */
  shiftClack(): void {
    if (!this.ctx || !this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600;
    bp.Q.value = 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.2, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.fxBus);
    src.start(t, 0.3, 0.1);
  }

  /** near-miss doppler whoosh — mass-dependent spectral profile */
  whoosh(pan: number, heavy: boolean, intensity: number): void {
    if (!this.ctx || !this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = heavy ? 0.42 : 1.0;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = heavy ? 0.8 : 1.1;
    const base = heavy ? 130 : 420;
    bp.frequency.setValueAtTime(base * 0.7, t);
    bp.frequency.exponentialRampToValueAtTime(base * 6, t + 0.12);
    bp.frequency.exponentialRampToValueAtTime(base * 0.9, t + 0.42);
    const g = ctx.createGain();
    const vol = clamp(0.14 + intensity * 0.4, 0, 0.6) * this.sfxVolume;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + 0.09);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.46);
    const panner = ctx.createStereoPanner();
    panner.pan.value = clamp(pan, -1, 1);
    src.connect(bp);
    bp.connect(g);
    g.connect(panner);
    panner.connect(this.fxBus);
    src.start(t, Math.random(), 0.55);
  }

  /** bridge expansion joint: double-thump (th…THUMP) every 60 m */
  jointThump(speedKmh: number): void {
    if (!this.ctx || !this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const vol = clamp(speedKmh / 260, 0.12, 1);
    const thump = (at: number, amp: number, f0: number, f1: number) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f0, at);
      osc.frequency.exponentialRampToValueAtTime(f1, at + 0.09);
      const g1 = ctx.createGain();
      g1.gain.setValueAtTime(vol * amp, at);
      g1.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
      osc.connect(g1);
      g1.connect(this.fxBus);
      osc.start(at);
      osc.stop(at + 0.15);
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900;
      bp.Q.value = 3;
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(vol * amp * 0.6, at);
      g2.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
      src.connect(bp);
      bp.connect(g2);
      g2.connect(this.fxBus);
      src.start(at, 0.8, 0.06);
    };
    thump(t, 0.55, 88, 58); // first tick
    thump(t + 0.07, 0.95, 72, 44); // main slam
  }

  /** crash impact slam */
  crash(): void {
    if (!this.ctx || !this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = 0.5;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3000, t);
    lp.frequency.exponentialRampToValueAtTime(160, t + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.6 * this.sfxVolume, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    src.connect(lp);
    lp.connect(g);
    g.connect(this.fxBus);
    src.start(t, 0.2, 0.8);
    const src2 = ctx.createBufferSource();
    src2.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2200, t);
    bp.frequency.exponentialRampToValueAtTime(700, t + 0.4);
    bp.Q.value = 5;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.28, t + 0.05);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    src2.connect(bp);
    bp.connect(g2);
    g2.connect(this.fxBus);
    src2.start(t, 1.2, 0.6);
  }

  dispose(): void {
    this.limiterLfo?.stop();
    this.flutterLfo?.stop();
    if (this.ctx) void this.ctx.close();
    this.ctx = null;
    this.started = false;
  }
}

function lerpNum(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function softCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount);
  }
  return curve;
}
