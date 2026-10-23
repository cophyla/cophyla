// The price table: exact, bare and prefix lookups, a newer Claude model as itself, overrides
// over the built-in prices, cost with and without cache prices and with writes kept an hour, a
// model call's cost with its cached part inside its input, a conversation's spend by model, an
// unknown model logged once; and the token counters between samples: llm calls by model,
// session deltas by profile, an ended session once, nothing before priming.

import { describe, expect, test } from "bun:test";
import type { Session } from "@cophyla/protocol";
import { createLogger } from "../src/log.ts";
import { conversationSpend, modelPrice } from "../src/metrics/conversation.ts";
import { BUILTIN_PRICES, completionCost, costOf, priceOf, Pricer, priceTable } from "../src/metrics/prices.ts";
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

  test("a newer Claude model is priced as itself, not as the first of its family its name starts with", () => {
    const table = priceTable();
    expect(priceOf(table, "claude-opus-5-5")).toEqual(BUILTIN_PRICES["anthropic/claude-opus-5-5"]);
    expect(priceOf(table, "claude-opus-5-5[1m]")).toEqual(BUILTIN_PRICES["anthropic/claude-opus-5-5"]);
    expect(priceOf(table, "claude-opus-5-5")!.input).toBe(4);
    expect(priceOf(table, "claude-opus-5")!.input).toBe(5);
    expect(priceOf(table, "claude-fable-5-1")!.cache_read).toBe(0.25);
    expect(priceOf(table, "claude-fable-5")!.cache_read).toBe(1);
    expect(priceOf(table, "claude-sonnet-5-5")).toEqual(BUILTIN_PRICES["anthropic/claude-sonnet-5-5"]);
    expect(priceOf(table, "claude-haiku-5-5")).toEqual(BUILTIN_PRICES["anthropic/claude-haiku-5-5"]);
  });

  test("cache writes kept an hour are priced at the hour's rate, the rest at five minutes', and at five minutes' without an hour's price", () => {
    const opus = BUILTIN_PRICES["anthropic/claude-opus-5-5"]!;
    // 1M written, 600k of it for an hour: 400k × 5 + 600k × 8.
    expect(costOf(opus, { in: 0, out: 0, cacheWrite: 1_000_000, cacheWrite1h: 600_000 })).toBeCloseTo(2 + 4.8, 6);
    expect(costOf(opus, { in: 0, out: 0, cacheWrite: 1_000_000 })).toBeCloseTo(5, 6);
    // An hour's part larger than the whole is held to it.
    expect(costOf(opus, { in: 0, out: 0, cacheWrite: 100, cacheWrite1h: 500 })).toBeCloseTo((100 * 8) / 1e6, 12);
    expect(costOf({ input: 2, output: 10, cache_write: 2.5 }, { in: 0, out: 0, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 })).toBeCloseTo(2.5, 6);
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

  test("a model call's cost takes the cached part out of its input and prices it at the cache's rate", () => {
    const flash = BUILTIN_PRICES["gemini/gemini-3.8-flash"]!;
    // 1M in, 400k of it from cache, 100k out: 600k × 0.75 + 400k × 0.075 + 100k × 3.75.
    expect(completionCost(flash, { in: 1_000_000, out: 100_000, cacheRead: 400_000 })).toBeCloseTo(0.45 + 0.03 + 0.375, 6);
    expect(completionCost(flash, { in: 1_000_000, out: 0 })).toBeCloseTo(0.75, 6);
    // A cache read the input cannot hold is capped at it; no cache price prices it as input.
    expect(completionCost(flash, { in: 100, out: 0, cacheRead: 500 })).toBeCloseTo((100 * 0.075) / 1e6, 12);
    expect(completionCost({ input: 2, output: 4 }, { in: 1_000_000, out: 0, cacheRead: 500_000 })).toBeCloseTo(2, 6);
  });

  test("a conversation's spend: each model priced, the cached part at its rate, an unknown model unpriced, and the next turn's model", () => {
    const thread = "thr_01ARZ3NDEKTSV4RRFFQ69G5FB3";
    const rows = [
      { model: "gemini-3.8-flash", calls: 3, in: 2_000_000, out: 10_000, cacheRead: 1_000_000, cacheWrite: 0, since: 10, last: 30 },
      { model: "acme-local", calls: 1, in: 5, out: 5, cacheRead: 0, cacheWrite: 0, since: 20, last: 20 },
    ];
    const flash = { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 };
    expect(conversationSpend(thread, rows, priceTable(), "gemini/gemini-3.8-flash")).toEqual({
      thread,
      models: [
        { model: "gemini-3.8-flash", calls: 3, since: 10, last: 30, tokens: { in: 2_000_000, out: 10_000, cacheRead: 1_000_000, cacheWrite: 0 }, price: flash, cost: expect.closeTo(0.75 + 0.075 + 0.0375, 9) },
        { model: "acme-local", calls: 1, since: 20, last: 20, tokens: { in: 5, out: 5, cacheRead: 0, cacheWrite: 0 } },
      ],
      next: { model: "gemini/gemini-3.8-flash", price: flash },
    });
    expect(conversationSpend(thread, [], priceTable(), "acme/never")).toEqual({ thread, models: [], next: { model: "acme/never" } });
    expect(conversationSpend(thread, [], priceTable())).toEqual({ thread, models: [] });
    expect(modelPrice({ input: 1, output: 2, cache_read: 0.1 })).toEqual({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 });
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
    // The daemon started before b did (`startedAt` 1).
    spend.prime([session(a, PROFILE_A, { in: 100, out: 50, cacheRead: 1000 }, 1)], 0);
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

  test("nothing is spent before priming: a restart's sessions, their transcripts read again whole, are history", () => {
    const spend = new ProfileSpend();
    const a = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1";
    const b = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB2";
    const c = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB3";
    // As the daemon starts: each live session announced with its whole history, one already ended.
    spend.observe(session(a, PROFILE_A, { in: 5000, out: 900, cacheRead: 2_000_000 }, 1250));
    spend.observe(session(b, PROFILE_B, { in: 70, out: 30 }, 4));
    spend.observe(session(c, PROFILE_B, { in: 10, out: 1 }, 1, "ended"));
    // Primed with the totals as they stand now: a lower reading of a than announced (priced anew) is the baseline.
    spend.prime([session(a, PROFILE_A, { in: 5000, out: 900, cacheRead: 2_000_000 }, 700), session(b, PROFILE_B, { in: 70, out: 30 }, 4)]);
    expect(spend.drain()).toBeUndefined();
    // Spend counts from there: a's growth from 700, b's from where it was announced, and the ended one never.
    spend.observe(session(a, PROFILE_A, { in: 5100, out: 950, cacheRead: 2_100_000 }, 712));
    spend.observe(session(b, PROFILE_B, { in: 70, out: 30 }, 4));
    spend.observe(session(c, PROFILE_B, { in: 20, out: 2 }, 2, "ended"));
    expect(spend.drain()).toEqual({ [PROFILE_A]: { in: 100, out: 50, cached: 100_000, cost: 12 } });
  });

  test("a session resumed under its id after it ended counts on from what it ended with", () => {
    const spend = new ProfileSpend();
    spend.prime([], 0);
    const a = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1";
    spend.observe(session(a, PROFILE_A, { in: 100, out: 10 }, 1));
    spend.observe(session(a, PROFILE_A, { in: 120, out: 12 }, 1.2, "ended"));
    expect(spend.drain()).toEqual({ [PROFILE_A]: { in: 120, out: 12, cached: 0, cost: 1.2 } });
    // Back, its transcript read again and a turn taken: that turn alone is spent, then what follows.
    spend.observe(session(a, PROFILE_A, { in: 150, out: 15 }, 1.5));
    spend.observe(session(a, PROFILE_A, { in: 160, out: 16 }, 1.6));
    expect(spend.drain()).toEqual({ [PROFILE_A]: { in: 40, out: 4, cached: 0, cost: expect.closeTo(0.4, 9) } });
    spend.observe(session(a, PROFILE_A, { in: 160, out: 16 }, 1.6, "ended"));
    spend.observe(session(a, PROFILE_A, { in: 160, out: 16 }, 1.6, "ended"));
    expect(spend.drain()).toBeUndefined();
  });

  test("totals that read lower for a while are not spent again when they climb back: only past the highest", () => {
    const spend = new ProfileSpend();
    spend.prime([], 0);
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

  test("what an ended session's totals climb by after its end is spent: Claude's cost record, read as it leaves", () => {
    const spend = new ProfileSpend();
    spend.prime([], 0);
    const a = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1";
    spend.observe(session(a, PROFILE_A, { in: 100, out: 10 }, 1));
    spend.observe(session(a, PROFILE_A, { in: 100, out: 10 }, 1, "ended"));
    spend.drain();
    spend.observe(session(a, PROFILE_A, { in: 140, out: 12 }, 1.3, "ended"));
    expect(spend.drain()).toEqual({ [PROFILE_A]: { in: 40, out: 2, cached: 0, cost: expect.closeTo(0.3, 9) } });
  });

  test("a session met after priming that started before it counts from what it shows; one closed before it never counts", () => {
    const spend = new ProfileSpend();
    const found = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1";
    const closed = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB2";
    const fresh = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB3";
    spend.prime([], 1000);
    // Running since before the daemon, found late with its whole history: none of it is this run's.
    spend.observe(session(found, PROFILE_A, { in: 5000, out: 500 }, 50));
    // Closed before the daemon started, announced again (higher, priced anew): never.
    spend.observe(session(closed, PROFILE_B, { in: 70, out: 7 }, 3, "ended"));
    spend.observe(session(closed, PROFILE_B, { in: 80, out: 8 }, 4, "ended"));
    expect(spend.drain()).toBeUndefined();
    // Then the found one works on, the closed one is reopened and works, and one starts now.
    spend.observe(session(found, PROFILE_A, { in: 5100, out: 510 }, 51));
    spend.observe(session(closed, PROFILE_B, { in: 80, out: 8 }, 4));
    spend.observe(session(closed, PROFILE_B, { in: 90, out: 9 }, 5));
    spend.observe({ ...session(fresh, PROFILE_B, { in: 20, out: 2 }, 0.2), startedAt: 2000 });
    expect(spend.drain()).toEqual({ [PROFILE_A]: { in: 100, out: 10, cached: 0, cost: 1 }, [PROFILE_B]: { in: 30, out: 3, cached: 0, cost: expect.closeTo(1.2, 9) } });
  });
});
