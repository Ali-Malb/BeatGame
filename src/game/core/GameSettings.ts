/**
 * GameSettings — real, persisted settings (§29–§31).
 *
 * Every key here is WIRED: Game.applySettings() pushes each value into the
 * live subsystem (input smoothing/gain, audio-graph gains, renderer budget,
 * postfx toggles, mirror cadence). Nothing decorative. Persisted to
 * localStorage under 'beatgame.settings.v1'.
 */

export interface GameSettingsData {
  // ---- controls (§29) ----
  steerSens: number; // 0.4..2 — scales raw steering gain
  steerResponse: number; // 0.4..2 — scales attack/release rate
  throttleSens: number; // 0.4..2
  brakeSens: number; // 0.4..2
  camSens: number; // 0.4..2 — camera look/roll response scale
  deadzone: number; // 0..0.4 — gamepad stick deadzone
  invertSteer: boolean;

  // ---- audio (§30) ----
  masterVolume: number; // 0..1
  musicVolume: number; // 0..1
  engineVolume: number; // 0..1
  sfxVolume: number; // 0..1 (near-miss/crash/gate shatter)
  uiVolume: number; // 0..1
  hudVolume: number; // 0..1 — gate ping/judgment volume

  // ---- graphics (§31) ----
  quality: 0 | 1 | 2; // low/medium/high → renderer budget
  bloom: boolean;
  motionBlur: boolean;
  rain: 0 | 1 | 2; // particle density tier
  reflections: boolean; // PMREM env reflections
  mirrorQuality: 'off' | 'low' | 'medium' | 'high'; // cadence + resolution
  particles: 0 | 1 | 2;
  fovOffset: number; // −10..+10 deg added to every camera's base FOV
  showFps: boolean;
}

const DEFAULTS: GameSettingsData = {
  steerSens: 1,
  steerResponse: 1,
  throttleSens: 1,
  brakeSens: 1,
  camSens: 1,
  deadzone: 0.09,
  invertSteer: false,

  masterVolume: 1,
  musicVolume: 0.9,
  engineVolume: 0.85,
  sfxVolume: 1,
  uiVolume: 0.8,
  hudVolume: 0.9,

  quality: 2,
  bloom: true,
  motionBlur: true,
  rain: 2,
  reflections: true,
  mirrorQuality: 'medium',
  particles: 2,
  fovOffset: 0,
  showFps: true,
};

const KEY = 'beatgame.settings.v1';

export class GameSettings {
  current: GameSettingsData = { ...DEFAULTS };

  constructor() {
    this.load();
  }

  load(): void {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
      if (!raw) {
        // first run on a phone/tablet (no persisted settings yet): start at a
        // tier the device can actually hold — user can raise it in settings
        if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) {
          this.current = { ...DEFAULTS, quality: 1, mirrorQuality: 'low', rain: 1, particles: 1 };
        }
        return;
      }
      const parsed = JSON.parse(raw) as Partial<GameSettingsData>;
      // merge defensively (unknown/new keys keep defaults)
      this.current = { ...DEFAULTS, ...parsed };
    } catch {
      // corrupted storage — keep defaults
    }
  }

  persist(): void {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(KEY, JSON.stringify(this.current));
      }
    } catch {
      // storage unavailable (private mode) — settings stay session-only
    }
  }

  update<K extends keyof GameSettingsData>(key: K, value: GameSettingsData[K]): void {
    this.current[key] = value;
    this.persist();
  }

  reset(): void {
    this.current = { ...DEFAULTS };
    this.persist();
  }
}
