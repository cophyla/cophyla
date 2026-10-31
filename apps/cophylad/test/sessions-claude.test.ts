// The Claude Code adapter in pieces: the registry reader, the transcript parser over a
// redacted capture, the hooks installer beside a foreign hook (and beside a copy of this
// machine's real settings), the pipe injector against a pipe the test hosts, and the
// adapter over a fake profile directory: discovery, resume under a new pid, tailing; then
// ending and resuming on evidence: a hook-only session kept for the grace and ended after,
// resumed by its next hook, its process found through the shim's ancestors, a registry still
// showing the ended process ignored, `setStatus` never un-ending, and an exit recording the
// transcript's last lines with a resume recording nothing twice; then a session in a Claude
// directory no profile has: listed under the profile its hooks name, flagged in its timeline
// and once in the log, and moved to its own profile once a restart declares it.
// With [sessions].claude_window_and_effort the stats infer a context window (200K, or 1M for a
// [1m] model, named in the transcript or the profile's settings, or past 200K used) and carry
// the effort each turn ran at.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, SessionEvent } from "@cophyla/protocol";
import { createLogger } from "../src/log.ts";
import { ClaudeAdapter, claudeConfigDirOf, countOn, namesOneMModel, subagentTranscripts } from "../src/sessions/claude/adapter.ts";
import { installClaudeHooks, isCophyladGroup, isOwnGroup, readSettings, uninstallClaudeHooks, withCophyladHooks, withoutCophyladHooks } from "../src/sessions/claude/hooks.ts";
import { claudeFrames, injectClaude } from "../src/sessions/claude/inject.ts";
import { readRegistry, transcriptDirName, transcriptPathFor } from "../src/sessions/claude/registry.ts";
import { applyClaudeCostRecord, applyClaudeRow, applyClaudeUsage, newClaudeState, statsFor } from "../src/sessions/claude/transcript.ts";
import type { ClaudeItem } from "../src/sessions/claude/transcript.ts";
import { clearRegistry, miniSessions, removeSocket, sleep, tempHome, testSocketPath, tomlString, waitFor, writeRegistry } from "./helpers.ts";
import type { Mini } from "./helpers.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "claude-transcript.jsonl");

describe("claude registry", () => {
  test("lists live sessions, ignoring stale keys, dead pids and other files", () => {
    const dir = join(tempHome(), "sessions");
    writeRegistry(dir, { pid: 100, sessionId: "s-100", cwd: "C:\\D\\a" });
    writeRegistry(dir, { pid: 200, sessionId: "s-200", cwd: "C:\\D\\b", keyProcStart: "999" });
    writeRegistry(dir, { pid: 300, sessionId: "s-300", cwd: "C:\\D\\c" });
    writeFileSync(join(dir, "notes.json"), "{}");
    writeFileSync(join(dir, "400.json"), "not json");
    const alive = new Set([100, 200]);
    const live = readRegistry(dir, (pid) => alive.has(pid));
    expect(live.map((l) => l.sessionId)).toEqual(["s-100"]);
    expect(live[0]!.peerToken).toBe("tok-100");
    expect(live[0]!.messagingSocketPath).toBe("\\\\.\\pipe\\LOCAL\\cc-msg-100");
    expect(readRegistry(join(dir, "missing"))).toEqual([]);
  });

  test("accepts the POSIX key shape: a numeric start under one name, a Unix socket path", () => {
    const dir = join(tempHome(), "sessions");
    writeRegistry(dir, { pid: 100, sessionId: "s-100", cwd: "/home/me/a", keyShape: "posix" });
    const live = readRegistry(dir, () => true);
    expect(live.map((l) => [l.sessionId, l.messagingSocketPath, l.procStart, l.peerToken])).toEqual([["s-100", "/tmp/cc-msg-100.sock", "1789657503", "tok-100"]]);
  });

  test("a key with no start value pairs with its entry; a start under either field name still has to match", () => {
    const dir = join(tempHome(), "sessions");
    writeRegistry(dir, { pid: 100, sessionId: "s-100", cwd: "/home/me/a", keyShape: "posix" });
    writeFileSync(join(dir, `100.${"ab".repeat(32)}.key`), JSON.stringify({ peerToken: "bare-100" }));
    writeRegistry(dir, { pid: 200, sessionId: "s-200", cwd: "/home/me/b", keyShape: "posix", keyProcStart: "999" });
    writeRegistry(dir, { pid: 300, sessionId: "s-300", cwd: "C:\\D\\c", keyProcStart: "999" });
    writeFileSync(join(dir, "400.json"), JSON.stringify({ pid: 400, sessionId: "s-400", cwd: "/home/me/d", messagingSocketPath: "/tmp/cc-msg-400.sock" }));
    writeFileSync(join(dir, `400.${"cd".repeat(32)}.key`), JSON.stringify({ peerToken: "tok-400", startTime: 42 }));
    const live = readRegistry(dir, () => true).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    expect(live.map((l) => [l.sessionId, l.peerToken, l.procStart])).toEqual([
      ["s-100", "bare-100", "1789657503"],
      ["s-400", "tok-400", undefined],
    ]);
  });

  test("names the transcript directory the way Claude does", () => {
    expect(transcriptDirName("C:\\D\\orchestrator")).toBe("C--D-orchestrator");
    expect(transcriptDirName("/home/me/src/orchestrator")).toBe("-home-me-src-orchestrator");
    expect(transcriptPathFor("/home/me/.claude", "/home/me/src/orchestrator", "abc")).toBe(join("/home/me/.claude", "projects", "-home-me-src-orchestrator", "abc.jsonl"));
    expect(transcriptPathFor("C:\\Users\\me\\.claude", "C:\\D\\orchestrator\\spikes\\02-permission-hook\\target", "abc")).toBe(
      join("C:\\Users\\me\\.claude", "projects", "C--D-orchestrator-spikes-02-permission-hook-target", "abc.jsonl"),
    );
  });
});

describe("claude transcript parser", () => {
  const state = newClaudeState();
  const items: ClaudeItem[] = [];
  for (const line of readFileSync(FIXTURE, "utf8").split("\n")) {
    if (line.trim()) items.push(...applyClaudeRow(state, JSON.parse(line)));
  }

  test("yields the human turn only, not slash commands, meta rows or task notifications", () => {
    const turns = items.filter((i) => i.kind === "user_turn");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.kind === "user_turn" && turns[0]!.text.startsWith("Use the Write tool")).toBe(true);
    expect(turns[0]!.kind === "user_turn" && turns[0]!.promptId).toBe("d8c6cb36-e8c9-44d3-a3e6-adae59720ae8");
  });

  test("yields the peer turn from cophylad, the tool call and result, the assistant text, titles and modes", () => {
    const kinds = items.map((i) => i.kind);
    expect(kinds).toEqual(["title", "permission_mode", "user_turn", "tool_call", "tool_result", "assistant_text", "queue", "queue", "peer", "permission_mode", "assistant_text"]);
    const call = items.find((i) => i.kind === "tool_call");
    expect(call && call.kind === "tool_call" && call.name).toBe("Write");
    const result = items.find((i) => i.kind === "tool_result");
    expect(result && result.kind === "tool_result" && result.name).toBe("Write");
    expect(result && result.kind === "tool_result" && (result.input as { content: string }).content).toBe("hello");
    const peer = items.find((i) => i.kind === "peer");
    expect(peer && peer.kind === "peer" && peer.from).toBe("cophylad");
    // The session was named, so Claude's own title after it does not replace the name.
    expect(items.filter((i) => i.kind === "title").map((i) => (i as { title: string }).title)).toEqual(["spike-perm-f"]);
    expect(items.filter((i) => i.kind === "permission_mode").map((i) => (i as { mode: string }).mode)).toEqual(["default", "bypassPermissions"]);
  });

  test("Claude's own title names the session until it is renamed, and each rename after that", () => {
    const s = newClaudeState();
    const rows = [
      { type: "ai-title", aiTitle: "Document translations" },
      { type: "custom-title", customTitle: "certification" },
      { type: "ai-title", aiTitle: "Document translations" },
      { type: "custom-title", customTitle: "translation-3" },
      { type: "ai-title", aiTitle: "Document translations" },
    ];
    const titles = rows.flatMap((r) => applyClaudeRow(s, r)).map((i) => (i as { title: string }).title);
    expect(titles).toEqual(["Document translations", "certification", "translation-3"]);
  });

  test("a plan's clear-context row yields the plan's heading, not a turn", () => {
    const s = newClaudeState();
    const row = {
      type: "user",
      origin: { kind: "auto-continuation" },
      planContent: "\n# Rail rework — sessions grouped by folder\n\n## Context\n…",
      message: { role: "user", content: "Implement the following plan:\n\n# Rail rework — sessions grouped by folder\n…" },
      timestamp: "2026-09-27T09:00:00.000Z",
    };
    expect(applyClaudeRow(s, row)).toEqual([{ kind: "plan", heading: "Rail rework — sessions grouped by folder" }]);
    expect(s.stats.turns).toBe(0);
  });

  test("counts usage once per message id and the window from the last message", () => {
    const stats = statsFor(state);
    expect(stats.turns).toBe(1);
    expect(stats.tokens).toEqual({ in: 23, out: 250, cacheRead: 85803, cacheWrite: 6601 });
    expect(stats.cost).toBe(0);
    expect(stats.context).toBeUndefined();
    expect(state.stats.context?.used).toBe(31005);
  });

  const assistant = (id: string, model: string, usage: Record<string, unknown>) => ({ type: "assistant", timestamp: "2026-10-23T05:00:00.000Z", message: { id, model, role: "assistant", content: [], usage } });

  test("prices each model's tokens at its own rates, the cache writes kept an hour apart", () => {
    const s = newClaudeState();
    applyClaudeRow(s, assistant("msg_1", "claude-opus-5-5", { input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 4000, cache_creation: { ephemeral_1h_input_tokens: 3000, ephemeral_5m_input_tokens: 1000 } }));
    // The same message again (another content block of it): counted once.
    applyClaudeRow(s, assistant("msg_1", "claude-opus-5-5", { input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 4000, cache_creation: { ephemeral_1h_input_tokens: 3000, ephemeral_5m_input_tokens: 1000 } }));
    applyClaudeRow(s, assistant("msg_2", "claude-sonnet-5-5", { input_tokens: 20, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000 }));
    expect([...s.byModel]).toEqual([
      ["claude-opus-5-5", { in: 10, out: 1000, cacheRead: 100_000, cacheWrite: 4000, cacheWrite1h: 3000 }],
      ["claude-sonnet-5-5", { in: 20, out: 500, cacheRead: 0, cacheWrite: 2000, cacheWrite1h: 0 }],
    ]);
    const prices: Record<string, number[]> = { "claude-opus-5-5": [4, 20, 0.2, 5, 8], "claude-sonnet-5-5": [2, 10, 0.2, 2.5, 4] };
    const price = (model: string, t: { in: number; out: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number }) => {
      const p = prices[model];
      return p ? (t.in * p[0]! + t.out * p[1]! + t.cacheRead * p[2]! + (t.cacheWrite - t.cacheWrite1h) * p[3]! + t.cacheWrite1h * p[4]!) / 1e6 : undefined;
    };
    const opus = (10 * 4 + 1000 * 20 + 100_000 * 0.2 + 1000 * 5 + 3000 * 8) / 1e6;
    const sonnet = (20 * 2 + 500 * 10 + 2000 * 2.5) / 1e6;
    const stats = statsFor(s, price);
    expect(stats.cost).toBeCloseTo(opus + sonnet, 6);
    expect(stats.tokens).toEqual({ in: 30, out: 1500, cacheRead: 100_000, cacheWrite: 6000 });
    expect(stats.model).toBe("claude-sonnet-5-5");
    // A model with no price adds nothing; without a price the cost is left to the host.
    applyClaudeRow(s, assistant("msg_3", "claude-future-9", { input_tokens: 1_000_000, output_tokens: 0 }));
    expect(statsFor(s, price).cost).toBeCloseTo(opus + sonnet, 6);
    expect(statsFor(s).cost).toBe(0);
  });

  test("a message's later rows add the output its first row had not counted yet, and nothing else", () => {
    const s = newClaudeState();
    const usage = (out: number) => ({ input_tokens: 6, output_tokens: out, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 900, cache_creation: { ephemeral_1h_input_tokens: 900 } });
    // Thinking, then text, then a tool call: one message, its output count growing row by row.
    expect(applyClaudeRow(s, assistant("msg_1", "claude-opus-5-5", usage(8)))).toEqual([]);
    const context = s.stats.context;
    applyClaudeRow(s, assistant("msg_1", "claude-opus-5-5", usage(8)));
    applyClaudeRow(s, assistant("msg_1", "claude-opus-5-5", usage(410)));
    expect(s.statsChanged).toBe(true);
    s.statsChanged = false;
    // A copy with less (a fork's, written before the message ended) changes nothing.
    applyClaudeUsage(s, { ...assistant("msg_1", "claude-opus-5-5", usage(8)), isSidechain: true });
    expect(s.statsChanged).toBe(false);
    expect(s.stats.tokens).toEqual({ in: 6, out: 410, cacheRead: 50_000, cacheWrite: 900 });
    expect(s.byModel.get("claude-opus-5-5")).toEqual({ in: 6, out: 410, cacheRead: 50_000, cacheWrite: 900, cacheWrite1h: 900 });
    expect(s.stats.context).toEqual(context);
  });

  test("Claude's cost record: what it holds beyond the usage counted is kept, the most any record showed", () => {
    const s = newClaudeState();
    const price = (_m: string, t: { in: number; out: number }) => (t.in * 4 + t.out * 20) / 1e6;
    applyClaudeRow(s, assistant("msg_1", "claude-opus-5-5", { input_tokens: 100, output_tokens: 1000 }));
    expect(s.settled).toBe(false);
    const counted = (100 * 4 + 1000 * 20) / 1e6;
    const record = (total: number, input: number) => ({ type: "cost-state", totalCostUSD: total, modelUsage: { "claude-opus-5-5": { inputTokens: input, outputTokens: 1000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: total } } });
    // The parser alone counts no record: its row yields nothing.
    expect(applyClaudeRow(s, record(1, 1))).toEqual([]);
    expect(applyClaudeCostRecord(s, record(counted + 0.1, 600), price)).toBe(true);
    expect(s.settled).toBe(true);
    expect(statsFor(s, price).cost).toBeCloseTo(counted + 0.1, 6);
    expect(statsFor(s, price).tokens).toEqual({ in: 600, out: 1000 });
    // Unpriced, the record's cost is left out, its tokens not.
    expect(statsFor(s).cost).toBe(0);
    // Lower (its totals not restored on a resume): nothing taken back, and its counts add nothing either.
    expect(applyClaudeCostRecord(s, record(0.001, 99_999), price)).toBe(false);
    expect(statsFor(s, price).cost).toBeCloseTo(counted + 0.1, 6);
    expect(statsFor(s, price).tokens).toEqual({ in: 600, out: 1000 });
    // Usage after it: no longer settled; a later record counts on top of all of it.
    applyClaudeRow(s, assistant("msg_2", "claude-opus-5-5", { input_tokens: 0, output_tokens: 1000 }));
    expect(s.settled).toBe(false);
    expect(applyClaudeCostRecord(s, record(counted + 0.02 + 0.3, 600), price)).toBe(true);
    expect(statsFor(s, price).cost).toBeCloseTo(counted + 0.02 + 0.3, 6);
    expect(applyClaudeCostRecord(s, { type: "cost-state", totalCostUSD: "x" }, price)).toBe(false);
  });

  test("a sub-agent's rows add their usage alone, and a fork's copy of the message it came from is not counted again", () => {
    const s = newClaudeState();
    applyClaudeRow(s, { type: "user", timestamp: "2026-10-23T05:00:00.000Z", message: { role: "user", content: "review this" } });
    applyClaudeRow(s, assistant("msg_parent", "claude-opus-5-5", { input_tokens: 5, output_tokens: 50, cache_read_input_tokens: 1000 }));
    const contextBefore = s.stats.context;
    // The fork's transcript: its reference row, the parent's message copied, then its own work on another model.
    applyClaudeUsage(s, { type: "fork-context-ref", agentId: "a1", parentSessionId: "p" });
    applyClaudeUsage(s, { ...assistant("msg_parent", "claude-opus-5-5", { input_tokens: 5, output_tokens: 50, cache_read_input_tokens: 1000 }), isSidechain: true });
    applyClaudeUsage(s, { ...assistant("msg_sub", "claude-sonnet-5-5", { input_tokens: 7, output_tokens: 70, cache_read_input_tokens: 9000 }), isSidechain: true });
    applyClaudeUsage(s, { type: "user", isSidechain: true, message: { role: "user", content: "a sub-agent's prompt" } });
    expect(s.stats.tokens).toEqual({ in: 12, out: 120, cacheRead: 10_000, cacheWrite: 0 });
    expect(s.byModel.get("claude-sonnet-5-5")).toEqual({ in: 7, out: 70, cacheRead: 9000, cacheWrite: 0, cacheWrite1h: 0 });
    // Its turns, its window and its model are the session's own.
    expect(s.stats.turns).toBe(1);
    expect(s.stats.context).toEqual(contextBefore);
    expect(s.model).toBe("claude-opus-5-5");
  });

  test("with the window inferred, context has a limit and the stats carry the effort", () => {
    expect(statsFor(state, undefined, { infer: true }).context).toEqual({ used: 31005, limit: 200_000 });
    expect(statsFor(state, undefined, { infer: true, oneM: true }).context).toEqual({ used: 31005, limit: 1_000_000 });
    const row = (id: string, used: number, extra: { effort?: string; model?: string } = {}) => ({
      type: "assistant",
      timestamp: "2026-10-20T10:00:00.000Z",
      effort: extra.effort ?? "high",
      message: { id, role: "assistant", model: extra.model ?? "claude-opus-5-5", content: [], usage: { input_tokens: used, output_tokens: 1 } },
    });
    const s = newClaudeState();
    applyClaudeRow(s, row("m1", 80_000));
    // Not asked: as before, no context and no effort.
    expect(statsFor(s).context).toBeUndefined();
    expect(statsFor(s).effort).toBeUndefined();
    expect(statsFor(s, undefined, { infer: true })).toMatchObject({ context: { used: 80_000, limit: 200_000 }, effort: "high", model: "claude-opus-5-5" });
    s.statsChanged = false;
    applyClaudeRow(s, row("m2", 250_000, { effort: "medium" }));
    expect(s.statsChanged).toBe(true);
    expect(statsFor(s, undefined, { infer: true })).toMatchObject({ context: { used: 250_000, limit: 1_000_000 }, effort: "medium" });
    const named = newClaudeState();
    applyClaudeRow(named, row("m3", 1_000, { model: "claude-opus-5-5[1m]" }));
    expect(statsFor(named, undefined, { infer: true }).context).toEqual({ used: 1_000, limit: 1_000_000 });
  });

  test("a profile's settings that name a [1m] model say the window, read again when they change", () => {
    const dir = tempHome();
    const path = join(dir, "settings.json");
    expect(namesOneMModel(path)).toBe(false);
    writeFileSync(path, JSON.stringify({ model: "opus[1m]" }));
    expect(namesOneMModel(path)).toBe(true);
    writeFileSync(path, JSON.stringify({ model: "sonnet", effortLevel: "high" }));
    expect(namesOneMModel(path)).toBe(false);
    writeFileSync(path, "{ not json");
    expect(namesOneMModel(path)).toBe(false);
  });

  test("the effort counts on across a cleared context as the model does", () => {
    const base = { turns: 2, cost: 0, tokens: { in: 10, out: 5 }, effort: "low" };
    expect(countOn(base, { turns: 1, cost: 0, tokens: { in: 1, out: 1 } }).effort).toBe("low");
    expect(countOn(base, { turns: 1, cost: 0, tokens: { in: 1, out: 1 }, effort: "high" }).effort).toBe("high");
  });
});

describe("claude sub-agent transcripts", () => {
  test("are found beside the session's, a workflow's agents a folder further down", () => {
    const dir = join(tempHome(), "projects", "C--w");
    mkdirSync(dir, { recursive: true });
    const transcript = join(dir, "sess-1.jsonl");
    writeFileSync(transcript, "");
    expect(subagentTranscripts(transcript)).toEqual([]);
    const subs = join(dir, "sess-1", "subagents");
    mkdirSync(join(subs, "workflows", "wf_1"), { recursive: true });
    writeFileSync(join(subs, "agent-a.jsonl"), "");
    writeFileSync(join(subs, "agent-a.meta.json"), "{}");
    writeFileSync(join(subs, "workflows", "wf_1", "agent-b.jsonl"), "");
    writeFileSync(join(subs, "workflows", "wf_1", "journal.jsonl"), "");
    mkdirSync(join(dir, "sess-1", "tool-results"), { recursive: true });
    writeFileSync(join(dir, "sess-1", "tool-results", "x.jsonl"), "");
    expect(subagentTranscripts(transcript).sort()).toEqual([join(subs, "agent-a.jsonl"), join(subs, "workflows", "wf_1", "agent-b.jsonl")].sort());
  });
});

describe("claude hooks installer", () => {
  const spec = { mode: "http" as const, url: "http://127.0.0.1:4817/hooks/claude", token: "hook-token", timeoutS: 7200, profileId: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8" };
  const foreign = { matcher: "", hooks: [{ type: "command", command: "node C:/tools/other-hook.mjs" }] };
  const foreignFile = () => ({ hooks: { UserPromptSubmit: [foreign], Notification: [foreign] }, permissions: { allow: ["Bash(ls)"] } });

  test("install keeps the foreign hook, uninstall leaves it alone, and both are idempotent", () => {
    const path = join(tempHome(), "settings.json");
    writeFileSync(path, JSON.stringify(foreignFile(), null, 4));
    installClaudeHooks(path, spec);
    let s = readSettings(path);
    let hooks = s["hooks"] as Record<string, unknown[]>;
    expect(hooks["UserPromptSubmit"]).toHaveLength(2);
    expect(hooks["UserPromptSubmit"]![0]).toEqual(foreign);
    expect(isCophyladGroup(hooks["UserPromptSubmit"]![1])).toBe(true);
    expect(hooks["PermissionRequest"]).toHaveLength(1);
    expect(hooks["Notification"]).toHaveLength(2);
    expect(s["permissions"]).toEqual({ allow: ["Bash(ls)"] });
    const handler = (hooks["PermissionRequest"]![0] as { hooks: Record<string, unknown>[] }).hooks[0]!;
    expect(handler["type"]).toBe("http");
    expect(handler["timeout"]).toBe(7200);
    expect((handler["headers"] as Record<string, string>)["Authorization"]).toBe("Bearer hook-token");
    expect((handler["headers"] as Record<string, string>)["x-cophylad"]).toBe("1");

    installClaudeHooks(path, spec);
    s = readSettings(path);
    hooks = s["hooks"] as Record<string, unknown[]>;
    expect(hooks["UserPromptSubmit"]).toHaveLength(2);
    expect(hooks["PermissionRequest"]).toHaveLength(1);

    // A foreign re-install that filters on its own marker keeps ours.
    const other = withoutCophyladHooks(s);
    const reinstalled = { ...s, hooks: { ...(s["hooks"] as object), UserPromptSubmit: [...((s["hooks"] as Record<string, unknown[]>)["UserPromptSubmit"] ?? []).filter((g) => JSON.stringify(g).indexOf("other-hook") < 0), foreign] } };
    void other;
    writeFileSync(path, JSON.stringify(reinstalled, null, 2));
    expect(((readSettings(path)["hooks"] as Record<string, unknown[]>)["UserPromptSubmit"] ?? []).filter(isCophyladGroup)).toHaveLength(1);

    uninstallClaudeHooks(path);
    s = readSettings(path);
    expect(s["hooks"]).toEqual({ UserPromptSubmit: [foreign], Notification: [foreign] });
    uninstallClaudeHooks(path);
    expect(readSettings(path)).toEqual(s);
  });

  test("a command-mode install writes the shim command and nothing else", () => {
    const out = withCophyladHooks({}, { ...spec, mode: "command", command: '"C:/bun.exe" "C:/cophyla/data/cophylad-hook-shim.mjs" claude prof_x' });
    const groups = (out["hooks"] as Record<string, { hooks: Record<string, unknown>[] }[]>)["Stop"]!;
    expect(groups[0]!.hooks[0]).toEqual({ type: "command", command: '"C:/bun.exe" "C:/cophyla/data/cophylad-hook-shim.mjs" claude prof_x', timeout: 7200 });
    expect(isCophyladGroup(groups[0])).toBe(true);
  });

  test("a missing or empty settings file becomes one with only cophylad's hooks, and uninstall empties it again", () => {
    const path = join(tempHome(), "settings.json");
    installClaudeHooks(path, spec);
    expect(Object.keys(readSettings(path)["hooks"] as object)).toHaveLength(10);
    uninstallClaudeHooks(path);
    expect(readSettings(path)).toEqual({});
  });

  test("a stopping daemon drops its own groups and leaves another daemon's", () => {
    const path = join(tempHome(), "settings.json");
    const other = { mode: "http" as const, url: "http://127.0.0.1:4900/hooks/claude", token: "other-token", timeoutS: 7200, profileId: "prof_other" };
    // Install drops every marked group, so two daemons against one file are built here the way
    // they end up in life: the second's groups beside the first's, under the same marker.
    const ourFile = withCophyladHooks(foreignFile(), spec);
    const hooks = { ...(ourFile["hooks"] as Record<string, unknown[]>) };
    for (const [event, groups] of Object.entries(withCophyladHooks({}, other)["hooks"] as Record<string, unknown[]>)) hooks[event] = [...(hooks[event] ?? []), ...groups];
    writeFileSync(path, JSON.stringify({ ...ourFile, hooks }, null, 2));
    expect(((readSettings(path)["hooks"] as Record<string, unknown[]>)["Stop"] ?? []).filter(isCophyladGroup)).toHaveLength(2);

    uninstallClaudeHooks(path, [{ url: spec.url }]);
    const after = readSettings(path)["hooks"] as Record<string, unknown[]>;
    const left = (after["Stop"] ?? []).filter(isCophyladGroup);
    expect(left).toHaveLength(1);
    expect(isOwnGroup(left[0], [{ url: other.url }])).toBe(true);
    expect(after["UserPromptSubmit"]![0]).toEqual(foreign);
    // And the other daemon's own stop clears the rest, foreign groups untouched.
    uninstallClaudeHooks(path, [{ url: other.url }]);
    expect(readSettings(path)["hooks"]).toEqual({ UserPromptSubmit: [foreign], Notification: [foreign] });
  });

  test("in command mode a daemon owns its shim path, and another data directory's survives", () => {
    const path = join(tempHome(), "settings.json");
    const ours = '"C:/bun.exe" "C:/Users/a/.cophyla/data/cophylad-hook-shim.mjs" claude prof_a';
    const theirs = '"C:/bun.exe" "C:/Users/a/.cophyla-scratch/data/cophylad-hook-shim.mjs" claude prof_b';
    writeFileSync(path, JSON.stringify(withCophyladHooks({}, { ...spec, mode: "command", command: ours }), null, 2));
    const withBoth = readSettings(path)["hooks"] as Record<string, unknown[]>;
    for (const event of Object.keys(withBoth)) withBoth[event] = [...withBoth[event]!, { matcher: "", hooks: [{ type: "command", command: theirs, timeout: 7200 }] }];
    writeFileSync(path, JSON.stringify({ hooks: withBoth }, null, 2));

    uninstallClaudeHooks(path, [{ url: spec.url, command: ours }]);
    const after = (readSettings(path)["hooks"] as Record<string, unknown[]>)["Stop"]!;
    expect(after).toHaveLength(1);
    expect((after[0] as { hooks: { command: string }[] }).hooks[0]!.command).toBe(theirs);
  });

  test("a removal that changes nothing does not touch the watched file", () => {
    const path = join(tempHome(), "settings.json");
    writeFileSync(path, JSON.stringify(foreignFile(), null, 4));
    const before = readFileSync(path, "utf8");
    uninstallClaudeHooks(path, [{ url: spec.url }]);
    expect(readFileSync(path, "utf8")).toBe(before);
    installClaudeHooks(path, spec);
    const installed = readFileSync(path, "utf8");
    installClaudeHooks(path, spec);
    expect(readFileSync(path, "utf8")).toBe(installed);
  });

  test("this machine's real settings.json keeps its foreign groups byte-identical through install and uninstall", () => {
    const real = join(homedir(), ".claude", "settings.json");
    if (!existsSync(real)) return;
    const path = join(tempHome(), "settings.json");
    copyFileSync(real, path);
    const before = readSettings(path);
    const foreignGroups = (settings: Record<string, unknown>) => {
      const hooks = (settings["hooks"] as Record<string, unknown[]> | undefined) ?? {};
      const out: Record<string, string[]> = {};
      for (const [event, groups] of Object.entries(hooks)) {
        const kept = groups.filter((g) => !isCophyladGroup(g)).map((g) => JSON.stringify(g));
        if (kept.length > 0) out[event] = kept;
      }
      return out;
    };
    const original = foreignGroups(before);
    installClaudeHooks(path, spec);
    expect(foreignGroups(readSettings(path))).toEqual(original);
    uninstallClaudeHooks(path);
    const after = readSettings(path);
    expect(foreignGroups(after)).toEqual(original);
    const { hooks: _h1, ...restBefore } = before;
    const { hooks: _h2, ...restAfter } = after;
    void _h1;
    void _h2;
    expect(restAfter).toEqual(restBefore);
  });
});

describe("claude hooks over the daemon's own start and stop", () => {
  test("start installs into the profile, stop takes this daemon's back out and leaves the rest", async () => {
    const scratch = tempHome();
    const profileDir = join(scratch, "claude-profile");
    mkdirSync(join(profileDir, "sessions"), { recursive: true });
    const settings = join(profileDir, "settings.json");
    const foreignGroup = { matcher: "", hooks: [{ type: "command", command: "node C:/tools/other-hook.mjs" }] };
    const before = { hooks: { Stop: [foreignGroup] }, permissions: { allow: ["Bash(ls)"] } };
    writeFileSync(settings, JSON.stringify(before, null, 2));

    const mini = await miniSessions(
      `[sessions]\ndiscover = false\npoll_ms = 100000\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(profileDir)}\n`,
      (host, log) => [new ClaudeAdapter({ host, log, isAlive: () => false, sharedSettings: join(profileDir, "no-such-shared-settings.json") })],
      { port: 4899 },
    );
    try {
      const installed = readSettings(settings)["hooks"] as Record<string, unknown[]>;
      expect(Object.keys(installed)).toHaveLength(10);
      const ours = installed["Stop"]!.filter(isCophyladGroup);
      expect(ours).toHaveLength(1);
      expect(isOwnGroup(ours[0], [{ url: "http://127.0.0.1:4899/hooks/claude" }])).toBe(true);
      expect(installed["Stop"]![0]).toEqual(foreignGroup);
    } finally {
      await mini.stop();
    }
    expect(readSettings(settings)).toEqual(before);
  });
});

describe("claude pipe injection", () => {
  const pipe = testSocketPath("inject");
  afterAll(() => removeSocket(pipe));

  test("writes exactly the auth line and the user line, from cophylad", async () => {
    let received = "";
    const server = createServer((c) => {
      c.setEncoding("utf8");
      c.on("data", (d: string) => (received += d));
    });
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
    try {
      await injectClaude(pipe, "secret-token", "hello there", { holdMs: 50 });
      await waitFor(() => received.split("\n").length >= 3);
      expect(received).toBe(claudeFrames("secret-token", "hello there"));
      const lines = received.trim().split("\n").map((l) => JSON.parse(l));
      expect(lines).toEqual([
        { type: "auth", token: "secret-token" },
        { type: "user", message: { role: "user", content: "hello there" }, from: "cophylad" },
      ]);
    } finally {
      server.close();
    }
  });

  test("a pipe nobody serves is an error, not a hang", async () => {
    await expect(injectClaude(testSocketPath("none"), "t", "x", { connectTimeoutMs: 500 })).rejects.toThrow();
  });
});

describe("claude adapter prices a session with its sub-agents", () => {
  let mini: Mini;
  let profileDir: string;
  let registry: string;
  let cwd: string;
  let clock = Date.parse("2026-10-23T05:00:00.000Z");
  const alive = new Set([500]);
  const PRICES: Record<string, number[]> = { "claude-opus-5-5": [4, 20, 0.2, 5, 8], "claude-sonnet-5-5": [2, 10, 0.2, 2.5, 4] };

  beforeAll(async () => {
    const scratch = tempHome();
    profileDir = join(scratch, "claude-profile");
    registry = join(profileDir, "sessions");
    cwd = join(scratch, "work");
    mkdirSync(registry, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mini = await miniSessions(
      `[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 100000\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(profileDir)}\n`,
      (host, log) => [
        new ClaudeAdapter({
          host,
          log,
          isAlive: (pid) => alive.has(pid),
          sharedSettings: join(profileDir, "no-such-shared-settings.json"),
          price: (model, t) => {
            const p = PRICES[model];
            return p ? (t.in * p[0]! + t.out * p[1]! + t.cacheRead * p[2]! + (t.cacheWrite - t.cacheWrite1h) * p[3]! + t.cacheWrite1h * p[4]!) / 1e6 : undefined;
          },
        }),
      ],
      { deps: { now: () => clock } },
    );
  });
  afterAll(() => mini.stop());

  const row = (id: string, model: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "assistant", timestamp: new Date(clock).toISOString(), message: { id, model, role: "assistant", content: [{ type: "text", text: `${id} says hi` }], usage }, ...extra });

  test("its sub-agents' usage counts towards its stats, priced by model, and none of their rows becomes an event", async () => {
    writeRegistry(registry, { pid: 500, sessionId: "sess-p", cwd, status: "busy" });
    const path = transcriptPathFor(profileDir, cwd, "sess-p");
    const subs = join(path.replace(/\.jsonl$/, ""), "subagents");
    mkdirSync(subs, { recursive: true });
    const parent = row("msg_p", "claude-opus-5-5", { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 1000 } });
    writeFileSync(path, parent + "\n");
    // A fork: the message it came from copied, then its own on Sonnet.
    writeFileSync(join(subs, "agent-a1.jsonl"), [JSON.stringify({ type: "fork-context-ref", agentId: "a1" }), parent, row("msg_s1", "claude-sonnet-5-5", { input_tokens: 5, output_tokens: 50, cache_read_input_tokens: 2000 }, { isSidechain: true })].join("\n") + "\n");
    await mini.sessions.tick();
    const s = mini.sessions.list().find((x) => x.native.id === "sess-p")!;
    const opus = (10 * 4 + 100 * 20 + 10_000 * 0.2 + 1000 * 8) / 1e6;
    const sonnet = (5 * 2 + 50 * 10 + 2000 * 0.2) / 1e6;
    expect(s.stats?.tokens).toEqual({ in: 15, out: 150, cacheRead: 12_000, cacheWrite: 1000 });
    expect(s.stats?.cost).toBeCloseTo(opus + sonnet, 6);
    expect(s.stats?.model).toBe("claude-opus-5-5");
    const texts = mini.store.sessionEvents.history(s.id, { limit: 50 }).filter((e) => e.kind === "assistant_text").map((e) => (e.payload as { text: string }).text);
    expect(texts).toEqual(["msg_p says hi"]);
  });

  test("a sub-agent that works while its session's transcript is still is read again after a while", async () => {
    const path = transcriptPathFor(profileDir, cwd, "sess-p");
    const subs = join(path.replace(/\.jsonl$/, ""), "subagents");
    const before = mini.sessions.list().find((x) => x.native.id === "sess-p")!.stats!.cost;
    writeFileSync(join(subs, "agent-a2.jsonl"), row("msg_s2", "claude-sonnet-5-5", { input_tokens: 1000, output_tokens: 1000 }, { isSidechain: true }) + "\n");
    clock += 1000;
    await mini.sessions.tick();
    expect(mini.sessions.list().find((x) => x.native.id === "sess-p")!.stats!.cost).toBe(before);
    clock += 10_000;
    await mini.sessions.tick();
    const s = mini.sessions.list().find((x) => x.native.id === "sess-p")!;
    expect(s.stats!.cost).toBeCloseTo(before + (1000 * 2 + 1000 * 10) / 1e6, 6);
    expect(s.stats!.tokens.in).toBe(1015);
  });

  const costRecord = (sessionId: string, total: number, usage: Record<string, { in: number; out: number; read?: number }> = {}) =>
    JSON.stringify({
      type: "cost-state",
      sessionId,
      totalCostUSD: total,
      startTime: clock,
      modelUsage: Object.fromEntries(Object.entries(usage).map(([m, u]) => [m, { inputTokens: u.in, outputTokens: u.out, cacheReadInputTokens: u.read ?? 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 }])),
    });

  test("Claude's cost record adds what it holds beyond the transcripts, its sub-agents read up to it first", async () => {
    alive.add(501);
    writeRegistry(registry, { pid: 501, sessionId: "sess-q", cwd });
    const path = transcriptPathFor(profileDir, cwd, "sess-q");
    const subs = join(path.replace(/\.jsonl$/, ""), "subagents");
    mkdirSync(subs, { recursive: true });
    writeFileSync(path, row("msg_q1", "claude-opus-5-5", { input_tokens: 10, output_tokens: 1000 }) + "\n");
    clock += 1000;
    await mini.sessions.tick();
    const id = mini.sessions.list().find((x) => x.native.id === "sess-q")!.id;
    const opus = (10 * 4 + 1000 * 20) / 1e6;
    const sonnet = (100 * 2 + 100 * 10) / 1e6;
    // A sub-agent's work its folder was read too recently to see, then the record as the session exits.
    writeFileSync(join(subs, "agent-q.jsonl"), row("msg_q2", "claude-sonnet-5-5", { input_tokens: 100, output_tokens: 100 }, { isSidechain: true }) + "\n");
    appendFileSync(path, costRecord("sess-q", opus + sonnet + 0.5, { "claude-opus-5-5": { in: 2010, out: 1000, read: 50_000 }, "claude-sonnet-5-5": { in: 100, out: 100 } }) + "\n");
    clock += 1000;
    await mini.sessions.tick();
    let s = mini.sessions.get(id)!;
    expect(s.stats!.cost).toBeCloseTo(opus + sonnet + 0.5, 6);
    expect(s.stats!.tokens).toEqual({ in: 2110, out: 1100, cacheRead: 50_000 });
    // A later record holding less (a resume that did not restore Claude's totals) takes nothing back.
    appendFileSync(path, costRecord("sess-q", 0.01, { "claude-opus-5-5": { in: 5, out: 5 } }) + "\n");
    clock += 1000;
    await mini.sessions.tick();
    s = mini.sessions.get(id)!;
    expect(s.stats!.cost).toBeCloseTo(opus + sonnet + 0.5, 6);
    expect(s.stats!.tokens).toEqual({ in: 2110, out: 1100, cacheRead: 50_000 });
  });

  test("a record Claude writes just after a clear is read from the transcript left behind, and the new one counts on from it", async () => {
    alive.add(502);
    writeRegistry(registry, { pid: 502, sessionId: "sess-r", cwd });
    const old = transcriptPathFor(profileDir, cwd, "sess-r");
    writeFileSync(old, row("msg_r1", "claude-opus-5-5", { input_tokens: 0, output_tokens: 1000 }) + "\n");
    clock += 1000;
    await mini.sessions.tick();
    const id = mini.sessions.list().find((x) => x.native.id === "sess-r")!.id;
    // Cleared: the entry rewritten under the new id before the old transcript has its record.
    clearRegistry(registry, 502);
    writeRegistry(registry, { pid: 502, sessionId: "sess-r2", cwd });
    clock += 1000;
    await mini.sessions.tick();
    expect(mini.sessions.get(id)!.native.id).toBe("sess-r2");
    expect(mini.sessions.get(id)!.stats!.cost).toBeCloseTo(0.02, 6);
    appendFileSync(old, costRecord("sess-r", 0.27) + "\n");
    clock += 1000;
    await mini.sessions.tick();
    expect(mini.sessions.get(id)!.stats!.cost).toBeCloseTo(0.27, 6);
    writeFileSync(transcriptPathFor(profileDir, cwd, "sess-r2"), row("msg_r2", "claude-opus-5-5", { input_tokens: 0, output_tokens: 500 }) + "\n");
    clock += 1000;
    await mini.sessions.tick();
    expect(mini.sessions.get(id)!.stats!.cost).toBeCloseTo(0.28, 6);
  });

  test("a session that ends before Claude writes its record is credited it once written, but not past the wait", async () => {
    alive.add(503);
    writeRegistry(registry, { pid: 503, sessionId: "sess-t", cwd });
    const path = transcriptPathFor(profileDir, cwd, "sess-t");
    writeFileSync(path, row("msg_t1", "claude-opus-5-5", { input_tokens: 0, output_tokens: 1000 }) + "\n");
    clock += 1000;
    await mini.sessions.tick();
    const id = mini.sessions.list().find((x) => x.native.id === "sess-t")!.id;
    alive.delete(503);
    clearRegistry(registry, 503);
    clock += 1000;
    await mini.sessions.tick();
    expect(mini.sessions.get(id)!.status).toBe("ended");
    appendFileSync(path, costRecord("sess-t", 0.05) + "\n");
    clock += 1000;
    await mini.sessions.tick();
    expect(mini.sessions.get(id)!.stats!.cost).toBeCloseTo(0.05, 6);

    // Another that ended, its record written only after the wait: not looked for any more.
    alive.add(504);
    writeRegistry(registry, { pid: 504, sessionId: "sess-u", cwd });
    const late = transcriptPathFor(profileDir, cwd, "sess-u");
    writeFileSync(late, row("msg_u1", "claude-opus-5-5", { input_tokens: 0, output_tokens: 1000 }) + "\n");
    clock += 1000;
    await mini.sessions.tick();
    const lateId = mini.sessions.list().find((x) => x.native.id === "sess-u")!.id;
    alive.delete(504);
    clearRegistry(registry, 504);
    await mini.sessions.tick();
    clock += 31_000;
    await mini.sessions.tick();
    appendFileSync(late, costRecord("sess-u", 0.05) + "\n");
    clock += 1000;
    await mini.sessions.tick();
    expect(mini.sessions.get(lateId)!.stats!.cost).toBeCloseTo(0.02, 6);
  });
});

describe("claude adapter over a fake profile directory", () => {
  let mini: Mini;
  let profileDir: string;
  let registry: string;
  let cwd: string;
  const alive = new Set<number>();
  const injected: { pipe: string; token: string; text: string }[] = [];

  beforeAll(async () => {
    const scratch = tempHome();
    profileDir = join(scratch, "claude-profile");
    registry = join(profileDir, "sessions");
    cwd = join(scratch, "work");
    mkdirSync(registry, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mini = await miniSessions(
      `[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 100000\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(profileDir)}\n`,
      (host, log) => [
        new ClaudeAdapter({
          host,
          log,
          isAlive: (pid) => alive.has(pid),
          inject: async (pipe, token, text) => {
            injected.push({ pipe, token, text });
          },
          sharedSettings: join(profileDir, "no-such-shared-settings.json"),
        }),
      ],
    );
  });
  afterAll(() => mini.stop());

  const events = (id: string): SessionEvent[] => mini.store.sessionEvents.history(id, { limit: 500 });

  test("discovers a live session under the declared profile with a workspace", async () => {
    alive.add(100);
    writeRegistry(registry, { pid: 100, sessionId: "sess-a", cwd, status: "busy", name: "my-session" });
    await mini.sessions.tick();
    const list = mini.sessions.list();
    expect(list).toHaveLength(1);
    const s = list[0]!;
    expect(s.harness).toBe("claude");
    expect(s.native).toEqual({ id: "sess-a", pid: 100, transport: "pipe" });
    expect(s.profile).toBe(mini.profiles.byHarness("claude")[0]!.id);
    expect(s.status).toBe("busy");
    expect(s.title).toBe("my-session");
    expect(s.workspace).toBeDefined();
    expect(mini.workspaces.get(s.workspace!)?.path.toLowerCase()).toBe(cwd.toLowerCase());
    expect(events(s.id).map((e) => e.kind)).toEqual(["status"]);
  });

  test("a rename in the registry moves the session's name", async () => {
    expect(mini.sessions.list()[0]!.name).toBe("my-session");
    writeRegistry(registry, { pid: 100, sessionId: "sess-a", cwd, status: "busy", name: "login-review" });
    await mini.sessions.tick();
    expect(mini.sessions.list()[0]!.name).toBe("login-review");
  });

  test("a resume under a new pid keeps the id and refreshes the handles", async () => {
    const before = mini.sessions.list()[0]!;
    clearRegistry(registry, 100);
    alive.delete(100);
    alive.add(200);
    writeRegistry(registry, { pid: 200, sessionId: "sess-a", cwd, status: "idle", token: "tok-200", pipe: "\\\\.\\pipe\\LOCAL\\cc-new" });
    await mini.sessions.tick();
    const after = mini.sessions.list();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before.id);
    expect(after[0]!.native.pid).toBe(200);
    expect(after[0]!.status).toBe("idle");
    const r = await mini.sessions.send(before.id, "ping");
    expect(r.status).toBe("queued");
    expect(injected.at(-1)).toEqual({ pipe: "\\\\.\\pipe\\LOCAL\\cc-new", token: "tok-200", text: "[cophylad, relaying the user]\nping" });
  });

  test("gone from the registry with a dead pid ends it; back again revives it under the same id", async () => {
    const id = mini.sessions.list()[0]!.id;
    clearRegistry(registry, 200);
    alive.delete(200);
    await mini.sessions.tick();
    expect(mini.sessions.list()).toHaveLength(0);
    expect(mini.store.sessions.get(id)?.status).toBe("ended");
    expect(events(id).at(-1)?.kind).toBe("ended");
    alive.add(300);
    writeRegistry(registry, { pid: 300, sessionId: "sess-a", cwd });
    await mini.sessions.tick();
    const s = mini.sessions.list()[0]!;
    expect(s.id).toBe(id);
    expect(s.status).toBe("idle");
    expect(s.endedAt).toBeUndefined();
  });

  test("tails the transcript into events, stats, title, intent and the permission mode", async () => {
    const id = mini.sessions.list()[0]!.id;
    const path = transcriptPathFor(profileDir, cwd, "sess-a");
    mkdirSync(join(path, ".."), { recursive: true });
    const lines = readFileSync(FIXTURE, "utf8").split("\n").filter((l) => l.trim());
    writeFileSync(path, lines.slice(0, 9).join("\n") + "\n" + lines[9]!.slice(0, 40));
    await mini.sessions.tick();
    let s = mini.store.sessions.get(id)!;
    expect(s.transcript?.path).toBe(path);
    expect(s.intent).toBe("Use the Write tool to create the file perm-test-5.txt containing the word hello. Then reply DONE5.");
    expect(s.title).toBe("spike-perm-f");
    // discovered; pid changed and idle on resume; the unanswered "ping" went unconfirmed at the end; ended; revived.
    expect(events(id).map((e) => e.kind)).toEqual(["status", "status", "status", "notification", "ended", "status", "user_turn", "tool_call"]);
    // The partial line waits for the rest.
    writeFileSync(path, lines.join("\n") + "\n");
    await mini.sessions.tick();
    s = mini.store.sessions.get(id)!;
    const kinds = events(id).map((e) => e.kind);
    expect(kinds.slice(8)).toEqual(["tool_result", "assistant_text", "assistant_text"]);
    expect(s.title).toBe("spike-perm-f");
    expect(s.stats).toEqual({ turns: 1, cost: 0, tokens: { in: 23, out: 250, cacheRead: 85803, cacheWrite: 6601 }, model: "claude-haiku-4-5-20251001" });
    const call = events(id).find((e) => e.kind === "tool_call")!;
    expect(call.payload).toEqual({ tool: "Write", id: "toolu_01UGRLxAXPUYTDuQmBphDLgn", args: { file_path: "C:\\D\\orchestrator\\spikes\\02-permission-hook\\target\\perm-test-5.txt", content: "hello" } });
    expect(call.raw).toBeDefined();
    // The transcript said bypassPermissions last, and no settings accept inbound: a send is held.
    const r = await mini.sessions.send(id, "again");
    expect(r.status).toBe("held");
  });

  test("a hook from a session the registry has not shown yet resolves through the registry", async () => {
    alive.add(400);
    writeRegistry(registry, { pid: 400, sessionId: "sess-b", cwd, status: "idle" });
    const answer = await mini.sessions.onHook("claude", { session_id: "sess-b", transcript_path: join(profileDir, "projects", "x", "sess-b.jsonl"), cwd, hook_event_name: "UserPromptSubmit", prompt: "hello" }, { via: "http" });
    expect(answer).toEqual({});
    const s = mini.sessions.list().find((x) => x.native.id === "sess-b")!;
    expect(s).toBeDefined();
    expect(s.status).toBe("busy");
    expect(s.intent).toBe("hello");
    expect(s.native.pid).toBe(400);
    expect(events(s.id).map((e) => e.kind)).toEqual(["status", "user_turn", "status"]);
  });

  test("session.list serves Session entities that parse", async () => {
    const { Session } = await import("@cophyla/protocol");
    for (const s of mini.sessions.list() as Session[]) expect(Session.safeParse(s).success).toBe(true);
  });
});

describe("claude sessions end and resume on evidence", () => {
  const GRACE_MS = 1000;
  let mini: Mini;
  let profileDir: string;
  let registry: string;
  let cwd: string;
  const alive = new Set<number>();
  /** The process tree above a command-mode hook: the shim's parent is a shell, and Claude is above it. */
  const tree = {
    async ancestors(pid: number) {
      return pid === 5151 ? [{ pid: 5151, name: "bash" }, { pid: 5100, name: process.platform === "win32" ? "claude.exe" : "claude" }, { pid: 5000, name: "zsh" }] : [];
    },
  };

  beforeAll(async () => {
    const scratch = tempHome();
    profileDir = join(scratch, "claude-profile");
    registry = join(profileDir, "sessions");
    cwd = join(scratch, "work");
    mkdirSync(registry, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mini = await miniSessions(
      `[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 100000\nclaude_hook_grace_ms = ${GRACE_MS}\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(profileDir)}\n`,
      (host, log) => [new ClaudeAdapter({ host, log, isAlive: (pid) => alive.has(pid), inject: async () => undefined, sharedSettings: join(profileDir, "none.json"), raiser: tree })],
    );
  });
  afterAll(() => mini.stop());

  const byNative = (native: string) => mini.store.sessions.getByNative("claude", native)!;
  const events = (native: string): SessionEvent[] => mini.store.sessionEvents.history(byNative(native).id, { limit: 500 });
  const hook = (native: string, name: string, meta: { via: "http" | "command"; ppid?: number } = { via: "http" }) =>
    mini.sessions.onHook("claude", { session_id: native, transcript_path: join(profileDir, "projects", "x", `${native}.jsonl`), cwd, hook_event_name: name, ...(name === "UserPromptSubmit" ? { prompt: "hi" } : {}) } as never, meta);

  test("a session known only from its hooks outlives the sweep within the grace, and ends inactive after it", async () => {
    await hook("hook-only", "UserPromptSubmit");
    expect(byNative("hook-only").native.pid).toBeUndefined();
    for (let i = 0; i < 3; i++) await mini.sessions.tick();
    expect(byNative("hook-only").status).toBe("busy");
    await sleep(GRACE_MS + 100);
    await mini.sessions.tick();
    expect(byNative("hook-only").status).toBe("ended");
    expect(events("hook-only").at(-1)?.payload).toEqual({ reason: "inactive" });
  });

  test("a hook on an ended session resumes it, with endedAt cleared", async () => {
    const id = byNative("hook-only").id;
    await hook("hook-only", "UserPromptSubmit");
    const s = byNative("hook-only");
    expect(s.id).toBe(id);
    expect(s.status).toBe("busy");
    expect(s.endedAt).toBeUndefined();
    const kinds = events("hook-only").map((e) => e.kind);
    // The resume says busy itself, so the prompt changes no status.
    expect(kinds.slice(kinds.lastIndexOf("ended") + 1)).toEqual(["status", "user_turn"]);
    expect(events("hook-only")[kinds.lastIndexOf("ended") + 1]!.payload).toMatchObject({ status: "busy", resumed: true });
    await mini.sessions.tick();
    expect(byNative("hook-only").status).toBe("busy");
  });

  test("a command-mode hook finds the session's process through the shim's ancestors; the sweep then watches it", async () => {
    alive.add(5100);
    await hook("walked", "UserPromptSubmit", { via: "command", ppid: 5151 });
    await waitFor(() => byNative("walked").native.pid === 5100);
    await sleep(GRACE_MS + 100);
    await mini.sessions.tick();
    expect(byNative("walked").status).toBe("busy");
    alive.delete(5100);
    await mini.sessions.tick();
    expect(byNative("walked").status).toBe("ended");
    expect(events("walked").at(-1)?.payload).toEqual({ reason: "gone" });
  });

  test("still listed under the process it ended in, a session stays ended; under a new process it resumes", async () => {
    alive.add(700);
    writeRegistry(registry, { pid: 700, sessionId: "sess-c", cwd });
    await mini.sessions.tick();
    expect(byNative("sess-c").status).toBe("idle");
    await hook("sess-c", "SessionEnd");
    expect(byNative("sess-c").status).toBe("ended");
    const before = events("sess-c").length;
    for (let i = 0; i < 3; i++) await mini.sessions.tick();
    expect(byNative("sess-c").status).toBe("ended");
    expect(events("sess-c")).toHaveLength(before);
    clearRegistry(registry, 700);
    alive.delete(700);
    alive.add(701);
    writeRegistry(registry, { pid: 701, sessionId: "sess-c", cwd, status: "busy" });
    await mini.sessions.tick();
    const s = byNative("sess-c");
    expect(s.status).toBe("busy");
    expect(s.native.pid).toBe(701);
    expect(s.endedAt).toBeUndefined();
  });

  test("setStatus never brings an ended session back", async () => {
    const rec = mini.sessions.find("claude", "walked")!;
    expect(rec.session.status).toBe("ended");
    mini.sessions.setStatus(rec, "busy");
    mini.sessions.setStatus(rec, "idle");
    expect(byNative("walked").status).toBe("ended");
    expect(events("walked").at(-1)?.kind).toBe("ended");
  });

  test("a session that exits has its transcript's last lines recorded before the end, and a resume records only what is new", async () => {
    const lines = readFileSync(FIXTURE, "utf8").split("\n").filter((l) => l.trim());
    const path = transcriptPathFor(profileDir, cwd, "sess-d");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, lines.slice(0, 9).join("\n") + "\n");
    alive.add(800);
    writeRegistry(registry, { pid: 800, sessionId: "sess-d", cwd });
    await mini.sessions.tick();
    await mini.sessions.tick();
    expect(events("sess-d").map((e) => e.kind)).toEqual(["status", "user_turn", "tool_call"]);
    // The last lines land, and the process is gone before the next pass reads them.
    writeFileSync(path, lines.join("\n") + "\n");
    clearRegistry(registry, 800);
    alive.delete(800);
    await mini.sessions.tick();
    expect(events("sess-d").map((e) => e.kind)).toEqual(["status", "user_turn", "tool_call", "tool_result", "assistant_text", "assistant_text", "ended"]);
    // Resumed under a new process: nothing recorded twice.
    alive.add(801);
    writeRegistry(registry, { pid: 801, sessionId: "sess-d", cwd });
    await mini.sessions.tick();
    await mini.sessions.tick();
    const kinds = events("sess-d").map((e) => e.kind);
    expect(kinds.slice(kinds.indexOf("ended") + 1)).toEqual(["status"]);
  });
});

describe("claude background jobs, spares, and what an idle session waits on", () => {
  let mini: Mini;
  let profileDir: string;
  let registry: string;
  let cwd: string;
  const alive = new Set<number>();

  beforeAll(async () => {
    const scratch = tempHome();
    profileDir = join(scratch, "claude-profile");
    registry = join(profileDir, "sessions");
    cwd = join(scratch, "work");
    mkdirSync(registry, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mini = await miniSessions(
      `[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 100000\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(profileDir)}\n`,
      (host, log) => [new ClaudeAdapter({ host, log, isAlive: (pid) => alive.has(pid), inject: async () => undefined, sharedSettings: join(profileDir, "none.json") })],
    );
  });
  afterAll(() => mini.stop());

  const live = (native: string): Session | undefined => {
    const rec = mini.sessions.find("claude", native);
    return rec ? mini.sessions.get(rec.session.id) : undefined;
  };
  const events = (id: string): SessionEvent[] => mini.store.sessionEvents.history(id, { limit: 500 });
  const hook = (native: string, name: string, extra: Record<string, unknown> = {}) =>
    mini.sessions.onHook("claude", { session_id: native, transcript_path: transcriptPathFor(profileDir, cwd, native), cwd, hook_event_name: name, ...extra } as never, { via: "http" });
  const iso = (ms: number) => new Date(ms).toISOString();
  const userRow = (text: string, at: number, uuid: string) => ({ type: "user", uuid, timestamp: iso(at), message: { role: "user", content: text } });
  const assistantRow = (text: string, at: number, id: string) => ({ type: "assistant", uuid: `a-${id}`, timestamp: iso(at), message: { id, model: "claude-haiku-4-5", role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 } } });
  const writeTranscript = (native: string, rows: unknown[], append = false) => {
    const path = transcriptPathFor(profileDir, cwd, native);
    mkdirSync(join(path, ".."), { recursive: true });
    const text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(path, append && existsSync(path) ? readFileSync(path, "utf8") + text : text);
  };
  const writeJob = (job: string, createdAt: number) => {
    mkdirSync(join(profileDir, "jobs", job), { recursive: true });
    writeFileSync(join(profileDir, "jobs", job, "state.json"), JSON.stringify({ state: "working", createdAt: iso(createdAt), sessionId: job }));
  };

  test("a turn over with its shells still running is idle, waiting on its shell; busy clears it", async () => {
    alive.add(1000);
    writeRegistry(registry, { pid: 1000, sessionId: "w-a", cwd, status: "shell" });
    await mini.sessions.tick();
    expect(live("w-a")).toMatchObject({ status: "idle", waiting: { on: "shell" } });
    const id = live("w-a")!.id;
    expect(events(id).at(-1)?.payload).toMatchObject({ status: "idle", waiting: { on: "shell" } });
    writeRegistry(registry, { pid: 1000, sessionId: "w-a", cwd, status: "busy" });
    await mini.sessions.tick();
    expect(live("w-a")!.status).toBe("busy");
    expect(live("w-a")!.waiting).toBeUndefined();
    writeRegistry(registry, { pid: 1000, sessionId: "w-a", cwd, status: "idle" });
    await mini.sessions.tick();
    expect(live("w-a")!.status).toBe("idle");
    expect(live("w-a")!.waiting).toBeUndefined();
    // Not stored: a restart reads it from the registry again.
    expect(mini.store.sessions.get(id)!.waiting).toBeUndefined();
  });

  test("a dialog open is waiting on the user, with what Claude calls it", async () => {
    writeRegistry(registry, { pid: 1000, sessionId: "w-a", cwd, status: "waiting", waitingFor: "sandbox request" });
    await mini.sessions.tick();
    expect(live("w-a")).toMatchObject({ status: "idle", waiting: { on: "user", detail: "sandbox request" } });
  });

  test("a Stop takes what the registry says, also when it says it a moment after the hook", async () => {
    writeRegistry(registry, { pid: 1000, sessionId: "w-a", cwd, status: "busy" });
    await hook("w-a", "UserPromptSubmit", { prompt: "run the tests" });
    expect(live("w-a")!.status).toBe("busy");
    writeRegistry(registry, { pid: 1000, sessionId: "w-a", cwd, status: "shell" });
    await hook("w-a", "Stop");
    expect(live("w-a")).toMatchObject({ status: "idle", waiting: { on: "shell" } });
    // Written after the hook: the session stays busy until the registry says, with no idle between.
    writeRegistry(registry, { pid: 1000, sessionId: "w-a", cwd, status: "busy" });
    await hook("w-a", "UserPromptSubmit", { prompt: "again" });
    const id = live("w-a")!.id;
    const seen: string[] = [];
    const off = mini.bus.on("session.event", (e) => {
      if (e.session === id && e.kind === "status") seen.push(JSON.stringify(e.payload));
    });
    await hook("w-a", "Stop");
    expect(live("w-a")!.status).toBe("busy");
    await sleep(120);
    writeRegistry(registry, { pid: 1000, sessionId: "w-a", cwd, status: "shell" });
    await waitFor(() => live("w-a")!.status === "idle");
    off();
    expect(live("w-a")!.waiting).toEqual({ on: "shell" });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p.includes("waiting"))).toBe(true);
  });

  test("a turn's end is one status event, with what it waits on and the last words; after an idle the registry read first, the Stop's own event carries the words", async () => {
    writeRegistry(registry, { pid: 1000, sessionId: "w-a", cwd, status: "busy" });
    await hook("w-a", "UserPromptSubmit", { prompt: "run the suite" });
    const id = live("w-a")!.id;
    const statuses = (from: number) => events(id).slice(from).filter((e) => e.kind === "status").map((e) => e.payload);
    let from = events(id).length;
    writeRegistry(registry, { pid: 1000, sessionId: "w-a", cwd, status: "shell" });
    await hook("w-a", "Stop", { last_assistant_message: "Running the suite." });
    expect(statuses(from)).toEqual([{ status: "idle", waiting: { on: "shell" }, pid: 1000, lastAssistantMessage: "Running the suite." }]);

    await hook("w-a", "UserPromptSubmit", { prompt: "and again" });
    writeRegistry(registry, { pid: 1000, sessionId: "w-a", cwd, status: "idle" });
    await mini.sessions.tick();
    expect(live("w-a")).toMatchObject({ status: "idle" });
    from = events(id).length;
    await hook("w-a", "Stop", { last_assistant_message: "All green." });
    expect(statuses(from)).toEqual([{ status: "idle", lastAssistantMessage: "All green." }]);
  });

  test("a turn its API ended fires StopFailure in place of Stop: idle all the same, with the error and the harness's words for it", async () => {
    writeRegistry(registry, { pid: 1000, sessionId: "w-a", cwd, status: "busy" });
    await hook("w-a", "UserPromptSubmit", { prompt: "and now?" });
    expect(live("w-a")!.status).toBe("busy");
    const id = live("w-a")!.id;
    const from = events(id).length;
    writeRegistry(registry, { pid: 1000, sessionId: "w-a", cwd, status: "idle" });
    const limit = "You've hit your weekly limit · resets Oct 18, 10am (Europe/Budapest)";
    expect(await hook("w-a", "StopFailure", { error: "rate_limit", last_assistant_message: limit })).toEqual({});
    expect(live("w-a")!.status).toBe("idle");
    const statuses = events(id).slice(from).filter((e) => e.kind === "status").map((e) => e.payload);
    expect(statuses).toEqual([{ status: "idle", pid: 1000, lastAssistantMessage: limit, failed: "rate_limit" }]);
  });

  test("a spare is no session; a record of one from an older daemon ends, and comes back when the spare becomes a job", async () => {
    alive.add(1100);
    writeRegistry(registry, { pid: 1100, sessionId: "spare-1", cwd, kind: "bg", jobId: "spare1", spare: true });
    await mini.sessions.tick();
    expect(mini.sessions.find("claude", "spare-1")).toBeUndefined();
    expect(await hook("spare-1", "SessionStart", { source: "startup" })).toEqual({});
    expect(mini.sessions.find("claude", "spare-1")).toBeUndefined();
    // What an older daemon made of it.
    const old = mini.sessions.ensure({ harness: "claude", nativeId: "spare-1", profile: mini.profiles.byHarness("claude")[0]!.id, cwd, transport: "pipe", pid: 1100 });
    await mini.sessions.tick();
    expect(mini.store.sessions.get(old.session.id)!.status).toBe("ended");
    expect(events(old.session.id).at(-1)?.payload).toEqual({ reason: "spare" });
    writeRegistry(registry, { pid: 1100, sessionId: "spare-1", cwd, kind: "bg", jobId: "spare1", status: "busy", statusUpdatedAt: Date.now() + 1000 });
    await mini.sessions.tick();
    expect(live("spare-1")).toMatchObject({ id: old.session.id, status: "busy", native: { id: "spare-1", pid: 1100, job: "spare1" } });
  });

  test("a conversation sent to the background goes on as its job: the same record, no history twice", async () => {
    const t0 = Date.now() - 60000;
    alive.add(1200);
    writeRegistry(registry, { pid: 1200, sessionId: "conv-a", cwd, startedAt: t0 - 1000 });
    writeTranscript("conv-a", [userRow("write the report", t0, "u1"), assistantRow("done", t0 + 1000, "m1")]);
    await mini.sessions.tick();
    await mini.sessions.tick();
    const rec = mini.sessions.find("claude", "conv-a")!;
    const id = rec.session.id;
    mini.sessions.patch(rec, { native: { ...rec.session.native, terminal: { host: "h1", id: "t1" } } });
    expect(events(id).filter((e) => e.kind === "user_turn" || e.kind === "assistant_text")).toHaveLength(2);
    expect(live("conv-a")!.stats).toMatchObject({ turns: 1, tokens: { in: 10, out: 5 } });

    // `/bg`: the transcript says where the conversation goes on, then the window exits.
    const bgAt = t0 + 5000;
    writeTranscript("conv-a", [{ type: "continued-in", timestamp: iso(bgAt), sessionId: "conv-a", continuedInSessionId: "job-a-0000" }, { type: "cost-state", sessionId: "conv-a" }], true);
    await mini.sessions.tick();
    clearRegistry(registry, 1200);
    alive.delete(1200);
    await hook("conv-a", "SessionEnd", { reason: "prompt_input_exit" });
    await mini.sessions.tick();
    expect(mini.sessions.get(id)!.status).not.toBe("ended");

    // The job registers under the new id, and the record follows it there.
    writeJob("job-a", bgAt - 100);
    alive.add(1300);
    writeRegistry(registry, { pid: 1300, sessionId: "job-a-0000", cwd, kind: "bg", jobId: "job-a" });
    writeTranscript("job-a-0000", [{ type: "ai-title", aiTitle: "Report", sessionId: "job-a-0000" }]);
    await mini.sessions.tick();
    const moved = mini.sessions.get(id)!;
    expect(moved.native).toEqual({ id: "job-a-0000", pid: 1300, transport: "pipe", job: "job-a" });
    expect(moved.status).toBe("idle");
    expect(mini.sessions.find("claude", "job-a-0000")?.session.id).toBe(id);
    expect(events(id).find((e) => e.kind === "notification" && (e.payload as { type: string }).type === "backgrounded")?.payload).toEqual({ type: "backgrounded", from: "conv-a", to: "job-a-0000" });
    expect(events(id).filter((e) => e.kind === "ended")).toHaveLength(0);

    // Its first prompt copies the history in, then the new turn: only the new turn is recorded.
    writeTranscript("job-a-0000", [userRow("write the report", t0, "u1"), assistantRow("done", t0 + 1000, "m1"), userRow("add a summary", bgAt + 2000, "u2"), assistantRow("summary added", bgAt + 3000, "m2")], true);
    await mini.sessions.tick();
    await mini.sessions.tick();
    const texts = events(id)
      .filter((e) => e.kind === "user_turn" || e.kind === "assistant_text")
      .map((e) => (e.payload as { text: string }).text);
    expect(texts).toEqual(["write the report", "done", "add a summary", "summary added"]);
    expect(mini.sessions.get(id)!.stats).toMatchObject({ turns: 2, tokens: { in: 20, out: 10 } });
    // A hook under the job's id, or a late one under the old, finds the same record and ends nothing.
    await hook("job-a-0000", "SessionStart", { source: "fork" });
    await hook("conv-a", "SessionEnd", { reason: "prompt_input_exit" });
    expect(mini.sessions.get(id)!.status).toBe("idle");
  });

  test("a job met before its conversation said where it went takes that conversation's place", async () => {
    alive.add(1400);
    writeRegistry(registry, { pid: 1400, sessionId: "conv-b", cwd, startedAt: Date.now() - 60000 });
    await mini.sessions.tick();
    const from = mini.sessions.find("claude", "conv-b")!;
    mini.sessions.patch(from, { origin: "orchestrator", task: "task_01ARZ3NDEKTSV4RRFFQ69G5FB2", intent: "port the tests" });
    alive.add(1500);
    writeRegistry(registry, { pid: 1500, sessionId: "job-b-0000", cwd, kind: "bg", jobId: "job-b" });
    await mini.sessions.tick();
    const into = mini.sessions.find("claude", "job-b-0000")!;
    expect(into.session.id).not.toBe(from.session.id);
    writeTranscript("conv-b", [{ type: "continued-in", timestamp: iso(Date.now()), sessionId: "conv-b", continuedInSessionId: "job-b-0000" }]);
    await mini.sessions.tick();
    expect(mini.store.sessions.get(from.session.id)!.status).toBe("ended");
    expect(events(from.session.id).at(-1)?.payload).toEqual({ reason: "backgrounded" });
    expect(mini.sessions.get(into.session.id)).toMatchObject({ origin: "orchestrator", task: "task_01ARZ3NDEKTSV4RRFFQ69G5FB2", intent: "port the tests" });
  });

  test("a window parked on the agents screen: its record waits for the job, then follows it", async () => {
    alive.add(1600);
    writeRegistry(registry, { pid: 1600, sessionId: "conv-c", cwd, status: "busy" });
    await mini.sessions.tick();
    const id = mini.sessions.find("claude", "conv-c")!.session.id;
    writeRegistry(registry, { pid: 1600, sessionId: "conv-c", cwd, status: "idle", parkedJobId: "job-c" });
    await mini.sessions.tick();
    // No job yet: left as it was, and no status taken from the window.
    expect(mini.sessions.get(id)).toMatchObject({ status: "busy", native: { id: "conv-c", pid: 1600 } });
    alive.add(1700);
    writeJob("job-c", Date.now());
    writeRegistry(registry, { pid: 1700, sessionId: "job-c-0000", cwd, kind: "bg", jobId: "job-c", status: "idle" });
    await mini.sessions.tick();
    expect(mini.sessions.get(id)).toMatchObject({ status: "idle", native: { id: "job-c-0000", pid: 1700, job: "job-c" } });
    // The window's own entry is no session.
    expect(mini.sessions.list().filter((s) => s.native.pid === 1600)).toHaveLength(0);
  });

  test("a job stops: its record ends", async () => {
    const id = mini.sessions.find("claude", "job-c-0000")!.session.id;
    clearRegistry(registry, 1700);
    alive.delete(1700);
    await hook("job-c-0000", "SessionEnd", { reason: "other" });
    expect(mini.store.sessions.get(id)!.status).toBe("ended");
  });

  test("the agents screen's own hooks, under an id no registry has, make no session", async () => {
    await hook("agents-screen", "Notification", { notification_type: "agent_completed", message: "done" });
    await hook("agents-screen", "SessionEnd", { reason: "other" });
    expect(mini.store.sessions.getByNative("claude", "agents-screen")).toBeUndefined();
  });

  test("session.list serves Session entities that parse, waiting and job included", async () => {
    const { Session } = await import("@cophyla/protocol");
    const list = mini.sessions.list();
    expect(list.some((s) => s.native.job !== undefined)).toBe(true);
    for (const s of list as Session[]) expect(Session.safeParse(s).success).toBe(true);
  });
});

describe("claude sessions under an account no profile has", () => {
  let scratch: string;
  let homeDir: string;
  let workDir: string;
  let gmailDir: string;
  let cwd: string;
  let storePath: string;
  let mini: Mini;
  const lines: string[] = [];
  const alive = new Set<number>();
  /** Declared profiles, the first the usual one; the store outlives a restart. */
  const start = (profiles: [string, string][]) =>
    miniSessions(
      `[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 100000\n` + profiles.map(([name, dir], i) => `\n[[profiles]]\nharness = "claude"\nname = "${name}"\nconfig_dir = ${tomlString(dir)}\n${i === 0 ? "default = true\n" : ""}`).join(""),
      (host, log) => [new ClaudeAdapter({ host, log, isAlive: (pid) => alive.has(pid), inject: async () => undefined, sharedSettings: join(scratch, "none.json") })],
      { log: createLogger("info", (line) => lines.push(line)), storePath },
    );

  beforeAll(async () => {
    scratch = tempHome();
    homeDir = join(scratch, "claude-home");
    workDir = join(scratch, "claude-accounts", "work");
    gmailDir = join(scratch, "claude-accounts", "gmail");
    cwd = join(scratch, "work");
    storePath = join(scratch, "store.sqlite");
    for (const dir of [join(homeDir, "sessions"), join(workDir, "sessions"), cwd]) mkdirSync(dir, { recursive: true });
    mini = await start([["home", homeDir], ["work", workDir]]);
  });
  afterAll(() => mini.stop());

  const profileId = (name: string) => mini.profiles.byHarness("claude").find((p) => p.name === name)!.id;
  const hook = (native: string, transcript: string | undefined, hooks: string | undefined, name = "UserPromptSubmit") =>
    mini.sessions.onHook("claude", { session_id: native, ...(transcript !== undefined ? { transcript_path: transcript } : {}), cwd, hook_event_name: name, ...(name === "UserPromptSubmit" ? { prompt: "hi" } : {}) } as never, { via: "http", ...(hooks !== undefined ? { profile: hooks } : {}) });
  const byNative = (native: string) => mini.store.sessions.getByNative("claude", native)!;
  const flags = (native: string) =>
    mini.store.sessionEvents
      .history(byNative(native).id, { limit: 500 })
      .map((e) => e.payload as Record<string, unknown>)
      .filter((p) => p["type"] === "unknown_account");
  /** The log lines that say `text`, from `from` on, with their fields. */
  const logged = (text: string, from = 0) =>
    lines
      .slice(from)
      .filter((l) => l.includes(text))
      .map((l) => ({ line: l, fields: JSON.parse(l.slice(l.indexOf(" {") + 1)) as Record<string, unknown> }));

  test("the directory a transcript is in, a sub-agent's too; none for a path of another shape", () => {
    expect(claudeConfigDirOf(join(gmailDir, "projects", "C--work", "s.jsonl"))).toBe(gmailDir);
    expect(claudeConfigDirOf(join(gmailDir, "projects", "C--work", "s", "subagents", "agent-1.jsonl"))).toBe(gmailDir);
    expect(claudeConfigDirOf(join("elsewhere", "s.jsonl"))).toBeUndefined();
  });

  test("a transcript under a known profile's directory files the session there, whatever profile its hooks name", async () => {
    const from = lines.length;
    const path = transcriptPathFor(workDir, cwd, "w1");
    await hook("w1", path, profileId("home"));
    await hook("w1", path, profileId("home"), "Stop");
    expect(byNative("w1").profile).toBe(profileId("work"));
    expect(mini.sessions.find("claude", "w1")!.handles.configDir).toBe(workDir);
    expect(flags("w1")).toEqual([]);
    // Another profile's hooks: said once, as information, since the directory decides.
    const crossed = logged("runs another profile's hooks", from);
    expect(crossed).toHaveLength(1);
    expect(crossed[0]!.line).toContain(" INFO ");
    expect(crossed[0]!.fields).toMatchObject({ dir: workDir, profile: profileId("work"), hooks: profileId("home") });
    expect(logged("no profile has", from)).toEqual([]);
  });

  test("a transcript in a Claude directory no profile has, its hooks naming the usual profile: listed under it, flagged in its timeline, warned of once in the log", async () => {
    const from = lines.length;
    const path = transcriptPathFor(gmailDir, cwd, "g1");
    await hook("g1", path, profileId("home"));
    await hook("g1", path, profileId("home"), "Stop");
    expect(byNative("g1").profile).toBe(profileId("home"));
    // What is read from its directory is read from its own.
    expect(mini.sessions.find("claude", "g1")!.handles.configDir).toBe(gmailDir);
    const flagged = flags("g1");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ configDir: gmailDir, profile: profileId("home") });
    expect(String(flagged[0]!["message"])).toContain(gmailDir);
    expect(String(flagged[0]!["message"])).toContain(`"home", whose hooks it runs`);
    // Another session from the same directory: flagged in its own timeline, not again in the log.
    await hook("g2", transcriptPathFor(gmailDir, cwd, "g2"), profileId("home"));
    expect(byNative("g2").profile).toBe(profileId("home"));
    expect(flags("g2")).toHaveLength(1);
    const warned = logged("no profile has", from);
    expect(warned).toHaveLength(1);
    expect(warned[0]!.line).toContain(" WARN ");
    expect(warned[0]!.fields).toMatchObject({ dir: gmailDir, hooks: profileId("home"), profile: profileId("home") });
    expect(logged("runs another profile's hooks", from)).toEqual([]);
  });

  test("with no transcript path, the profile its hooks name, else the usual one, and nothing flagged", async () => {
    const from = lines.length;
    await hook("n1", undefined, profileId("work"));
    await hook("n2", undefined, undefined);
    expect(byNative("n1").profile).toBe(profileId("work"));
    expect(byNative("n2").profile).toBe(profileId("home"));
    expect(flags("n1")).toEqual([]);
    expect(flags("n2")).toEqual([]);
    expect(logged("no profile has", from)).toEqual([]);
    expect(logged("runs another profile's hooks", from)).toEqual([]);
  });

  test("its directory declared, a restart moves the session to its own profile as soon as the registry there lists it", async () => {
    const id = byNative("g1").id;
    await mini.stop();
    alive.add(7100);
    writeRegistry(join(gmailDir, "sessions"), { pid: 7100, sessionId: "g1", cwd, status: "idle" });
    const from = lines.length;
    mini = await start([["home", homeDir], ["work", workDir], ["gmail", gmailDir]]);
    const s = byNative("g1");
    expect(s.id).toBe(id);
    expect(s.profile).toBe(profileId("gmail"));
    expect(mini.sessions.find("claude", "g1")!.handles.configDir).toBe(gmailDir);
    expect(logged("moved to the profile whose registry lists it", from)).toHaveLength(1);
    // The next poll leaves it there.
    await mini.sessions.tick();
    expect(byNative("g1").profile).toBe(profileId("gmail"));
    expect(logged("moved to the profile whose registry lists it", from)).toHaveLength(1);
  });
});
