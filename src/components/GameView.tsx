'use client';

/**
 * GameView — mounts the WebGL canvas and renders every UI surface:
 *   main menu, YouTube search, loading/analyzing overlays, countdown,
 *   gameplay HUD (HP / combo / score / multiplier / judgments / track),
 *   results (victory & failure), pause menu and the debug overlay (F3).
 *
 * All gameplay timing lives in the engine (AudioContext clock); React only
 * renders state pushed at ~12 Hz via telemetry.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { GameManager, type GameState, type Telemetry } from '@/game/core/Game';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Gamepad2, Keyboard, Gauge, Music2, Youtube, Play, Search, Upload, RotateCcw, Home, Pause, Heart, Zap, Flame } from 'lucide-react';

interface Popup {
  id: number;
  text: string;
  points: number;
  kind: string;
}

interface SearchItem {
  id: string;
  title: string;
  channel: string;
  duration: number;
  thumbnail: string;
}

const EMPTY_TELEMETRY: Telemetry = {
  state: 'menu',
  speedKmh: 0,
  rpm: 0,
  gear: 0,
  gearLabel: 'N',
  leanDeg: 0,
  score: 0,
  combo: 0,
  multiplier: 1,
  hp: 100,
  hpFlash: false,
  perfects: 0,
  goods: 0,
  misses: 0,
  crashes: 0,
  bestCombo: 0,
  accuracy: 0,
  musicTime: 0,
  songDuration: 165,
  bpm: 128,
  section: '—',
  biome: 'SAKURA TWILIGHT',
  fps: 60,
  cameraMode: 'cockpit',
  gamepad: false,
  countdown: null,
  song: { source: 'demo', videoId: '', title: 'MIDNIGHT RUNNER — C1 Inner Loop', channel: 'built-in synthwave' },
  analysisQuality: '—',
  debug: {
    audioTime: 0,
    beatPhase: 0,
    subdivision: 0,
    playerS: 0,
    laneX: 0,
    activeGates: 0,
    nextGateTime: 0,
    gateDelta: 0,
    distanceKm: 0,
    nearMisses: 0,
  },
};

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

let popupId = 0;

export default function GameView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lyricRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<GameManager | null>(null);
  const [tel, setTel] = useState<Telemetry>(EMPTY_TELEMETRY);
  const [state, setState] = useState<GameState>('menu');
  const [popups, setPopups] = useState<Popup[]>([]);
  const [volume, setVolume] = useState(0.9);
  const [musicOn, setMusicOn] = useState(true);
  const [showDebug, setShowDebug] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchItem[]>([]);
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'error' | 'done'>('idle');
  const [searchError, setSearchError] = useState('');
  const [progress, setProgress] = useState<{ phase: string; fraction: number; detail: string } | null>(null);
  const [analysisInfo, setAnalysisInfo] = useState<{ bpm: number; duration: number; sections: number; quality: string; notes: number } | null>(null);
  const [judgment, setJudgment] = useState<{ text: string; kind: string; id: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const game = new GameManager(canvasRef.current, {
      getLyricContainer: () => lyricRef.current,
      onTelemetry: (t) => setTel(t),
      onStateChange: (s) => setState(s),
      onPopup: (text, points, kind) => {
        const p = { id: ++popupId, text, points, kind };
        setPopups((prev) => [...prev.slice(-5), p]);
        setTimeout(() => setPopups((prev) => prev.filter((x) => x.id !== p.id)), 900);
        if (kind === 'gatePerfect' || kind === 'gateGood' || kind === 'gateMiss') {
          setJudgment({ text: kind === 'gatePerfect' ? 'PERFECT' : kind === 'gateGood' ? 'GOOD' : 'MISS', kind, id: p.id });
          setTimeout(() => setJudgment((j) => (j && j.id === p.id ? null : j)), 700);
        }
      },
      onProgress: (p) => setProgress(p),
      onAnalysis: (a) => setAnalysisInfo(a),
    });
    gameRef.current = game;
    return () => {
      game.dispose();
      gameRef.current = null;
    };
  }, []);

  // F3 debug overlay
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'F3') {
        e.preventDefault();
        setShowDebug((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const runSearch = useCallback(async () => {
    const q = searchQuery.trim();
    if (!q) return;
    setSearchState('loading');
    setSearchError('');
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { cache: 'no-store' });
      const j = (await res.json()) as { results?: SearchItem[]; error?: string };
      if (!res.ok) {
        setSearchError(j.error ?? `search failed (${res.status})`);
        setSearchResults([]);
        setSearchState('error');
        return;
      }
      setSearchResults(j.results ?? []);
      setSearchState((j.results ?? []).length === 0 ? 'error' : 'done');
      if ((j.results ?? []).length === 0) setSearchError('No results — try different words.');
    } catch {
      setSearchError('Search request failed — is the server running?');
      setSearchState('error');
    }
  }, [searchQuery]);

  const pick = useCallback((item: SearchItem) => {
    setSearchState('idle');
    void gameRef.current?.startYouTube(item.id);
  }, []);

  const onUpload = useCallback((file: File) => {
    void gameRef.current?.startUpload(file);
  }, []);

  const riding = state === 'playing' || state === 'countdown';
  const paused = state === 'paused';
  const playingState = state === 'playing';

  const judgmentColor = (kind: string) =>
    kind === 'gatePerfect' ? 'text-cyan-300' : kind === 'gateGood' ? 'text-sky-200' : 'text-red-400';

  return (
    <main className="fixed inset-0 select-none overflow-hidden bg-black">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-label="Rhythm motorcycle racing viewport" />

      {/* kinetic lyrics (DSP-driven by the engine) */}
      <div ref={lyricRef} className="klyric-container" aria-hidden="true" />

      {/* ---------------------------------------------------------- HUD */}
      {riding && (
        <>
          {/* TOP LEFT — HP */}
          <div className="pointer-events-none absolute left-5 top-5 w-64">
            <div className="mb-1 flex items-center gap-2 font-mono text-[10px] tracking-[0.3em] text-white/50">
              <Heart className={`h-3.5 w-3.5 ${tel.hp < 30 ? 'text-red-500' : 'text-rose-300/70'}`} />
              INTEGRITY
            </div>
            <div className="h-3 w-full overflow-hidden rounded-sm border-2 border-zinc-600/80 bg-zinc-900/80 shadow-[0_2px_10px_rgba(0,0,0,0.8)]">
              <div
                className={`h-full transition-[width] duration-150 ${
                  tel.hpFlash ? 'bg-red-500' : tel.hp > 55 ? 'bg-white' : tel.hp > 25 ? 'bg-amber-200' : 'bg-red-400'
                }`}
                style={{ width: `${tel.hp}%` }}
              />
            </div>
          </div>

          {/* TOP RIGHT — combo + score + multiplier */}
          <div className="pointer-events-none absolute right-6 top-4 text-right">
            <div
              key={tel.combo}
              className={`font-mono text-4xl font-black italic leading-none drop-shadow-[0_2px_10px_rgba(0,0,0,0.95)] ${
                tel.combo >= 100 ? 'text-amber-300' : tel.combo >= 40 ? 'text-orange-300' : tel.combo >= 10 ? 'text-cyan-200' : 'text-white/80'
              }`}
              style={{ animation: 'pop-num 0.18s ease-out' }}
            >
              {tel.combo}
              <span className="ml-1 text-sm not-italic text-white/60">COMBO</span>
            </div>
            <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]">
              {tel.score.toLocaleString()}
            </div>
            <div className="font-mono text-xs tracking-wider text-white/60">
              score ×{tel.multiplier.toFixed(2)}
              {tel.multiplier >= 2 && <Flame className="ml-1 inline h-3.5 w-3.5 text-orange-400" />}
            </div>
          </div>

          {/* JUDGMENT (center, no layout shift) */}
          {judgment && (
            <div key={judgment.id} className="pointer-events-none absolute left-1/2 top-[24%] -translate-x-1/2">
              <div
                className={`animate-popup font-mono text-4xl font-black italic tracking-[0.18em] drop-shadow-[0_2px_14px_rgba(0,0,0,0.95)] ${judgmentColor(judgment.kind)}`}
              >
                {judgment.text}
              </div>
            </div>
          )}

          {/* popups (near miss / biome / crash) */}
          <div className="pointer-events-none absolute left-1/2 top-[31%] -translate-x-1/2 text-center">
            {popups
              .filter((p) => p.kind !== 'gatePerfect' && p.kind !== 'gateGood' && p.kind !== 'gateMiss')
              .map((p, i) => (
                <div
                  key={p.id}
                  className="animate-popup font-mono text-base font-bold tracking-widest text-white/90 drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]"
                  style={{ opacity: 1 - i * 0.22 }}
                >
                  {p.text} {p.points > 0 ? `+${p.points}` : ''}
                </div>
              ))}
          </div>

          {/* BOTTOM RIGHT — track */}
          <div className="pointer-events-none absolute bottom-5 right-6 text-right font-mono">
            <div className="text-lg font-bold tabular-nums text-white/90 drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]">
              {fmt(tel.musicTime)} / {fmt(tel.songDuration)}
            </div>
            <div className="max-w-[320px] truncate text-xs font-semibold text-cyan-200/90">{tel.song.title}</div>
            <div className="max-w-[320px] truncate text-[11px] text-white/45">{tel.song.channel || '—'}</div>
          </div>

          {/* BOTTOM LEFT — speed (chase cam) + stats */}
          <div className="pointer-events-none absolute bottom-5 left-5 font-mono text-[11px] text-white/40">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">{tel.gamepad ? <Gamepad2 className="h-3.5 w-3.5 text-emerald-400/70" /> : <Keyboard className="h-3.5 w-3.5" />}{tel.gamepad ? 'GAMEPAD' : 'KEYS'}</span>
              <span className="flex items-center gap-1"><Gauge className="h-3.5 w-3.5" />{Math.round(tel.fps)} FPS</span>
              <span className="text-cyan-200/60">{tel.biome}</span>
            </div>
            <div className="mt-1">{tel.debug.distanceKm.toFixed(1)} km · {tel.debug.nearMisses} near-miss · {tel.perfects}P {tel.goods}G {tel.misses}M</div>
            {tel.cameraMode === 'chase' && (
              <div className="mt-1 font-mono text-3xl font-bold tabular-nums text-white/90">{Math.round(tel.speedKmh)} <span className="text-xs text-white/50">KM/H</span></div>
            )}
          </div>

          {/* section / bpm */}
          <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 font-mono text-[10px] tracking-[0.35em] text-white/35">
            {tel.section.toUpperCase()} · {Math.round(tel.bpm)} BPM
          </div>

          {/* COUNTDOWN */}
          {state === 'countdown' && tel.countdown != null && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div
                key={tel.countdown}
                className="font-mono text-[140px] font-black italic leading-none text-white drop-shadow-[0_0_40px_rgba(80,200,255,0.55)]"
                style={{ animation: 'count-pop 0.85s ease-out' }}
              >
                {tel.countdown > 0 ? tel.countdown : 'GO'}
              </div>
            </div>
          )}

          {/* DEBUG OVERLAY (F3) */}
          {showDebug && (
            <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-cyan-400/30 bg-black/80 p-4 font-mono text-[11px] leading-relaxed text-cyan-100/90">
              <div className="mb-1 font-bold tracking-widest text-cyan-300">DEBUG (F3)</div>
              <div>audioTime {tel.debug.audioTime.toFixed(3)}s · beat {tel.debug.beatPhase.toFixed(2)}</div>
              <div>bpm {tel.bpm.toFixed(1)} · sub {tel.debug.subdivision}/8 · {tel.analysisQuality}</div>
              <div>speed {Math.round(tel.speedKmh)} km/h · gear {tel.gearLabel} · lane x {tel.debug.laneX.toFixed(2)}m</div>
              <div>s {tel.debug.playerS}m · dist {tel.debug.distanceKm.toFixed(2)}km</div>
              <div>gates active {tel.debug.activeGates} · next t {tel.debug.nextGateTime.toFixed(3)}</div>
              <div>gate Δ {tel.debug.gateDelta.toFixed(3)}s</div>
              <div>combo {tel.combo} · ×{tel.multiplier.toFixed(2)} · hp {tel.hp.toFixed(0)}</div>
              <div>biome {tel.biome} · section {tel.section}</div>
            </div>
          )}
        </>
      )}

      {/* ---------------------------------------------------- LOADING / ANALYZING */}
      {(state === 'loading' || state === 'analyzing') && progress && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/75 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-cyan-300/20 bg-zinc-950/90 p-8 text-center">
            <div className="mb-4 flex items-center justify-center gap-2 font-mono text-xs tracking-[0.4em] text-cyan-300">
              <Zap className="h-4 w-4 animate-pulse" />
              {state === 'loading' ? 'LOADING AUDIO' : 'ANALYZING'}
            </div>
            <div className="mb-2 truncate font-mono text-sm text-white/80">{tel.song.title}</div>
            <div className="mb-4 h-2 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className={`h-full rounded-full transition-[width] duration-200 ${state === 'analyzing' ? 'bg-gradient-to-r from-fuchsia-500 to-cyan-400' : 'bg-cyan-400'}`}
                style={{ width: `${Math.round(progress.fraction * 100)}%` }}
              />
            </div>
            <div className="font-mono text-[11px] text-white/45">{progress.detail}</div>
            {analysisInfo && (
              <div className="mt-4 font-mono text-[11px] text-cyan-200/80">
                BPM {analysisInfo.bpm} · {analysisInfo.notes} gates · {analysisInfo.sections} sections · quality {analysisInfo.quality}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------ RESULTS */}
      {(state === 'victory' || state === 'failed') && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 backdrop-blur-[3px]">
          <div className={`mx-4 w-full max-w-lg rounded-2xl border p-8 shadow-2xl ${state === 'victory' ? 'border-cyan-300/30 bg-zinc-950/90' : 'border-red-500/30 bg-zinc-950/90'}`}>
            <div className={`mb-1 font-mono text-[11px] tracking-[0.5em] ${state === 'victory' ? 'text-cyan-300' : 'text-red-400'}`}>
              {state === 'victory' ? 'RIDE COMPLETE' : 'BIKE TOTALED'}
            </div>
            <h2 className={`mb-5 font-mono text-4xl font-black italic tracking-tight ${state === 'victory' ? 'text-white' : 'text-red-400'}`}>
              {state === 'victory' ? 'VICTORY' : 'FAILED'}
            </h2>

            <div className="mb-5 rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="mb-1 font-mono text-4xl font-black tabular-nums text-white">{tel.score.toLocaleString()}</div>
              <div className="font-mono text-xs text-white/50">FINAL SCORE</div>
            </div>

            <div className="mb-6 grid grid-cols-3 gap-3 font-mono text-xs">
              <div className="rounded-lg border border-cyan-300/20 bg-cyan-400/5 p-3 text-center">
                <div className="text-xl font-black text-cyan-300">{tel.perfects}</div>
                <div className="text-white/40">PERFECT</div>
              </div>
              <div className="rounded-lg border border-sky-300/20 bg-sky-400/5 p-3 text-center">
                <div className="text-xl font-black text-sky-200">{tel.goods}</div>
                <div className="text-white/40">GOOD</div>
              </div>
              <div className="rounded-lg border border-red-400/20 bg-red-400/5 p-3 text-center">
                <div className="text-xl font-black text-red-400">{tel.misses}</div>
                <div className="text-white/40">MISS</div>
              </div>
            </div>

            <div className="mb-6 grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-xs text-white/60">
              <div>HIGHEST COMBO <span className="float-right font-bold text-white">{tel.bestCombo}</span></div>
              <div>ACCURACY <span className="float-right font-bold text-white">{Math.round(tel.accuracy * 100)}%</span></div>
              <div>CRASHES <span className="float-right font-bold text-white">{tel.crashes}</span></div>
              <div>NEAR MISSES <span className="float-right font-bold text-white">{tel.debug.nearMisses}</span></div>
              <div className="col-span-2 truncate">TRACK <span className="font-bold text-cyan-200">{tel.song.title}</span></div>
              <div className="col-span-2 truncate">ARTIST <span className="text-white/70">{tel.song.channel || '—'}</span></div>
            </div>

            <div className="flex gap-3">
              <Button onClick={() => gameRef.current?.retry()} className="flex-1 bg-cyan-500 font-mono font-bold tracking-widest text-black hover:bg-cyan-400">
                <RotateCcw className="mr-1.5 h-4 w-4" /> RETRY
              </Button>
              <Button onClick={() => gameRef.current?.backToMenu()} variant="outline" className="flex-1 border-white/20 font-mono text-white/80 hover:text-white">
                <Home className="mr-1.5 h-4 w-4" /> MENU
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- PAUSE */}
      {paused && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-md rounded-2xl border border-white/10 bg-zinc-950/90 p-6 shadow-2xl">
            <h2 className="mb-1 flex items-center gap-2 font-mono text-xl font-bold tracking-[0.3em] text-white">
              <Pause className="h-5 w-5 text-cyan-300" /> PAUSED
            </h2>
            <div className="mb-5 font-mono text-xs text-white/40">
              score {tel.score.toLocaleString()} · {tel.combo} combo · ×{tel.multiplier.toFixed(2)} · {fmt(tel.musicTime)} / {fmt(tel.songDuration)}
            </div>

            <div className="mb-4">
              <div className="mb-2 flex justify-between font-mono text-[11px] tracking-widest text-white/50">
                <span>MUSIC VOLUME</span>
                <span>{Math.round(volume * 100)}%</span>
              </div>
              <Slider
                value={[volume]}
                min={0}
                max={1}
                step={0.05}
                onValueChange={(vals) => {
                  setVolume(vals[0]);
                  gameRef.current?.setMusicVolume(vals[0]);
                }}
              />
            </div>

            <div className="mb-5 flex items-center justify-between">
              <span className="font-mono text-[11px] tracking-widest text-white/50">MUSIC</span>
              <button
                onClick={() => {
                  const next = !musicOn;
                  setMusicOn(next);
                  gameRef.current?.setMusicEnabled(next);
                }}
                className={`rounded-full px-4 py-1.5 font-mono text-[11px] transition ${musicOn ? 'bg-cyan-500/90 text-black' : 'border border-white/15 text-white/60 hover:text-white'}`}
              >
                {musicOn ? 'ON' : 'OFF'}
              </button>
            </div>

            <div className="flex gap-3">
              <Button onClick={() => gameRef.current?.togglePause()} className="flex-1 bg-cyan-500 font-mono font-bold tracking-widest text-black hover:bg-cyan-400">
                RESUME
              </Button>
              <Button onClick={() => gameRef.current?.backToMenu()} variant="outline" className="flex-1 border-white/20 font-mono text-white/80 hover:text-white">
                QUIT TO MENU
              </Button>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[11px] text-white/40">
              <div><span className="text-white/70">W / ↑</span> throttle</div>
              <div><span className="text-white/70">S / ↓</span> brake</div>
              <div><span className="text-white/70">A D / ← →</span> steer</div>
              <div><span className="text-white/70">SHIFT</span> aero tuck</div>
              <div><span className="text-white/70">C</span> camera</div>
              <div><span className="text-white/70">ESC</span> pause</div>
              <div><span className="text-white/70">F3</span> debug overlay</div>
              <div><span className="text-white/70">R</span> restart run</div>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------ MENU + SEARCH */}
      {(state === 'menu' || state === 'search') && (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-black/70 via-black/40 to-black/85 backdrop-blur-[2px]">
          <div className="mx-4 grid w-full max-w-4xl gap-6 md:grid-cols-[1.05fr_1fr]">
            {/* left: identity + start */}
            <div className="rounded-2xl border border-white/10 bg-black/60 p-7 shadow-2xl">
              <div className="mb-1 font-mono text-[10px] tracking-[0.5em] text-amber-400/80">BEAT FOR SPEED · RHYTHM RACING</div>
              <h1 className="mb-2 text-4xl font-black tracking-tight text-white">
                NEON <span className="text-cyan-300">VELOCITY</span>
              </h1>
              <p className="mb-5 text-sm leading-relaxed text-white/60">
                320 km/h lane-splitting where the highway <span className="text-cyan-200">is</span> the rhythm: every gate,
                environment cut and camera kick rides your song&apos;s beat. Thread PERFECT gates, keep the combo, don&apos;t
                touch the traffic.
              </p>

              <div className="mb-5 grid grid-cols-2 gap-x-6 gap-y-1.5 font-mono text-xs text-white/55">
                <div><span className="text-white/90">W / ↑</span> throttle</div>
                <div><span className="text-white/90">S / ↓</span> brake</div>
                <div><span className="text-white/90">A D / ← →</span> steer &amp; lean</div>
                <div><span className="text-white/90">SHIFT / L3</span> aero tuck</div>
                <div><span className="text-white/90">C / Y</span> cockpit ↔ chase</div>
                <div><span className="text-white/90">ESC / START</span> pause</div>
              </div>

              <div className="mb-6 rounded-xl border border-cyan-300/20 bg-cyan-400/5 p-4">
                <div className="mb-2 flex items-center gap-2 font-mono text-[11px] tracking-widest text-cyan-200/80">
                  <Music2 className="h-4 w-4" /> SOUNDTRACK
                </div>
                <div className="mb-3 font-mono text-[11px] leading-relaxed text-white/45">
                  Search a real track — it&apos;s streamed, decoded and beat-analyzed into your run. Or ride the built-in
                  synthwave. Local MP3/WAV also supported.
                </div>
                <div className="flex flex-col gap-2">
                  <Button
                    onClick={() => gameRef.current?.openSearch()}
                    className="w-full bg-cyan-500 font-mono text-sm font-bold tracking-[0.25em] text-black hover:bg-cyan-400"
                  >
                    <Search className="mr-2 h-4 w-4" /> SEARCH YOUTUBE
                  </Button>
                  <Button
                    onClick={() => fileInputRef.current?.click()}
                    variant="outline"
                    className="w-full border-white/15 font-mono text-xs text-white/70 hover:text-white"
                  >
                    <Upload className="mr-2 h-4 w-4" /> USE LOCAL FILE
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onUpload(f);
                      e.target.value = '';
                    }}
                  />
                  <Button
                    onClick={() => void gameRef.current?.startDemo()}
                    variant="outline"
                    className="w-full border-amber-400/30 font-mono text-xs text-amber-200/90 hover:bg-amber-400/10 hover:text-amber-100"
                  >
                    <Play className="mr-2 h-4 w-4" /> QUICK RIDE — DEMO TRACK
                  </Button>
                </div>
              </div>

              <div className="font-mono text-[10px] leading-relaxed text-white/30">
                Judging: PERFECT ±45 ms / ≤1.2 m · GOOD ±90 ms / ≤1.6 m · a miss costs −4 HP, a crash −25. Combos build
                your multiplier up to ×2.00 at 100.
              </div>
            </div>

            {/* right: search panel (expanded in search state) */}
            <div className={`rounded-2xl border p-5 shadow-2xl transition ${state === 'search' ? 'border-cyan-300/40 bg-black/75' : 'border-white/10 bg-black/45'}`}>
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2 font-mono text-[11px] tracking-[0.3em] text-cyan-200/80">
                  <Youtube className="h-4 w-4 text-red-400" /> YOUTUBE SEARCH
                </div>
                {state === 'search' && (
                  <button onClick={() => gameRef.current?.closeSearch()} className="font-mono text-[10px] text-white/40 hover:text-white">
                    ✕ close
                  </button>
                )}
              </div>

              <div className="mb-3 flex gap-2">
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void runSearch();
                  }}
                  placeholder="song or artist… (enter to search)"
                  spellCheck={false}
                  className="w-full rounded-lg border border-white/15 bg-black/60 px-3 py-2 font-mono text-xs text-white placeholder:text-white/25 focus:border-cyan-300/60 focus:outline-none"
                />
                <Button onClick={() => void runSearch()} disabled={searchState === 'loading'} className="bg-cyan-500 px-3 font-mono text-black hover:bg-cyan-400">
                  {searchState === 'loading' ? '…' : 'GO'}
                </Button>
              </div>

              {searchState === 'error' && (
                <div className="mb-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 font-mono text-[11px] text-amber-200/90">
                  {searchError}
                  <button onClick={() => void runSearch()} className="ml-2 underline hover:text-white">retry</button>
                </div>
              )}

              <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
                {searchResults.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => pick(item)}
                    className="flex w-full items-center gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-2 text-left transition hover:border-cyan-300/50 hover:bg-cyan-400/10"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={item.thumbnail} alt="" className="h-11 w-20 flex-none rounded object-cover" loading="lazy" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-semibold text-white/90">{item.title}</div>
                      <div className="truncate font-mono text-[10px] text-white/40">{item.channel}</div>
                    </div>
                    <div className="flex-none font-mono text-[10px] tabular-nums text-white/50">{fmt(item.duration)}</div>
                  </button>
                ))}
                {searchState === 'idle' && searchResults.length === 0 && (
                  <div className="rounded-lg border border-white/10 bg-white/[0.02] p-4 font-mono text-[11px] leading-relaxed text-white/35">
                    Real YouTube results via the server&apos;s yt-dlp backend — thumbnails, channels and durations included.
                    Pick a track and the engine analyzes its beat map into a live rhythm chart.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
