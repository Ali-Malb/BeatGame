/**
 * InputHandler — unified keyboard + gamepad input with analog smoothing.
 *
 * Gamepad (Xbox / DualShock):
 *   RT/R2 throttle, LT/L2 front brake, A/Cross rear brake, Left stick X steering,
 *   L3 or LB tuck, Y/Triangle camera toggle, R3 look back, Start/Options pause.
 * Keyboard:
 *   W/Up throttle, S/Down front brake, Space rear brake, A/D or Left/Right steering,
 *   Left Shift tuck (toggle), C camera, B look back, Escape pause, 1-4 weather presets,
 *   Q/E manual gear down/up.
 */

import { clamp } from './utils';

export interface InputSnapshot {
  throttle: number; // 0..1 smoothed
  brake: number; // 0..1 front brake, smoothed
  rearBrake: number; // 0..1
  steer: number; // -1..1 smoothed
  tuck: boolean;
  lookBack: boolean;
}

// one-shot events consumed by the game manager
export interface InputEvents {
  toggleCamera: boolean;
  togglePause: boolean;
  weather: number; // 0 = none requested, 1..4 preset
  gearUp: boolean;
  gearDown: boolean;
  restart: boolean;
  tapTempo: boolean; // song-mode BPM calibration (T key / select button)
}

/**
 * Gamepad stick sign contract (§4): negative X = LEFT, positive X = RIGHT.
 * Applied deadzone preserves the sign — exported so the steering-direction
 * test (§32) can verify the actual mapping used at runtime.
 */
export function gamepadSteer(axisX: number, deadzone = 0.09): number {
  const a = Math.abs(axisX);
  if (a < deadzone) return 0;
  return Math.sign(axisX) * ((a - deadzone) / (1 - deadzone));
}


export class InputHandler {
  private keys = new Set<string>();
  private keyDownOnce = new Set<string>();
  private gamepadIndex: number | null = null;
  private prevGamepadButtons: boolean[] = [];
  private _wasGamepad = false;

  // smoothed analog channels
  throttle = 0;
  brake = 0;
  rearBrake = 0;
  steer = 0;
  tuckToggled = false; // keyboard shift toggle state
  lookBack = false;

  gamepadConnected = false;
  lastDevice: 'keyboard' | 'gamepad' = 'keyboard';
  /** resolved tuck state (keyboard toggle OR gamepad hold) */
  tuckActive = false;

  // ---- live settings (wired from Game.applySettings, §29) ----
  /** raw steering gain — multiplies the analog command before smoothing */
  sensitivity = 1;
  /** attack/release rate scale — higher = snappier, lower = smoother */
  response = 1;
  throttleSens = 1;
  brakeSens = 1;
  /** gamepad stick deadzone (applied via gamepadSteer) */
  deadzone = 0.09;
  /** flips the steering command sign (controls setting) */
  invertSteer = false;

  private onGamepadConnect = (e: GamepadEvent) => {
    this.gamepadIndex = e.gamepad.index;
    this.gamepadConnected = true;
  };
  private onGamepadDisconnect = () => {
    this.gamepadIndex = null;
    this.gamepadConnected = false;
    this.prevGamepadButtons = [];
  };

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeyDown);
      window.addEventListener('keyup', this.onKeyUp);
      window.addEventListener('blur', this.onBlur);
      window.addEventListener('gamepadconnected', this.onGamepadConnect);
      window.addEventListener('gamepaddisconnected', this.onGamepadDisconnect);
    }
  }

  dispose() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKeyDown);
      window.removeEventListener('keyup', this.onKeyUp);
      window.removeEventListener('blur', this.onBlur);
      window.removeEventListener('gamepadconnected', this.onGamepadConnect);
      window.removeEventListener('gamepaddisconnected', this.onGamepadDisconnect);
    }
  }

  private onKeyDown = (e: KeyboardEvent) => {
    // never intercept when typing in inputs
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Tab') e.preventDefault();
    if (!this.keys.has(e.code)) this.keyDownOnce.add(e.code);
    this.keys.add(e.code);
    this.lastDevice = 'keyboard';
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private onBlur = () => {
    this.keys.clear();
  };

  private key(code: string): boolean {
    return this.keys.has(code);
  }

  private once(code: string): boolean {
    if (this.keyDownOnce.has(code)) {
      this.keyDownOnce.delete(code);
      return true;
    }
    return false;
  }

  /**
   * Poll all devices and integrate smoothing. Call once per frame.
   */
  update(dt: number): InputEvents {
    const events: InputEvents = {
      toggleCamera: false,
      togglePause: false,
      weather: 0,
      gearUp: false,
      gearDown: false,
      restart: false,
      tapTempo: false,
    };


    // ---- keyboard raw channels ----
    let kThrottle = this.key('KeyW') || this.key('ArrowUp') ? 1 : 0;
    let kBrake = this.key('KeyS') || this.key('ArrowDown') ? 1 : 0;
    let kRear = this.key('Space') ? 1 : 0;
    let kSteer = (this.key('KeyD') || this.key('ArrowRight') ? 1 : 0) - (this.key('KeyA') || this.key('ArrowLeft') ? 1 : 0);
    if (this.invertSteer) kSteer = -kSteer; // §29 invert steering (controls)
    let kTuck = this.key('ShiftLeft') || this.key('ShiftRight');
    let kLookBack = this.key('KeyB');

    // ---- gamepad polling ----
    let gp: Gamepad | null = null;
    if (typeof navigator !== 'undefined' && navigator.getGamepads) {
      const pads = navigator.getGamepads();
      if (this.gamepadIndex != null) {
        gp = pads[this.gamepadIndex];
      } else {
        // fallback: grab first non-null pad
        for (const p of pads) {
          if (p && p.connected) {
            gp = p;
            this.gamepadIndex = p.index;
            this.gamepadConnected = true;
            break;
          }
        }
      }
    }

    let gpActive = false;
    if (gp) {
      const axLX = gp.axes[0] ?? 0;
      const gpSteerRaw = gamepadSteer(axLX, this.deadzone); // settings-driven deadzone (§29)
      const rt = gp.buttons[7]?.value ?? 0;
      const lt = gp.buttons[6]?.value ?? 0;
      const aBtn = gp.buttons[0]?.pressed ?? false;
      const l3 = gp.buttons[10]?.pressed ?? false;
      const lb = gp.buttons[4]?.pressed ?? false;
      const r3 = gp.buttons[11]?.pressed ?? false;
      const yBtn = gp.buttons[3]?.pressed ?? false;
      const start = gp.buttons[9]?.pressed ?? false;
      const select = gp.buttons[8]?.pressed ?? false;
      const dpu = gp.buttons[12]?.pressed ?? false;
      const dpd = gp.buttons[13]?.pressed ?? false;

      const gpSteer = this.invertSteer ? -gpSteerRaw : gpSteerRaw;
      const rtSig = Math.abs(rt) > 0.04 || Math.abs(lt) > 0.04 || Math.abs(gpSteerRaw) > 0.04;
      if (rtSig) this.lastDevice = 'gamepad';
      gpActive = rtSig || aBtn || l3 || lb || r3 || yBtn || start;

      if (this.lastDevice === 'gamepad' || gpActive) {
        // analog values override keyboard when active
        if (rt > 0.04) kThrottle = Math.max(kThrottle, rt);
        if (lt > 0.04) kBrake = Math.max(kBrake, lt);
        if (aBtn) kRear = 1;
        if (Math.abs(gpSteer) > 0) kSteer = gpSteer;
        if (l3 || lb) kTuck = true;
        if (r3) kLookBack = true;
      }

      // rising-edge button events
      const btnState = gp.buttons.map((b) => b.pressed);
      const wasDown = (i: number) => this.prevGamepadButtons[i] ?? false;
      if (yBtn && !wasDown(3)) events.toggleCamera = true;
      if (start && !wasDown(9)) events.togglePause = true;
      if (select && !wasDown(8)) events.tapTempo = true;
      if (dpu && !wasDown(12)) events.gearUp = true;
      if (dpd && !wasDown(13)) events.gearDown = true;
      this.prevGamepadButtons = btnState;
      this._wasGamepad = true;
    }

    // ---- keyboard one-shot events ----
    if (this.once('KeyC')) events.toggleCamera = true;
    if (this.once('Escape') || this.once('KeyP')) events.togglePause = true;
    if (this.once('KeyQ')) events.gearDown = true;
    if (this.once('KeyE')) events.gearUp = true;
    if (this.once('KeyR')) events.restart = true;
    if (this.once('KeyT')) events.tapTempo = true;
    if (this.once('Digit1')) events.weather = 1;
    if (this.once('Digit2')) events.weather = 2;
    if (this.once('Digit3')) events.weather = 3;
    if (this.once('Digit4')) events.weather = 4;

    // tuck: keyboard is a toggle, gamepad hold ORs in
    if (this.once('ShiftLeft') || this.once('ShiftRight')) this.tuckToggled = !this.tuckToggled;
    const tuckActive = this.tuckToggled || kTuck;

    // ---- smoothing (analog progressive feel, scaled by settings §29) ----
    // sensitivity scales the COMMAND (reach partial travel faster); response
    // scales the smoothing RATE (snappier vs. smoother)
    const sens = clamp(this.sensitivity, 0.2, 3);
    const resp = clamp(this.response, 0.2, 3);
    this.throttle = moveToward(this.throttle, clamp(kThrottle * this.throttleSens, 0, 1), dt, (kThrottle > this.throttle ? 3.2 : 7.5) * resp);
    this.brake = moveToward(this.brake, clamp(kBrake * this.brakeSens, 0, 1), dt, (kBrake > this.brake ? 6.0 : 10.0) * resp);
    this.rearBrake = moveToward(this.rearBrake, kRear, dt, 12);
    // steering: medium attack, medium release, slight snap
    const steerRate = (Math.abs(kSteer) > 0 ? 7.5 : 9.5) * resp;
    this.steer = moveToward(this.steer, clamp(kSteer * sens, -1, 1), dt, steerRate);
    this.steer = clamp(this.steer, -1, 1);
    this.lookBack = kLookBack;

    void kTuck; // held state folded into tuckActive below
    this.tuckActive = tuckActive;
    return { ...events, tuck: tuckActive, lookBack: this.lookBack } as InputEvents & InputSnapshot;
  }

  snapshot(): InputSnapshot {
    return {
      throttle: this.throttle,
      brake: this.brake,
      rearBrake: this.rearBrake,
      steer: this.steer,
      tuck: this.tuckActive,
      lookBack: this.lookBack,
    };
  }
}

/** linear move toward with per-axis rate */
function moveToward(cur: number, target: number, dt: number, rate: number): number {
  const d = target - cur;
  const step = rate * dt;
  if (Math.abs(d) <= step) return target;
  return cur + Math.sign(d) * step;
}
