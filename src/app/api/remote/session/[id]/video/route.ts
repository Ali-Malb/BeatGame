import { sessionManager } from '@/game/server/SessionManager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BOUNDARY = 'beatgameframe';

/**
 * GET /api/remote/session/:id/video — the server's rendered video stream.
 *
 * Real encoded frames (JPEG, produced by the server-side software renderer and
 * libjpeg) pushed as multipart/x-mixed-replace, which every browser displays in
 * a plain <img>. Frames are produced by the session's own loop, so this stream
 * only observes them — closing it never stops the simulation.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager().get(id);
  if (!session) return new Response('session not found', { status: 404 });

  const encoder = new TextEncoder();
  const signal = req.signal;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) {
        controller.close();
        return;
      }
      const frame = await session.nextFrame(1500);
      if (signal.aborted) {
        closed = true;
        controller.close();
        return;
      }
      if (!frame) {
        // no frame yet: enqueue nothing. A bodyless part would be an invalid
        // multipart chunk and browsers abort the stream on it, so we simply let
        // pull() be called again instead.
        return;
      }
      const header = `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.buffer.byteLength}\r\nX-Seq: ${frame.seq}\r\nX-At: ${frame.at}\r\n\r\n`;
      controller.enqueue(encoder.encode(header));
      controller.enqueue(new Uint8Array(frame.buffer));
      controller.enqueue(encoder.encode('\r\n'));
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
