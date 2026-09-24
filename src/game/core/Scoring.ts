/**
 * Scoring — combo/multiplier/HP bookkeeping per the design spec.
 *
 * Multiplier table (exact):
 *   0–9 → 1.00×, 10–19 → 1.10×, 20–39 → 1.20×, 40–59 → 1.30×,
 *   60–79 → 1.40×, 80–99 → 1.50×, 100+ → 2.00×
 */

export const PERFECT_POINTS = 1000;
export const GOOD_POINTS = 500;
export const PERFECT_HP = 1.5; // % of max HP
export const GOOD_HP = 0.5; // %
export const MISS_HP = -4.0; // %
export const CRASH_HP = -25.0; // %

export type Judgment = 'perfect' | 'good' | 'miss';

export function multiplierForCombo(combo: number): number {
  if (combo >= 100) return 2.0;
  if (combo >= 80) return 1.5;
  if (combo >= 60) return 1.4;
  if (combo >= 40) return 1.3;
  if (combo >= 20) return 1.2;
  if (combo >= 10) return 1.1;
  return 1.0;
}

export class Scoring {
  score = 0;
  combo = 0;
  hp = 100;
  perfects = 0;
  goods = 0;
  misses = 0;
  crashes = 0;
  bestCombo = 0;
  invuln = 0; // seconds of post-crash invulnerability
  hpFlash = 0; // > 0 while the HP bar flashes red

  get multiplier(): number {
    return multiplierForCombo(this.combo);
  }

  reset(): void {
    this.score = 0;
    this.combo = 0;
    this.hp = 100;
    this.perfects = 0;
    this.goods = 0;
    this.misses = 0;
    this.crashes = 0;
    this.bestCombo = 0;
    this.invuln = 0;
    this.hpFlash = 0;
  }

  addJudgment(j: Judgment): void {
    if (j === 'perfect') {
      this.score += Math.round(PERFECT_POINTS * this.multiplier);
      this.combo += 1;
      this.hp = Math.min(100, this.hp + PERFECT_HP);
      this.perfects++;
    } else if (j === 'good') {
      this.score += Math.round(GOOD_POINTS * this.multiplier);
      this.combo += 1;
      this.hp = Math.min(100, this.hp + GOOD_HP);
      this.goods++;
    } else {
      this.combo = 0;
      this.hp += MISS_HP;
      this.misses++;
    }
    this.bestCombo = Math.max(this.bestCombo, this.combo);
  }

  /** returns true if the collision damaged the bike (not invulnerable) */
  applyCrash(speedMult: number): boolean {
    if (this.invuln > 0) return false;
    this.invuln = 1.2;
    this.hpFlash = 0.9;
    this.crashes++;
    this.combo = 0;
    this.hp += CRASH_HP;
    return true;
  }

  tick(dt: number): void {
    if (this.invuln > 0) this.invuln -= dt;
    if (this.hpFlash > 0) this.hpFlash -= dt;
  }

  get dead(): boolean {
    return this.hp <= 0;
  }
}
