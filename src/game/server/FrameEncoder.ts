/**
 * server/FrameEncoder.ts — turns raw RGBA frames from the software renderer
 * into a streamable image format.
 *
 * Encoder probe order:
 *   1. sharp (libvips/libjpeg-turbo) — real, native, SIMD-accelerated JPEG
 *   2. none — the session then reports `serverEncoder: 'none'` and the runtime
 *      falls back to LocalRuntime instead of pretending video exists.
 *
 * There is deliberately no WebRTC media encoding here: emitting VP8/H264 needs
 * a codec stack Node does not ship, so `serverRtc` stays false unless a real
 * media bridge is configured (REMOTE_WEBRTC_ENDPOINT).
 */

export type EncoderKind = 'hardware' | 'libjpeg' | 'none';

export interface EncoderInfo {
  kind: EncoderKind;
  name: string | null;
  reason: string | null;
}

export interface FrameEncoder {
  info: EncoderInfo;
  encode(rgba: Uint8Array, width: number, height: number, quality?: number): Promise<Buffer>;
}

interface SharpLike {
  (input: Buffer, options?: unknown): {
    jpeg(opts?: unknown): { toBuffer(): Promise<Buffer> };
  };
}

let cached: FrameEncoder | null = null;
let probed = false;

async function probeSharp(): Promise<SharpLike | null> {
  try {
    const mod = (await import('sharp')) as unknown as { default?: SharpLike } & SharpLike;
    return (mod.default ?? mod) as SharpLike;
  } catch {
    return null;
  }
}

/** probe once per process */
export async function getFrameEncoder(): Promise<FrameEncoder> {
  if (probed && cached) return cached;
  probed = true;
  const sharp = await probeSharp();
  if (!sharp) {
    cached = {
      info: { kind: 'none', name: null, reason: 'no native image encoder available (sharp missing)' },
      encode: async () => {
        throw new Error('no frame encoder available');
      },
    };
    return cached;
  }
  cached = {
    info: { kind: 'libjpeg', name: 'libvips/libjpeg-turbo (sharp)', reason: null },
    encode: async (rgba, width, height, quality = 72) => {
      const buf = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
      return sharp(buf, { raw: { width, height, channels: 4 } })
        .jpeg({ quality, chromaSubsampling: '4:2:0', mozjpeg: false })
        .toBuffer();
    },
  };
  return cached;
}

/** encoder availability without allocating one */
export async function encoderInfo(): Promise<EncoderInfo> {
  const enc = await getFrameEncoder();
  return enc.info;
}
