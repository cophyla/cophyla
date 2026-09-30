// The default view's microphone wave, its meter alone: bars that stay where they are and rise
// and fall with the levels, all together and the middle highest, each level played on its own
// 20 ms step a little behind the newest, rising quickly and falling slowly, a gap playing from
// now, a burst far ahead dropped, and a stop letting every bar fall back. No DOM: the drawing is
// the browser's.

import { describe, expect, test } from "bun:test";
import { BARS, RISE_MS, STEP_MS, WaveMeter } from "../views/default/waveclock.ts";

const MID = (BARS - 1) / 2;

describe("the wave's meter", () => {
  test("a level lifts every bar at once where it stands, the middle highest", () => {
    const m = new WaveMeter();
    expect(m.heights(1000)).toEqual(new Array(BARS).fill(0));
    m.push([1, 1, 1, 1], 1000);
    const hs = m.heights(1000 + 5 * RISE_MS);
    expect(hs).toHaveLength(BARS);
    for (const h of hs) expect(h).toBeGreaterThan(0);
    expect(hs[MID]!).toBeGreaterThan(hs[0]!);
    expect(hs[MID]!).toBeGreaterThan(hs[BARS - 1]!);
  });

  test("a frame's levels play one step apart, the first at once and the next a step on", () => {
    const m = new WaveMeter();
    m.push([0, 1], 1000);
    m.heights(1000);
    expect(m.heights(1000 + STEP_MS - 1)[MID]).toBe(0);
    expect(m.heights(1000 + STEP_MS + 10)[MID]).toBeGreaterThan(0);
  });

  test("the bars rise quickly and fall back slowly", () => {
    const m = new WaveMeter();
    m.push([1], 1000);
    m.heights(1000);
    const up = m.heights(1000 + RISE_MS)[MID]!;
    const full = m.heights(1999)[MID]!;
    expect(up).toBeGreaterThan(full / 2);
    m.push([0], 2000);
    m.heights(2000);
    // As long falling as it took to rise, most of the height is still there.
    expect(m.heights(2000 + RISE_MS)[MID]).toBeGreaterThan(full / 2);
    expect(m.heights(3000)[MID]).toBeLessThan(0.01);
  });

  test("whatever comes, every bar stays within 0 to 1", () => {
    const m = new WaveMeter();
    m.push([7, Number.NaN, -3, Number.POSITIVE_INFINITY, 1, 1], 1000);
    for (let t = 1000; t <= 1400; t += 16) {
      for (const h of m.heights(t)) {
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(1);
      }
    }
  });

  test("after a gap a frame plays from now, on its steps", () => {
    const m = new WaveMeter();
    m.push([0], 1000);
    m.heights(1000);
    // Played on from the old clock, both would be long due and the silent one would show.
    m.push([1, 0], 9000);
    expect(m.heights(9000)[MID]).toBeGreaterThan(0.5);
  });

  test("a burst far ahead of the clock is dropped, and what comes next plays from now", () => {
    const m = new WaveMeter();
    m.push(new Array(40).fill(0), 1000);
    m.push([1, 1], 1000);
    m.heights(1000);
    expect(m.heights(1000 + STEP_MS)[MID]).toBeGreaterThan(0);
  });

  test("when recording stops every bar falls back, whatever was still to play", () => {
    const m = new WaveMeter();
    m.push(new Array(20).fill(1), 1000);
    m.heights(1000);
    expect(m.heights(1200)[MID]).toBeGreaterThan(0.5);
    m.rest();
    expect(m.heights(2000).every((h) => h < 0.01)).toBe(true);
  });
});
