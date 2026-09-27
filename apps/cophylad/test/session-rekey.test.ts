// A Claude session whose id changes in the same process — `/clear`, or a plan's clear-context
// row — stays the same cophylad session: its origin, task, workspace and terminal stay, the old id
// stays an alias, its stats count on, and a late hook under the old id ends nothing. Its intent
// is the new conversation's: its first prompt, or the plan a clear-context row carries. The new
// id is followed from a rewritten registry entry, or from its first hook when the old one's
// `SessionEnd` said it was clearing. A clear with no new id ends the session once the grace
// runs out, and a new process that reused the pid is a new session.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeHookEvent, SessionEvent } from "@cophyla/protocol";
import { ClaudeAdapter, countOn } from "../src/sessions/claude/adapter.ts";
import { clearRegistry, miniSessions, tempHome, tomlString, waitFor, writeRegistry } from "./helpers.ts";
import type { Mini } from "./helpers.ts";

let mini: Mini;
let registry: string;
let cwd: string;
let profile: string;
const alive = new Set<number>();

const events = (id: string): SessionEvent[] => mini.store.sessionEvents.history(id, { limit: 1000 });

function hook(nativeId: string, event: ClaudeHookEvent["hook_event_name"], extra: Record<string, unknown> = {}): ClaudeHookEvent {
  return { session_id: nativeId, transcript_path: join(cwd, `${nativeId}.jsonl`), cwd, hook_event_name: event, permission_mode: "default", ...extra } as ClaudeHookEvent;
}

beforeAll(async () => {
  const scratch = tempHome();
  const profileDir = join(scratch, "claude-profile");
  registry = join(profileDir, "sessions");
  cwd = join(scratch, "work");
  mkdirSync(registry, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mini = await miniSessions(
    `[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 100000\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(profileDir)}\n`,
    (host, log) => [new ClaudeAdapter({ host, log, isAlive: (pid) => alive.has(pid), sharedSettings: join(profileDir, "none.json") })],
    { deps: { clearGraceMs: 300 } },
  );
  profile = mini.profiles.defaultFor("claude")!.id;
});

afterAll(() => mini.stop());

describe("a session whose id changes in the same process", () => {
  test("follows a rewritten registry entry, keeping what it is", async () => {
    alive.add(300);
    writeRegistry(registry, { pid: 300, sessionId: "a-old", cwd });
    const rec = mini.sessions.ensure({ harness: "claude", nativeId: "a-old", profile, cwd, transport: "pipe", pid: 300, origin: "orchestrator", task: "tsk_01ARZ3NDEKTSV4RRFFQ69G5FB7", terminal: { host: "h1", id: "t1" }, handles: { procStart: "134341311020543343" } });
    mini.sessions.patch(rec, { stats: { turns: 3, cost: 0.5, tokens: { in: 10, out: 20 }, context: { used: 900, limit: 1000 } } });
    await mini.sessions.tick();
    clearRegistry(registry, 300);
    writeRegistry(registry, { pid: 300, sessionId: "a-new", cwd });
    await mini.sessions.tick();

    const after = mini.sessions.find("claude", "a-new")!;
    expect(after).toBe(rec);
    expect(after.session.native).toEqual({ id: "a-new", pid: 300, transport: "pipe", terminal: { host: "h1", id: "t1" } });
    expect(after.session.origin).toBe("orchestrator");
    expect(after.session.task).toBe("tsk_01ARZ3NDEKTSV4RRFFQ69G5FB7");
    expect(mini.sessions.find("claude", "a-old")).toBe(rec);
    expect(mini.sessions.list().filter((s) => s.native.pid === 300)).toHaveLength(1);
    const cleared = events(rec.session.id).find((e) => e.kind === "notification" && (e.payload as { type: string }).type === "context_cleared")!;
    expect(cleared.payload).toEqual({ type: "context_cleared", from: "a-old", to: "a-new" });
    expect(rec.statsBase?.turns).toBe(3);
    expect(mini.store.sessions.get(rec.session.id)?.native.id).toBe("a-new");

    // The old id's SessionEnd, arriving late, ends nothing.
    await mini.sessions.onHook("claude", hook("a-old", "SessionEnd", { reason: "clear" }), { via: "http" });
    expect(mini.sessions.get(rec.session.id)?.status).not.toBe("ended");
  });

  test("follows the new id's first hook when the old one said it was clearing", async () => {
    alive.add(400);
    writeRegistry(registry, { pid: 400, sessionId: "b-old", cwd: join(cwd, "b") });
    await mini.sessions.tick();
    const rec = mini.sessions.find("claude", "b-old")!;
    const b = (id: string, event: ClaudeHookEvent["hook_event_name"], extra: Record<string, unknown> = {}) => ({ ...hook(id, event, extra), cwd: join(cwd, "b") }) as ClaudeHookEvent;
    await mini.sessions.onHook("claude", b("b-old", "SessionEnd", { reason: "clear" }), { via: "http" });
    expect(mini.sessions.get(rec.session.id)?.status).not.toBe("ended");
    // The registry still names the old id; the hook under the new one comes first.
    await mini.sessions.onHook("claude", b("b-new", "SessionStart", { source: "clear" }), { via: "http" });
    expect(mini.sessions.find("claude", "b-new")).toBe(rec);
    expect(rec.session.native.id).toBe("b-new");
    clearRegistry(registry, 400);
    writeRegistry(registry, { pid: 400, sessionId: "b-new", cwd: join(cwd, "b") });
    await mini.sessions.tick();
    expect(mini.sessions.list().filter((s) => s.native.pid === 400)).toHaveLength(1);
    await Bun.sleep(400);
    expect(mini.sessions.get(rec.session.id)?.status).not.toBe("ended");
  });

  test("a clear drops the intent: the new conversation's first prompt, or the plan it carries out, says what it is for", async () => {
    alive.add(700);
    const dir = join(cwd, "e");
    mkdirSync(dir, { recursive: true });
    writeRegistry(registry, { pid: 700, sessionId: "e-old", cwd: dir });
    await mini.sessions.tick();
    const rec = mini.sessions.find("claude", "e-old")!;
    const e = (id: string, event: ClaudeHookEvent["hook_event_name"], extra: Record<string, unknown> = {}) => ({ ...hook(id, event, extra), cwd: dir, transcript_path: join(dir, `${id}.jsonl`) }) as ClaudeHookEvent;
    await mini.sessions.onHook("claude", e("e-old", "UserPromptSubmit", { prompt: "check the NPC AI" }), { via: "http" });
    expect(rec.session.intent).toBe("check the NPC AI");

    // `/clear`, then a new task typed.
    await mini.sessions.onHook("claude", e("e-old", "SessionEnd", { reason: "clear" }), { via: "http" });
    await mini.sessions.onHook("claude", e("e-mid", "SessionStart", { source: "clear" }), { via: "http" });
    expect(rec.session.native.id).toBe("e-mid");
    expect(rec.session.intent).toBeUndefined();
    expect(mini.store.sessions.get(rec.session.id)?.intent).toBeUndefined();
    await mini.sessions.onHook("claude", e("e-mid", "UserPromptSubmit", { prompt: "give the gathering skill an aim upgrade" }), { via: "http" });
    expect(rec.session.intent).toBe("give the gathering skill an aim upgrade");

    // A plan's clear-context row: the new conversation opens on the plan, with no turn typed.
    await mini.sessions.onHook("claude", e("e-mid", "SessionEnd", { reason: "clear" }), { via: "http" });
    const plan = { type: "user", origin: { kind: "auto-continuation" }, planContent: "# Aim assist for gathering\n\n## Context\n…", message: { role: "user", content: "Implement the following plan: …" }, timestamp: new Date().toISOString() };
    writeFileSync(join(dir, "e-new.jsonl"), JSON.stringify(plan) + "\n");
    await mini.sessions.onHook("claude", e("e-new", "SessionStart", { source: "clear" }), { via: "http" });
    expect(rec.session.intent).toBeUndefined();
    clearRegistry(registry, 700);
    writeRegistry(registry, { pid: 700, sessionId: "e-new", cwd: dir });
    await mini.sessions.tick();
    expect(rec.session.intent).toBe("Aim assist for gathering");
  });

  test("a clear with no new id ends the session once the grace runs out", async () => {
    alive.add(500);
    writeRegistry(registry, { pid: 500, sessionId: "c-old", cwd: join(cwd, "c") });
    await mini.sessions.tick();
    const rec = mini.sessions.find("claude", "c-old")!;
    await mini.sessions.onHook("claude", { ...hook("c-old", "SessionEnd", { reason: "clear" }), cwd: join(cwd, "c") } as ClaudeHookEvent, { via: "http" });
    expect(rec.session.status).not.toBe("ended");
    await waitFor(() => rec.session.status === "ended", 3000);
    expect(events(rec.session.id).find((e) => e.kind === "ended")?.payload).toEqual({ reason: "clear" });
  });

  test("a new process that reused the pid is a new session", async () => {
    alive.add(600);
    writeRegistry(registry, { pid: 600, sessionId: "d-old", cwd, procStart: "111" });
    await mini.sessions.tick();
    const old = mini.sessions.find("claude", "d-old")!;
    clearRegistry(registry, 600);
    writeRegistry(registry, { pid: 600, sessionId: "d-new", cwd, procStart: "222" });
    await mini.sessions.tick();
    const fresh = mini.sessions.find("claude", "d-new")!;
    expect(fresh).not.toBe(old);
    expect(old.session.native.id).toBe("d-old");
  });
});

describe("stats across a clear", () => {
  test("turns and tokens add up; the context is the new one's; a zero cost is left to the price table", () => {
    const base = { turns: 3, cost: 0.5, tokens: { in: 10, out: 20, cacheRead: 5 }, context: { used: 900, limit: 1000 }, model: "m1" };
    expect(countOn(base, { turns: 1, cost: 0, tokens: { in: 1, out: 2 }, context: { used: 10, limit: 1000 } })).toEqual({ turns: 4, cost: 0, tokens: { in: 11, out: 22, cacheRead: 5 }, context: { used: 10, limit: 1000 }, model: "m1" });
    expect(countOn(base, { turns: 1, cost: 0.25, tokens: { in: 1, out: 2 }, model: "m2" }).cost).toBe(0.75);
    expect(countOn(undefined, base)).toBe(base);
  });
});
