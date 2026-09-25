/**
 * runtime/capabilities.ts — capability probes.
 *
 * Remote rendering is only honest when the capability probe is honest: the
 * client reports what it can decode (WebRTC / MSE / hardware decoder) and the
 * session API reports what the server can actually produce (GPU renderer,
 * software renderer, encoder, WebRTC stack). When a piece is missing the
 * runtime falls back to LocalRuntime and reports the real reason instead of
 * pretending remote mode is active.
 */

import type { RuntimeCapabilities } from './types';

export const UNKNOWN_CAPABILITIES: RuntimeCapabilities = {
  webgl2: false,
  gpuRenderer: null,
  hardwareEncode: false,
  rtcSupported: false,
  serverRenderer: 'none',
  serverEncoder: 'none',
  serverRtc: false,
  remoteVideoReason: null,
};

/** browser-side probe (cached after the first call) */
let cachedClient: RuntimeCapabilities | null = null;

export function detectClientCapabilities(): RuntimeCapabilities {
  if (cachedClient) return cachedClient;
  const caps: RuntimeCapabilities = { ...UNKNOWN_CAPABILITIES };
  if (typeof document !== 'undefined') {
    try {
      const canvas = document.createElement('canvas');
      const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
      caps.webgl2 = !!canvas.getContext('webgl2');
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null;
        caps.gpuRenderer = name;
      }
    } catch {
      caps.gpuRenderer = null;
    }
  }
  caps.rtcSupported = typeof RTCPeerConnection !== 'undefined';
  cachedClient = caps;
  return caps;
}

/** ask the browser whether it can decode VP8/VP9 in hardware (used for WebRTC) */
export async function detectHardwareDecode(): Promise<boolean> {
  const nav = navigator as Navigator & {
    mediaCapabilities?: {
      decodingInfo(cfg: unknown): Promise<{ supported: boolean; powerEfficient: boolean }>;
    };
  };
  if (!nav.mediaCapabilities) return false;
  try {
    const info = await nav.mediaCapabilities.decodingInfo({
      type: 'webrtc',
      video: { contentType: 'video/VP8', width: 1280, height: 720, bitrate: 3_000_000, framerate: 60 },
    });
    return !!info.supported;
  } catch {
    return false;
  }
}

export function mergeCapabilities(
  client: RuntimeCapabilities,
  server: Partial<RuntimeCapabilities> | null
): RuntimeCapabilities {
  return { ...client, ...(server ?? {}) };
}

/**
 * Decide whether a remote video path is actually usable, and why not when it
 * is not. Returns the transport to use plus the reason string for the HUD.
 */
export function chooseRemoteTransport(caps: RuntimeCapabilities): {
  transport: 'webrtc' | 'mjpeg' | 'none';
  reason: string | null;
} {
  if (caps.serverRenderer === 'none') {
    return { transport: 'none', reason: 'server renderer unavailable' };
  }
  if (caps.serverEncoder === 'none') {
    return { transport: 'none', reason: 'server video encoder unavailable' };
  }
  if (caps.serverRtc && caps.rtcSupported) return { transport: 'webrtc', reason: null };
  return {
    transport: 'mjpeg',
    reason: caps.serverRtc
      ? 'client WebRTC unsupported — using JPEG stream'
      : 'server has no WebRTC media stack — using JPEG stream',
  };
}
