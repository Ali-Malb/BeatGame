import { NextResponse } from 'next/server';
import { resolveAudioUrl } from '@/lib/yt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/stream?id=<11-char video id>
 * Resolves the best audio-only stream via yt-dlp and proxies the bytes so the
 * browser sees a same-origin, browser-compatible audio response.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = (url.searchParams.get('id') ?? '').trim();

  if (!/^[0-9A-Za-z_-]{11}$/.test(id)) {
    return NextResponse.json({ error: 'Invalid video id' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  let meta;
  try {
    meta = await resolveAudioUrl(id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'yt-dlp failed';
    return NextResponse.json({ error: `Stream resolution failed: ${msg}` }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
  if (!meta || !meta.url) {
    return NextResponse.json({ error: 'No audio stream available for this video' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const upstream = await fetch(meta.url, {
      headers: {
        // googlevideo requires the original client context to keep the URL valid
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Referer: 'https://www.youtube.com/',
      },
      redirect: 'follow',
      cache: 'no-store',
    });
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: `Upstream audio fetch failed (${upstream.status})` }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }
    const headers = new Headers({
      'Content-Type': upstream.headers.get('content-type') ?? 'audio/mp4',
      'Cache-Control': 'no-store',
      'X-Song-Title': meta.title.slice(0, 180),
      'X-Song-Channel': meta.uploader.slice(0, 120),
      'Access-Control-Expose-Headers': 'X-Song-Title, X-Song-Channel',
    });
    const len = upstream.headers.get('content-length');
    if (len) headers.set('Content-Length', len);
    return new NextResponse(upstream.body, { status: 200, headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'audio fetch failed';
    return NextResponse.json({ error: `Audio fetch failed: ${msg}` }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
