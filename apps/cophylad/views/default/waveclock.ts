// Where the microphone's wave (waves.ts) puts each level it is handed. Levels come in bursts,
// a frame's worth at a time, so each is set on its own 20 ms step, and the strip moves on the
// clock a little behind the newest, gliding rather than jumping. DOM-free.

/** The time one level stands for. */
export const STEP_MS = 20;
/** The strip runs this far behind the newest level, so a frame that comes a little late still glides in. */
export const LAG_MS = 80;
/** Levels that come later than their steps by more than this are after a gap, and start again at the right edge. */
const LATE_MS = 120;
/** Levels that come further ahead of the clock than this (a stalled page catching up) start again from now. */
const AHEAD_MS = 250;
/** A bar and the gap after it, in CSS pixels. */
export const PITCH_PX = 5;
/** How much of a level carries into the next, so the bars rise and fall rather than flicker. */
const CARRY = 0.3;

/** Where each level falls on the clock, for as long as it is on the strip. */
export class WaveTimeline {
  private items: { at: number; level: number }[] = [];
  private next = -Infinity;
  private last = 0;

  /** A frame's levels, as they came at `now`, each clamped to 0–1. */
  push(levels: readonly number[], now: number): void {
    // After a gap the next level starts at the right edge; after a burst far ahead, from now.
    if (this.next < now - LAG_MS - LATE_MS || this.next > now + AHEAD_MS) this.next = now - LAG_MS;
    for (const raw of levels) {
      const level = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
      this.last = level * (1 - CARRY) + this.last * CARRY;
      this.items.push({ at: this.next, level: this.last });
      this.next += STEP_MS;
    }
  }

  /**
   * The bars at `now` on a strip `width` pixels wide: each one's distance from the right edge
   * and its level, newest first. Ones gone past the left edge are dropped for good.
   */
  bars(now: number, width: number): { x: number; level: number }[] {
    const shown = now - LAG_MS;
    const perMs = PITCH_PX / STEP_MS;
    const out: { x: number; level: number }[] = [];
    let keepFrom = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i]!;
      if (item.at > shown) continue;
      const x = (shown - item.at) * perMs;
      if (x > width + PITCH_PX) {
        keepFrom = i + 1;
        break;
      }
      out.push({ x, level: item.level });
    }
    if (keepFrom > 0) this.items.splice(0, keepFrom);
    return out;
  }

  clear(): void {
    this.items = [];
    this.next = -Infinity;
    this.last = 0;
  }
}
