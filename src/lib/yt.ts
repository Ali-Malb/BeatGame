/**
 * yt.ts — yt-dlp helpers used by the /api/search and /api/stream routes.
 *
 * Safety: every external value is passed as a separate argv entry via
 * execFile (no shell, no interpolation of user text).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

export interface YtSearchItem {
  id: string;
  title: string;
  channel: string;
  duration: number;
  thumbnail: string;
}

let ytdlpPath: string | null = null;
let ytdlpCheckedAt = 0;
let ytdlpVersion = '';

function tryPaths(): string[] {
  return ['yt-dlp', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp', `${process.env.HOME ?? ''}/.local/bin/yt-dlp`];
}

/** locate yt-dlp and cache availability for 30 s */
export async function findYtDlp(): Promise<{ path: string; version: string } | null> {
  const now = Date.now();
  if (ytdlpPath && now - ytdlpCheckedAt < 30000) return { path: ytdlpPath, version: ytdlpVersion };
  for (const candidate of tryPaths()) {
    try {
      const { stdout } = await execFileP(candidate, ['--version'], { timeout: 8000, encoding: 'utf8' });
      ytdlpPath = candidate;
      ytdlpVersion = stdout.trim();
      ytdlpCheckedAt = now;
      return { path: ytdlpPath, version: ytdlpVersion };
    } catch {
      // try next candidate
    }
  }
  ytdlpCheckedAt = now;
  return null;
}

export async function hasYtDlp(): Promise<boolean> {
  return (await findYtDlp()) != null;
}

/** ffmpeg presence probe (used by /api/health) */
export async function hasFfmpeg(): Promise<boolean> {
  try {
    await execFileP('ffmpeg', ['-version'], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

interface YtFlatEntry {
  id?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
  thumbnails?: { url?: string; width?: number; preference?: number }[];
  thumbnail?: string;
  view_count?: number;
}

/**
 * YouTube search via yt-dlp's flat extractor. Returns [] on any failure —
 * routes translate that into an explicit error for the client.
 */
export async function searchYouTube(query: string, limit = 12): Promise<YtSearchItem[]> {
  const found = await findYtDlp();
  if (!found) throw new Error('yt-dlp unavailable');
  const bin = found.path;
  const argv = [
    'ytsearch' + Math.max(1, Math.min(20, limit)) + `:${query}`,
    '--dump-json',
    '--flat-playlist',
    '--no-warnings',
    '--quiet',
    '--socket-timeout', '10',
  ];
  const { stdout } = await execFileP(bin, argv, { timeout: 30000, maxBuffer: 24 * 1024 * 1024, encoding: 'utf8' });
  const items: YtSearchItem[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e: YtFlatEntry;
    try {
      e = JSON.parse(line) as YtFlatEntry;
    } catch {
      continue;
    }
    const id = typeof e.id === 'string' ? e.id : '';
    if (!/^[0-9A-Za-z_-]{11}$/.test(id)) continue;
    let thumb = e.thumbnail ?? '';
    if (!thumb && Array.isArray(e.thumbnails) && e.thumbnails.length > 0) {
      const sorted = [...e.thumbnails].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
      thumb = sorted[Math.min(1, sorted.length - 1)]?.url ?? '';
    }
    if (!thumb) thumb = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
    items.push({
      id,
      title: (e.title ?? 'Untitled').slice(0, 200),
      channel: (e.channel ?? e.uploader ?? '').slice(0, 120),
      duration: Math.max(0, Math.round(e.duration ?? 0)),
      thumbnail: thumb,
    });
  }
  return items;
}

export interface YtAudioMeta {
  id: string;
  title: string;
  uploader: string;
  duration: number;
  url: string;
  ext: string;
}

/** resolve the best audio-only stream URL for a video (yt-dlp -f bestaudio -J) */
export async function resolveAudioUrl(id: string): Promise<YtAudioMeta | null> {
  const found = await findYtDlp();
  if (!found) throw new Error('yt-dlp unavailable');
  const bin = found.path;
  if (!/^[0-9A-Za-z_-]{11}$/.test(id)) return null;
  const argv = [
    '-f', 'bestaudio[acodec^=mp4a]/bestaudio/best',
    '--no-warnings', '--no-playlist',
    '--socket-timeout', '12',
    '-J', `https://www.youtube.com/watch?v=${id}`,
  ];
  const { stdout } = await execFileP(bin, argv, { timeout: 30000, maxBuffer: 24 * 1024 * 1024, encoding: 'utf8' });
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
  const url = typeof j.url === 'string' ? j.url : '';
  if (!url) return null;
  return {
    id: typeof j.id === 'string' ? j.id : id,
    title: typeof j.title === 'string' ? j.title : '',
    uploader: typeof j.uploader === 'string' ? j.uploader : typeof j.channel === 'string' ? String(j.channel) : '',
    duration: typeof j.duration === 'number' ? j.duration : 0,
    url,
    ext: typeof j.ext === 'string' ? j.ext : 'm4a',
  };
}
