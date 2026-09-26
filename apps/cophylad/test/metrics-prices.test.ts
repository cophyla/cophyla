// The price table: exact, bare and prefix lookups, overrides over the built-in prices,
// cost with and without cache prices, an unknown model logged once; and the token counters
// between samples: llm calls by model, session deltas by profile, an ended session once.

import { describe, expect, test } from "bun:test";
import type { Session } from "@cophyla/protocol";
import { createLogger } from "../src/log.ts";
import { BUILTIN_PRICES, costOf, priceOf, Pricer, priceTable } from "../src/metrics/prices.ts";
import { LlmCounter, ProfileSpend } from "../src/metrics/tokens.ts";

const PROFILE_A = "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8";
const PROFILE_B = "prof_01ARZ3NDEKTSV4RRFFQ69G5FB9";

describe("metrics prices", () => {
  test("looks a model up exactly, by bare name, then by the longest prefix", () => {
    const table = priceTable();
    expect(priceOf(table, "gemini/gemini-3.8-flash")).toEqual(BUILTIN_PRICES["gemini/gemini-3.8-flash"]);
    expect(priceOf(table, "gemini-3.8-flash")).toEqual(BUILTIN_PRICES["gemini/gemini-3.8-flash"]);
    expect(priceOf(table, "claude-sonnet-5")).toEqual(BUILTIN_PRICES["anthropic/claude-sonnet-5"]);
    expect(priceOf(table, "claude-sonnet-5-20260801")).toEqual(BUILTIN_PRICES["anthropic/claude-sonnet-5"]);
    expect(priceOf(table, "anthropic/claude-opus-5[1m]")).toEqual(BUILTIN_PRICES["anthropic/claude-opus-5"]);
    expect(priceOf(table, "openai/gpt-5.6-terra")).toEqual(BUILTIN_PRICES["openai/gpt-5.6-terra"]);
    expect(priceOf(table, "acme/never")).toBeUndefined();
  });

  test("an override replaces a built-in price, and a bare key stands for every vendor", () => {
    const table = priceTable({ "gemini/gemini-3.8-flash": { input: 1.5, output: 7.5, cache_read: 0.15 }, "my-model": { input: 1, output: 2 } });
    expect(priceOf(table, "gemini/gemini-3.8-flash")).toEqual({ input: 1.5, output: 7.5, cache_read: 0.15 });
    expect(priceOf(table, "local/my-model")).toEqual({ input: 1, output: 2 });
  });

  test("cost is per million, with cache reads priced apart and a missing cache price falling back to input", () => {
    expect(costOf({ input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 }, { in: 1_000_000, out: 100_000, cacheRead: 1_000_000, cacheWrite: 100_000 })).toBeCloseTo(2 + 1 + 0.2 + 0.25, 6);
    expect(costOf({ input: 2, output: 10 }, { in: 0, out: 0, cacheRead: 1_000_000 })).toBeCloseTo(2, 6);
    expect(costOf({ input: 0.75, output: 3.75 }, { in: 12000, out: 900 })).toBeCloseTo(0.009 + 0.003375, 6);
  });

  test("the pricer logs an unknown model once and prices a known one", () => {
    const lines: string[] = [];
    const pricer = new Pricer(priceTable(), createLogger("debug", (l) => lines.push(l)));
    expect(pricer.cost("acme/never", { in: 1, out: 1 })).toBeUndefined();
    expect(pricer.cost("acme/never", { in: 1, out: 1 })).toBeUndefined();
    expect(lines.filter((l) => l.includes("no price")).length).toBe(1);
    expect(pricer.cost("gemini/gemini-3.8-flash", { in: 1_000_000, out: 0 })).toBeCloseTo(0.75, 6);
  });
});

const session = (id: string, profile: string, tokens: { in: number; out: number; cacheRead?: number }, cost = 0, status: Session["status"] = "idle"): Session => ({
  id,
  node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  harness: "claude",
  profile,
  native: { id: "n", transport: "pipe" },
  origin: "user",
  cwd: "/w",
  tags: [],
  status,
  startedAt: 1,
  lastActivity: 2,
  stats: { turns: 1, cost, tokens },
});

describe("metrics token counters", () => {
  test("llm calls sum by model and drain to nothing", () => {
    const c = new LlmCounter();
    expect(c.drain()).toEqual({});
    c.count("gemini/gemini-3.8-flash", { in: 10, out: 2 });
    c.count("gemini/gemini-3.8-flash", { in: 5, out: 1 });
    c.count("anthropic/claude-sonnet-5", { in: 1, out: 1 });
    expect(c.drain()).toEqual({ "gemini/gemini-3.8-flash": { in: 15, out: 3 }, "anthropic/claude-sonnet-5": { in: 1, out: 1 } });
    expect(c.drain()).toEqual({});
  });

  test("session stats are diffed per session and credited to the profile; primed totals are not spend", () => {
    const spend = new ProfileSpend();
    const a = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1";
    const b = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB2";
    spend.prime([session(a, PROFILE_A, { in: 100, out: 50, cacheRead: 1000 }, 1)]);
    expect(spend.drain()).toBeUndefined();
    // The same totals again: nothing new. Then growth: the delta.
    spend.observe(session(a, PROFILE_A, { in: 100, out: 50, cacheRead: 1000 }, 1));
    expect(spend.drain()).toBeUndefined();
    spend.observe(session(a, PROFILE_A, { in: 130, out: 60, cacheRead: 1500 }, 1.25));
    spend.observe(session(b, PROFILE_B, { in: 7, out: 3 }));
    expect(spend.drain()).toEqual({ [PROFILE_A]: { in: 30, out: 10, cached: 500, cost: 0.25 }, [PROFILE_B]: { in: 7, out: 3, cached: 0, cost: 0 } });
    // A session that ended is credited its last delta once; announced ended again, it counts nothing more.
    spend.observe(session(b, PROFILE_B, { in: 9, out: 3 }, 0, "ended"));
    expect(spend.drain()).toEqual({ [PROFILE_B]: { in: 2, out: 0, cached: 0, cost: 0 } });
    spend.observe(session(b, PROFILE_B, { in: 9, out: 3 }, 0, "ended"));
    expect(spend.drain()).toBeUndefined();
  });

  test("totals that read lower for a while are not spent again when they climb back: only past the highest", () => {
    const spend = new ProfileSpend();
    const a = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1";
    spend.observe(session(a, PROFILE_A, { in: 400, out: 40, cacheRead: 300 }, 2));
    expect(spend.drain()).toEqual({ [PROFILE_A]: { in: 400, out: 40, cached: 300, cost: 2 } });
    // Another thread's stats in its place, then its own again, twice over.
    for (let i = 0; i < 2; i++) {
      spend.observe(session(a, PROFILE_A, { in: 30, out: 3, cacheRead: 20 }, 0));
      spend.observe(session(a, PROFILE_A, { in: 400, out: 40, cacheRead: 300 }, 2));
    }
    expect(spend.drain()).toBeUndefined();
    spend.observe(session(a, PROFILE_A, { in: 30, out: 3, cacheRead: 20 }, 0));
    spend.observe(session(a, PROFILE_A, { in: 410, out: 41, cacheRead: 300 }, 2.5));
    expect(spend.drain()).toEqual({ [PROFILE_A]: { in: 10, out: 1, cached: 0, cost: 0.5 } });
  });
});
