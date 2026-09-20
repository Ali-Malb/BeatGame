import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LRCLIB_API = 'https://lrclib.net/api';
const CLIENT_ID = 'midnight-runner/0.3';

interface LrclibRecord {
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
  lyricsfile?: string | null;
}

interface SearchParams {
  track: string;
  artist: string;
  title: string;
  duration?: number;
}

function clean(value: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function getParams(request: Request): SearchParams | null {
  const url = new URL(request.url);
  const track = clean(url.searchParams.get('track'));
  const artist = clean(url.searchParams.get('artist'));
  const title = clean(url.searchParams.get('title'));
  const rawDuration = clean(url.searchParams.get('duration'));
  const duration = rawDuration ? Number(rawDuration) : undefined;
  if (!track || !artist) return null;
  if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0 || duration > 24 * 60 * 60)) return null;
  return { track, artist, title, duration };
}

async function fetchRecords(path: string): Promise<LrclibRecord[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${LRCLIB_API}${path}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': `Midnight Runner/0.3 (${CLIENT_ID})`,
        'X-User-Agent': CLIENT_ID,
        'Lrclib-Client': CLIENT_ID,
      },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const payload = await response.json();
    if (Array.isArray(payload)) return payload as LrclibRecord[];
    return payload && typeof payload === 'object' ? [payload as LrclibRecord] : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function encode(params: Record<string, string>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) q.set(key, value);
  return `?${q.toString()}`;
}

export async function GET(request: Request) {
  const params = getParams(request);
  if (!params) {
    return NextResponse.json({ records: [] }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  const exactQuery: Record<string, string> = {
    track_name: params.track,
    artist_name: params.artist,
  };
  if (params.duration !== undefined) exactQuery.duration = String(params.duration);

  let records = await fetchRecords(`/get${encode(exactQuery)}`).catch(() => []);
  if (!records.length) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    records = await fetchRecords(`/search${encode({ track_name: params.track, artist_name: params.artist })}`).catch(() => []);
  }
  if (!records.length && params.title) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    records = await fetchRecords(`/search${encode({ q: params.title })}`).catch(() => []);
  }

  return NextResponse.json(
    { records: records.slice(0, 20) },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
