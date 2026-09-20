# Worklog

---
Task ID: 1
Agent: Super Z (main agent)
Task: Build a complete, playable 3D motorcycle traffic-cutting highway game (Shutoko-style liter-bike simulator) as a Next.js web application.

Work Log:
- Initialized fullstack environment (Next.js 16 + TypeScript + Tailwind 4), installed `three@0.180` + `@types/three`.
- Implemented the full game engine under `src/game/` in the requested modular architecture:
  - `core/utils.ts` — math, RNG, framerate-independent damping, canvas helpers.
  - `core/Input.ts` — unified keyboard + gamepad (analog RT/LT triggers, deadzones, edge events, tuck toggle/hold).
  - `core/Game.ts` — GameManager state machine (menu attract / riding / crashing / paused), fixed-substep CCD loop, near-miss scoring + combo (x0.5 steps to x10), crash/respawn sequence (wipeout 1.0 s → fade → clear-lane respawn at 80 km/h), adaptive quality tiers (MSAA/pixelRatio/shadows/mirror-rate), telemetry bridge to React at 12 Hz.
  - `environment/roadSpline.ts` — arc-length parameterized centerline, clamped curvature (R 1200–2600 m → navigable >200 km/h), bridge/overpass planning, rolling elevation.
  - `environment/chunkBuilder.ts` — 100 m merged-geometry chunks: 4-lane deck w/ procedural asphalt + joints texture, median Jersey barrier + anti-glare slats, outer wall + aluminum rail + acoustic panels, staggered streetlamps w/ fake volumetric cones + pools, viaduct pillars, kanji sign gantries, oblique overpasses, suspension-bridge zones (towers, catenary cables, hangers, aviation beacons), emissive window skyline + cranes.
  - `environment/Highway.ts` — chunk streaming (−160/+700 m), dark city ground, passing lit elevated train.
  - `environment/Weather.ts` — 4 presets (Deep Twilight / Starry Night w/ drifting embers / Fiery Golden Hour / Wet Rainy Night) with 2.5 s blending of sky shader (gradient + sun disc + stars + stratus), FogExp2, directional sun w/ shadows, ambient, lamp/window/sign emission, bloom/exposure/grade params, rain LineSegments (layer-1, hidden from mirrors), tire-spray GPU points, PMREM env reflections for wet asphalt.
  - `vehicle/Motorcycle.ts` — road-frame physics: 149 kW power curve, quadratic drag w/ 18 % tuck CdA cut, 299/322 km/h limiter, 6-speed auto box w/ 0.08 s shift cut + 14 200 shift light, 52° lean dynamics w/ gyroscopic rate limit (0.35–0.45 s full swing), curve-neutral lean + counter-steer feel, spring-damper suspension w/ joint impulses (120/130 mm), narrow compound collision footprint, crash tumble + respawn.
  - `vehicle/Dashboard.ts` — diegetic CanvasTexture cluster (16 k tach arc + LED sweep + flashing shift light, LCD speed, gear, combo bar) @30 Hz.
  - `vehicle/BikeAudio.ts` — synthesized crossplane-4 engine (4 oscillator voices crossfaded by RPM band, waveshaper, RPM-tracked filter), limiter gate, overrun backfire bursts, gear whine, wind rush (tuck-muffled), doppler stereo near-miss whoosh (mass-dependent), joint thumps, rain hiss, crash slam.
  - `models/bikeModel.ts` — primitive-built supersport (raked fork group, spinning wheels, clip-ons, stalk mirrors w/ live RT textures, windscreen, exhaust, headlight SpotLight).
  - `models/riderModel.ts` — rigged rider (BFS hoodie back texture, helmet/visor) with analytic two-bone IK arms pinned to grips + legs to pegs, hip shift / knee-out on lean, spine tuck, torso hidden in cockpit.
  - `camera/CameraController.ts` — cockpit (1.40 m eye, tuck slide −0.12/+0.15, 60 % lean roll, FOV 85→105 (150–300 km/h), RPM 40–90 Hz vibration, brake/throttle pitch, wind buffet, 0.02 near clip, 180° look-back) + chase (4.2 m/1.55 m, 12·dt pos smoothing, 8·dt look lag, 17 % roll) + 512×256 real-time mirrors rendered every 2nd frame.
  - `traffic/trafficModels.ts` + `traffic/TrafficManager.ts` — 7 vehicle classes (sedan/coupe/taxi/boxTruck/flatbed/ambulance w/ strobes/bus), 26-object pool, spawn horizon 250–350 m / despawn −60 m, wall-of-cars prevention, lane discipline + 2.5 s signaled lane changes, class-based speeds, brake-light 4× flares, night headlight cones, opposing-carriageway ghosts, swept CCD collision + near-miss/lane-split detection.
  - `fx/PostFX.ts` — EffectComposer (MSAA HalfFloat) → UnrealBloom → custom final pass (quadratic radial speed blur >180 km/h, screen-space rain droplet refraction, saturation/contrast grade, vignette, crash flash, respawn fade) → OutputPass (ACES).
- React shell: `components/GameView.tsx` (start screen w/ audio-unlock gesture, near-miss popups, score/combo, chase-mode minimal speed widget, pause menu w/ weather picker/volume/auto-cycle/help), `app/page.tsx`, metadata, HUD keyframes.
- Verification loop with headless browser + VLM screenshot analysis; fixed: fork assembly origin (dashboard/mirrors/wheel placement), grip IK targets, windscreen occlusion of cluster, cockpit camera height vs rider torso (tank-cam + torso hide), golden-hour sun glare tuning, PMREM sigma warning, real-time adaptive quality.
- Functional verification via dev debug hook: throttle 80→203 km/h, auto gear 3→5, near-miss combo (8 events, x5), forced collision → crash state → 1.55 s respawn at lane center 80 km/h, weather presets 1–4, camera toggle, pause/resume, audio context start, traffic pool (17 active, correct lanes/speeds/kinds).

Stage Summary:
- Deliverable: fully playable 3D liter-bike lane-splitting simulator at `/` (Next.js 16 + three.js, ~5.5k lines, 60 fps target with adaptive quality fallback).
- All acceptance criteria implemented and browser-verified; preview screenshots in `download/`.
- Known environment note: sandbox headless browser uses SwiftShader (software GL) so FPS is low there; real GPUs run at tier-2 quality.

## Second-pass verification (spec re-audit)

Audit conclusion: existing systems retained; four real gaps found and fixed.

Fixes applied:
1. `Game.ts` — loop dt floor 0.05→0.1 s and physics substep cap 8→12 (12×1/120=0.1 s): sim time now tracks real time down to 10 FPS, so the live game no longer slow-mos against the DSP clock (§3/§36/§5).
2. `RhythmGateSpawner.ts` — prediction velocity damp 2.5→6, corrector damp 3→5: gate positions converge to the beat-predicted standoff earlier while still correctable (§5).
3. `TrafficManager.ts` — escape-corridor repair cadence 0.8→0.3 s: arise→relieve latency for convergence-caused walls (§20). Harness corridor audit: violations 5→0, 24 active vehicles.
4. `GameTestHarness.ts` — weather-cut test bug: it cut to the already-active preset (weatherBefore === weatherAfter → false). Now cuts to (active+1)%4. Test passed=true with all six physics fields bit-identical (§23).

Verification results (testartifacts/):
- `acceptance.json` — acceleration: 0–100 3.12 s / 100–200 4.06 s / 200–300 8.72 s, top 298.1 upright / 318.6 tucked (auto-tuck above 220 confirmed as designed; ECU 299/320), shifts 5, redline 14500, limiter 15200, shift cut 70 ms, shift light 14200, lean 52°, full swing 0.408 s, self-right 0.875 s.
- `gate_sim.ts` (bun, offline lockstep sim of real spawner + real physics + real cue sheet): 10/10 gates PERFECT, meanAbsDelta 6 ms, all |delta| ≤ 75 ms (§5). Live in-browser gate judgement is environment-limited (SwiftShader 0.5–8 FPS → sim/music rate mismatch) but the math is DSP-pure and sim-time now equals real time at ≥10 FPS.
- `e2e_driver.mjs` — full ride E2E: no runtime errors; weather hard cuts mid-ride preserve coasting speed/RPM/lean; crash → tumble → respawn completes to 'riding' at 80 km/h in a cleared corridor; screenshots for all 4 presets, cockpit/chase, lean sweeps, tuck, crash/respawn.
- `engineSweep` — 1200→15200 RPM: firing 40→507 Hz, harmonics 20→2533 Hz, gain sum 2.46→3.8, RPM-tracked LP 5.2→12 kHz — continuous tonal pitch/intensity rise (§24/§25/§37).
- `corridor` — 38 windows, 0 violations, spawnFailCorridor 62 (solver refusing walls), 24 vehicles (§20).
- `tsconfig.json` — exclude `examples/` (template leftovers, not part of the game build).
- `Weather.ts` — rain velocity scratch vector reused per frame (was `playerVel.clone()` in hot loop, §35).
- `chunkBuilder.ts` — kanji sign gantries every ~300 m (was ~450 m, §18).

Test tooling (kept per §9's measurement requirement): `scripts/e2e_driver.mjs`, `scripts/gate_probe.mjs`, `scripts/gate_sim.ts`, `src/game/core/GameTestHarness.ts` (window.__gameTest.runAll() in dev).

## Third pass — camera framing, steering sign, wheelie, real-song lyrics

Master prompt fixes (§1–§4, §6–§15, §31–§33). Physics/audio acceptance re-verified headlessly (`scripts/verify.ts`, new dev script `npm run verify`):

1. **Steering inverted (§4)** — root cause: `BikePhysicsModel` lateral entry negated the sign convention (steer +1 documented "left" but road-frame `x +` = LEFT meant D curved left). Fixed once at the physics entry: steer −1 = LEFT, +1 = RIGHT; `rollCmdFromInput = −steer·rate` (rollAngle + = LEFT lean), low-speed bar authority and counter-steer telemetry sign-aligned; low-speed `aLat` handlebar term flipped to `−steer`. Harness `steeringDirection`: A → x +3.61/lean +52°, D → x −3.61/lean −52° (pass); gamepad `gamepadSteer` exported and sign-tested (pass).
2. **Camera framing (§1–§3, §17)** — `CameraController` rewritten with `CAM_CONFIG` (all §3 tunables exposed): rider eye at 1.34 m, z −0.22 (above cluster), tuck slide, lookAheadDist 34, viewDownBias −0.03, FOV 85→105 over 150–300 km/h, lean roll 0.6 (52°→31°), RPM jitter + wind buffet >220, throttle/brake pitch kicks, look-back. Browser e2e: bike ~15–18% of frame (was 40%), cockpit band along the bottom edge, road/traffic/skyline dominate, horizon mid-frame. Chase retuned (§18): 4.6 m behind rear axle, 1.72 m up, road-anchored look target, basePitch −6°.
3. **Wheelie system (§2, §5)** — `BikePhysicsModel`: rear load-transfer traction cap + physical pitch dynamics about the rear contact (MAX_WHEELIE 24°, front-brake ineffective airborne, gravity/brake restore, pitch inertia 250, launch ramp). `BikeController` exposes wheelie + visual front-lift (nose-up rotation about rear contact + chassis rise + fork compression). Camera compensation layer (§2): damped `wheelieComp` cancels 85% of the wheelie pitch (15% genuine movement passes through, damp 5.5/s, never hard-locked); eye rides the chassis rise at 0.5; chase look target rises only 0.25. Harness `wheelie`: peak 24° capped, brakes settle to 0 (pass). Physics targets intact: 0–100 2.83 s / 100–200 3.71 s / 200–300 8.71 s, top 298.8 upright / 319.8 tucked, lean swing 0.408 s, self-right 0.275 s.
4. **Real-song lyric system (§6–§15, §34)** — new `SongResolver` (YouTube id parse incl. share/shorts/embed, noembed oEmbed identity, `splitTitle`/`normalizeTitle`, LRCLIB synced-lyrics resolution with identity gates on track/artist/duration; A2 word timing parsed only when the source carries it; plain lyrics → labeled Source-C reconstruction; NO bundled/substituted/invented text; mismatch → LYRICS UNAVAILABLE) + new `YouTubeSongHost` (hidden IFrame player, ENDED loop, volume/duck, player-clock as song authority). `AudioDspClock` gains epoch control (`setEpochTo`/`nudgeToward`) so song seconds ARE the musical timeline (hardware clock authoritative, soft resync ±0.3 s, hard jump resync; pause/resume re-anchors). `AudioRhythm`/`ParsedCueSheet` song-aware (`loopSec` = song duration; sheet-driven beat/bar sizes; song-mode energy fn). `RhythmGateSpawner.attachRhythm` — gates re-derive from the selected song's calibrated BPM/phase (±75 ms PERFECT unchanged). `KineticLyricManager` upgraded: word-timing mode (true per-word DSP timestamps, greedy token match, no fake staggering), line-only mode (whole-line emphasis, no per-word highlights), demo stagger mode explicitly kept for authored cues only; end chaining; lyric timing still DSP-clock driven. GameManager: `start({songUrl})` session (identity = player-reported title/duration), `swapSongSheet` (lyric cues = resolved timestamps; beats/gates = calibrated BPM), T/Select tap-tempo (median + outlier filter, BPM snap 65–200, popup "BPM x · RHYTHM LOCKED"), gate PERFECT ducks the song so the ping cuts through, demo track/lyrics fully disabled in song mode, telemetry `song` block. React: YouTube URL field on the start screen, LYRICS UNAVAILABLE handling, pause-menu song-identity readout (SONG/ARTIST/YOUTUBE ID/DURATION/BPM/LYRICS/LYRIC SOURCE/AUDIO TIME/CURRENT LYRIC, §33).
5. **Tests (§31–§33)** — `GameTestHarness` adds `steeringDirection` (fails if swapped), `inputDirection`, `wheelie`, `cameraFraming` (live eye/FOV + config readout), `songState`, `resolverChecks` (parse/split/LRC/word-timing/plain layout); `lean()` updated to the corrected convention; `runAll()` includes the new suite. `scripts/verify.ts` = headless run (all PASS; fire Hz 40→507 monotonic).

e2e screenshots (dev preview): cockpit framing confirms §1 targets. Known env note unchanged: sandbox headless browser renders SwiftShader; real GPUs at tier-2.
