// How tall each bar of the microphone's meter (waves.ts) stands. Levels come in bursts, a
// frame's worth at a time, so each is played on its own 20 ms step, a little behind the newest,
// and every bar follows it where it stands: rising quickly and falling slowly, the middle ones
// reaching highest, each with a lean of its own that changes every few steps, so the bars move
// up and down with the voice and nothing travels across. DOM-free.

/** The time one level stands for. */
export const STEP_MS = 20;
/** The meter plays each level this long after the clock's newest, so a frame that comes a little late still plays its levels in turn. */
export const LAG_MS = 80;
/** Levels that come later than their steps by more than this are after a gap, and play from now. */
const LATE_MS = 120;
/** Levels that come further ahead of the clock than this (a stalled page catching up) play from now, and the ones still waiting are dropped. */
const AHEAD_MS = 250;
/** Past this many waiting levels (a page that stopped drawing), the oldest go. */
const MAX_WAITING = 64;
/** The bars, side by side. */
export const BARS = 9;
/** How quickly a bar rises to a louder level and falls to a quieter one: the time it takes to go most of the way. */
export const RISE_MS = 40;
export const FALL_MS = 140;
/** How many steps a bar keeps its lean before it takes another. */
const LEAN_STEPS = 5;

/** How high each bar reaches at the loudest: the middle all the way, the ends half. */
const REACH = Array.from({ length: BARS }, (_, i) => {
  const off = Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2);
  return 1 - 0.5 * off * off;
});

/** A bar's lean for a stretch of steps, 0.55–1: the same for the same stretch and bar. */
function lean(stretch: number, bar: number): number {
  let x = Math.imul(stretch + 1, 0x9e3779b1) ^ Math.imul(bar + 1, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  x ^= x >>> 13;
  return 0.55 + 0.45 * ((x >>> 0) / 2 ** 32);
}

/** The bars' heights, played from the levels as they come. */
export class WaveMeter {
  private waiting: { at: number; level: number }[] = [];
  private next = -Infinity;
  private step = 0;
  private aims: number[] = new Array<number>(BARS).fill(0);
  private tall: number[] = new Array<number>(BARS).fill(0);
  private then: number | undefined;

  /** A frame's levels, as they came at `now`, each clamped to 0–1. */
  push(levels: readonly number[], now: number): void {
    if (this.next < now - LAG_MS - LATE_MS || this.next > now + AHEAD_MS) {
      this.next = now - LAG_MS;
      this.waiting = [];
    }
    for (const raw of levels) {
      const level = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
      this.waiting.push({ at: this.next, level });
      this.next += STEP_MS;
    }
    if (this.waiting.length > MAX_WAITING) this.waiting.splice(0, this.waiting.length - MAX_WAITING);
  }

  /** Each bar's height at `now`, 0–1, left to right. */
  heights(now: number): number[] {
    const shown = now - LAG_MS;
    let due = 0;
    while (due < this.waiting.length && this.waiting[due]!.at <= shown) this.aim(this.waiting[due++]!.level);
    if (due > 0) this.waiting.splice(0, due);
    const dt = this.then === undefined ? 0 : Math.max(0, now - this.then);
    this.then = now;
    for (let i = 0; i < BARS; i++) {
      const aim = this.aims[i]!;
      const h = this.tall[i]!;
      this.tall[i] = h + (aim - h) * (1 - Math.exp(-dt / (aim > h ? RISE_MS : FALL_MS)));
    }
    return [...this.tall];
  }

  /** Recording stopped: every bar falls back, whatever was still to play. */
  rest(): void {
    this.waiting = [];
    this.aims.fill(0);
  }

  clear(): void {
    this.waiting = [];
    this.next = -Infinity;
    this.step = 0;
    this.aims.fill(0);
    this.tall.fill(0);
    this.then = undefined;
  }

  private aim(level: number): void {
    this.step++;
    // Each bar takes a new lean on steps of its own, so they do not all turn at once.
    for (let i = 0; i < BARS; i++) this.aims[i] = level * REACH[i]! * lean(Math.floor((this.step + i * 3) / LEAN_STEPS), i);
  }
}
