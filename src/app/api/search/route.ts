import { NextResponse } from 'next/server';
import { searchYouTube, hasYtDlp } from '@/lib/yt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RESERVED = /^\s*(ytsearch|https?:)/i; // raw URLs / nested ytsearch go through stream flow, not search

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') ?? '').replace(/\s+/g, ' ').trim();
  const limitRaw = Number(url.searchParams.get('limit') ?? 12);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(20, Math.floor(limitRaw))) : 12;

  if (!q) {
    return NextResponse.json({ error: 'Missing q', results: [] }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  if (q.length > 120) {
    return NextResponse.json({ error: 'Query too long', results: [] }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  if (!(await hasYtDlp())) {
    return NextResponse.json(
      { error: 'Search backend unavailable: yt-dlp is not installed on the server', results: [] },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const results = await searchYouTube(RESERVED.test(q) ? q.replace(RESERVED, '').trim() || q : q, limit);
    return NextResponse.json({ results }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'search failed';
    return NextResponse.json({ error: `Search failed: ${msg}`, results: [] }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
