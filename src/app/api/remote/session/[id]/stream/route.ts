import { sessionManager } from '@/game/server/SessionManager';
import type { SimSnapshot } from '@/game/runtime/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/remote/session/:id/stream — authoritative state stream (SSE).
 *
 * The client renders its HUD, judgment popups, biomes and lyric timing from
 * THESE snapshots, so remote mode keeps the server as the source of truth for
 * scoring, combo, HP and rhythm timing while the video is just pixels.
 *
 * The session's simulation loop is independent of this connection: an aborted
 * stream only detaches a listener.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager().get(id);
  if (!session) return new Response('session not found', { status: 404 });

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* client vanished mid-write */
        }
      };
      send('hello', session.snapshot());
      let lastJudgmentTick = -1;
      unsubscribe = session.addSnapshotListener((snap: SimSnapshot) => {
        send('snapshot', snap);
        // judgments are pushed the moment the server records them
        if (snap.judgment && snap.tick !== lastJudgmentTick || (snap.judgment && lastJudgmentTick === -1)) {
          lastJudgmentTick = snap.tick;
          if (snap.judgment) send('judgment', { ...snap.judgment, songTime: snap.songTime });
        }
      });
      keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          /* ignore */
        }
      }, 10_000);
      req.signal.addEventListener('abort', () => {
        unsubscribe?.();
        if (keepAlive) clearInterval(keepAlive);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      unsubscribe?.();
      if (keepAlive) clearInterval(keepAlive);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
