import { NextResponse } from 'next/server';
import { hasYtDlp, hasFfmpeg } from '@/lib/yt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const [ytdlp, ffmpeg] = await Promise.all([hasYtDlp(), hasFfmpeg()]);
  return NextResponse.json(
    {
      server: 'ok',
      'yt-dlp': ytdlp ? 'ok' : 'unavailable',
      ffmpeg: ffmpeg ? 'ok' : 'unavailable',
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
