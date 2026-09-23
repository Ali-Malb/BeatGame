/**
 * trackPosition — THE rhythm-world invariant (§3/§4).
 *
 * A musical note's world position is a PURE FUNCTION of its chart timestamp:
 *
 *     gate.s = trackOrigin + note.time × RHYTHM_SPEED
 *
 * - trackOrigin: the bike's spline coordinate at song t=0 (set once per run).
 * - RHYTHM_SPEED: fixed 240 km/h — the nominal "rhythm pace" of the highway.
 *
 * The result NEVER depends on player speed/acceleration/FPS. The player rides
 * to the beat; the beat does not move to the player. Same song + same chart +
 * same trackOrigin ⇒ same gate position, always.
 */

/** nominal rhythm pace (m/s) — 240 km/h. Players race faster (up to 320) to
 *  bank time and arrive early, or brake and arrive late: that IS the game. */
export const RHYTHM_SPEED = 240 / 3.6;

/** Deterministic track position of a note (m along the spline). */
export function trackPositionFor(noteTime: number, trackOrigin: number): number {
  return trackOrigin + noteTime * RHYTHM_SPEED;
}

/** Inverse: song time at which the bike crosses track coordinate s (if the
 *  bike were riding exactly at the rhythm pace). Debug/telemetry aid. */
export function trackTimeFor(s: number, trackOrigin: number): number {
  return (s - trackOrigin) / RHYTHM_SPEED;
}
