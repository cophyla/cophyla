// The default view's Context overlay, its parts that need no page (model.ts): dollars and rates
// in words; the conversation's spend line by line per model, the cached input apart at its own
// rate, and summed; the next turn's tokens tier by tier against the brain's budgets, and that
// turn's input priced; and the brain's messages a block at a time, each labelled by whose it is
// and what kind: text, a tool call with its input, a result as the model reads it, a picture.

import { describe, expect, test } from "bun:test";
import type { BrainContext, ConversationSpend } from "@cophyla/protocol";
import { contextBlocks, nextTurn, rateWords, spendSummary, tierRows, tokenWords, usdWords } from "../views/default/model.ts";

const THREAD = "thr_01ARZ3NDEKTSV4RRFFQ69G5FB3";
const FLASH = { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 };

const spend: ConversationSpend = {
  thread: THREAD,
  models: [
    { model: "gemini-3.8-flash", calls: 12, since: 1000, last: 2000, tokens: { in: 84_000, out: 2100, cacheRead: 30_000, cacheWrite: 0 }, price: FLASH, cost: 0.050625 },
    { model: "local-thing", calls: 1, since: 500, last: 500, tokens: { in: 10, out: 2, cacheRead: 0, cacheWrite: 4 } },
  ],
  next: { model: "gemini/gemini-3.8-flash", price: FLASH },
};

const context = (over: Partial<BrainContext> = {}): BrainContext => ({
  thread: THREAD,
  at: 1758196800000,
  tokens: { situation: 420, working: 9000, loaded: 0, log: 60, total: 9480, rules: 2300, tools: 3800 },
  budgets: { situation: 2000, working: 8000, loaded: 12000, total: 24000 },
  rules: "You are Cophyla.",
  situation: "Now: Tuesday",
  messages: [],
  tools: ["agents"],
  ...over,
});

describe("view default context", () => {
  test("dollars to the cent, a fraction of a cent to two figures; rates to two places or their first figure; tokens in full", () => {
    expect(usdWords(0)).toBe("$0.00");
    expect(usdWords(0.050625)).toBe("$0.05");
    expect(usdWords(1234.5)).toBe("$1,234.50");
    expect(usdWords(0.0042)).toBe("$0.0042");
    expect(usdWords(0.00031)).toBe("$0.00031");
    expect(rateWords(0.75)).toBe("$0.75");
    expect(rateWords(0.075)).toBe("$0.075");
    expect(rateWords(0.025)).toBe("$0.025");
    expect(rateWords(3.75)).toBe("$3.75");
    expect(rateWords(12)).toBe("$12.00");
    expect(tokenWords(26_325_495.4)).toBe("26,325,495");
  });

  test("the spend line by line: input not cached, input from cache at its own rate, cache writes when any, output; summed with what the cache saved", () => {
    const sum = spendSummary(spend);
    expect(sum.models[0]).toEqual({
      model: "gemini-3.8-flash",
      calls: 12,
      cost: 0.050625,
      // A cached token at a tenth of the input's rate.
      discount: expect.closeTo(0.9, 9),
      lines: [
        { kind: "input", label: "Input, not cached", tokens: 54_000, rate: 0.75, cost: expect.closeTo(0.0405, 9) },
        { kind: "cached", label: "Input, from cache", tokens: 30_000, rate: 0.075, cost: expect.closeTo(0.00225, 9) },
        { kind: "output", label: "Output, with thinking", tokens: 2100, rate: 3.75, cost: expect.closeTo(0.007875, 9) },
      ],
    });
    // A model with no price: its lines carry no rate and no cost, and its calls are counted apart.
    expect(sum.models[1]).toEqual({
      model: "local-thing",
      calls: 1,
      lines: [
        { kind: "input", label: "Input, not cached", tokens: 10 },
        { kind: "cached", label: "Input, from cache", tokens: 0 },
        { kind: "cacheWrite", label: "Cache writes", tokens: 4 },
        { kind: "output", label: "Output, with thinking", tokens: 2 },
      ],
    });
    expect(sum).toMatchObject({ calls: 13, since: 500, cost: 0.050625, unpriced: 1, input: 84_010, cached: 30_000, output: 2102 });
    expect(sum.saved).toBeCloseTo((30_000 * (0.75 - 0.075)) / 1e6, 9);
    // The lines come to the model's cost.
    expect(sum.models[0]!.lines.reduce((n, l) => n + (l.cost ?? 0), 0)).toBeCloseTo(0.050625, 9);
    expect(spendSummary(undefined)).toEqual({ models: [], calls: 0, cost: 0, unpriced: 0, input: 0, cached: 0, output: 0, saved: 0 });
  });

  test("the next turn's tokens: each tier against its budget, the window against its own, the rules and tools on top; a brain from before has no budgets", () => {
    expect(tierRows(context())).toEqual([
      { key: "situation", label: "Situation", tokens: 420, budget: 2000, share: 0.21 },
      { key: "log", label: "Log", tokens: 60, note: "cut to fit the window" },
      { key: "working", label: "Working", tokens: 9000, budget: 8000, share: 1.125 },
      { key: "loaded", label: "Loaded", tokens: 0, budget: 12000, share: 0 },
      { key: "window", label: "Window", tokens: 9480, budget: 24000, share: 0.395 },
      { key: "rules", label: "Rules", tokens: 2300, note: "with every call" },
      { key: "tools", label: "Tools", tokens: 3800, note: "with every call" },
    ]);
    const old = context({ tokens: { situation: 420, working: 9000, loaded: 0, log: 60, total: 9480 } });
    delete old.budgets;
    expect(tierRows(old).map((r) => [r.key, r.budget])).toEqual([["situation", undefined], ["log", undefined], ["working", undefined], ["loaded", undefined], ["window", undefined]]);
  });

  test("the next turn sends the window and the rules and tools, priced at the next model's input rate before any cache", () => {
    expect(nextTurn(context(), spend)).toEqual({ tokens: 15_580, window: 9480, budget: 24000, rate: 0.75, cost: expect.closeTo(0.011685, 9) });
    expect(nextTurn(context(), undefined)).toEqual({ tokens: 15_580, window: 9480, budget: 24000 });
  });

  test("messages a block at a time: text as it is (none when empty), a call with its input, a result or its stub, a picture by kind", () => {
    const blocks = contextBlocks([
      { role: "user", content: [{ type: "text", text: "what is open?" }] },
      { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "c1", name: "tasks", input: { action: "List" } }] },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "c1", content: "[r4 collapsed: tasks List. Say context expand r4 to see it again.]" },
          { type: "tool_result", toolUseId: "c2", content: "no such task", isError: true },
          { type: "image", mime: "image/jpeg", base64: "AAAA" },
        ],
      },
      { role: "assistant", content: [{ type: "tool_use", id: "c3", name: "agents", input: undefined }, { type: "text", text: "" }] },
    ]);
    expect(blocks).toEqual([
      { role: "user", label: "user", text: "what is open?" },
      { role: "assistant", label: "assistant", text: "Looking." },
      { role: "assistant", label: "assistant · calls tasks", text: '{\n  "action": "List"\n}' },
      { role: "user", label: "user · result", text: "[r4 collapsed: tasks List. Say context expand r4 to see it again.]" },
      { role: "user", label: "user · result, an error", text: "no such task" },
      { role: "user", label: "user · picture", text: "[image/jpeg]" },
      { role: "assistant", label: "assistant · calls agents", text: "{}" },
    ]);
    expect(contextBlocks([])).toEqual([]);
  });
});
