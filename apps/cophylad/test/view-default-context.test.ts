// The default view's Context overlay and the chat's head, their parts that need no page
// (model.ts): dollars and rates in words; a conversation's spend line by line per model, the
// cached input apart at its own rate, and summed; what the chat's session is told part by
// part, and the context it holds against the size it is folded at; and the chat's head, from
// what the node says of the session the chat runs in: what runs it, where it stands, and its
// terminal where the view may show it.

import { describe, expect, test } from "bun:test";
import type { AssistantState, BrainContext, ConversationSpend, HarnessProfile } from "@cophyla/protocol";
import { apply, canRestartChat, chatDraw, chatHead, chatMode, contextRows, heldContext, initialState, rateWords, spendSummary, tokenWords, usdWords } from "../views/default/model.ts";
import type { ViewState } from "../views/default/model.ts";

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
  tokens: { situation: 420, rules: 2300, tools: 3800, used: 41_000, window: 300_000 },
  rules: "You are Cophyla.",
  situation: "Now: Tuesday",
  notes: [],
  tools: ["agents"],
  ...over,
});

const PROFILE = "prof_01ARZ3NDEKTSV4RRFFQ69G5FB3";

/** A connected view that may open terminals and manage the node, with the account the session runs on. */
function connected(assistant?: AssistantState, scopes: ViewState["scopes"] = ["chat", "terminal", "nodes"]): ViewState {
  const state = initialState();
  state.connected = true;
  state.scopes = scopes;
  state.profiles.set(PROFILE, { id: PROFILE, name: "Work" } as HarnessProfile);
  if (assistant) apply(state, { type: "assistant.state", params: assistant });
  return state;
}

const running: AssistantState = { status: "idle", harness: "claude", profile: PROFILE, model: "sonnet", effort: "low", context: { used: 41_000, limit: 300_000 }, terminal: { host: "h1", id: "t7" } };

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

  test("what the session is told, part by part with when it is said; what it holds against the size it is folded at, none until its harness says", () => {
    expect(contextRows(context())).toEqual([
      { key: "rules", label: "Rules", tokens: 2300, note: "at each start" },
      { key: "tools", label: "Tools", tokens: 3800, note: "at each start" },
      { key: "situation", label: "Situation", tokens: 420, note: "whole at a start, then what changed" },
    ]);
    expect(heldContext(41_000, 300_000)).toEqual({ used: 41_000, limit: 300_000, share: expect.closeTo(0.13667, 4) });
    expect(heldContext(310_000, 300_000)!.share).toBeGreaterThan(1);
    expect(heldContext(undefined, 300_000)).toBeUndefined();
    expect(heldContext(41_000, undefined)).toBeUndefined();
    expect(heldContext(41_000, 0)).toBeUndefined();
  });

  test("the chat's head: the harness, its model and effort, the account in its title, its context and its terminal", () => {
    expect(chatHead(connected(running))).toEqual({
      status: "idle",
      words: "Claude Code · sonnet · low effort",
      title: "The chat runs in a Claude Code session of your own, on the account Work.",
      context: { used: 41_000, limit: 300_000, share: expect.closeTo(0.13667, 4) },
      terminal: "t7",
    });
    // Working: said beside it. A Codex thread has no terminal.
    expect(chatHead(connected({ status: "busy", harness: "codex", model: "gpt-6.1-sol", effort: "low" }))).toEqual({
      status: "busy",
      words: "Codex · gpt-6.1-sol · low effort",
      note: "working",
      title: "The chat runs in a Codex session of your own.",
    });
  });

  test("the chat's head says why nothing answers, and offers no terminal then or to a view that may open none", () => {
    const none = chatHead(connected({ status: "unavailable", detail: "Sign in to one." }))!;
    expect(none).toEqual({ status: "unavailable", words: "No agent", note: "no account signed in", title: "The chat runs in a Claude Code or Codex session of your own. Sign in to one." });
    // Starting again: its terminal is not the one to show.
    expect(chatHead(connected({ ...running, status: "down" }))).toMatchObject({ note: "starting again" });
    expect(chatHead(connected({ ...running, status: "down" }))!.terminal).toBeUndefined();
    expect(chatHead(connected(running, ["chat"]))!.terminal).toBeUndefined();
    // A node that says nothing of a session, or none connected: no head.
    expect(chatHead(connected())).toBeUndefined();
    const gone = connected(running);
    apply(gone, { type: "host.state", params: { connected: false } });
    expect(gone.assistant).toBeUndefined();
    expect(chatHead(gone)).toBeUndefined();
  });

  test("the chat's pane shows the conversation until the user chose the terminal, and only while one can be shown; a change of the session's state redraws no chat item", () => {
    expect(chatMode(undefined, connected(running))).toBe("chat");
    expect(chatMode("terminal", connected(running))).toBe("terminal");
    expect(chatMode("chat", connected(running))).toBe("chat");
    expect(chatMode("terminal", connected({ ...running, status: "starting" }))).toBe("chat");
    expect(chatMode("terminal", connected(running, ["chat"]))).toBe("chat");
    expect(chatDraw({ type: "assistant.state", params: running })).toBe("none");
  });

  test("the chat's session is started again from a view that may manage the node, while the node runs one", () => {
    expect(canRestartChat(connected(running))).toBe(true);
    expect(canRestartChat(connected({ status: "unavailable" }))).toBe(true);
    expect(canRestartChat(connected({ status: "off" }))).toBe(false);
    expect(canRestartChat(connected(running, ["chat", "terminal"]))).toBe(false);
    expect(canRestartChat(connected())).toBe(false);
  });
});
