import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEEZER_API = 'https://api.deezer.com';
const USER_AGENT = 'Midnight Runner/0.3';

type DeezerSearchTrack = {
  id?: number;
  title?: string;
  title_short?: string;
  duration?: number;
  artist?: { name?: string };
};

type DeezerSearchResponse = { data?: DeezerSearchTrack[] };
type DeezerTrack = DeezerSearchTrack & { bpm?: number };

function clean(value: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function norm(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(official|video|audio|music|mv|lyrics?|hd|4k|remastered|remaster|hq|topic|full|album|version|ver)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarity(candidate: DeezerSearchTrack, track: string, artist: string, duration?: number): number {
  const ct = norm(candidate.title ?? candidate.title_short ?? '');
  const ca = norm(candidate.artist?.name ?? '');
  const targetT = norm(track);
  const targetA = norm(artist);
  let score = 0;
  if (ct && targetT && (ct === targetT || ct.includes(targetT) || targetT.includes(ct))) score += 5;
  if (ca && targetA && (ca === targetA || ca.includes(targetA) || targetA.includes(ca))) score += 4;
  if (duration && candidate.duration) {
    const delta = Math.abs(candidate.duration - duration);
    if (delta <= 3) score += 4;
    else if (delta <= 8) score += 2;
    else if (delta > 12) score -= 6;
  }
  return score;
}

async function getJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const track = clean(url.searchParams.get('track'));
  const artist = clean(url.searchParams.get('artist'));
  const rawDuration = clean(url.searchParams.get('duration'));
  const duration = rawDuration ? Number(rawDuration) : undefined;
  if (!track || !artist || (duration !== undefined && (!Number.isFinite(duration) || duration <= 0 || duration > 3600))) {
    return NextResponse.json({ bpm: null }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  const q = `artist:"${artist}" track:"${track}"`;
  const search = await getJson<DeezerSearchResponse>(`${DEEZER_API}/search?q=${encodeURIComponent(q)}&limit=10`);
  const candidates = [...(search?.data ?? [])].sort((a, b) => similarity(b, track, artist, duration) - similarity(a, track, artist, duration));
  const best = candidates[0];
  if (!best?.id || similarity(best, track, artist, duration) < 7) {
    return NextResponse.json({ bpm: null }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const detail = await getJson<DeezerTrack>(`${DEEZER_API}/track/${best.id}`);
  const bpm = Number(detail?.bpm);
  if (!Number.isFinite(bpm) || bpm < 50 || bpm > 220) {
    return NextResponse.json({ bpm: null }, { headers: { 'Cache-Control': 'no-store' } });
  }

  return NextResponse.json(
    { bpm: +bpm.toFixed(1), matchedTitle: detail?.title ?? best.title ?? '', matchedArtist: detail?.artist?.name ?? best.artist?.name ?? '' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
