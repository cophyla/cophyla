// The chat's own session is nobody's agent, and the sessions module keeps it apart: met under
// the id it was claimed with, it is the machine's own with no workspace, in no list and found
// by no id but through its own partition; none of its events is stored and nothing of it goes
// on the bus; its hooks are answered by the assistant module, which also hears its row's
// changes; a record an adapter met a moment too soon leaves the lists when it is claimed. The
// terminal it runs in, known by its label, is in no terminal list and never told, but its own
// pane opens it by id; no client ends it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { newId, RpcError, Scope } from "@cophyla/protocol";
import type { ClaudeHookEvent, ClientNotificationParams, Session, Terminal } from "@cophyla/protocol";
import { TetherClient } from "@tether-pty/client";
import { ClientRegistry } from "../src/api/clients.ts";
import { Bus } from "../src/bus.ts";
import { silentLogger } from "../src/log.ts";
import { ASSISTANT_PART } from "../src/sessions/index.ts";
import type { HarnessAdapter, HookInstallSpec, NormalisedHook, SessionRecord } from "../src/sessions/model.ts";
import { Tether } from "../src/sessions/tether/index.ts";
import { ASSISTANT_LABEL, TerminalRows, TerminalStreams } from "../src/sessions/tether/streams.ts";
import type { Workspaces } from "../src/workspaces/index.ts";
import { FakeTether } from "./fakes/tether.ts";
import { miniSessions, sleep, tempHome, removeHome, tomlString, waitFor } from "./helpers.ts";
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

const refusal = async (fn: () => unknown): Promise<string> => {
  try {
    await fn();
    return "ok";
  } catch (e) {
    return e instanceof RpcError ? `${e.code}: ${e.message}` : String(e);
  }
};

describe("the chat's own session among the sessions", () => {
  let mini: Mini;
  let scratch: string;
  let profile: string;
  let own: Session;
  let other: Session;
  let ownCwd: string;
  let userCwd: string;
  /** Every session's row and event the bus carried, whatever its partition. */
  const heard: { name: string; id: string; status?: string }[] = [];
  /** What the assistant module was handed. */
  const hooks: { hook: NormalisedHook; info: { ref?: string } }[] = [];
  const changed: Session[] = [];

  beforeAll(async () => {
    scratch = tempHome();
    ownCwd = join(scratch, "data", "assistant", "work");
    userCwd = join(scratch, "work", "app");
    const configDir = join(scratch, "claude-home");
    for (const dir of [ownCwd, userCwd, configDir]) mkdirSync(dir, { recursive: true });
    mini = await miniSessions(`[sessions]\ndiscover = false\ninstall_hooks = false\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(configDir)}\n`, () => [new NullAdapter()]);
    profile = mini.profiles.defaultFor("claude")!.id;
    mini.bus.onAll("session.state", (s) => heard.push({ name: "session.state", id: s.id, status: s.status }));
    mini.bus.onAll("session.event", (e) => heard.push({ name: "session.event", id: e.session }));
  }, 30_000);

  afterAll(async () => {
    await mini.stop();
    removeHome(scratch);
  });

  const seed = (nativeId: string, cwd: string, pid: number) => ({ harness: "claude" as const, nativeId, profile, cwd, transport: "pipe" as const, pid, status: "idle" as const, title: nativeId });
  const hook = (nativeId: string, cwd: string, event: ClaudeHookEvent["hook_event_name"], extra: Record<string, unknown> = {}): ClaudeHookEvent =>
    ({ session_id: nativeId, cwd, hook_event_name: event, ...extra }) as ClaudeHookEvent;

  test("met under the id it was claimed with, it is the machine's own, with no workspace and no user to its name", () => {
    mini.sessions.claimAssistant("claude", "chat-native");
    own = mini.sessions.ensure(seed("chat-native", ownCwd, 8001)).session;
    other = mini.sessions.ensure(seed("user-native", userCwd, 8002)).session;
    expect(own.role).toBe("assistant");
    expect(own.origin).toBe("orchestrator");
    expect(own.node).toBe(mini.sessions.nodeId);
    expect(own.workspace).toBeUndefined();
    expect(mini.workspaces.list().some((w) => ownCwd.toLowerCase().startsWith(w.path.toLowerCase()))).toBe(false);
    // any other session is as it ever was
    expect(other.role).toBeUndefined();
    expect(other.origin).toBe("user");
    expect(other.workspace).toBeDefined();
    // and the role is kept with its row
    expect(mini.store.sessions.get(own.id)?.role).toBe("assistant");
    expect(mini.store.sessions.get(other.id)?.role).toBeUndefined();
  });

  test("no list holds it, and no request by id finds it but through its own partition", async () => {
    expect(mini.sessions.list().map((s) => s.id)).toEqual([other.id]);
    expect(mini.sessions.list({ harness: "claude" }).map((s) => s.id)).toEqual([other.id]);
    expect(mini.sessions.get(own.id)).toBeUndefined();
    const none = `not_found: no session ${own.id}`;
    expect(await refusal(() => mini.sessions.history(own.id))).toBe(none);
    expect(await refusal(() => mini.sessions.annotate(own.id, { intent: "peek" }))).toBe(none);
    expect(await refusal(() => mini.sessions.send(own.id, "hi"))).toBe(none);
    expect(await refusal(() => mini.sessions.stopSession(own.id, { as: "user" }))).toBe(none);
    expect([...mini.sessions.pids().values()]).toEqual([other.id]);
    // a workspace node's view is no way in either
    const guest = mini.sessions.view(newId("node"));
    expect(guest.list()).toEqual([]);
    expect(guest.get(own.id)).toBeUndefined();
    // its own partition holds it, and it alone
    expect(mini.sessions.list({}, ASSISTANT_PART).map((s) => s.id)).toEqual([own.id]);
    expect(mini.sessions.get(own.id, ASSISTANT_PART)?.id).toBe(own.id);
    expect(mini.sessions.get(other.id, ASSISTANT_PART)).toBeUndefined();
    expect(await refusal(() => mini.sessions.history(other.id, {}, ASSISTANT_PART))).toBe(`not_found: no session ${other.id}`);
    expect(mini.sessions.assistantSession()?.id).toBe(own.id);
    // what follows a session wherever it is still finds it; the metrics tree walk claims no process for it,
    // since no client could show whose it is: its processes count to the machine alone
    expect(mini.sessions.getAny(own.id)?.id).toBe(own.id);
    expect([...mini.sessions.pidsAll().values()]).toEqual([other.id]);
  });

  test("its hooks are answered by the assistant module, with what it answers; none of its events is stored or told", async () => {
    mini.sessions.setAssistant({
      hook: (h, info) => {
        hooks.push({ hook: h, info });
        return h.name === "SessionStart" || h.name === "UserPromptSubmit" ? { hookSpecificOutput: { hookEventName: h.name, additionalContext: `told at ${h.name}` } } : undefined;
      },
      changed: (s) => changed.push(s),
    });
    const meta = { via: "http" as const };
    expect(await mini.sessions.onHook("claude", hook("chat-native", ownCwd, "SessionStart", { source: "startup" }), meta)).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "told at SessionStart" } });
    expect(await mini.sessions.onHook("claude", hook("chat-native", ownCwd, "UserPromptSubmit", { prompt: "what is open?", prompt_id: "p1" }), meta)).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "told at UserPromptSubmit" },
    });
    expect(await mini.sessions.onHook("claude", hook("chat-native", ownCwd, "PostToolUse", { tool_name: "Read", tool_input: { file_path: "notes.md" }, tool_response: "x" }), meta)).toEqual({});
    expect(await mini.sessions.onHook("claude", hook("chat-native", ownCwd, "Stop", { last_assistant_message: "Two sessions are open." }), meta)).toEqual({});
    await waitFor(() => hooks.length === 4);
    expect(hooks.map((h) => h.hook.name)).toEqual(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]);
    expect(hooks[0]!.hook).toMatchObject({ harness: "claude", sessionId: "chat-native", source: "startup" });
    // words typed into its terminal are no message of cophylad's: no ref names them
    expect(hooks[1]!).toMatchObject({ hook: { prompt: "what is open?", promptId: "p1" }, info: {} });
    expect(hooks[2]!.hook).toMatchObject({ toolName: "Read", toolInput: { file_path: "notes.md" } });
    expect(hooks[3]!.hook.lastAssistantMessage).toBe("Two sessions are open.");
    // nothing of the four is in the store or on the bus
    expect(mini.store.sessionEvents.count(own.id)).toBe(0);
    expect(heard.filter((h) => h.id === own.id)).toEqual([]);
    // its row's changes go to the module instead
    await waitFor(() => changed.some((s) => s.status === "idle" && s.id === own.id), 3000);
    expect(changed.every((s) => s.id === own.id && s.role === "assistant")).toBe(true);
  });

  test("a session of the user's is told and stored as ever, and the module hears nothing of it", async () => {
    const before = hooks.length;
    expect(await mini.sessions.onHook("claude", hook("user-native", userCwd, "UserPromptSubmit", { prompt: "fix the tests" }), { via: "http" })).toEqual({});
    expect(await mini.sessions.onHook("claude", hook("user-native", userCwd, "Stop", { last_assistant_message: "Fixed." }), { via: "http" })).toEqual({});
    expect(hooks.length).toBe(before);
    expect(mini.store.sessionEvents.count(other.id)).toBeGreaterThan(0);
    expect(heard.some((h) => h.name === "session.event" && h.id === other.id)).toBe(true);
    await waitFor(() => heard.some((h) => h.name === "session.state" && h.id === other.id));
    expect(changed.some((s) => s.id === other.id)).toBe(false);
  });

  test("a module that fails, or is not up, leaves the hook answered with nothing", async () => {
    mini.sessions.setAssistant({
      hook: () => {
        throw new Error("the module went");
      },
      changed: () => undefined,
    });
    expect(await mini.sessions.onHook("claude", hook("chat-native", ownCwd, "UserPromptSubmit", { prompt: "again" }), { via: "http" })).toEqual({});
    mini.sessions.setAssistant(undefined);
    expect(await mini.sessions.onHook("claude", hook("chat-native", ownCwd, "SessionStart", { source: "resume" }), { via: "http" })).toEqual({});
    expect(mini.store.sessionEvents.count(own.id)).toBe(0);
  });

  test("a record met a moment before it was claimed leaves the lists: its row is told once more, as ended", () => {
    const early = mini.sessions.ensure(seed("thread-early", userCwd, 8003)).session;
    expect(mini.sessions.list().map((s) => s.id)).toContain(early.id);
    expect(early.workspace).toBeDefined();
    const at = heard.length;
    mini.sessions.claimAssistant("claude", "thread-early");
    expect(mini.sessions.list().map((s) => s.id)).not.toContain(early.id);
    expect(mini.sessions.get(early.id)).toBeUndefined();
    const now = mini.sessions.get(early.id, ASSISTANT_PART)!;
    expect(now).toMatchObject({ role: "assistant", origin: "orchestrator", status: "idle" });
    expect(now.workspace).toBeUndefined();
    expect(mini.store.sessions.get(early.id)?.role).toBe("assistant");
    // what the clients heard of it is taken back; the record itself lives on
    expect(heard.slice(at)).toEqual([{ name: "session.state", id: early.id, status: "ended" }]);
    // claiming it again tells nothing more
    mini.sessions.claimAssistant("claude", "thread-early");
    expect(heard.slice(at)).toHaveLength(1);
  });

  test("ended, it is no longer the session the module would meet again", () => {
    const rec = mini.sessions.find("claude", "chat-native")!;
    mini.sessions.end(rec, "stopped");
    expect(mini.sessions.assistantSession()?.native.id).not.toBe("chat-native");
    expect(mini.sessions.list({}, ASSISTANT_PART).map((s) => s.native.id)).not.toContain("chat-native");
    expect(heard.filter((h) => h.id === own.id)).toEqual([]);
    expect(mini.store.sessionEvents.count(own.id)).toBe(0);
  });

  test("a Codex thread claimed as the chat's is kept apart the same when it is met, and is no session in a terminal to meet again", () => {
    const at = heard.length;
    mini.sessions.claimAssistant("codex", "thread-of-the-chat");
    const thread = mini.sessions.ensure({ harness: "codex", nativeId: "thread-of-the-chat", profile, cwd: ownCwd, transport: "app-server", status: "idle" }).session;
    expect(thread).toMatchObject({ role: "assistant", origin: "orchestrator", harness: "codex" });
    expect(thread.workspace).toBeUndefined();
    expect(mini.sessions.list().map((s) => s.id)).not.toContain(thread.id);
    expect(mini.sessions.list({ harness: "codex" })).toEqual([]);
    expect(mini.sessions.get(thread.id)).toBeUndefined();
    expect(heard.slice(at)).toEqual([]);
    // the module holds a thread through its own app-server, never through a record here
    expect(mini.sessions.assistantSession()?.id).not.toBe(thread.id);
    expect(mini.sessions.assistantSession()?.harness ?? "claude").toBe("claude");
    // and a record no transcript was read for has no size to tell
    expect(mini.sessions.assistantContext()).toBeUndefined();
  });
});

describe("the terminal the chat's own session runs in", () => {
  type Output = ClientNotificationParams<"terminal.output">;
  const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const A = "cli_01ARZ3NDEKTSV4RRFFQ69G5FA1";
  let scratch: string;
  let fake: FakeTether;
  let tether: Tether;
  let rows: TerminalRows;
  let streams: TerminalStreams;
  const told: Terminal[] = [];
  const frames: { method: string; params: unknown }[] = [];

  beforeAll(async () => {
    scratch = tempHome();
    fake = await new FakeTether(join(scratch, "tether")).start();
    tether = new Tether({
      config: { idle_exit_s: 600, window: "none", window_on_start: false, profiles: false, on_path: false, dir: fake.dir },
      env: {},
      dataDir: join(scratch, "data"),
      nodeId: NODE,
      log: silentLogger,
      exe: "C:/fake/tether.exe",
      run: async () => ({ code: 0, out: "tether 0.1.0\n", err: "" }),
      connectOrStart: (opts) => TetherClient.connect(fake.host, { name: opts.name ?? "cophylad" }),
    });
    await tether.start();
    const bus = new Bus();
    bus.on("terminal.state", (row) => told.push(row));
    const registry = new ClientRegistry();
    registry.add({ id: A, kind: "ui", scopes: [...Scope.options], via: "direct", audio: { in: false, out: false }, connectedAt: 1 }, { send: (d) => frames.push(JSON.parse(d)), close() {}, buffered: () => 0 }, "loopback");
    rows = new TerminalRows({ tether, bus, nodeId: NODE, workspaces: {} as unknown as Workspaces, env: {}, sessionOf: () => undefined, log: silentLogger, rowMs: 20 });
    streams = new TerminalStreams({ tether, registry, rows, log: silentLogger });
  }, 30_000);

  afterAll(async () => {
    await streams.stop();
    rows.stop();
    await tether.stop();
    await fake.stop();
    removeHome(scratch);
  });

  test("it is in no terminal list and its row is never told, whatever it does; a terminal beside it is", async () => {
    const own = fake.add({ argv: ["claude", "--session-id", "chat-native"], cwd: scratch, labels: { app: "cophylad", [ASSISTANT_LABEL]: "1", "cophylad.session": "chat-native" } });
    const plain = fake.add({ argv: ["pwsh.exe"], cwd: scratch, labels: { app: "cophylad" } });
    await waitFor(() => tether.byId(own.id) && tether.byId(plain.id));
    expect(rows.list().map((t) => t.id)).toEqual([plain.id]);
    expect(rows.visible(tether.byId(own.id)!)).toBe(false);
    expect(rows.visible(tether.byId(plain.id)!)).toBe(true);
    own.retitle("Cophyla");
    own.sized(90, 30);
    plain.retitle("build");
    await waitFor(() => told.some((r) => r.id === plain.id && r.title === "build"));
    await sleep(80);
    expect(told.filter((r) => r.id === own.id)).toEqual([]);
    expect(rows.list().map((t) => t.id)).toEqual([plain.id]);
  });

  test("its own pane opens it by id and follows its output; no client ends it", async () => {
    const own = [...fake.sessions.values()].find((s) => s.spawn.labels[ASSISTANT_LABEL] !== undefined)!;
    own.setScreen(["❯ "]);
    expect(rows.opens(tether.byId(own.id)!)).toBe(true);
    const r = await streams.open(A, own.id, {});
    expect(r.terminal.id).toBe(own.id);
    expect(r.data).toContain("❯ ");
    own.output("Two sessions are open.");
    await waitFor(() => frames.some((f) => f.method === "terminal.output" && (f.params as Output).terminal === own.id && (f.params as Output).data === "Two sessions are open."));
    // closing its view is the pane's to do; ending its program is not a client's
    await expect(streams.close(A, own.id, true)).rejects.toMatchObject({ code: "not_found" });
    expect(fake.requests.some((q) => q.op === "kill" && q.body["session"] === own.id)).toBe(false);
    expect(own.status).toBe("running");
    expect(streams.viewers(own.id)).toBe(0);
  });

  test("its end is told to no client either", async () => {
    const own = [...fake.sessions.values()].find((s) => s.spawn.labels[ASSISTANT_LABEL] !== undefined)!;
    const plain = [...fake.sessions.values()].find((s) => s.spawn.labels[ASSISTANT_LABEL] === undefined)!;
    own.exit(0);
    plain.exit(0);
    await waitFor(() => told.some((r) => r.id === plain.id && r.status === "exited"));
    await sleep(80);
    expect(told.filter((r) => r.id === own.id)).toEqual([]);
  });
});
