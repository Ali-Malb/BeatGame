'use client';

/**
 * RemoteSessionPanel — the remote-rendering surface.
 *
 * It owns a RemoteRuntime, forwards the player's LOCAL input to the server as
 * the same normalized InputState local play uses, shows the server's rendered
 * video, and renders the authoritative HUD (score/combo/HP/judgment/biome) from
 * the server's snapshot stream. Capabilities shown here come from the real
 * probes — client WebGL/GPU and the session's renderer/encoder/WebRTC — so a
 * refusal is always explained rather than faked.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import type { GameManager } from '@/game/core/Game';
import { InputHandler } from '@/game/core/Input';
import { RemoteRuntime, type RemoteStartOptions } from '@/game/runtime/RemoteRuntime';
import type { RuntimeCapabilities, RuntimeStatus, SimSnapshot } from '@/game/runtime/types';
import { Activity, MonitorPlay, Server, Wifi, X } from 'lucide-react';

/** the beatmap the server receives: notes are data, timing authority is not */
export type BeatmapPayload = NonNullable<RemoteStartOptions['chart']>;

interface Props {
  onClose: () => void;
  beatmap: BeatmapPayload | null;
  onBlockGameInput?: (blocked: boolean) => void;
}

export default function RemoteSessionPanel({ onClose, beatmap, onBlockGameInput }: Props) {
  const runtimeRef = useRef<RemoteRuntime | null>(null);
  const inputRef = useRef<InputHandler | null>(null);
  const rafRef = useRef<number>(0);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [snapshot, setSnapshot] = useState<SimSnapshot | null>(null);
  const [caps, setCaps] = useState<RuntimeCapabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'>('idle');
  const statusListenersRef = useRef<(() => void)[]>([]);

  // capability probe before any session exists (client side + server probe)
  useEffect(() => {
    let alive = true;
    void (async () => {
      const runtime = new RemoteRuntime('');
      runtimeRef.current = runtime;
      setCaps(runtime.capabilities());
      try {
        const res = await fetch('/api/remote/session');
        if (!res.ok) return;
        const json = (await res.json()) as { capabilities?: RuntimeCapabilities };
        if (alive && json.capabilities) setCaps({ ...runtime.capabilities(), ...json.capabilities });
      } catch {
        /* server probe unavailable — the client view still works */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // remote mode owns the client surface: the local 3D world stops rendering so
  // the player's GPU/CPU cost actually drops to the video decode (Phase 9/15)
  const localGame = typeof window !== 'undefined' ? (window as unknown as { __game?: GameManager }).__game ?? null : null;
  useEffect(() => {
    if (!localGame) return;
    if (videoUrl) localGame.suspendAttract();
    else if (localGame.getState() === 'menu') localGame.resumeAttract();
  }, [videoUrl, localGame]);
  useEffect(() => {
    return () => {
      // panel unmount (close/stop) always gives the surface back
      if (localGame && localGame.getState() === 'menu') localGame.resumeAttract();
    };
  }, [localGame]);

  // input forward loop: local devices → normalized InputState → server
  useEffect(() => {
    const handler = new InputHandler();
    inputRef.current = handler;
    let last = performance.now();
    let stopped = false;
    const pump = () => {
      if (stopped) return;
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      handler.update(dt);
      runtimeRef.current?.setInput(handler.snapshot());
      rafRef.current = requestAnimationFrame(pump);
    };
    rafRef.current = requestAnimationFrame(pump);
    return () => {
      stopped = true;
      cancelAnimationFrame(rafRef.current);
      handler.dispose();
    };
  }, []);

  const start = async () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    setBusy(true);
    setError(null);
    try {
      await runtime.start({
        song: { source: 'demo', id: 'demo', title: 'MIDNIGHT RUNNER — C1 Inner Loop' },
        chart: beatmap,
        // The CPU renderer is intentionally conservative: 320×180 gives the
        // browser a real first frame quickly on a server without a GPU, then
        // the session adapts quality from measured render/encode cost.
        videoWidth: 320,
        videoHeight: 180,
      });
      setVideoUrl(runtime.videoUrl());
      const offStatus = runtime.onStatus((s) => {
        setStatus(s);
        if (!s.connected && (s.state === 'playing' || s.state === 'countdown')) setPhase('reconnecting');
        else if (s.connected) setPhase('connected');
        else if (s.state === 'error') setPhase('failed');
      });
      const offSnap = runtime.onSnapshot((s) => setSnapshot(s));
      statusListenersRef.current = [offStatus, offSnap];
      runtimeRef.current = runtime;
      setStatus(runtime.status());
      setPhase('connected');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus(runtime.status());
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    for (const off of statusListenersRef.current) off();
    statusListenersRef.current = [];
    await runtimeRef.current?.dispose();
    runtimeRef.current = null;
    setVideoUrl(null);
    setSnapshot(null);
    setPhase('idle');
    onClose();
  };

  useEffect(() => {
    onBlockGameInput?.(!!videoUrl);
  }, [videoUrl, onBlockGameInput]);

  const score = snapshot?.scoring;

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/85 backdrop-blur-sm">
      <div className="mx-3 flex w-full max-w-5xl flex-col gap-3 rounded-2xl border border-white/10 bg-black/80 p-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-ui text-[11px] font-semibold tracking-[0.35em] text-cyan-200/80">
            <Server className="h-4 w-4" /> REMOTE RENDER — SERVER-SIDE SIMULATION
          </div>
          <div className="flex items-center gap-3">
            {videoUrl && (
              <span
                className={`rounded-full px-2.5 py-0.5 font-ui text-[10px] font-bold tracking-widest ${
                  phase === 'connected'
                    ? 'bg-emerald-400/15 text-emerald-300'
                    : phase === 'reconnecting'
                      ? 'bg-amber-400/15 text-amber-300'
                      : 'bg-white/10 text-white/60'
                }`}
              >
                {phase === 'connected' ? '● CONNECTED' : phase === 'reconnecting' ? '● RECONNECTING' : `● ${phase.toUpperCase()}`}
              </span>
            )}
            <button onClick={() => void stop()} className="text-white/40 transition hover:text-white" aria-label="close">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {!videoUrl && (
          <div className="grid gap-3 md:grid-cols-[1.2fr_1fr]">
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <div className="mb-2 font-ui text-[10px] tracking-[0.3em] text-white/45">WHAT THIS MODE DOES</div>
              <ul className="space-y-1.5 font-ui text-xs leading-relaxed text-white/60">
                <li>· the bike, traffic, rhythm gates and scoring run on the server clock</li>
                <li>· the server rasterizes the world and streams encoded frames</li>
                <li>· your keyboard/gamepad/touch becomes the same normalized input local play uses</li>
                <li>· the HUD you see here is the server&apos;s authoritative state</li>
              </ul>
              {error && (
                <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 font-ui text-xs text-amber-200">
                  Remote session could not start: <span className="font-semibold">{error}</span>
                  <div className="mt-1 text-amber-200/70">
                    Local play is unaffected — the runtime keeps the local renderer instead of pretending remote mode is live.
                  </div>
                </div>
              )}
              <Button
                onClick={() => void start()}
                disabled={busy}
                className="mt-4 h-11 w-full bg-cyan-400 font-display text-sm font-black italic tracking-widest text-black hover:bg-cyan-300"
              >
                <MonitorPlay className="mr-2 h-4 w-4" /> {busy ? 'CREATING SESSION…' : 'START REMOTE SESSION'}
              </Button>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 font-mono text-[11px] text-white/55">
              <div className="mb-2 font-ui text-[10px] tracking-[0.3em] text-white/45">CAPABILITY PROBE</div>
              <Row label="client webgl2" value={caps?.webgl2 ? 'yes' : 'no'} />
              <Row label="client gpu" value={caps?.gpuRenderer ?? 'unknown'} />
              <Row label="client webrtc" value={caps?.rtcSupported ? 'available' : 'unavailable'} />
              <Row label="server renderer" value={caps?.serverRenderer ?? '…'} />
              <Row label="server encoder" value={caps?.serverEncoder ?? '…'} />
              <Row label="server webrtc" value={caps?.serverRtc ? 'media bridge configured' : 'no media stack'} />
              {caps?.remoteVideoReason && <Row label="note" value={caps.remoteVideoReason} />}
            </div>
          </div>
        )}

        {videoUrl && (
          <div className="relative overflow-hidden rounded-xl border border-white/10 bg-black">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={videoUrl} alt="server-rendered video" className="block w-full" />
            <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-center gap-2 bg-gradient-to-b from-black/70 to-transparent p-2 font-mono text-[10px] tracking-wider text-white/80">
              <Chip icon={<Wifi className="h-3 w-3" />} label={`${status?.transport ?? 'mjpeg'} · ${status?.latencyMs ?? 0} ms rtt`} />
              <Chip icon={<Activity className="h-3 w-3" />} label={`srv ${snapshot?.perf.serverFps ?? 0} fps · lag ${status?.streamLagMs ?? 0} ms`} />
              <Chip label={`${snapshot?.perf.renderMs ?? 0} ms render / ${snapshot?.perf.encodeMs ?? 0} ms encode`} />
              <Chip label={`session ${status?.sessionId?.slice(0, 8) ?? '—'}`} />
              {status?.reason && <Chip label={status.reason} />}
            </div>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 grid grid-cols-2 gap-2 bg-gradient-to-t from-black/80 to-transparent p-3 font-mono text-white">
              <div className="space-y-1">
                <div className="text-2xl font-bold tabular-nums">{Math.round((snapshot?.bike.v ?? 0) * 3.6)}<span className="ml-1 text-xs text-white/50">km/h</span></div>
                <div className="text-[10px] tracking-widest text-white/50">
                  {snapshot?.environment.biomeName} · {snapshot?.environment.districtName} · {snapshot?.environment.section}
                </div>
                <div className="text-[10px] tracking-widest text-white/50">
                  HP {Math.round(score?.hp ?? 100)} · {score?.combo ?? 0}× combo · ×{(score?.multiplier ?? 1).toFixed(2)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold tabular-nums">{(score?.score ?? 0).toLocaleString()}</div>
                <div className="text-[10px] tracking-widest text-white/50">
                  P {score?.perfects ?? 0} · G {score?.goods ?? 0} · M {score?.misses ?? 0}
                </div>
                {snapshot?.judgment && (
                  <div className="text-xs font-bold tracking-widest text-cyan-300">
                    {snapshot.judgment.judgment.toUpperCase()} {snapshot.judgment.delta >= 0 ? '+' : ''}
                    {Math.round(snapshot.judgment.delta * 1000)} ms
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="font-ui text-[10px] text-white/35">
          Latency and jitter are network properties the server cannot remove; rhythm timing never depends on your render
          frame rate because the server owns the clock.
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-white/5 py-1">
      <span className="text-white/40">{label}</span>
      <span className="truncate text-right text-white/80">{value}</span>
    </div>
  );
}

function Chip({ label, icon }: { label: string; icon?: ReactNode }) {
  return (
    <span className="flex items-center gap-1 rounded-full border border-white/15 bg-black/50 px-2 py-0.5">
      {icon}
      {label}
    </span>
  );
}
