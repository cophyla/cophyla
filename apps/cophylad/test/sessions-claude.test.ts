// The Claude Code adapter in pieces: the registry reader, the transcript parser over a
// redacted capture, the hooks installer beside a foreign hook (and beside a copy of this
// machine's real settings), the pipe injector against a pipe the test hosts, and the
// adapter over a fake profile directory: discovery, resume under a new pid, tailing; then
// ending and resuming on evidence: a hook-only session kept for the grace and ended after,
// resumed by its next hook, its process found through the shim's ancestors, a registry still
// showing the ended process ignored, `setStatus` never un-ending, and an exit recording the
// transcript's last lines with a resume recording nothing twice.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, SessionEvent } from "@cophyla/protocol";
import { ClaudeAdapter } from "../src/sessions/claude/adapter.ts";
import { installClaudeHooks, isCophyladGroup, isOwnGroup, readSettings, uninstallClaudeHooks, withCophyladHooks, withoutCophyladHooks } from "../src/sessions/claude/hooks.ts";
import { claudeFrames, injectClaude } from "../src/sessions/claude/inject.ts";
import { readRegistry, transcriptDirName, transcriptPathFor } from "../src/sessions/claude/registry.ts";
import { applyClaudeRow, newClaudeState, statsFor } from "../src/sessions/claude/transcript.ts";
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

  test("counts usage once per message id and the window from the last message", () => {
    const stats = statsFor(state);
    expect(stats.turns).toBe(1);
    expect(stats.tokens).toEqual({ in: 23, out: 250, cacheRead: 85803, cacheWrite: 6601 });
    expect(stats.cost).toBe(0);
    expect(stats.context).toBeUndefined();
    expect(state.stats.context?.used).toBe(31005);
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
    expect(Object.keys(readSettings(path)["hooks"] as object)).toHaveLength(9);
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
      expect(Object.keys(installed)).toHaveLength(9);
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
