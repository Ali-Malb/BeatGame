/**
 * scripts/remote-e2e.mjs — REMOTE RUNTIME E2E (Phase 6–13 verification).
 *
 *   REMOTE_URL=http://localhost:3001 node scripts/remote-e2e.mjs
 *
 * Unlike scripts/remote-runtime.test.ts (in-process, no HTTP), this drives the
 * REAL transport stack end to end over HTTP:
 *   1. capability probe (GET /api/remote/session)
 *   2. session create → CONNECTED (POST /api/remote/session)
 *   3. MJPEG video actually carries frames (real multipart parse + JPEG magic)
 *   4. input transport (POST …/input → ack with server timing)
 *   5. SSE snapshot stream (GET …/stream — server state arrives as events)
 *   6. actions (pause/resume/restart/camera)
 *   7. reconnect semantics (disconnect → heartbeat resume)
 *   8. explicit destroy
 *
 * Honesty requirement: video bytes must be real JPEG (FFD8…) frames produced by
 * the server renderer. A refusal (serverRenderer=none / encoder=none) is a PASS
 * for the honesty check, with remote marked UNAVAILABLE + the real reason.
 */
import fs from 'fs';

const BASE = process.env.REMOTE_URL ?? 'http://localhost:3001';
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✔ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
  else { fail++; console.log(`  ✘ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jfetch(path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null }; }
}

/** read an MJPEG multipart stream until N frames or timeout; returns {frames, bytes, contentType} */
async function readMjpeg(path, { maxFrames = 3, timeoutMs = 15000 } = {}) {
  const res = await fetch(`${BASE}${path}`);
  const ct = res.headers.get('content-type') ?? '';
  if (!res.ok || !ct.includes('multipart')) return { ok: false, status: res.status, contentType: ct, frames: [], bytes: 0 };
  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  const frames = [];
  let buf = Buffer.alloc(0);
  const deadline = Date.now() + timeoutMs;
  const scan = () => {
    // extract complete JPEG frames from the accumulated buffer
    for (;;) {
      const start = buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) return;
      const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) return;
      frames.push(buf.subarray(start, end + 2));
      bytes += end + 2 - start;
      buf = buf.subarray(end + 2);
      if (frames.length >= maxFrames) return;
    }
  };
  while (frames.length < maxFrames && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf = Buffer.concat([buf, value]);
    scan();
  }
  try { await reader.cancel(); } catch { /* already done */ }
  return { ok: true, frames, bytes, contentType: ct };
}

/** read an SSE stream until enough snapshot events arrived (or timeout); returns {events, status} */
async function readSse(path, { minSnapshots = 5, timeoutMs = 12000 } = {}) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) return { ok: false, status: res.status, events: {} };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = {};
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  outer: while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const m = chunk.match(/^event: (.+)$/m);
      const d = chunk.match(/^data: (.+)$/m);
      if (m) {
        const name = m[1];
        (events[name] ??= []).push(d ? d[1] : '');
        if ((events.snapshot?.length ?? 0) >= minSnapshots) break outer;
      }
    }
  }
  try { await reader.cancel(); } catch { /* already done */ }
  return { ok: true, events };
}

const inputWire = (steer, throttle) =>
  JSON.stringify({ q: 1, c: Date.now(), s: steer, t: throttle, b: 0, r: 0, k: 0, l: 0 });

async function main() {
  console.log('== 1. capability probe ==');
  const probe = await jfetch('/api/remote/session');
  check('session API reachable', probe.status === 200);
  const caps = probe.json?.capabilities;
  check('capabilities honestly reported', !!caps && typeof caps.serverRenderer === 'string', caps);
  const remotePossible = caps && caps.serverRenderer !== 'none' && caps.serverEncoder !== 'none';
  if (!remotePossible) {
    check('remote honestly unavailable with a reason', !!caps?.remoteVideoReason, caps?.remoteVideoReason);
    console.log(`REMOTE UNAVAILABLE (honest): ${caps?.remoteVideoReason ?? 'unknown reason'}`);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  }

  console.log('== 2. session create (with a real beatmap chart) ==');
  // a chart the e2e authors itself — the same shape the client DSP produces
  // (RemoteSessionPanel uploads game.exportBeatmap() / demoBeatmap())
  const notes = [];
  for (let i = 1; i <= 24; i++) {
    notes.push({ time: i * 0.5, lane: i % 4, type: i % 2 ? 'kick' : 'snare', strength: 0.8, subdivision: 4 });
  }
  const chart = { notes, bpm: 120, duration: 14, firstBeat: 0, beatSec: 0.5, sections: [{ start: 0, end: 14, kind: 'verse', energy: 0.6 }] };
  const created = await jfetch('/api/remote/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: 'remote-e2e',
      countdownSec: 2,
      videoWidth: 320,
      videoHeight: 180,
      chart,
      music: { source: 'none', title: 'e2e', streamUrl: null },
    }),
  });
  check('session created', created.status === 200 && !!created.json?.id, created.status);
  const id = created.json?.id;
  const caps2 = created.json?.capabilities;
  check('create response carries capabilities + snapshot', !!caps2 && !!created.json?.snapshot);
  check('initial snapshot is a countdown', created.json?.snapshot?.state === 'countdown', created.json?.snapshot?.state);

  console.log('== 3. MJPEG video stream ==');
  const t0 = Date.now();
  const video = await readMjpeg(`/api/remote/session/${id}/video`, { maxFrames: 2, timeoutMs: 15000 });
  const videoMs = Date.now() - t0;
  check('video endpoint streams multipart', video.ok && video.contentType.includes('multipart'), video.contentType);
  check('video carries real JPEG frames', video.frames.length >= 1 && video.frames.every((f) => f[0] === 0xff && f[1] === 0xd8), {
    frames: video.frames.length,
    bytes: video.frames[0]?.length ?? 0,
    ms: videoMs,
  });
  const jpegSize = video.frames[0]?.length ?? 0;
  check('video frame is not a stub (sane size)', jpegSize > 1500, jpegSize);

  console.log('== 4. input transport ==');
  const in1 = await jfetch(`/api/remote/session/${id}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'remote-e2e', state: inputWire(0.4, 1) }),
  });
  check('input accepted with server ack', in1.status === 200 && !!in1.json?.ack?.serverTime, in1.json?.ack);
  const status1 = await jfetch(`/api/remote/session/${id}`);
  const vBefore = status1.json?.snapshot?.bike?.v ?? 0;
  await sleep(1500);
  const status2 = await jfetch(`/api/remote/session/${id}`);
  const vAfter = status2.json?.snapshot?.bike?.v ?? 0;
  check('input actually drives the server sim (bike accelerated)', vAfter > Math.max(vBefore, 8), { vBefore: +vBefore.toFixed(1), vAfter: +vAfter.toFixed(1) });

  console.log('== 5. SSE snapshot stream ==');
  // keep throttle held while the stream is read so judgments actually happen
  void jfetch(`/api/remote/session/${id}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'remote-e2e', state: inputWire(0, 1) }),
  });
  const sse = await readSse(`/api/remote/session/${id}/stream`, { minSnapshots: 8, timeoutMs: 15000 });
  check('stream carries hello event', (sse.events.hello?.length ?? 0) >= 1);
  check('stream carries live snapshot events', (sse.events.snapshot?.length ?? 0) >= 8, { count: sse.events.snapshot?.length ?? 0 });
  const lastSnap = sse.events.snapshot?.length ? JSON.parse(sse.events.snapshot.at(-1)) : null;
  check('snapshots carry authoritative scoring', !!lastSnap?.scoring && typeof lastSnap.scoring.hp === 'number', lastSnap?.scoring);
  check('snapshots carry traffic + live gates', (lastSnap?.traffic?.length ?? 0) > 0 && (lastSnap?.gates?.length ?? 0) > 0, {
    traffic: lastSnap?.traffic?.length,
    gates: lastSnap?.gates?.length,
  });
  check('server judged gates on its own clock', (lastSnap?.scoring?.perfects ?? 0) + (lastSnap?.scoring?.goods ?? 0) + (lastSnap?.scoring?.misses ?? 0) > 0, {
    p: lastSnap?.scoring?.perfects,
    g: lastSnap?.scoring?.goods,
    m: lastSnap?.scoring?.misses,
  });
  check('snapshots carry environment + song clock', typeof lastSnap?.songTime === 'number' && !!lastSnap?.environment?.districtName, {
    songTime: lastSnap?.songTime,
    district: lastSnap?.environment?.districtName,
  });

  console.log('== 6. actions ==');
  const pause = await jfetch(`/api/remote/session/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'pause', clientId: 'remote-e2e' }),
  });
  check('pause accepted', pause.status === 200 && pause.json?.state === 'paused', pause.json?.state);
  const tick1 = (await jfetch(`/api/remote/session/${id}`)).json?.tick ?? 0;
  await sleep(400);
  const tick2 = (await jfetch(`/api/remote/session/${id}`)).json?.tick ?? 0;
  check('paused sim stops advancing', tick1 === tick2, { tick1, tick2 });
  const resume = await jfetch(`/api/remote/session/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'resume', clientId: 'remote-e2e' }),
  });
  check('resume accepted', resume.status === 200 && resume.json?.state === 'playing', resume.json?.state);

  console.log('== 7. reconnect semantics ==');
  await jfetch(`/api/remote/session/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'disconnect', clientId: 'remote-e2e' }),
  });
  await sleep(300);
  const reconn = await jfetch(`/api/remote/session/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'connect', clientId: 'remote-e2e' }),
  });
  check('reconnect re-attaches the client', reconn.status === 200 && !!reconn.json?.client, reconn.json?.client);
  check('session capabilities unchanged after reconnect', reconn.json?.capabilities?.serverRenderer === caps2.serverRenderer);

  console.log('== 8. destroy ==');
  const del = await jfetch(`/api/remote/session/${id}`, { method: 'DELETE' });
  check('session destroyed', del.json?.destroyed === true);
  const gone = await jfetch(`/api/remote/session/${id}`);
  check('destroyed session is gone (404)', gone.status === 404, gone.status);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('e2e crashed:', e);
  process.exit(1);
});
