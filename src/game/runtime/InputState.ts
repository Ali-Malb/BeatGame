/**
 * runtime/InputState.ts — the ONE normalized input representation.
 *
 * keyboard → gamepad → touch → remote input data channel all collapse into
 * this struct before they reach the simulation, so a remote session and a
 * local run consume byte-identical input. `smoothInput` is the shared response
 * curve (sensitivity / deadzone / invert / attack-release rates) — local and
 * server both run it, so remote steering feels exactly like local steering.
 */

export interface InputState {
  /** -1 (left) .. +1 (right), raw command sign convention */
  steer: number;
  /** 0..1 */
  throttle: number;
  /** 0..1 front brake */
  brake: number;
  /** 0..1 rear brake */
  rearBrake: number;
  tuck: boolean;
  lookBack: boolean;
}

export const NEUTRAL_INPUT: InputState = {
  steer: 0,
  throttle: 0,
  brake: 0,
  rearBrake: 0,
  tuck: false,
  lookBack: false,
};

export interface InputTuning {
  sensitivity: number;
  deadzone: number;
  invertSteer: boolean;
  throttleSens: number;
  brakeSens: number;
  response: number;
}

export const DEFAULT_INPUT_TUNING: InputTuning = {
  sensitivity: 1,
  deadzone: 0.08,
  invertSteer: false,
  throttleSens: 1,
  brakeSens: 1,
  response: 1,
};

export function createInputState(): InputState {
  return { ...NEUTRAL_INPUT };
}

export function copyInput(src: InputState, dst: InputState): InputState {
  dst.steer = src.steer;
  dst.throttle = src.throttle;
  dst.brake = src.brake;
  dst.rearBrake = src.rearBrake;
  dst.tuck = src.tuck;
  dst.lookBack = src.lookBack;
  return dst;
}

/** clamp + deadzone a raw analog axis (sign-preserving) */
export function applyAxis(raw: number, deadzone: number): number {
  const v = Math.max(-1, Math.min(1, raw));
  const d = Math.max(0, Math.min(0.9, deadzone));
  if (Math.abs(v) <= d) return 0;
  const sign = v < 0 ? -1 : 1;
  return sign * ((Math.abs(v) - d) / (1 - d));
}

function moveToward(cur: number, target: number, dt: number, rate: number): number {
  const d = target - cur;
  const step = rate * dt;
  if (Math.abs(d) <= step) return target;
  return cur + Math.sign(d) * step;
}

/**
 * Shared response curve: raw InputState → smoothed InputState. Deterministic
 * per dt so a 60 Hz local loop and a 60 Hz server loop converge identically.
 */
export function smoothInput(
  cur: InputState,
  raw: InputState,
  dt: number,
  tuning: InputTuning = DEFAULT_INPUT_TUNING
): InputState {
  const resp = Math.max(0.2, tuning.response);
  const steerCmd = applyAxis(raw.steer, tuning.deadzone) * tuning.sensitivity * (tuning.invertSteer ? -1 : 1);
  const throttleCmd = Math.max(0, Math.min(1, raw.throttle * tuning.throttleSens));
  const brakeCmd = Math.max(0, Math.min(1, raw.brake * tuning.brakeSens));
  const rearCmd = Math.max(0, Math.min(1, raw.rearBrake));

  cur.throttle = moveToward(cur.throttle, throttleCmd, dt, (throttleCmd > cur.throttle ? 3.2 : 7.5) * resp);
  cur.brake = moveToward(cur.brake, Math.max(brakeCmd, rearCmd), dt, (brakeCmd > cur.brake ? 6.0 : 10.0) * resp);
  const steerRate = (Math.abs(steerCmd) > 0 ? 7.5 : 9.5) * resp;
  cur.steer = Math.max(-1, Math.min(1, moveToward(cur.steer, Math.max(-1, Math.min(1, steerCmd)), dt, steerRate)));
  cur.rearBrake = rearCmd;
  cur.tuck = raw.tuck;
  cur.lookBack = raw.lookBack;
  return cur;
}

/** wire format for the remote input data channel (compact, one line) */
export function serializeInput(s: InputState, seq: number, clientTime: number): string {
  return JSON.stringify({
    q: seq,
    c: clientTime,
    s: Math.round(s.steer * 1000) / 1000,
    t: Math.round(s.throttle * 1000) / 1000,
    b: Math.round(s.brake * 1000) / 1000,
    r: Math.round(s.rearBrake * 1000) / 1000,
    k: s.tuck ? 1 : 0,
    l: s.lookBack ? 1 : 0,
  });
}

export interface DecodedInput {
  state: InputState;
  seq: number;
  clientTime: number;
}

export function deserializeInput(text: string, fallback?: InputState): DecodedInput {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    return {
      seq: num(j.q, 0),
      clientTime: num(j.c, 0),
      state: {
        steer: Math.max(-1, Math.min(1, num(j.s))),
        throttle: Math.max(0, Math.min(1, num(j.t))),
        brake: Math.max(0, Math.min(1, num(j.b))),
        rearBrake: Math.max(0, Math.min(1, num(j.r))),
        tuck: j.k === 1 || j.k === true,
        lookBack: j.l === 1 || j.l === true,
      },
    };
  } catch {
    return { state: fallback ? { ...fallback } : createInputState(), seq: 0, clientTime: 0 };
  }
}

/** merge several sources (keyboard/gamepad/touch) into one command state */
export function mergeSources(...sources: Partial<InputState>[]): InputState {
  const out = createInputState();
  for (const s of sources) {
    if (!s) continue;
    if (typeof s.steer === 'number' && Math.abs(s.steer) > Math.abs(out.steer)) out.steer = s.steer;
    if (typeof s.throttle === 'number') out.throttle = Math.max(out.throttle, s.throttle);
    if (typeof s.brake === 'number') out.brake = Math.max(out.brake, s.brake);
    if (typeof s.rearBrake === 'number') out.rearBrake = Math.max(out.rearBrake, s.rearBrake);
    if (s.tuck) out.tuck = true;
    if (s.lookBack) out.lookBack = true;
  }
  return out;
}
