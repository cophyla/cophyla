// Thresholds with hysteresis: a resource going up crosses `warn` and `critical` at once;
// coming down it must sit below the threshold less `hysteresis` for `holdSamples` readings
// before the level falls, so a load that hovers at the line raises one event, not a stream.
// `update` returns the new level only when it changed, `normal` included.

import type { z } from "zod";
import type { PressureLevel, PressureResource } from "@cophyla/protocol";

export type Level = z.infer<typeof PressureLevel>;
export type Resource = z.infer<typeof PressureResource>;

export interface PressureOptions {
  warn: number;
  critical: number;
  hysteresis?: number;
  holdSamples?: number;
}

const ORDER: Level[] = ["normal", "warn", "critical"];

export class PressureTracker {
  private opts: Required<PressureOptions>;
  private levels = new Map<Resource, Level>();
  /** Consecutive readings below the current level's fall line. */
  private below = new Map<Resource, number>();

  constructor(opts: PressureOptions) {
    this.opts = { hysteresis: 5, holdSamples: 2, ...opts };
  }

  level(resource: Resource): Level {
    return this.levels.get(resource) ?? "normal";
  }

  /** Every resource not at `normal`. */
  raised(): { resource: Resource; level: Level }[] {
    return [...this.levels].filter(([, l]) => l !== "normal").map(([resource, level]) => ({ resource, level }));
  }

  private levelFor(pct: number): Level {
    if (pct >= this.opts.critical) return "critical";
    if (pct >= this.opts.warn) return "warn";
    return "normal";
  }

  private lineOf(level: Level): number {
    return level === "critical" ? this.opts.critical : this.opts.warn;
  }

  update(resource: Resource, pct: number): Level | undefined {
    const current = this.level(resource);
    const target = this.levelFor(pct);
    if (ORDER.indexOf(target) > ORDER.indexOf(current)) {
      this.levels.set(resource, target);
      this.below.set(resource, 0);
      return target;
    }
    if (target === current) {
      this.below.set(resource, 0);
      return undefined;
    }
    // Falling: below the current level's line by the hysteresis, held for enough readings.
    if (pct < this.lineOf(current) - this.opts.hysteresis) {
      const n = (this.below.get(resource) ?? 0) + 1;
      if (n >= this.opts.holdSamples) {
        // Fall one step at a time, so critical → normal passes through warn's own test next reading.
        const next = ORDER[ORDER.indexOf(current) - 1]!;
        const settled = ORDER.indexOf(target) < ORDER.indexOf(next) && pct < this.lineOf(next) - this.opts.hysteresis ? target : next;
        this.levels.set(resource, settled);
        this.below.set(resource, 0);
        return settled;
      }
      this.below.set(resource, n);
      return undefined;
    }
    this.below.set(resource, 0);
    return undefined;
  }
}
