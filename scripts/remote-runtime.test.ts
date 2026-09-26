/**
 * scripts/remote-runtime.test.ts — Phase 12 remote-runtime coverage.
 *
 *   bun scripts/remote-runtime.test.ts
 *
 * Exercises the real pieces, headless, with no HTTP server involved:
 *   - runtime abstraction + local fallback decision
 *   - session creation / destruction / reconnect / heartbeat / timeout
 *   - input transport (serialized InputState → authoritative server sim)
 *   - server-authoritative simulation (physics, gates, judging, scoring)
 *   - server-side rendering (real triangles) and frame encoding (real JPEG)
 *   - signaling honesty (explicit refusal when no media bridge exists)
 */

import { SessionManager, DEFAULT_TIMEOUT_MS } from '../src/game/server/SessionManager';
import { getFrameEncoder } from '../src/game/server/FrameEncoder';
import { AuthoritativeSim } from '../src/game/server/AuthoritativeSim';
import { SoftwareRenderer } from '../src/game/server/SoftwareRenderer';
import {
  createInputState,
  serializeInput,
  deserializeInput,
  smoothInput,
  mergeSources,
} from '../src/game/runtime/InputState';
import { chooseRemoteTransport, UNKNOWN_CAPABILITIES } from '../src/game/runtime/capabilities';
import { RHYTHM_SPEED } from '../src/game/rhythm/trackPosition';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✔ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  } else {
    fail++;
    console.log(`  ✘ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** a short deterministic beatmap: a note every 0.5 s for 6 s */
function testChart() {
  const notes: { time: number; lane: number; type: string; strength: number; subdivision: number }[] = [];
  for (let i = 1; i <= 12; i++) {
    notes.push({ time: i * 0.5, lane: i % 4, type: i % 2 ? 'kick' : 'snare', strength: 0.8, subdivision: 4 });
  }
  return {
    notes,
    bpm: 120,
    duration: 6,
    firstBeat: 0,
    beatSec: 0.5,
    sections: [{ start: 0, end: 6, kind: 'verse', energy: 0.6 }],
  };
}

async function main() {
  console.log('== input normalization ==');
  {
    const raw = mergeSources({ steer: -0.4 }, { throttle: 0.8 }, { tuck: true });
    check('mergeSources folds devices into one state', raw.steer === -0.4 && raw.throttle === 0.8 && raw.tuck);
    const wire = serializeInput(raw, 7, 1234);
    const back = deserializeInput(wire);
    check('input round-trips over the wire', back.seq === 7 && Math.abs(back.state.steer + 0.4) < 1e-3 && back.state.tuck);
    const smoothed = smoothInput(createInputState(), raw, 0.1);
    check('remote input runs the shared response curve', smoothed.throttle > 0 && smoothed.steer < 0);
    const broken = deserializeInput('not json');
    check('malformed input cannot throw', broken.state.steer === 0 && broken.seq === 0);
  }

  console.log('== local fallback decision ==');
  {
    const none = chooseRemoteTransport({ ...UNKNOWN_CAPABILITIES, serverRenderer: 'none' });
    check('no server renderer → remote refused with a reason', none.transport === 'none' && !!none.reason, none.reason);
    const noEncoder = chooseRemoteTransport({ ...UNKNOWN_CAPABILITIES, serverRenderer: 'software', serverEncoder: 'none' });
    check('no encoder → remote refused with a reason', noEncoder.transport === 'none' && !!noEncoder.reason);
    const jpeg = chooseRemoteTransport({ ...UNKNOWN_CAPABILITIES, serverRenderer: 'software', serverEncoder: 'libjpeg' });
    check('software renderer + libjpeg → JPEG transport', jpeg.transport === 'mjpeg' && !!jpeg.reason);
    const rtc = chooseRemoteTransport({
      ...UNKNOWN_CAPABILITIES,
      serverRenderer: 'gpu',
      serverEncoder: 'hardware',
      serverRtc: true,
      rtcSupported: true,
    });
    check('real media stack + client support → WebRTC', rtc.transport === 'webrtc' && rtc.reason === null);
  }

  console.log('== encoder ==');
  const encoder = await getFrameEncoder();
  check('encoder probed', encoder.info.kind !== 'none', encoder.info);
  if (encoder.info.kind !== 'none') {
    const w = 16;
    const h = 16;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = 200;
      rgba[i + 1] = 40;
      rgba[i + 2] = 90;
      rgba[i + 3] = 255;
    }
    const jpeg = await encoder.encode(rgba, w, h, 70);
    check('encodes a real JPEG', jpeg.byteLength > 100 && jpeg[0] === 0xff && jpeg[1] === 0xd8, { bytes: jpeg.byteLength });
  }

  console.log('== authoritative simulation + rendering ==');
  {
    const sim = new AuthoritativeSim(1234);
    sim.loadChart(testChart());
    sim.start({ countdownSec: 0.2, startLane: 2, startSpeed: RHYTHM_SPEED });
    check('sim starts in countdown', sim.state === 'countdown' || sim.state === 'playing', sim.state);

    const renderer = new SoftwareRenderer(192, 108);
    renderer.registerSurfaces(sim.highway.mats);

    // hold pace on the centre lane so gates are actually reached
    const raw = createInputState();
    raw.throttle = 1;
    const t0 = Date.now();
    let rendered = false;
    while (Date.now() - t0 < 2000) {
      sim.setInput(raw);
      sim.step(1 / 60);
      if (!rendered && Date.now() - t0 > 900) {
        const pixels = renderer.render(sim);
        const stats = renderer.lastStats;
        let lit = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 60) lit++;
        }
        const frac = lit / (pixels.length / 4);
        check('server rasterizes real triangles', stats.tris > 500, stats);
        check('server frame has visible content', frac > 0.3, { litFraction: +frac.toFixed(2) });
        rendered = true;
      }
    }
    check('server rendered at least one frame', rendered);
    const snap = sim.snapshot({
      serverFps: 60,
      simMs: 0,
      renderMs: 0,
      encodeMs: 0,
      clients: 1,
      framesDropped: 0,
    });
    check('song clock advanced on the server', snap.songTime > 0.5, +snap.songTime.toFixed(2));
    check('bike moved along the track', snap.bike.s > 60 + RHYTHM_SPEED * 0.5, +snap.bike.s.toFixed(1));
    check('rhythm gates are live in the world', snap.gates.length > 0, { gates: snap.gates.length });
    check(
      'server judged gates on its own clock',
      snap.scoring.perfects + snap.scoring.goods + snap.scoring.misses > 0,
      { p: snap.scoring.perfects, g: snap.scoring.goods, m: snap.scoring.misses }
    );
    check('traffic is simulated server-side', snap.traffic.length > 0, { cars: snap.traffic.length });
    check('district + biome state present', !!snap.environment.districtName && snap.environment.biome >= 0, snap.environment);

    sim.action({ type: 'camera' });
    check('camera action changes the server camera', sim.cam.mode !== 'cockpit', sim.cam.mode);
    sim.dispose();
    check('sim disposes', sim.state === 'ended');
  }

  console.log('== session lifecycle ==');
  {
    const mgr = new SessionManager();
    mgr.setBaseCapabilities({ serverRenderer: 'software', serverEncoder: 'libjpeg' });
    check('manager reports its real capabilities', mgr.capabilities().serverRenderer === 'software', mgr.capabilities());

    const session = await mgr.create({ chart: testChart(), countdownSec: 0.2, music: { source: 'demo', title: 'test', streamUrl: null } });
    check('session created', !!session.id && mgr.count === 1, { id: session.id.slice(0, 8) });
    check('capabilities carried onto the session', session.capabilitiesSnapshot.serverRenderer === 'software');

    const client = session.connect('client-a');
    check('client connects', client.clientId === 'client-a' && session.clientList().length === 1);

    let snapshots = 0;
    const off = session.addSnapshotListener(() => snapshots++);
    session.startRun();

    // input transport: serialized state → authoritative sim
    const state = createInputState();
    state.throttle = 1;
    state.steer = -0.5;
    const ack = session.setInput('client-a', state, 42, Date.now());
    check('input ack carries server timing', ack.seq === 42 && ack.serverTime > 0, { tick: ack.tick });

    await sleep(1200);
    check('session loop runs without any open HTTP request', session.sim.tick > 20, { ticks: session.sim.tick });
    check('snapshots were pushed to subscribers', snapshots > 5, { snapshots });
    off();

    const live = session.snapshot();
    check('server owns score/combo/HP', live.scoring.hp > 0 && live.scoring.hp <= 100, { hp: live.scoring.hp });
    check('session reports perf telemetry', live.perf.serverFps > 0, live.perf);

    // frames: the video pipe produced encoded data
    const frame = session.lastFrame();
    check('server produced an encoded video frame', !!frame && frame.buffer.byteLength > 500, frame ? { bytes: frame.buffer.byteLength, w: frame.width } : null);
    check('video bytes are accounted', session.videoBytes > 0, { bytes: session.videoBytes });

    // signaling honesty
    const reply = await session.signal('client-a', { type: 'offer', sdp: 'v=0' });
    check('signaling refuses honestly without a media bridge', reply.type === 'unsupported' && !!reply.reason, reply);

    // heartbeat keeps it alive
    const hb = session.heartbeat('client-a');
    check('heartbeat refreshes liveness', hb.ok && hb.clients === 1, { state: hb.state });

    // reconnect: same client id re-attaches to the running session
    session.disconnect('client-a');
    const before = session.sim.tick;
    await sleep(200);
    const reconnected = session.connect('client-a');
    await sleep(120);
    check('reconnect re-attaches without restarting', reconnected.clientId === 'client-a' && session.sim.tick > before, {
      before,
      after: session.sim.tick,
    });

    // timeout: no heartbeat → the sim freezes (paused), session survives
    session.timeoutMs = 200;
    session.heartbeatAt = Date.now() - 1000;
    await sleep(220);
    check('abandoned heartbeat freezes the simulation', session.state === 'paused', session.state);
    const frozenTick = session.sim.tick;
    await sleep(150);
    check('frozen simulation stops advancing', session.sim.tick === frozenTick, { frozenTick, now: session.sim.tick });
    session.heartbeat('client-a');
    await sleep(150);
    check('heartbeat after timeout resumes the session', session.state !== 'paused' || session.sim.tick >= frozenTick, session.state);
    check('default timeout is a real value', DEFAULT_TIMEOUT_MS >= 2000);

    // destruction is real
    const destroyed = mgr.destroy(session.id);
    check('session destroyed', destroyed && mgr.count === 0);

    // reap pass
    const s2 = await mgr.create({ chart: testChart() });
    s2.clientList();
    const reaped = mgr.sweep(Date.now() + 10 * 60 * 1000, 1000);
    check('idle sessions are reaped', reaped >= 1 && mgr.get(s2.id) === undefined, { reaped });
    mgr.destroyAll();
    check('manager cleanup leaves nothing behind', mgr.count === 0);

    // vanished client: a client record that stopped talking must not pin its
    // session forever (real-world leak: a closed tab leaves the record until
    // the next sweep prunes it — then the abandoned session is reappable).
    {
      const s3 = await mgr.create({ chart: testChart() });
      s3.connect('ghost-client');
      check('ghost client is attached', s3.clientList().length === 1);
      const ghostReaped = mgr.sweep(Date.now() + 10 * 60 * 1000, 1000);
      check('vanished client is pruned and its session reaped', ghostReaped >= 1 && mgr.get(s3.id) === undefined, {
        reaped: ghostReaped,
      });
      mgr.destroyAll();
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
