// A metric condition watched over a node's samples: "CPU above 90% for 10 s" holds once
// every sample for the last `forS` seconds is past the line, the run of them spanning at
// least `forS`. After a fire it is disarmed until the reading has been back across the line
// by `HYSTERESIS` points for `REARM_SAMPLES` samples in a row, as pressure falls, so a load
// that hovers at the line fires once, not on every sample. A line within `HYSTERESIS` of the
// scale's end (below 96, above 4 and the like) cannot be crossed back that far: such a
// condition re-arms as it fires, and holds again only after another `forS`. A gap in the
// samples longer than `forS` starts the run again. The samples come as fast as `intervalFor`
// asks: five a window, between one and five seconds apart.

import type { MetricCondition, MetricsSample } from "@cophyla/protocol";
import { readings } from "../metrics/pressure.ts";

export const HYSTERESIS = 5;
export const REARM_SAMPLES = 2;

/** How often a condition wants its node sampled: five samples a window, one a second at most, one every five seconds at least. */
export function intervalFor(forS: number): number {
  return Math.min(5000, Math.max(1000, Math.round((forS * 1000) / 5)));
}

export class MetricWatch {
  readonly condition: MetricCondition;
  /** When the run of samples past the line began. */
  private since?: number;
  private lastAt?: number;
  private armed = true;
  private back = 0;

  constructor(condition: MetricCondition) {
    this.condition = condition;
  }

  /** The line the condition names, and which side of it holds. */
  private get line(): { at: number; above: boolean } {
    return this.condition.above !== undefined ? { at: this.condition.above, above: true } : { at: this.condition.below ?? 0, above: false };
  }

  /** Whether the reading can come back across the line by the hysteresis at all. */
  private get rearmable(): boolean {
    const { at, above } = this.line;
    return above ? at - HYSTERESIS > 0 : at + HYSTERESIS < 100;
  }

  /**
   * One sample. Returns the reading when the condition holds and the watch is armed: the
   * caller fires and says so with `fired`, or leaves it armed (a cooldown) to hold again on
   * the next sample.
   */
  offer(sample: MetricsSample): number | undefined {
    const value = readings(sample).find(([r]) => r === this.condition.resource)?.[1];
    if (this.lastAt !== undefined && sample.at - this.lastAt > this.condition.forS * 1000) this.since = undefined;
    this.lastAt = sample.at;
    if (value === undefined) {
      // A node with no GPU reads none: nothing holds.
      this.since = undefined;
      return undefined;
    }
    const { at, above } = this.line;
    const past = above ? value > at : value < at;
    if (!this.armed) {
      const clear = above ? value < at - HYSTERESIS : value > at + HYSTERESIS;
      this.back = clear ? this.back + 1 : 0;
      if (this.back < REARM_SAMPLES) return undefined;
      this.armed = true;
      this.back = 0;
      this.since = undefined;
    }
    if (!past) {
      this.since = undefined;
      return undefined;
    }
    this.since ??= sample.at;
    return sample.at - this.since >= this.condition.forS * 1000 ? value : undefined;
  }

  /** The caller fired: the run starts again, and the watch waits to be re-armed where the line allows it. */
  fired(): void {
    this.since = undefined;
    this.back = 0;
    if (this.rearmable) this.armed = false;
  }
}
