'use client';

/**
 * GameView — mounts the WebGL canvas, owns the React DOM HUD:
 * start screen (audio unlock gesture), kinetic lyric container (DSP-driven
 * by the game engine, NOT React state), near-miss / PERFECT SYNC popups,
 * score + rhythm combo readout, minimal chase-mode speed widget, pause menu
 * with weather presets & music controls.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { GameManager, GameState, type SongInfo } from '@/game/core/Game';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Gamepad2, Keyboard, Gauge, CloudRain, Sunset, MoonStar, SunDim, Music2, Music, Youtube, Play, Disc3 } from 'lucide-react';

interface Telemetry {
  speedKmh: number;
  rpm: number;
  gear: number;
  gearLabel: string;
  leanDeg: number;
  wheelieDeg: number;
  score: number;
  combo: number;
  rhythmCombo: number;
  gatePerfects: number;
  distanceKm: number;
  topSpeedKmh: number;
  nearMisses: number;
  state: GameState;
  weather: string;
  section: string;
  musicTime: number;
  fps: number;
  cameraMode: string;
  gamepad: boolean;
  song: SongInfo;
}

interface Popup {
  id: number;
  text: string;
  points: number;
  kind: string;
}

const WEATHERS = [
  { name: 'Deep Twilight', key: '1', icon: SunDim },
  { name: 'Starry Night', key: '2', icon: MoonStar },
  { name: 'Golden Hour', key: '3', icon: Sunset },
  { name: 'Wet Rain', key: '4', icon: CloudRain },
];

const EMPTY_TELEMETRY: Telemetry = {
  speedKmh: 0,
  rpm: 0,
  gear: 0,
  gearLabel: 'N',
  leanDeg: 0,
  wheelieDeg: 0,
  score: 0,
  combo: 1,
  rhythmCombo: 0,
  gatePerfects: 0,
  distanceKm: 0,
  topSpeedKmh: 0,
  nearMisses: 0,
  state: 'menu',
  weather: 'Deep Twilight',
  section: '—',
  musicTime: 0,
  fps: 60,
  cameraMode: 'cockpit',
  gamepad: false,
  song: {
    mode: 'demo',
    title: 'MIDNIGHT RUNNER — C1 Inner Loop',
    artist: '',
    videoId: '',
    duration: 0,
    bpm: 128,
    bpmCalibrated: true,
    lyricSource: 'authored-demo',
    currentLyric: '',
    audioTime: 0,
  },
};

let popupId = 0;

export default function GameView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lyricRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<GameManager | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry>(EMPTY_TELEMETRY);
  const [popups, setPopups] = useState<Popup[]>([]);
  const [state, setState] = useState<GameState>('menu');
  const [started, setStarted] = useState(false);
  const [volume, setVolume] = useState(0.85);
  const [musicVolume, setMusicVolume] = useState(0.6);
  const [musicOn, setMusicOn] = useState(true);
  const [autoCycle, setAutoCycle] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [songUrl, setSongUrl] = useState('');
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    if (!canvasRef.current) return;
    const game = new GameManager(canvasRef.current, {
      getLyricContainer: () => lyricRef.current,
      onTelemetry: (t) => setTelemetry(t),
      onPopup: (text, points, kind) => {
        const p = { id: ++popupId, text, points, kind };
        setPopups((prev) => [...prev.slice(-5), p]);
        // popups fade over ~0.6 s (§32)
        setTimeout(() => setPopups((prev) => prev.filter((x) => x.id !== p.id)), 640);
      },
      onStateChange: (s) => setState(s),
    });
    gameRef.current = game;
    game.startAttract();
    return () => {
      game.dispose();
      gameRef.current = null;
    };
  }, []);

  const handleStart = useCallback(async (songMode: boolean) => {
    setLaunching(true);
    try {
      await gameRef.current?.start(songMode && songUrl.trim() ? { songUrl: songUrl.trim() } : undefined);
      setStarted(true);
    } finally {
      setLaunching(false);
    }
  }, [songUrl]);

  const handleResume = useCallback(() => gameRef.current?.togglePause(), []);
  const handleRestart = useCallback(() => gameRef.current?.restart(), []);
  const handleWeather = useCallback((i: number) => gameRef.current?.setWeather(i), []);
  const handleAutoCycle = useCallback((on: boolean) => {
    setAutoCycle(on);
    gameRef.current?.setAutoCycle(on);
  }, []);

  const riding = state === 'riding';
  const crashing = state === 'crashing';
  const paused = state === 'paused';
  const chase = telemetry.cameraMode === 'chase';

  const popupColor = (kind: string): string => {
    if (kind === 'gatePerfect') return '#7fe7ff';
    if (kind === 'gateGood') return '#a8d8e8';
    if (kind === 'gateMiss') return '#8a9096';
    if (kind === 'laneSplit') return '#ffd24a';
    if (kind === 'close') return '#ff9a3c';
    return '#ffffff';
  };

  return (
    <main className="fixed inset-0 overflow-hidden bg-black select-none">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-label="Motorcycle highway game viewport" />

      {/* ---------------- kinetic lyrics (timing driven by the DSP clock) ---------------- */}
      <div ref={lyricRef} className="klyric-container" aria-hidden="true" />

      {/* ---------------- riding HUD ---------------- */}
      {started && !paused && (
        <>
          {/* score + combos, upper center (below lyrics) */}
          <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 text-center">
            <div className="font-mono text-2xl font-bold tracking-wider text-white/90 drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]">
              {telemetry.score.toLocaleString()}
            </div>
            <div className="flex items-center justify-center gap-3 font-mono text-xs">
              {telemetry.combo > 1.01 && (
                <span className="font-semibold text-amber-400/90">×{telemetry.combo.toFixed(1)} combo</span>
              )}
              {telemetry.rhythmCombo > 0 && (
                <span className="rounded-full border border-cyan-300/40 bg-cyan-400/10 px-2 py-0.5 font-bold text-cyan-200">
                  SYNC ×{telemetry.rhythmCombo}
                </span>
              )}
            </div>
          </div>

          {/* near-miss / PERFECT SYNC popups */}
          <div className="pointer-events-none absolute left-1/2 top-[19%] -translate-x-1/2">
            {popups.map((p, i) => (
              <div
                key={p.id}
                className="animate-popup font-mono text-lg font-bold tracking-widest drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]"
                style={{
                  color: popupColor(p.kind),
                  opacity: 1 - i * 0.22,
                  marginTop: i === 0 ? 0 : 4,
                  textShadow:
                    p.kind === 'gatePerfect'
                      ? '0 0 18px rgba(80,200,255,0.8), 0 2px 6px rgba(0,0,0,0.9)'
                      : undefined,
                }}
              >
                {p.text} {p.points > 0 ? `+${p.points}` : ''}
              </div>
            ))}
          </div>

          {/* chase-mode minimal speed widget */}
          {chase && !crashing && (
            <div className="pointer-events-none absolute bottom-8 left-1/2 -translate-x-1/2 text-center">
              <div className="font-mono text-5xl font-bold leading-none text-white/95 drop-shadow-[0_2px_10px_rgba(0,0,0,0.95)]">
                {Math.round(telemetry.speedKmh)}
              </div>
              <div className="font-mono text-xs tracking-[0.3em] text-white/50">KM/H · GEAR {telemetry.gearLabel}</div>
            </div>
          )}

          {/* wipeout banner */}
          {crashing && (
            <div className="pointer-events-none absolute left-1/2 top-1/3 -translate-x-1/2 font-mono text-4xl font-black tracking-[0.2em] text-red-500/90 drop-shadow-[0_0_24px_rgba(255,40,20,0.6)]">
              WIPEOUT
            </div>
          )}

          {/* status strip */}
          <div className="pointer-events-none absolute right-4 top-4 flex items-center gap-3 font-mono text-[11px] text-white/40">
            <span className="flex items-center gap-1">
              {telemetry.gamepad ? <Gamepad2 className="h-3.5 w-3.5 text-emerald-400/70" aria-label="gamepad connected" /> : <Keyboard className="h-3.5 w-3.5" aria-label="keyboard" />}
              {telemetry.gamepad ? 'GAMEPAD' : 'KEYS'}
            </span>
            <span>{telemetry.weather}</span>
            {telemetry.section !== '—' && (
              <span className="flex items-center gap-1 text-cyan-200/60">
                <Music2 className="h-3.5 w-3.5" />
                {telemetry.section}
              </span>
            )}
            <span className="flex items-center gap-1">
              <Gauge className="h-3.5 w-3.5" />
              {Math.round(telemetry.fps)} FPS
            </span>
          </div>

          <div className="pointer-events-none absolute bottom-4 left-4 font-mono text-[11px] text-white/35">
            {telemetry.distanceKm.toFixed(1)} km · top {Math.round(telemetry.topSpeedKmh)} km/h · {telemetry.nearMisses} near misses · {telemetry.gatePerfects} perfect syncs
          </div>
          <div className="pointer-events-none absolute bottom-4 right-4 font-mono text-[11px] text-white/35">C camera · B look back · SHIFT tuck · ESC pause</div>
        </>
      )}

      {/* ---------------- start screen ---------------- */}
      {!started && (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-black/70 via-black/40 to-black/80 backdrop-blur-[2px]">
          <div className="mx-4 w-full max-w-2xl rounded-2xl border border-white/10 bg-black/60 p-8 shadow-2xl">
            <div className="mb-1 flex items-center justify-between font-mono text-[11px] tracking-[0.5em] text-amber-400/80">
              <span>SHUTO EXPRESSWAY · C1 INNER LOOP</span>
              <span className="flex items-center gap-1 tracking-normal text-cyan-200/70">
                <Music className="h-3.5 w-3.5" /> SONG-SYNCED RHYTHM
              </span>
            </div>
            <h1 className="mb-2 text-4xl font-black tracking-tight text-white">
              MIDNIGHT <span className="text-amber-400">RUNNER</span>
            </h1>
            <p className="mb-6 max-w-xl text-sm leading-relaxed text-white/60">
              Liter-class supersport. Dense traffic. Lane-split at 300 km/h while the expressway itself rides the beat —
              gates, lights, lyrics and weather all lock to the music. Hit the arches on the downbeat for{' '}
              <span className="text-cyan-300">PERFECT SYNC</span>, thread the gaps for near-miss combos, don&apos;t touch
              anything.
            </p>

            <div className="mb-6 grid grid-cols-2 gap-x-8 gap-y-2 font-mono text-xs text-white/55 sm:grid-cols-3">
              <div><span className="text-white/90">W / RT</span> throttle</div>
              <div><span className="text-white/90">S / LT</span> front brake</div>
              <div><span className="text-white/90">SPACE / A</span> rear brake</div>
              <div><span className="text-white/90">A D / LX</span> steer & lean</div>
              <div><span className="text-white/90">SHIFT / L3</span> aero tuck</div>
              <div><span className="text-white/90">C / Y</span> cockpit ↔ chase</div>
              <div><span className="text-white/90">B / R3</span> look back</div>
              <div><span className="text-white/90">1–4</span> weather</div>
              <div><span className="text-white/90">ESC / START</span> pause</div>
            </div>

            <div className="mb-6 flex flex-wrap gap-2">
              {WEATHERS.map((w, i) => (
                <button
                  key={w.key}
                  onClick={() => handleWeather(i)}
                  className="pointer-events-auto flex items-center gap-2 rounded-full border border-white/15 px-3 py-1.5 font-mono text-[11px] text-white/60 transition hover:border-amber-400/50 hover:text-white"
                >
                  <w.icon className="h-3.5 w-3.5" />
                  {w.name} <span className="text-white/30">{w.key}</span>
                </button>
              ))}
            </div>

            {/* ---------- selected-song mode (§6/§7): YouTube song drives music, timing, lyrics ---------- */}
            <div className="mb-6 rounded-xl border border-cyan-300/20 bg-cyan-400/5 p-4">
              <div className="mb-2 flex items-center gap-2 font-mono text-[11px] tracking-widest text-cyan-200/80">
                <Youtube className="h-4 w-4" />
                RIDE TO YOUR SONG
              </div>
              <p className="mb-3 font-mono text-[11px] leading-relaxed text-white/50">
                Paste a YouTube link — music, playback clock, gates, weather cuts and{' '}
                <span className="text-cyan-200/90">that song&apos;s real synced lyrics</span> all follow it. Lyrics resolve from
                an open synced-lyrics source for the exact track; if they can&apos;t be resolved the HUD says LYRICS
                UNAVAILABLE instead of guessing. Demo soundtrack stays as fallback.
              </p>
              <input
                type="url"
                value={songUrl}
                onChange={(e) => setSongUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=…"
                spellCheck={false}
                className="pointer-events-auto w-full rounded-lg border border-white/15 bg-black/50 px-3 py-2 font-mono text-xs text-white placeholder:text-white/25 focus:border-cyan-300/60 focus:outline-none"
              />
              {songUrl.trim().length > 0 && (
                <div className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-cyan-200/60">
                  <Disc3 className="h-3 w-3 animate-spin" />
                  song mode armed — your track launches with the engine
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                size="lg"
                disabled={launching}
                onClick={() => handleStart(true)}
                className="w-full bg-amber-500 text-black font-mono text-base font-bold tracking-[0.3em] hover:bg-amber-400 disabled:opacity-60"
              >
                {launching ? 'LAUNCHING…' : 'START ENGINE'}
              </Button>
            </div>
            <div className="mt-3 text-center font-mono text-[10px] text-white/30">
              {songUrl.trim() ? 'song + engine audio start on launch · BPM auto-resolves when available; tap T / Select with the beat to phase-lock gates' : 'music + engine audio start on launch · gamepad recommended'}
            </div>
          </div>
        </div>
      )}

      {/* ---------------- pause menu ---------------- */}
      {paused && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-md rounded-2xl border border-white/10 bg-zinc-950/90 p-6 shadow-2xl">
            <h2 className="mb-1 font-mono text-xl font-bold tracking-[0.3em] text-white">PAUSED</h2>
            <div className="mb-5 font-mono text-xs text-white/40">
              score {telemetry.score.toLocaleString()} · {telemetry.nearMisses} near misses · {telemetry.gatePerfects} perfect syncs · top {Math.round(telemetry.topSpeedKmh)} km/h
            </div>

            {/* ---------- §33 song identity readout: ONE consistent track ---------- */}
            {telemetry.song.mode === 'song' && (
              <div className="mb-4 rounded-lg border border-cyan-300/20 bg-cyan-400/5 p-3 font-mono text-[11px] leading-relaxed text-white/60">
                <div className="mb-1.5 flex items-center gap-1.5 text-[10px] tracking-widest text-cyan-200/70">
                  <Play className="h-3 w-3" /> SONG IDENTITY
                </div>
                <div className="truncate"><span className="text-cyan-200/80">SONG:</span> {telemetry.song.title}</div>
                <div><span className="text-cyan-200/80">ARTIST:</span> {telemetry.song.artist || '—'}</div>
                <div><span className="text-cyan-200/80">YOUTUBE ID:</span> {telemetry.song.videoId}</div>
                <div><span className="text-cyan-200/80">DURATION:</span> {Math.floor(telemetry.song.duration / 60)}:{String(Math.round(telemetry.song.duration % 60)).padStart(2, '0')}</div>
                <div>
                  <span className="text-cyan-200/80">BPM:</span>{' '}
                  {telemetry.song.bpmCalibrated ? `${telemetry.song.bpm} (${telemetry.song.bpmSource === 'manual-tap' ? 'tap-locked' : 'catalog'})` : 'tap T with the beat'}
                </div>
                <div><span className="text-cyan-200/80">LYRICS:</span> {telemetry.song.lyricSource}</div>
                <div><span className="text-cyan-200/80">AUDIO TIME:</span> {telemetry.song.audioTime.toFixed(1)}s</div>
                <div className="truncate text-white/80">
                  <span className="text-cyan-200/80">CURRENT LYRIC:</span>{' '}
                  {telemetry.song.currentLyric || (telemetry.song.lyricSource === 'unavailable' ? 'LYRICS UNAVAILABLE' : '—')}
                </div>
              </div>
            )}

            <div className="mb-4">
              <div className="mb-2 font-mono text-[11px] tracking-widest text-white/50">WEATHER PRESET</div>
              <div className="grid grid-cols-2 gap-2">
                {WEATHERS.map((w, i) => (
                  <button
                    key={w.key}
                    onClick={() => handleWeather(i)}
                    className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 font-mono text-[11px] text-white/70 transition hover:border-amber-400/50 hover:text-white"
                  >
                    <w.icon className="h-4 w-4 text-amber-400/70" />
                    {w.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-4 flex items-center justify-between">
              <span className="font-mono text-[11px] tracking-widest text-white/50">AUTO-CYCLE SKY</span>
              <button
                onClick={() => handleAutoCycle(!autoCycle)}
                className={`rounded-full px-4 py-1.5 font-mono text-[11px] transition ${autoCycle ? 'bg-amber-500 text-black' : 'border border-white/15 text-white/60 hover:text-white'}`}
              >
                {autoCycle ? 'ON' : 'OFF'}
              </button>
            </div>

            <div className="mb-3">
              <div className="mb-2 flex justify-between font-mono text-[11px] tracking-widest text-white/50">
                <span>ENGINE VOLUME</span>
                <span>{Math.round(volume * 100)}%</span>
              </div>
              <Slider
                value={[volume]}
                min={0}
                max={1}
                step={0.05}
                onValueChange={(vals) => {
                  setVolume(vals[0]);
                  gameRef.current?.setVolume(vals[0]);
                }}
              />
            </div>

            <div className="mb-6">
              <div className="mb-2 flex items-center justify-between font-mono text-[11px] tracking-widest text-white/50">
                <span>MUSIC</span>
                <button
                  onClick={() => {
                    const next = !musicOn;
                    setMusicOn(next);
                    gameRef.current?.setMusicEnabled(next);
                  }}
                  className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 font-mono text-[11px] transition ${musicOn ? 'bg-cyan-500/90 text-black' : 'border border-white/15 text-white/60 hover:text-white'}`}
                >
                  <Music2 className="h-3.5 w-3.5" />
                  {musicOn ? 'ON' : 'OFF'}
                </button>
              </div>
              <Slider
                value={[musicVolume]}
                min={0}
                max={1}
                step={0.05}
                onValueChange={(vals) => {
                  setMusicVolume(vals[0]);
                  gameRef.current?.setMusicVolume(vals[0]);
                }}
              />
            </div>

            <div className="flex gap-3">
              <Button onClick={handleResume} className="flex-1 bg-amber-500 font-mono font-bold tracking-widest text-black hover:bg-amber-400">
                RESUME
              </Button>
              <Button onClick={handleRestart} variant="outline" className="flex-1 border-white/20 font-mono text-white/80 hover:text-white">
                RESTART
              </Button>
            </div>

            <button
              onClick={() => setShowHelp(!showHelp)}
              className="mt-4 w-full text-center font-mono text-[11px] text-white/35 underline-offset-4 hover:text-white/70 hover:underline"
            >
              {showHelp ? 'hide controls' : 'show controls'}
            </button>
            {showHelp && (
              <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border border-white/10 bg-white/5 p-4 font-mono text-[11px] text-white/50">
                <div><span className="text-white/80">W</span> throttle</div>
                <div><span className="text-white/80">S</span> front brake</div>
                <div><span className="text-white/80">SPACE</span> rear brake</div>
                <div><span className="text-white/80">A / D</span> lean</div>
                <div><span className="text-white/80">SHIFT</span> tuck (toggle)</div>
                <div><span className="text-white/80">C</span> camera</div>
                <div><span className="text-white/80">B</span> look back</div>
                <div><span className="text-white/80">Q / E</span> manual shift</div>
                <div><span className="text-white/80">1–4</span> weather</div>
                <div><span className="text-white/80">R</span> restart</div>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
