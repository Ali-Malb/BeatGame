/**
 * SongLoader — selected song → decoded AudioBuffer.
 *
 * Sources: a YouTube id (through the same-origin /api/stream proxy, yt-dlp
 * resolved) or a local uploaded file. Decoding uses the live AudioContext so
 * playback can be scheduled on the DSP clock afterwards. All failures surface
 * as typed errors — the game falls back to the demo soundtrack instead of
 * breaking the session.
 */

export type SongLoadErrorCode = 'backend-unavailable' | 'not-found' | 'decode-failed' | 'network' | 'cancelled';

export class SongLoadError extends Error {
  code: SongLoadErrorCode;
  constructor(code: SongLoadErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface LoadProgress {
  phase: 'fetch' | 'decode';
  /** 0..1 (fetch: bytes over content-length; decode: indeterminate → 0..1 by time) */
  fraction: number;
  received: number;
  total: number;
}

export interface LoadedSong {
  buffer: AudioBuffer;
  /** stream title from the proxy headers (YouTube title or filename) */
  title: string;
  channel: string;
  /** decode duration in seconds — authoritative after decodeAudioData */
  duration: number;
  source: 'youtube' | 'upload';
  videoId: string;
}

/** rough human duration for a decoded track (display only) */
export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export class SongLoader {
  private cancelled = false;
  private ctx: AudioContext;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  cancel(): void {
    this.cancelled = true;
  }

  async loadYouTube(
    videoId: string,
    onProgress?: (p: LoadProgress) => void,
  ): Promise<LoadedSong> {
    this.cancelled = false;
    return this.loadFromUrl(`/api/stream?id=${encodeURIComponent(videoId)}`, onProgress, 'youtube', videoId);
  }

  async loadUpload(file: File, onProgress?: (p: LoadProgress) => void): Promise<LoadedSong> {
    this.cancelled = false;
    const body = await this.bufferFile(file, onProgress);
    return this.decodeBuffer(body, file.name.replace(/\.[^.]+$/, '') || 'local upload', 'local upload', 'upload', '', onProgress);
  }

  private async loadFromUrl(
    url: string,
    onProgress: ((p: LoadProgress) => void) | undefined,
    source: 'youtube' | 'upload',
    videoId: string,
  ): Promise<LoadedSong> {
    onProgress?.({ phase: 'fetch', fraction: 0, received: 0, total: 0 });
    let res: Response;
    try {
      res = await fetch(url, { cache: 'no-store' });
    } catch (e) {
      throw new SongLoadError('network', e instanceof Error ? e.message : 'network failure');
    }
    if (this.cancelled) throw new SongLoadError('cancelled', 'load cancelled');
    if (res.status === 503) throw new SongLoadError('backend-unavailable', 'stream backend unavailable (yt-dlp missing?)');
    if (res.status === 404) throw new SongLoadError('not-found', 'no audio stream available for this video');
    if (!res.ok) {
      let detail = '';
      try {
        const j = (await res.json()) as { error?: string };
        detail = j.error ?? '';
      } catch {
        // non-JSON error body
      }
      throw new SongLoadError('network', detail || `stream request failed (${res.status})`);
    }

    const total = Number(res.headers.get('content-length') ?? 0);
    let body: ArrayBuffer;
    if (res.body && total > 0) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (this.cancelled) {
          try {
            void reader.cancel();
          } catch {
            // already closed
          }
          throw new SongLoadError('cancelled', 'load cancelled');
        }
        if (done) break;
        if (value) {
          chunks.push(value);
          received += value.byteLength;
          onProgress?.({ phase: 'fetch', fraction: Math.min(0.99, received / total), received, total });
        }
      }
      const parts = chunks.map((c) => (c instanceof Uint8Array ? c : new Uint8Array(c)));
      const merged = new Uint8Array(received);
      let off = 0;
      for (const c of parts) {
        merged.set(c, off);
        off += c.byteLength;
      }
      body = merged.buffer;
    } else {
      body = await res.arrayBuffer();
      if (this.cancelled) throw new SongLoadError('cancelled', 'load cancelled');
    }

    const title = res.headers.get('X-Song-Title') ?? '';
    const channel = res.headers.get('X-Song-Channel') ?? '';
    return this.decodeBuffer(body, title, channel, source, videoId, onProgress);
  }

  private async bufferFile(file: File, onProgress?: (p: LoadProgress) => void): Promise<ArrayBuffer> {
    onProgress?.({ phase: 'fetch', fraction: 0, received: 0, total: file.size });
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const fr = new FileReader();
      fr.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.({ phase: 'fetch', fraction: Math.min(0.99, e.loaded / e.total), received: e.loaded, total: e.total });
      };
      fr.onload = () => resolve(fr.result as ArrayBuffer);
      fr.onerror = () => reject(new SongLoadError('network', 'could not read file'));
      fr.readAsArrayBuffer(file);
    });
  }

  private async decodeBuffer(
    body: ArrayBuffer,
    title: string,
    channel: string,
    source: 'youtube' | 'upload',
    videoId: string,
    onProgress?: (p: LoadProgress) => void,
  ): Promise<LoadedSong> {
    onProgress?.({ phase: 'decode', fraction: 0.05, received: body.byteLength, total: body.byteLength });
    if (body.byteLength < 1024) {
      throw new SongLoadError('decode-failed', 'audio payload is empty or truncated');
    }
    let buffer: AudioBuffer;
    try {
      // decodeAudioData detaches the buffer; copy so retries are possible
      buffer = await this.ctx.decodeAudioData(body.slice(0));
    } catch {
      throw new SongLoadError('decode-failed', 'browser could not decode this audio (unsupported format or corrupt stream)');
    }
    if (this.cancelled) throw new SongLoadError('cancelled', 'load cancelled');
    if (!buffer || buffer.duration < 5 || !Number.isFinite(buffer.duration)) {
      throw new SongLoadError('decode-failed', 'decoded audio is too short or invalid');
    }
    onProgress?.({ phase: 'decode', fraction: 1, received: body.byteLength, total: body.byteLength });
    return { buffer, title, channel, duration: buffer.duration, source, videoId };
  }
}
