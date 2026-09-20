/**
 * SongResolver — the selected-YouTube-song → song-identity → timed-lyrics
 * pipeline (§6–§9).
 *
 * Selected YouTube video
 *   → parseYouTubeId
 *   → fetchSongMeta (oEmbed via noembed, CORS-open, no key)
 *   → SongMetadata {videoId, title, artist, track, duration}
 *   → fetchLyrics (LRCLIB — legitimate open lyrics API, no key, CORS-open)
 *       Source A  syncedLyrics  → word- or line-level real timestamps
 *       Source B  lyricsfile    → line/word timestamps authored by the source
 *       Plain lyrics without timestamps are rejected as 'unavailable'.
 *   → TimedLyrics (or status 'unavailable' → the UI shows LYRICS UNAVAILABLE)
 *
 * §8/§9: NO invented lyric content, NO bundled copyrighted lyric text, NO
 * substitution from another song. Every fetch is matched on track identity
 * (title/artist/duration) — a mismatch resolves to 'unavailable', which is
 * strictly better than wrong lyrics.
 *
 * buildSongCueSheet(): song-aware rhythm sheet for AudioRhythm/gates — beats
 * and downbeats from the SONG's calibrated BPM + phase, lyric cues from the
 * resolved TimedLyrics, duration = the SONG's duration (not the demo loop).
 */

// ------------------------------------------------------------ lyrics types ----
export interface TimedLyricWord {
  start: number;
  end: number;
  text: string;
}

export interface TimedLyricLine {
  start: number;
  /** when absent the manager uses the next line's start (§8 Source A) */
  end?: number;
  text: string;
  /** word-level timing only when the source actually carries it (§10) */
  words?: TimedLyricWord[];
}

export interface TimedLyrics {
  lines: TimedLyricLine[];
  source:
    | 'lrclib-synced-word'
    | 'lrclib-synced-line'
    | 'unavailable';
}

export interface SongMetadata {
  videoId: string;
  title: string;
  channel: string;
  artist: string;
  track: string;
  /** playback seconds — authoritative once the player reports it */
  duration: number;
  durationResolved: boolean;
}

// ------------------------------------------------------------- youtube url ----
const ID_RE =
  /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([0-9A-Za-z_-]{11})/;

/** accept a full URL, a share link, or a raw 11-char video id */
export function parseYouTubeId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^[0-9A-Za-z_-]{11}$/.test(s)) return s;
  const m = ID_RE.exec(s);
  return m ? m[1] : null;
}

// --------------------------------------------------------------- metadata ----
/** normalization for identity matching — punctuation, casing, noise words */
export function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/\(([^)]*)\)|\[([^\]]*)\]/g, ' ') // (official video), [hd] …
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(official|video|audio|music|mv|lyrics?|hd|4k|remastered|remaster|hq|topic|full|album|version|ver)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split an oEmbed/player title into (artist, track).
 * Handles "Artist - Song", "Artist – Song", "Song by Artist", "Artist "Song""
 * and topic-channel form "Song" (artist from channel). Noise suffixes
 * (Official Video/Audio/… ) are stripped. Purely syntactic — no guessing.
 */
export function splitTitle(title: string, channel: string): { artist: string; track: string } {
  let t = title
    .replace(/\(([^)]*)\)/g, (m, inner: string) => (/official|video|audio|mv|lyric|hd|4k|remaster/i.test(inner) ? ' ' : ` (${inner}) `))
    .replace(/\[([^\]]*)\]/g, ' ')
    .trim();
  let channelArtist = channel
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .trim();

  for (const sep of [' - ', ' – ', ' — ', ' · ']) {
    const i = t.indexOf(sep);
    if (i > 0 && i < t.length - sep.length) {
      return { artist: t.slice(0, i).trim() || channelArtist, track: t.slice(i + sep.length).trim() };
    }
  }
  const by = / by /i.exec(t);
  if (by && by.index > 0) {
    return { artist: t.slice(by.index + 4).trim() || channelArtist, track: t.slice(0, by.index).trim() };
  }
  const quoted = /^["“](.+)["”]$/.exec(t.trim());
  if (quoted) t = quoted[1];
  return { artist: channelArtist, track: t };
}

/** resolve the player title + channel via noembed (CORS-open, no key) */
export async function fetchSongMeta(videoId: string, duration = 0): Promise<SongMetadata> {
  const meta: SongMetadata = {
    videoId,
    title: `YouTube · ${videoId}`,
    channel: '',
    artist: '',
    track: '',
    duration,
    durationResolved: duration > 0,
  };
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(`https://noembed.com/embed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (res.ok) {
      const j = (await res.json()) as { title?: string; author_name?: string; error?: string };
      if (!j.error && j.title) {
        meta.title = j.title;
        meta.channel = j.author_name ?? '';
        const parts = splitTitle(j.title, meta.channel);
        meta.artist = parts.artist;
        meta.track = parts.track;
      }
    }
  } catch {
    // network-less / blocked: identity stays at the id level; never faked
  } finally {
    window.clearTimeout(timer);
  }
  if (!meta.artist || !meta.track) {
    const parts = splitTitle(meta.title, meta.channel);
    meta.artist = parts.artist || meta.artist;
    meta.track = parts.track || meta.track;
  }
  return meta;
}

// ------------------------------------------------------------------ lyrics ----
const LRCLIB = 'https://lrclib.net/api';

/** raw fetched record from LRCLIB */
interface LrcRecord {
  trackName?: string;
  artistName?: string;
  duration?: number;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  lyricsfile?: string | null;
}

/**
 * LRC parser. Supports line tags [mm:ss.xx] and A2 enhanced word tags
 * <mm:ss.xx>. Word timings are ONLY produced when the source actually has
 * them (§10: never pretend word timing exists).
 */
export function parseSynced(lrc: string): { lines: TimedLyricLine[]; anyWords: boolean } {
  const lines: TimedLyricLine[] = [];
  let anyWords = false;
  const lineTag = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of lrc.split(/\r?\n/)) {
    lineTag.lastIndex = 0;
    let m: RegExpExecArray | null;
    let start: number | null = null;
    let lastEnd = 0;
    while ((m = lineTag.exec(raw)) !== null) {
      const t = Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) / Math.pow(10, m[3].length) : 0);
      if (start === null) start = t;
      lastEnd = lineTag.lastIndex;
    }
    if (start === null) continue;
    const body = raw.slice(lastEnd).trim();
    if (!body) continue;

    // A2 enhanced word tags <mm:ss.xx> — words timed ONLY when present
    const wordTag = /<(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
    const segs: { t: number; text: string }[] = [];
    let wm: RegExpExecArray | null;
    let lastTagT = start;
    let lastIdx = 0;
    let hasWordTags = false;
    while ((wm = wordTag.exec(body)) !== null) {
      hasWordTags = true;
      const t = Number(wm[1]) * 60 + Number(wm[2]) + (wm[3] ? Number(wm[3]) / Math.pow(10, wm[3].length) : 0);
      const seg = body.slice(lastIdx, wm.index).trim();
      if (seg) segs.push({ t: lastTagT, text: seg });
      lastTagT = t;
      lastIdx = wm.index + wm[0].length;
    }
    const tail = body.slice(lastIdx).trim();
    if (tail && hasWordTags) segs.push({ t: lastTagT, text: tail });
    const words: TimedLyricWord[] = hasWordTags
      ? segs.map((seg) => ({ start: seg.t, end: seg.t + 1.2, text: seg.text }))
      : [];
    for (let i = 0; i < words.length - 1; i++) words[i].end = words[i + 1].start;
    if (words.length > 0) anyWords = true;
    lines.push({
      start,
      text: body.replace(wordTag, ' ').replace(/\s+/g, ' ').trim(),
      words: words.length > 0 ? words : undefined,
    });
  }
  lines.sort((a, b) => a.start - b.start);
  return { lines, anyWords };
}

/**
 * Parse LRCLIB's Lyricsfile v1 timing subset without pulling a YAML runtime into
 * the client bundle. We only consume the line/word fields needed for the game;
 * text is returned exactly as provided and timestamps remain source-authored.
 */
export function parseLyricsfile(src: string): { lines: TimedLyricLine[]; anyWords: boolean } {
  const lines: TimedLyricLine[] = [];
  let current: TimedLyricLine | null = null;
  let inWords = false;
  let wordIndent = -1;

  const scalar = (value: string): string => {
    const v = value.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
    return v;
  };

  for (const raw of src.split(/\r?\n/)) {
    const indent = raw.match(/^\s*/)?.[0].length ?? 0;
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^lines:\s*$/.test(line)) {
      inWords = false;
      continue;
    }
    const isLineItem = indent <= 2 && /^-\s+text:\s*/.test(line);
    if (isLineItem) {
      const text = scalar(line.replace(/^-\s+text:\s*/, ''));
      current = { start: 0, text };
      lines.push(current);
      inWords = false;
      wordIndent = -1;
      continue;
    }
    if (!current) continue;

    if (/^words:\s*$/.test(line)) {
      inWords = true;
      current.words = [];
      wordIndent = -1;
      continue;
    }
    if (indent <= 2 && /^-\s+/.test(line)) {
      inWords = false;
    }
    if (inWords && indent >= 4 && /^-\s+text:\s*/.test(line)) {
      const text = scalar(line.replace(/^-\s+text:\s*/, ''));
      current.words = current.words ?? [];
      current.words.push({ start: 0, end: 0, text });
      wordIndent = indent;
      continue;
    }
    const start = line.match(/^start_ms:\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (start) {
      const ms = Number(start[1]);
      if (inWords && current.words?.length && wordIndent >= 0 && indent >= wordIndent) current.words[current.words.length - 1].start = ms / 1000;
      else current.start = ms / 1000;
      continue;
    }
    const end = line.match(/^end_ms:\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (end) {
      if (inWords && current.words?.length && wordIndent >= 0 && indent >= wordIndent) current.words[current.words.length - 1].end = Number(end[1]) / 1000;
      else current.end = Number(end[1]) / 1000;
    }
  }

  // Complete only missing word ends from the next source-authored word
  // boundary or the source-authored line end. The final word is omitted from
  // word highlighting when neither boundary exists; its start is still real.
  for (const line of lines) {
    const words = line.words;
    if (!words?.length) continue;
    if (!line.start) line.start = words[0].start;
    for (let i = 0; i < words.length - 1; i++) {
      if (!(words[i].end > words[i].start)) words[i].end = words[i + 1].start;
    }
    if (!(words[words.length - 1].end > words[words.length - 1].start)) {
      if (line.end != null && line.end > words[words.length - 1].start) words[words.length - 1].end = line.end;
      else line.words = words.slice(0, -1);
    }
  }
  lines.splice(0, lines.length, ...lines.filter((l) => l.text && Number.isFinite(l.start)));
  lines.sort((a, b) => a.start - b.start);
  return { lines, anyWords: lines.some((l) => !!l.words?.length) };
}

/** identity match gate — a wrong-song substitution is worse than nothing (§9) */
function identityMatch(rec: LrcRecord, meta: SongMetadata): boolean {
  if (rec.duration != null && meta.durationResolved && Math.abs(rec.duration - meta.duration) > 6) return false;
  const recTrack = normalizeTitle(rec.trackName ?? '');
  const metaTrack = normalizeTitle(meta.track);
  if (!recTrack || !metaTrack) return false;
  // Prefer exact titles; allow containment only for longer qualified forms
  // (feat./remix/live/etc.) so a short title cannot match an unrelated track.
  const shorter = Math.min(recTrack.length, metaTrack.length);
  const longer = Math.max(recTrack.length, metaTrack.length);
  const trackMatch = recTrack === metaTrack || (
    shorter >= 5 && longer > 0 && shorter / longer >= 0.72 &&
    (recTrack.includes(metaTrack) || metaTrack.includes(recTrack))
  );
  if (trackMatch) {
    // When the selected YouTube identity has an artist, a lyric record without
    // an artist is rejected rather than risk a same-title cross-artist match.
    const recArtist = normalizeTitle(rec.artistName ?? '');
    const metaArtist = normalizeTitle(meta.artist);
    if (metaArtist.length > 2) {
      if (recArtist.length <= 2) return false;
      return recArtist.includes(metaArtist) || metaArtist.includes(recArtist);
    }
    return true;
  }
  return false;
}

/**
 * Resolve lyrics for THE selected song. Never invents content; a failed
 * resolution returns source 'unavailable' and the UI shows LYRICS UNAVAILABLE.
 */
export async function fetchLyrics(meta: SongMetadata): Promise<TimedLyrics> {
  if (!meta.track || !meta.artist) return { lines: [], source: 'unavailable' };
  try {
    const params = new URLSearchParams({ track: meta.track, artist: meta.artist });
    if (meta.durationResolved) params.set('duration', String(Math.round(meta.duration)));
    params.set('title', meta.title);
    const res = await fetch(`/api/lyrics?${params.toString()}`, { cache: 'no-store' });
    if (!res.ok) return { lines: [], source: 'unavailable' };
    const payload = (await res.json()) as { records?: LrcRecord[] };
    for (const rec of payload.records ?? []) {
      if (!identityMatch(rec, meta)) continue;
      const out = fromRecord(rec);
      // Plain lyrics are deliberately NOT placed on the musical timeline. There
      // are no source timestamps, so guessing timings would violate sync honesty.
      if (out.source !== 'unavailable') return out;
    }
  } catch {
    // offline / blocked — UI reports LYRICS UNAVAILABLE
  }
  return { lines: [], source: 'unavailable' };
}

function fromRecord(rec: LrcRecord): TimedLyrics {
  // Lyricsfile is the richer representation when present. Prefer its word
  // timing, but do not discard an enhanced-LRC source if that is richer.
  const file = rec.lyricsfile ? parseLyricsfile(rec.lyricsfile) : { lines: [], anyWords: false };
  const synced = rec.syncedLyrics ? parseSynced(rec.syncedLyrics) : { lines: [], anyWords: false };

  const chainEnds = (lines: TimedLyricLine[]) => {
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i].end == null) lines[i].end = lines[i + 1].start - 0.05;
    }
  };

  if (file.anyWords) {
    return { lines: file.lines, source: 'lrclib-synced-word' };
  }
  if (synced.anyWords) {
    chainEnds(synced.lines);
    return { lines: synced.lines, source: 'lrclib-synced-word' };
  }
  if (file.lines.length > 0) {
    return { lines: file.lines, source: 'lrclib-synced-line' };
  }
  if (synced.lines.length > 0) {
    chainEnds(synced.lines);
    return { lines: synced.lines, source: 'lrclib-synced-line' };
  }
  return { lines: [], source: 'unavailable' };
}

/**
 * Resolve a catalog BPM for the exact selected track. This is deliberately
 * metadata-only: it never analyzes or alters the YouTube audio stream. If the
 * external catalog cannot produce a confident match, return null and let the
 * player use tap-tempo calibration rather than guessing a tempo.
 */
export async function fetchSongTempo(meta: SongMetadata): Promise<number | null> {
  if (!meta.track || !meta.artist) return null;
  try {
    const params = new URLSearchParams({ track: meta.track, artist: meta.artist, title: meta.title });
    if (meta.durationResolved) params.set('duration', String(Math.round(meta.duration)));
    const res = await fetch(`/api/song-tempo?${params.toString()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const payload = (await res.json()) as { bpm?: number | null };
    const bpm = Number(payload.bpm);
    return Number.isFinite(bpm) && bpm >= 50 && bpm <= 220 ? bpm : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------- song cue sheet ----
/**
 * Build a song-aware rhythm sheet (§13/§14): beats/downbeats/gates generated
 * from the SONG's calibrated BPM + phase over the SONG's duration, lyric cues
 * from the resolved TimedLyrics. bpm == 0 → no beat cues yet (rhythm disabled
 * until the player calibrates — never a hardcoded fake BPM).
 */
export function buildSongCueSheet(
  meta: SongMetadata,
  lyrics: TimedLyrics | null,
  bpm: number,
  firstBeat: number,
  sectionEnergy: (t: number) => number
): unknown {
  const cues: {
    time: number;
    type: string;
    text?: string;
    energy?: number;
    camera?: 'impact' | 'shake' | 'none';
    preset?: number;
  }[] = [];

  // lyric cues — REAL resolved timestamps for THIS song
  if (lyrics && lyrics.source !== 'unavailable') {
    for (const line of lyrics.lines) {
      cues.push({ time: line.start, type: 'lyric', text: line.text, energy: sectionEnergy(line.start) });
    }
  }

  if (bpm > 0) {
    const beatSec = 60 / bpm;
    const duration = meta.durationResolved ? meta.duration : 480;
    for (let t = firstBeat; t < duration - 0.5; t += beatSec) {
      const k = Math.round((t - firstBeat) / beatSec);
      const isDownbeat = k % 4 === 0;
      const e = sectionEnergy(t);
      cues.push({ time: t, type: isDownbeat ? 'downbeat' : 'beat', energy: e });
      if (isDownbeat && k % 16 === 0) cues.push({ time: t, type: 'bar', energy: e });
      // gates on downbeats (every 4th → every 2nd bar in the back half)
      if (isDownbeat && (t > duration * 0.15 ? k % 8 === 0 : k % 16 === 0)) {
        cues.push({ time: t, type: 'gate', energy: e });
      }
    }
  }

  cues.sort((a, b) => a.time - b.time);
  return {
    track_title: meta.track || meta.title,
    bpm: bpm > 0 ? bpm : 0,
    offset_sec: 0,
    loop_sec: meta.durationResolved ? meta.duration : 480,
    cues,
  };
}
