import { NextResponse } from 'next/server';
import { sessionManager } from '@/game/server/SessionManager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/remote/session — create a persistent remote-play session.
 *
 * The body carries the beatmap (chart) produced by the client's deterministic
 * DSP analysis plus the song the client will play locally while the server owns
 * the authoritative clock. The session starts its own simulation loop here and
 * keeps running independently of this request.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const mgr = sessionManager();
  const session = await mgr.create({
    chart: (body.chart ?? null) as never,
    countdownSec: typeof body.countdownSec === 'number' ? body.countdownSec : 3,
    music: (body.music ?? null) as never,
    // 576×324 is the lightweight default for the software rasterizer: sharper
    // than the old 640×360 default at ~19% fewer pixels to rasterize AND a
    // cheaper JPEG encode, while the client's adapt() still scales it further
    // on measured cost. Clients that need something else pass explicit sizes.
    videoWidth: typeof body.videoWidth === 'number' ? Math.max(240, Math.min(1920, body.videoWidth)) : 576,
    videoHeight: typeof body.videoHeight === 'number' ? Math.max(135, Math.min(1080, body.videoHeight)) : 324,
    startLane: typeof body.startLane === 'number' ? body.startLane : 2,
    startSpeed: typeof body.startSpeed === 'number' ? body.startSpeed : undefined,
  });
  const clientId = typeof body.clientId === 'string' && body.clientId ? body.clientId : 'web-client';
  session.connect(clientId);
  session.startRun();
  return NextResponse.json({
    id: session.id,
    capabilities: session.capabilitiesSnapshot,
    videoParams: session.videoParams,
    snapshot: session.snapshot(),
  });
}

/** GET /api/remote/session — list live sessions (ops/telemetry) */
export async function GET() {
  const mgr = sessionManager();
  return NextResponse.json({ sessions: mgr.list(), capabilities: mgr.capabilities() });
}

/** DELETE /api/remote/session — tear every session down (cleanup) */
export async function DELETE() {
  const mgr = sessionManager();
  const n = mgr.count;
  mgr.destroyAll();
  return NextResponse.json({ destroyed: n });
}
