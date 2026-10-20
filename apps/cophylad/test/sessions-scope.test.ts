// Which of the user's own sessions a node connects to. The test itself: a profile left off, a
// session outside tether when only tether's are wanted, outside the allowed folders or inside a
// hidden one, is not connected, and one Cophyla started always is. In the registry: a session
// outside the scope is in no list and found by no id, none of its events is kept or told, a
// question of its own is left to its window, and it has no workspace until it comes in; one the
// clients knew, moved out by a new scope, is told once as ended, and told as it stands when it
// comes back. The scope is kept in the node's kv, marked set the first time; over the client
// protocol a folder must be a whole path, and `~` is the home.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RpcError } from "@cophyla/protocol";
import type { ClaudeHookEvent, Session, SessionScope, SessionScopeState } from "@cophyla/protocol";
import type { HarnessAdapter, HookInstallSpec, NormalisedHook, SessionRecord } from "../src/sessions/model.ts";
import { admits, checkScope, normaliseScope, OPEN_SCOPE, SCOPE_KV_NS, ScopeStore } from "../src/sessions/scope.ts";
import { EXCLUDED_KV_NS } from "../src/nodes/replication.ts";
import { RESERVED_KV_NS } from "../src/grants/namespaces.ts";
import { miniSessions, removeHome, stopDaemon, tempHome, TestClient, testDaemon, tomlString, waitFor } from "./helpers.ts";
import type { Mini } from "./helpers.ts";

class NullAdapter implements HarnessAdapter {
  readonly harness = "claude" as const;
  async start(_p: unknown, _h: HookInstallSpec | undefined): Promise<void> {}
  async stop(): Promise<void> {}
  async tick(): Promise<void> {}
  async send(): Promise<{ status: "queued" }> {
    return { status: "queued" };
  }
  onHook(_hook: NormalisedHook, rec: SessionRecord | undefined): SessionRecord | undefined {
    return rec;
  }
}

const scope = (over: Partial<SessionScope> = {}): SessionScope => ({ ...OPEN_SCOPE, ...over });

const base = { profile: "prof_a", cwd: "C:/work/app", origin: "user" as const, native: { id: "n", transport: "pipe" as const } };

describe("the scope's test", () => {
  test("every session is in an open scope", () => {
    expect(admits(OPEN_SCOPE, base, "win32")).toBe(true);
  });

  test("a profile left off, and a session outside tether when only tether's are wanted, are out", () => {
    expect(admits(scope({ profilesOff: ["prof_a"] }), base, "win32")).toBe(false);
    expect(admits(scope({ profilesOff: ["prof_b"] }), base, "win32")).toBe(true);
    expect(admits(scope({ tetherOnly: true }), base, "win32")).toBe(false);
    expect(admits(scope({ tetherOnly: true }), { ...base, native: { ...base.native, terminal: { host: "h", id: "t1" } } }, "win32")).toBe(true);
  });

  test("an allowed folder holds what is under it, whichever way it is written; a hidden one wins inside it", () => {
    const s = scope({ allowedFolders: ["c:\\Work"], hiddenFolders: ["C:/work/app/secret"] });
    expect(admits(s, base, "win32")).toBe(true);
    expect(admits(s, { ...base, cwd: "C:\\work" }, "win32")).toBe(true);
    expect(admits(s, { ...base, cwd: "C:/workshop" }, "win32")).toBe(false);
    expect(admits(s, { ...base, cwd: "C:/other" }, "win32")).toBe(false);
    expect(admits(s, { ...base, cwd: "C:/work/app/secret/deep" }, "win32")).toBe(false);
    // case counts where the filesystem says it does
    expect(admits(scope({ hiddenFolders: ["/home/me/Private"] }), { ...base, cwd: "/home/me/private/x" }, "linux")).toBe(true);
    expect(admits(scope({ hiddenFolders: ["/home/me/Private"] }), { ...base, cwd: "/home/me/Private/x" }, "linux")).toBe(false);
  });

  test("a session Cophyla started, spawned over ACP, or the chat's own is always in", () => {
    const closed = scope({ profilesOff: ["prof_a"], tetherOnly: true, allowedFolders: ["D:/elsewhere"] });
    expect(admits(closed, { ...base, origin: "orchestrator" }, "win32")).toBe(true);
    expect(admits(closed, { ...base, native: { id: "n", transport: "acp" } }, "win32")).toBe(true);
    expect(admits(closed, { ...base, role: "assistant" }, "win32")).toBe(true);
  });

  test("kept without blanks or repeats; a folder written two ways is kept once", () => {
    expect(normaliseScope(scope({ profilesOff: ["prof_a", "prof_a"], allowedFolders: [" C:\\work ", "c:/work/", ""], hiddenFolders: ["C:\\work\\a"] }), "win32")).toEqual(scope({ profilesOff: ["prof_a"], allowedFolders: ["C:\\work"], hiddenFolders: ["C:\\work\\a"] }));
  });

  test("a folder sent must be a whole path; ~ is the home", () => {
    const home = process.platform === "win32" ? "C:\\Users\\me" : "/home/me";
    const ok = checkScope(scope({ hiddenFolders: ["~"], allowedFolders: ["~/code"] }), home);
    expect(ok.hiddenFolders).toEqual([home]);
    expect(ok.allowedFolders).toEqual([join(home, "code")]);
    expect(() => checkScope(scope({ hiddenFolders: ["code/app"] }), home)).toThrow(RpcError);
  });

  test("the scope is the node's own: never replicated, backed up, or the brain's to read", () => {
    expect(EXCLUDED_KV_NS).toContain(SCOPE_KV_NS);
    expect(RESERVED_KV_NS).toContain(SCOPE_KV_NS);
  });
});

describe("the scope in the session registry", () => {
  let mini: Mini;
  let scratch: string;
  let work: string;
  let home: string;
  let inApp: string;
  let inSecret: string;
  let elsewhere: string;
  const heard: { name: string; id: string; status?: string }[] = [];
  const rows = new Map<string, Session>();

  beforeAll(async () => {
    scratch = tempHome();
    inApp = join(scratch, "work", "app");
    inSecret = join(scratch, "work", "app", "secret");
    elsewhere = join(scratch, "elsewhere");
    const workDir = join(scratch, "claude-work");
    const homeDir = join(scratch, "claude-home");
    for (const dir of [inApp, inSecret, elsewhere, workDir, homeDir]) mkdirSync(dir, { recursive: true });
    const toml = `[sessions]\ndiscover = false\ninstall_hooks = false\n\n[[profiles]]\nharness = "claude"\nname = "work"\nconfig_dir = ${tomlString(workDir)}\ndefault = true\n\n[[profiles]]\nharness = "claude"\nname = "home"\nconfig_dir = ${tomlString(homeDir)}\n`;
    mini = await miniSessions(toml, () => [new NullAdapter()]);
    const profiles = mini.profiles.list();
    work = profiles.find((p) => p.name === "work")!.id;
    home = profiles.find((p) => p.name === "home")!.id;
    mini.bus.onAll("session.state", (s) => heard.push({ name: "session.state", id: s.id, status: s.status }));
    mini.bus.onAll("session.event", (e) => heard.push({ name: "session.event", id: e.session }));
    const seed = (nativeId: string, profile: string, cwd: string, pid: number, extra: Record<string, unknown> = {}) => ({ harness: "claude" as const, nativeId, profile, cwd, transport: "pipe" as const, pid, status: "idle" as const, title: nativeId, ...extra });
    for (const s of [
      seed("app", work, inApp, 9001),
      seed("secret", work, inSecret, 9002),
      seed("far", work, elsewhere, 9003, { terminal: { host: "host_1", id: "t1" } }),
      seed("personal", home, inApp, 9004),
      seed("spawned", home, elsewhere, 9005, { origin: "orchestrator" }),
    ]) {
      const rec = mini.sessions.ensure(s);
      rows.set(s.nativeId, rec.session);
    }
  }, 30_000);

  afterAll(async () => {
    await mini.stop();
    removeHome(scratch);
  });

  const listed = () => mini.sessions.list().map((s) => s.title).sort();
  const hook = (nativeId: string, cwd: string, event: ClaudeHookEvent["hook_event_name"], extra: Record<string, unknown> = {}): ClaudeHookEvent => ({ session_id: nativeId, cwd, hook_event_name: event, ...extra }) as ClaudeHookEvent;

  test("open until the user sets it: every session listed, and the scope not yet set", () => {
    expect(listed()).toEqual(["app", "far", "personal", "secret", "spawned"]);
    expect(mini.sessions.scopeState()).toEqual({ node: mini.sessions.nodeId, scope: OPEN_SCOPE });
  });

  test("a profile left off: its sessions leave every list, told once as ended, while the ones Cophyla started stay", async () => {
    await waitFor(() => heard.some((h) => h.id === rows.get("personal")!.id && h.status === "idle"));
    const at = heard.length;
    const state = mini.sessions.setScope(scope({ profilesOff: [home] }));
    expect(state.scope.profilesOff).toEqual([home]);
    expect(typeof state.setupAt).toBe("number");
    expect(listed()).toEqual(["app", "far", "secret", "spawned"]);
    const personal = rows.get("personal")!.id;
    expect(heard.slice(at)).toEqual([{ name: "session.state", id: personal, status: "ended" }]);
    // found by no id, by a client or the brain
    expect(mini.sessions.get(personal)).toBeUndefined();
    expect(() => mini.sessions.history(personal)).toThrow(RpcError);
    expect([...mini.sessions.pids().values()]).not.toContain(personal);
    // the record runs on, and the row is kept
    expect(mini.sessions.getAny(personal)?.status).toBe("idle");
  });

  test("a session outside the scope keeps none of its events, tells nothing, and asks in its own window", async () => {
    const personal = rows.get("personal")!.id;
    const kept = mini.store.sessionEvents.count(personal);
    const at = heard.length;
    expect(await mini.sessions.onHook("claude", hook("personal", inApp, "UserPromptSubmit", { prompt: "private" }), { via: "http" })).toEqual({});
    expect(await mini.sessions.onHook("claude", hook("personal", inApp, "PermissionRequest", { tool_name: "Bash", tool_input: { command: "ls" } }), { via: "http" })).toEqual({});
    expect(await mini.sessions.onHook("claude", hook("personal", inApp, "Stop", { last_assistant_message: "done" }), { via: "http" })).toEqual({});
    await new Promise((r) => setTimeout(r, 400));
    expect(mini.store.sessionEvents.count(personal)).toBe(kept);
    expect(heard.slice(at).filter((h) => h.id === personal)).toEqual([]);
    expect(mini.asks.listOpen()).toEqual([]);
  });

  test("tether only: a session in a tether terminal stays, the others go", () => {
    mini.sessions.setScope(scope({ tetherOnly: true }));
    expect(listed()).toEqual(["far", "spawned"]);
  });

  test("an allowed folder narrows to what is under it, and a hidden folder inside it still hides", () => {
    mini.sessions.setScope(scope({ allowedFolders: [join(scratch, "work")], hiddenFolders: [inSecret] }));
    expect(listed()).toEqual(["app", "personal", "spawned"]);
  });

  test("open again: every session comes back as it stands, not ended", async () => {
    const at = heard.length;
    mini.sessions.setScope(OPEN_SCOPE);
    expect(listed()).toEqual(["app", "far", "personal", "secret", "spawned"]);
    const back = heard.slice(at).filter((h) => h.name === "session.state");
    expect(back.map((h) => h.id).sort()).toEqual([rows.get("far")!.id, rows.get("secret")!.id].sort());
    expect(back.every((h) => h.status === "idle")).toBe(true);
  });

  test("a session met outside the scope has no workspace, and gets one when it comes in", () => {
    const later = join(scratch, "later");
    mkdirSync(later, { recursive: true });
    mini.sessions.setScope(scope({ hiddenFolders: [later] }));
    const late = mini.sessions.ensure({ harness: "claude", nativeId: "late", profile: work, cwd: later, transport: "pipe", pid: 9006, status: "idle", title: "late" });
    expect(late.session.workspace).toBeUndefined();
    expect(mini.workspaces.list().some((w) => w.path === later)).toBe(false);
    mini.sessions.setScope(OPEN_SCOPE);
    expect(mini.sessions.get(late.session.id)?.workspace).toBeDefined();
  });

  test("kept in the node's kv, and read back by the next run", () => {
    mini.sessions.setScope(scope({ tetherOnly: true, hiddenFolders: [elsewhere] }));
    const again = new ScopeStore(mini.store);
    expect(again.get()).toEqual(scope({ tetherOnly: true, hiddenFolders: [elsewhere] }));
    expect(again.setupAt()).toBe(mini.sessions.scopeState().setupAt!);
    mini.sessions.setScope(OPEN_SCOPE);
  });
});

describe("the scope over the client protocol", () => {
  test("read, set whole and marked set; a folder that is not a whole path is refused", async () => {
    const d = await testDaemon();
    const c = await TestClient.connect(d.api.url);
    try {
      await c.hello(d.token, { name: "app" });
      const first = await c.request<SessionScopeState>("session.scope", {});
      expect(first.scope).toEqual(OPEN_SCOPE);
      expect(first.setupAt).toBeUndefined();
      const bad = await c.call("session.setScope", { scope: scope({ hiddenFolders: ["relative/folder"] }) });
      expect("error" in bad && bad.error.message).toContain("is not a whole path");
      const folder = join(d.home, "private");
      const set = await c.request<SessionScopeState>("session.setScope", { scope: scope({ tetherOnly: true, hiddenFolders: [folder] }) });
      expect(set.scope).toEqual(scope({ tetherOnly: true, hiddenFolders: [folder] }));
      expect(typeof set.setupAt).toBe("number");
      expect(await c.request<SessionScopeState>("session.scope", { node: first.node })).toEqual(set);
    } finally {
      c.close();
      await stopDaemon(d);
    }
  }, 30_000);
});
