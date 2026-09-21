import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 40 * 1024 * 1024; // 40 MB — plenty for a 4-min 320 kbps track
const AUDIO_TYPES = /^audio\/(mpeg|mp3|wav|x-wav|wave|ogg|flac|aac|mp4|m4a|webm)/i;

/** POST /api/upload — accept a user MP3/WAV file as multipart form "file" */
export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data with a "file" field' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing "file" field' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `File too large (max ${Math.round(MAX_BYTES / 1024 / 1024)} MB)` }, { status: 413 });
  }
  const type = file.type || '';
  const nameOk = /\.(mp3|wav|ogg|flac|m4a|aac|webm)$/i.test(file.name);
  if (!AUDIO_TYPES.test(type) && !nameOk) {
    return NextResponse.json({ error: `Unsupported file type (${type || 'unknown'}) — use MP3/WAV/OGG/FLAC/M4A` }, { status: 415 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const body = new Uint8Array(buf);
  const ext = (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? 'mp3').toLowerCase();
  const mime = AUDIO_TYPES.test(type) ? type : ext === 'wav' ? 'audio/wav' : 'audio/mpeg';
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(buf.byteLength),
      'X-Song-Title': file.name.replace(/\.[^.]+$/, '').slice(0, 180),
      'X-Song-Channel': 'local upload',
      'Access-Control-Expose-Headers': 'X-Song-Title, X-Song-Channel',
      'Cache-Control': 'no-store',
    },
  });
}
