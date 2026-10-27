// The sign-in door's rule, walked as a table: it serves only with a kit that opens a door, no
// daemon attached for the debounce, and the console at the sign-in screen or locked; someone
// who signs in keeps a live stream for the grace and no longer, and no stream means standing
// down at once. And the shim's power rule, mirrored: awake while ready at the sign-in or lock
// screen on mains power, and during any stream.

import { describe, expect, test } from "bun:test";
import { GONE_DEBOUNCE_MS, GRACE_MS } from "../src/door/constants.ts";
import { holdAwake, serveVerdict } from "../src/door/serve.ts";
import type { ServeInputs } from "../src/door/serve.ts";

const T = 1_000_000_000;
const base: ServeInputs = { now: T, refusal: undefined, attached: false, goneSince: T - GONE_DEBOUNCE_MS - 1, console: "signin", serving: false, streaming: false };

describe("serveVerdict", () => {
  test("no one signed in, Cophyla gone past the debounce: serves", () => {
    expect(serveVerdict(base)).toEqual({ serve: true, why: "no one is signed in" });
    expect(serveVerdict({ ...base, console: "locked" }).serve).toBe(true);
  });

  test("a kit that opens no door never serves, whatever the console", () => {
    const v = serveVerdict({ ...base, refusal: "desktop sharing is off on this machine" });
    expect(v).toEqual({ serve: false, why: "desktop sharing is off on this machine" });
  });

  test("a daemon attached means Cophyla runs here: locked or not, the door stands back", () => {
    expect(serveVerdict({ ...base, attached: true, console: "locked" })).toEqual({ serve: false, why: "Cophyla runs here" });
  });

  test("Cophyla gone moments ago: not yet, and when to look again", () => {
    const goneSince = T - 1000;
    const v = serveVerdict({ ...base, goneSince });
    expect(v.serve).toBe(false);
    expect(v).toMatchObject({ why: "Cophyla went moments ago", after: goneSince + GONE_DEBOUNCE_MS });
  });

  test("someone signed in with no stream: stands down at once", () => {
    expect(serveVerdict({ ...base, console: "active", activeSince: T - 1, serving: true, streaming: false })).toEqual({ serve: false, why: "someone is signed in" });
  });

  test("someone signed in through a live stream keeps it for the grace, and no longer", () => {
    const live = { ...base, console: "active" as const, serving: true, streaming: true };
    expect(serveVerdict({ ...live, activeSince: T - GRACE_MS + 1 }).serve).toBe(true);
    expect(serveVerdict({ ...live, activeSince: T - GRACE_MS }).serve).toBe(false);
    // a door that did not serve does not start serving because someone is signed in
    expect(serveVerdict({ ...live, serving: false, activeSince: T - 1 }).serve).toBe(false);
  });

  test("the test timings stand in for the constants", () => {
    expect(serveVerdict({ ...base, goneSince: T - 50, goneMs: 40 }).serve).toBe(true);
    expect(serveVerdict({ ...base, console: "active", activeSince: T - 50, serving: true, streaming: true, graceMs: 40 }).serve).toBe(false);
  });
});

describe("holdAwake", () => {
  test("ready at the sign-in or lock screen on mains power", () => {
    expect(holdAwake({ ready: true, streaming: false, console: "signin", ac: true })).toBe(true);
    expect(holdAwake({ ready: true, streaming: false, console: "locked", ac: true })).toBe(true);
  });
  test("on battery, the power plan decides while idle", () => {
    expect(holdAwake({ ready: true, streaming: false, console: "signin", ac: false })).toBe(false);
  });
  test("a live stream holds it awake on battery too", () => {
    expect(holdAwake({ ready: false, streaming: true, console: "active", ac: false })).toBe(true);
  });
  test("someone working, or a door not ready, holds nothing", () => {
    expect(holdAwake({ ready: true, streaming: false, console: "active", ac: true })).toBe(false);
    expect(holdAwake({ ready: false, streaming: false, console: "signin", ac: true })).toBe(false);
  });
});
