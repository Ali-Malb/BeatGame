import { NextResponse } from 'next/server';
import { sessionManager } from '@/game/server/SessionManager';
import { deserializeInput } from '@/game/runtime/InputState';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ id: string }>;
}

/** POST normalized remote input at the dedicated high-frequency endpoint. */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const session = sessionManager().get(id);
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const clientId = typeof body.clientId === 'string' && body.clientId ? body.clientId : 'web-client';
  const decoded = deserializeInput(typeof body.state === 'string' ? body.state : JSON.stringify(body.state ?? {}));
  const ack = session.setInput(clientId, decoded.state, decoded.seq, decoded.clientTime || Date.now());
  return NextResponse.json({ ok: true, ack });
}
