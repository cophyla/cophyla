// The default view's microphone wave, its clock alone: each level on its own 20 ms step, the
// strip a little behind the newest so a frame's two levels glide in rather than jump, a gap
// starting again at the right edge, a burst far ahead starting again from now, and a level
// past the left edge dropped. No DOM: the drawing is the browser's.

import { describe, expect, test } from "bun:test";
import { LAG_MS, PITCH_PX, STEP_MS, WaveTimeline } from "../views/default/waveclock.ts";

/** CSS pixels a level moves each millisecond: the bar and its gap per step. */
const PER_MS = PITCH_PX / STEP_MS;

describe("the wave's clock", () => {
  test("a frame's levels come in at the right edge one step apart, and slide left on the clock", () => {
    const t = new WaveTimeline();
    t.push([1, 1], 1000);
    // The first stands at the edge at once; the second is a step behind it, still to come.
    expect(t.bars(1000, 400).map((b) => b.x)).toEqual([0]);
    expect(t.bars(1000 + STEP_MS, 400).map((b) => b.x)).toEqual([0, STEP_MS * PER_MS]);
    expect(t.bars(1100, 400).map((b) => b.x)).toEqual([(1100 - LAG_MS - (1000 - LAG_MS + STEP_MS)) * PER_MS, (1100 - 1000) * PER_MS]);
  });

  test("the next frame's levels follow on the same steps, however late it came", () => {
    const t = new WaveTimeline();
    t.push([0.5, 0.5], 1000);
    t.push([0.5, 0.5], 1055);
    const xs = t.bars(1200, 400).map((b) => b.x);
    expect(xs).toHaveLength(4);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeCloseTo(STEP_MS * PER_MS);
  });

  test("levels rise and fall rather than flicker, and stay within 0 to 1", () => {
    const t = new WaveTimeline();
    t.push([1, 0, 7, Number.NaN], 1000);
    const levels = t
      .bars(1200, 400)
      .map((b) => b.level)
      .reverse();
    expect(levels[0]).toBeGreaterThan(0.5);
    expect(levels[0]).toBeLessThan(1);
    // Silence after a loud level keeps some of it.
    expect(levels[1]).toBeGreaterThan(0);
    expect(levels[1]).toBeLessThan(levels[0]!);
    for (const l of levels) expect(l).toBeLessThanOrEqual(1);
  });

  test("after a gap the next level starts again at the right edge; one past the left edge is gone", () => {
    const t = new WaveTimeline();
    t.push([1, 1], 1000);
    t.push([1, 1], 9000);
    const bars = t.bars(9000, 400);
    expect(bars.map((b) => b.x)).toEqual([0]);
    // The old ones went off the strip and were dropped, so a wider strip does not bring them back.
    expect(t.bars(9000, 1e6)).toHaveLength(1);
  });

  test("a burst far ahead of the clock starts again from now", () => {
    const t = new WaveTimeline();
    t.push(new Array(40).fill(0.5), 1000);
    t.push([1, 1], 1000);
    expect(t.bars(1000, 400).map((b) => b.x)).toEqual([0, 0]);
  });
});
