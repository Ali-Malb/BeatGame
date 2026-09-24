import { NextResponse } from 'next/server';
import { sessionManager } from '@/game/server/SessionManager';
import { deserializeInput } from '@/game/runtime/InputState';
import type { RuntimeAction } from '@/game/runtime/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ id: string }>;
}

/** GET /api/remote/session/:id — session status + latest authoritative snapshot */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const session = sessionManager().get(id);
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  return NextResponse.json({
    id: session.id,
    state: session.state,
    tick: session.sim.tick,
    clients: session.clientList(),
    videoParams: session.videoParams,
    capabilities: session.capabilitiesSnapshot,
    videoBytes: session.videoBytes,
    snapshot: session.snapshot(),
  });
}

/**
 * POST /api/remote/session/:id — input, heartbeat, signaling and actions.
 *
 * Input arrives as a serialized InputState (the same struct keyboard, gamepad
 * and touch produce locally). The ack carries the server timestamp so the
 * client can measure real input→ack latency.
 */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const session = sessionManager().get(id);
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? '');
  const clientId = typeof body.clientId === 'string' ? body.clientId : 'web-client';

  switch (action) {
    case 'connect':
      return NextResponse.json({ ok: true, client: session.connect(clientId), capabilities: session.capabilitiesSnapshot });
    case 'disconnect':
      session.disconnect(clientId);
      return NextResponse.json({ ok: true });
    case 'heartbeat':
      return NextResponse.json(session.heartbeat(clientId));
    case 'input': {
      const decoded = deserializeInput(typeof body.state === 'string' ? body.state : JSON.stringify(body.state ?? {}));
      const ack = session.setInput(clientId, decoded.state, decoded.seq, decoded.clientTime || Date.now());
      return NextResponse.json({ ok: true, ack });
    }
    case 'signal': {
      const reply = await session.signal(clientId, (body.message ?? { type: 'bye' }) as never);
      return NextResponse.json({ ok: true, reply });
    }
    case 'pause':
    case 'resume':
    case 'restart':
    case 'camera':
    case 'menu':
      session.action({ type: action } as RuntimeAction);
      return NextResponse.json({ ok: true, state: session.state });
    default:
      return NextResponse.json({ error: `unknown action ${action}` }, { status: 400 });
  }
}

/** DELETE /api/remote/session/:id — real session destruction */
export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const ok = sessionManager().destroy(id);
  return NextResponse.json({ destroyed: ok });
}
