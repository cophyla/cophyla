// The ACP adapter over the fake agent through `Sessions`: the spawn shape and the profile's
// environment, busy → idle around a prompt, the event order and shapes for chunks, tool
// calls and plans, a permission request as an Ask that the answer resolves (a plan approval
// showing the plan itself), a cancelled ask
// answered with the reject option, a form elicitation as one choice ask per question whose
// answers are accepted together (declined when cancelled, abandoned or unshowable), a second
// send queued behind a turn, stop, a hook posted for the native id answered `{}`, and
// `session.stop` refused on an attached session.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Ask, Session, SessionEvent } from "@cophyla/protocol";
import { pickRuntime } from "../src/sessions/acp/adapter.ts";
import type { HarnessAdapter, HookInstallSpec, NormalisedHook, SessionHost, SessionRecord } from "../src/sessions/model.ts";
import { parseConfig } from "../src/config/load.ts";
import { miniSessions, sleep, tempHome, tomlString, waitFor } from "./helpers.ts";
import type { Mini } from "./helpers.ts";

const FAKE_AGENT = join(import.meta.dir, "fakes", "acp-agent.ts");
/** The plan the fake agent asks to build. */
const PLAN = "## Plan\n\n1. Read the file\n2. Write the file";
const CLIENT = "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7";

/** An attached adapter that records the hooks it is asked about and owns nothing. */
class NullAdapter implements HarnessAdapter {
  readonly harness = "claude" as const;
  hooks: NormalisedHook[] = [];
  async start(_p: unknown, _h: HookInstallSpec | undefined): Promise<void> {}
  async stop(): Promise<void> {}
  async tick(): Promise<void> {}
  async send(): Promise<{ status: "queued" }> {
    return { status: "queued" };
  }
  onHook(hook: NormalisedHook, rec: SessionRecord | undefined): SessionRecord | undefined {
    this.hooks.push(hook);
    return rec;
  }
}

let mini: Mini;
let nullAdapter: NullAdapter;
let wsId: string;
let cwd: string;
let configDir: string;

const events = (id: string): SessionEvent[] => mini.store.sessionEvents.history(id, { limit: 1000 });

beforeAll(async () => {
  const scratch = tempHome();
  cwd = join(scratch, "work");
  configDir = join(scratch, "claude-home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const toml = `[sessions]\ndiscover = false\ninstall_hooks = false\nlaunch = "acp"\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(configDir)}\ncommand = "claude-fake.exe"\nenv = { TEST_PROFILE_VAR = "from-profile" }\n\n[acp]\nspawn_timeout_ms = 10000\n[acp.claude]\ncommand = ${tomlString(FAKE_AGENT)}\n`;
  nullAdapter = new NullAdapter();
  mini = await miniSessions(toml, () => [nullAdapter], { acp: (config) => ({ config: config.acp, env: { ...process.env, CLAUDE_CODE_SESSION_ID: "leak-me", TEST_PROFILE_VAR: "from-daemon" } }) });
  wsId = mini.workspaces.put({ node: mini.sessions.nodeId, path: cwd, name: "work" }).id;
}, 30_000);

afterAll(async () => {
  await mini.stop();
});

async function spawn(prompt: string): Promise<Session> {
  return mini.sessions.spawn({ harness: "claude", workspace: wsId, prompt }, { profiles: mini.profiles });
}

describe("acp sessions", () => {
  test("pickRuntime prefers node on PATH, else bun", () => {
    expect(pickRuntime("node", "C:\\bun.exe", () => "C:\\node.exe")).toBe("C:\\node.exe");
    expect(pickRuntime("node", "C:\\bun.exe", () => null)).toBe("C:\\bun.exe");
    expect(pickRuntime("bun", "C:\\bun.exe", () => "C:\\node.exe")).toBe("C:\\bun.exe");
  });

  test("spawn: the session's shape, the profile's environment, busy then idle, the chunks folded into one text", async () => {
    const s = await spawn("say hi");
    expect(s.origin).toBe("orchestrator");
    expect(s.native.transport).toBe("acp");
    expect(s.native.pid).toBeGreaterThan(0);
    expect(s.workspace).toBe(wsId);
    expect(s.cwd.toLowerCase()).toBe(cwd.toLowerCase());
    expect(s.intent).toBe("say hi");
    expect(s.profile).toBe(mini.profiles.byHarness("claude")[0]!.id);
    expect(mini.sessions.list({ status: ["busy"] }).map((x) => x.id)).toContain(s.id);
    await waitFor(() => mini.sessions.get(s.id)?.status === "idle");
    const evs = events(s.id);
    expect(evs.map((e) => e.kind)).toEqual(["status", "status", "user_turn", "assistant_text", "status", "status"]);
    expect(evs[2]!.payload).toEqual({ text: "say hi", source: "orchestrator", ref: expect.stringMatching(/^cophylad-spawn-/) });
    expect(evs[3]!.payload).toEqual({ text: "Hi there." });
    expect(evs[4]!.payload).toEqual({ status: "idle", stopReason: "end_turn" });
    const after = mini.sessions.get(s.id)!;
    expect(after.stats).toEqual({ turns: 1, cost: 0.01, tokens: { in: 10, out: 5, cacheRead: 100, cacheWrite: 7 }, context: { used: 1200, limit: 200000 } });
    // The attached adapter never sees the record; the ACP adapter's native id is taken.
    expect(mini.sessions.ownedByAcp("claude", after.native.id)).toBe(true);
    expect((mini.sessions as unknown as { records(h: string): SessionRecord[] }).records("claude")).toEqual([]);
    await mini.sessions.stopSession(s.id);
    await waitFor(() => mini.sessions.get(s.id)?.status === "ended");
  });

  test("a record an attached adapter discovered first is taken over by the ACP seed and tailed by no one else", async () => {
    // The harness writes its registry entry before session/new returns: the Claude adapter's tick ensures first.
    const profile = mini.profiles.byHarness("claude")[0]!;
    const first = mini.sessions.ensure({ harness: "claude", nativeId: "race-1", profile: profile.id, cwd, transport: "pipe", pid: process.pid, status: "busy", handles: { pipe: "pipe-x" } });
    expect(first.session.origin).toBe("user");
    expect((mini.sessions as unknown as { records(h: string): SessionRecord[] }).records("claude").map((r) => r.session.id)).toContain(first.session.id);
    first.tail = {} as SessionRecord["tail"];
    // Then the ACP adapter arrives with the same native id.
    const second = mini.sessions.ensure({ harness: "claude", nativeId: "race-1", profile: profile.id, cwd, transport: "acp", pid: 4242, origin: "orchestrator", task: "task_race", workspace: wsId, status: "idle", intent: "fix the race" });
    expect(second.session.id).toBe(first.session.id);
    expect(second.session.native).toEqual({ id: "race-1", transport: "acp", pid: 4242 });
    expect(second.session.origin).toBe("orchestrator");
    expect(second.session.task).toBe("task_race");
    expect(second.session.workspace).toBe(wsId);
    expect(second.session.intent).toBe("fix the race");
    expect(second.tail).toBeUndefined();
    expect(second.handles).toEqual({});
    expect(mini.sessions.ownedByAcp("claude", "race-1")).toBe(true);
    expect((mini.sessions as unknown as { records(h: string): SessionRecord[] }).records("claude").map((r) => r.session.id)).not.toContain(first.session.id);
    expect(mini.store.sessions.get(first.session.id)?.origin).toBe("orchestrator");
    // A later attached ensure leaves it alone.
    const third = mini.sessions.ensure({ harness: "claude", nativeId: "race-1", profile: profile.id, cwd, transport: "pipe", pid: process.pid, status: "busy" });
    expect(third.session.native.transport).toBe("acp");
    mini.sessions.end(third, "gone", mini.sessions.now());
  });

  test("the environment the child gets: scrubbed CLAUDE_CODE_*, the profile's dir, exec and env winning over the daemon's", async () => {
    // The fake echoes its environment in `initialize`; read it back through the adapter's log is not possible,
    // so spawn a child directly and ask it.
    const { StdioRpc } = await import("../src/rpc/stdio.ts");
    const { silentLogger } = await import("../src/log.ts");
    const { AcpAdapter } = await import("../src/sessions/acp/adapter.ts");
    const profile = mini.profiles.byHarness("claude")[0]!;
    const adapter = new AcpAdapter({ host: mini.sessions, asks: mini.asks, config: parseConfig(`[acp.claude]\ncommand = ${tomlString(FAKE_AGENT)}\n`).acp, log: silentLogger, env: { ...process.env, CLAUDE_CODE_SESSION_ID: "leak", TEST_PROFILE_VAR: "daemon" }, askTimeoutS: 60 });
    const env = (adapter as unknown as { envFor(i: unknown): Record<string, string> }).envFor({ harness: "claude", profile, cwd, workspace: wsId, prompt: "x" });
    expect(env["CLAUDE_CONFIG_DIR"]).toBe(configDir);
    expect(env["CLAUDE_CODE_EXECUTABLE"]).toBe("claude-fake.exe");
    expect(env["TEST_PROFILE_VAR"]).toBe("from-profile");
    expect(env["CLAUDE_CODE_SESSION_ID"]).toBeUndefined();
    const rpc = new StdioRpc({ command: process.execPath, args: [FAKE_AGENT], env, log: silentLogger });
    const init = (await rpc.request("initialize", {})) as { _meta: { env: Record<string, unknown> } };
    expect(init._meta.env["CLAUDE_CONFIG_DIR"]).toBe(configDir);
    expect(init._meta.env["TEST_PROFILE_VAR"]).toBe("from-profile");
    expect(init._meta.env["leaked"]).toEqual([]);
    await rpc.stop();
    // Claude's own directory is named by leaving the variable unset, and an inherited one goes.
    const home = join(configDir, "..");
    const own = { ...profile, configDir: join(home, ".claude"), env: {} };
    const homed = new AcpAdapter({ host: mini.sessions, asks: mini.asks, config: parseConfig("").acp, log: silentLogger, env: { PATH: "x", CLAUDE_CONFIG_DIR: "C:/inherited" }, askTimeoutS: 60, home });
    const ownEnv = (homed as unknown as { envFor(i: unknown): Record<string, string> }).envFor({ harness: "claude", profile: own, cwd, workspace: wsId, prompt: "x" });
    expect("CLAUDE_CONFIG_DIR" in ownEnv).toBe(false);
    expect(ownEnv["PATH"]).toBe("x");
  });

  test("a tool call is written once its input is known, then its result; plans and modes are notifications", async () => {
    const s = await spawn("use tool");
    await waitFor(() => mini.sessions.get(s.id)?.status === "idle");
    const evs = events(s.id).filter((e) => e.kind === "tool_call" || e.kind === "tool_result" || e.kind === "assistant_text");
    expect(evs.map((e) => e.kind)).toEqual(["tool_call", "tool_result", "assistant_text"]);
    expect(evs[0]!.payload).toEqual({ id: "tc1", tool: "Write", title: "Write x.txt", kind: "edit", input: { file_path: "x.txt", content: "hello" } });
    expect(evs[1]!.payload).toEqual({ id: "tc1", tool: "Write", title: "Write x.txt", result: "File created successfully at: x.txt" });
    expect(evs[0]!.raw).toBeDefined();
    await mini.sessions.send(s.id, "plan it");
    await waitFor(() => events(s.id).some((e) => e.kind === "notification" && (e.payload as { type: string }).type === "mode"));
    await waitFor(() => mini.sessions.get(s.id)?.status === "idle" && events(s.id).filter((e) => e.kind === "user_turn").length === 2);
    const notes = events(s.id).filter((e) => e.kind === "notification").map((e) => e.payload as { type: string; entries?: unknown });
    expect(notes.map((n) => n.type)).toEqual(["message", "plan", "mode"]);
    expect(notes[1]).toEqual({ type: "plan", entries: [{ content: "Read the code", status: "completed", priority: "high" }, { content: "Fix it", status: "in_progress", priority: "medium" }] });
    expect(mini.sessions.get(s.id)?.title).toBe("A plan");
    // Thoughts are dropped.
    expect(events(s.id).some((e) => e.kind === "assistant_text" && (e.payload as { text: string }).text === "thinking")).toBe(false);
    await mini.sessions.stopSession(s.id);
  });

  test("a permission request is an Ask with the agent's options; the answer resolves the agent; a cancelled ask rejects", async () => {
    const asks: Ask[] = [];
    const off = mini.bus.on("ask.state", (a) => asks.push(a));
    const s = await spawn("please ask me");
    const opened = await waitFor(() => asks.find((a) => a.status === "open"));
    expect(opened.type).toBe("permission");
    expect(opened.source).toEqual({ kind: "harness", session: s.id });
    expect(opened.title).toBe("Run rm -rf build in work");
    expect(opened.detail).toBe("rm -rf build");
    expect(opened.options).toEqual([
      { id: "allow-once", label: "Yes", style: "primary" },
      { id: "allow-always", label: "Yes, always", style: "primary" },
      { id: "reject", label: "No", style: "danger" },
    ]);
    expect(opened.answerableBy).toEqual(["user", "brain"]);
    expect(opened.expiresAt).toBeGreaterThan(opened.createdAt);
    expect(mini.sessions.get(s.id)?.status).toBe("needs_permission");
    expect(mini.sessions.get(s.id)?.ask).toBe(opened.id);
    mini.asks.answer(opened.id, { option: "allow-once" }, { kind: "brain" });
    await waitFor(() => mini.sessions.get(s.id)?.status === "idle");
    const evs = events(s.id);
    expect(evs.filter((e) => e.kind === "ask").map((e) => (e.payload as { phase: string }).phase)).toEqual(["opened", "answered"]);
    expect(evs.find((e) => e.kind === "assistant_text")!.payload).toEqual({ text: "you chose allow-once" });
    expect(evs.find((e) => e.kind === "tool_result")!.payload).toMatchObject({ id: "tc2", tool: "Bash", result: "you chose allow-once" });
    expect(mini.sessions.get(s.id)?.ask).toBeUndefined();

    // A second ask, cancelled: the agent gets the reject option.
    await mini.sessions.send(s.id, "ask again");
    const second = await waitFor(() => asks.find((a) => a.status === "open" && a.id !== opened.id));
    mini.asks.cancel(second.id);
    await waitFor(() => mini.sessions.get(s.id)?.status === "idle" && events(s.id).filter((e) => e.kind === "assistant_text").length === 2);
    expect(events(s.id).filter((e) => e.kind === "assistant_text")[1]!.payload).toEqual({ text: "you chose reject" });
    expect(events(s.id).filter((e) => e.kind === "ask").map((e) => (e.payload as { phase: string; reason?: string }).reason)).toEqual([undefined, undefined, undefined, "cancelled"]);
    off();
    await mini.sessions.stopSession(s.id);
  });

  test("a plan approval shows the plan, not its input as JSON, and keeps the agent's own options", async () => {
    const asks: Ask[] = [];
    const off = mini.bus.on("ask.state", (a) => asks.push(a));
    const s = await spawn("please approve this");
    const opened = await waitFor(() => asks.find((a) => a.status === "open"));
    expect(opened.type).toBe("permission");
    expect(opened.title).toBe("Approve Plan in work");
    expect(opened.detail).toBe(PLAN);
    expect(opened.options.map((o) => o.id)).toEqual(["exit_plan_accept_edits", "exit_plan_default", "reject"]);
    mini.asks.answer(opened.id, { option: "exit_plan_accept_edits" }, { kind: "user", client: CLIENT });
    await waitFor(() => mini.sessions.get(s.id)?.status === "idle");
    expect(events(s.id).find((e) => e.kind === "assistant_text")!.payload).toEqual({ text: "you chose exit_plan_accept_edits" });
    off();
    await mini.sessions.stopSession(s.id);
  });

  test("a form elicitation is one choice ask per question, opened in turn; the answers are accepted together", async () => {
    const asks: Ask[] = [];
    const off = mini.bus.on("ask.state", (a) => asks.push(a));
    const s = await spawn("question me");
    const first = await waitFor(() => asks.find((a) => a.status === "open"));
    expect(first).toMatchObject({
      type: "choice",
      source: { kind: "harness", session: s.id },
      title: "Which cache?",
      detail: "Cache · 1 of 2",
      options: [{ id: "Redis", label: "Redis", description: "In-memory, persistent" }, { id: "Memcached", label: "Memcached" }],
      allowsText: true,
      answerableBy: ["user", "brain"],
    });
    expect(first.multiple).toBeUndefined();
    expect(first.expiresAt).toBeGreaterThan(first.createdAt);
    expect(mini.sessions.get(s.id)?.status).toBe("needs_input");
    expect(mini.sessions.get(s.id)?.ask).toBe(first.id);
    // The tool call was announced from the stream before the form arrived.
    expect(events(s.id).find((e) => e.kind === "tool_call")!.payload).toMatchObject({ id: "tc3", tool: "AskUserQuestion", title: "Asking the user" });
    mini.asks.answer(first.id, { option: "Redis", text: "managed please" }, { kind: "brain" });
    const second = await waitFor(() => asks.find((a) => a.status === "open" && a.id !== first.id));
    expect(second).toMatchObject({ type: "choice", title: "Which tools?", detail: "Tools · 2 of 2", multiple: true, allowsText: true, options: [{ id: "ESLint", label: "ESLint" }, { id: "Prettier", label: "Prettier" }] });
    expect(mini.store.asks.get(first.id)?.status).toBe("answered");
    expect(mini.sessions.get(s.id)?.status).toBe("needs_input");
    expect(mini.sessions.get(s.id)?.ask).toBe(second.id);
    mini.asks.answer(second.id, { option: "ESLint", options: ["ESLint", "Prettier"], text: "Biome" }, { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" });
    await waitFor(() => mini.sessions.get(s.id)?.status === "idle");
    const texts = events(s.id).filter((e) => e.kind === "assistant_text").map((e) => (e.payload as { text: string }).text);
    expect(texts[0]).toBe('caps={"form":{}}');
    expect(texts[1]).toBe('answer={"action":"accept","content":{"question_0":"Redis","question_0_custom":"managed please","question_1":["ESLint","Prettier"],"question_1_custom":"Biome"}}');
    const askEvents = events(s.id).filter((e) => e.kind === "ask").map((e) => e.payload as Record<string, unknown>);
    expect(askEvents).toEqual([
      { ask: first.id, phase: "opened", tool: "AskUserQuestion", question: 1, of: 2, id: "tc3", title: first.title, detail: first.detail, options: first.options.map((o) => o.label) },
      { ask: first.id, phase: "answered", answer: expect.objectContaining({ option: "Redis", text: "managed please" }) },
      { ask: second.id, phase: "opened", tool: "AskUserQuestion", question: 2, of: 2, id: "tc3", title: "Which tools?", detail: "Tools · 2 of 2", options: ["ESLint", "Prettier"] },
      { ask: second.id, phase: "answered", answer: expect.objectContaining({ options: ["ESLint", "Prettier"] }) },
    ]);
    expect(events(s.id).find((e) => e.kind === "tool_result")!.payload).toMatchObject({ id: "tc3", tool: "AskUserQuestion", result: expect.stringContaining("accept") });
    expect(mini.sessions.get(s.id)?.ask).toBeUndefined();
    off();
    await mini.sessions.stopSession(s.id);
  });

  test("a cancelled question declines the form; a form with no ask for it is declined at once; an abandoned form is closed as stopped", async () => {
    const asks: Ask[] = [];
    const off = mini.bus.on("ask.state", (a) => asks.push(a));
    const s = await spawn("question me");
    const first = await waitFor(() => asks.find((a) => a.status === "open"));
    mini.asks.cancel(first.id);
    await waitFor(() => mini.sessions.get(s.id)?.status === "idle");
    expect(events(s.id).filter((e) => e.kind === "assistant_text").at(-1)!.payload).toEqual({ text: 'answer={"action":"decline"}' });
    expect(events(s.id).filter((e) => e.kind === "ask").map((e) => e.payload)).toEqual([
      expect.objectContaining({ ask: first.id, phase: "opened" }),
      { ask: first.id, phase: "closed", reason: "cancelled" },
    ]);
    expect(mini.sessions.get(s.id)?.ask).toBeUndefined();

    const before = asks.length;
    await mini.sessions.send(s.id, "weird form please");
    await waitFor(() => mini.sessions.get(s.id)?.status === "idle" && events(s.id).filter((e) => e.kind === "assistant_text").length === 3);
    expect(asks.length).toBe(before);
    expect(events(s.id).filter((e) => e.kind === "assistant_text").at(-1)!.payload).toEqual({ text: 'answer={"action":"decline"}' });

    await mini.sessions.send(s.id, "question and abandon");
    const abandoned = await waitFor(() => asks.find((a) => a.status === "open" && a.id !== first.id));
    await waitFor(() => mini.sessions.get(s.id)?.status === "idle" && mini.store.asks.get(abandoned.id)?.status === "cancelled");
    expect(events(s.id).filter((e) => e.kind === "ask").at(-1)!.payload).toEqual({ ask: abandoned.id, phase: "closed", reason: "stopped" });

    // The agent withdraws its own request: the ask closes as cancelled and the form is declined.
    await mini.sessions.send(s.id, "question and withdraw");
    const withdrawn = await waitFor(() => asks.find((a) => a.status === "open" && a.id !== first.id && a.id !== abandoned.id));
    await waitFor(() => mini.store.asks.get(withdrawn.id)?.status === "cancelled");
    expect(events(s.id).filter((e) => e.kind === "ask").at(-1)!.payload).toEqual({ ask: withdrawn.id, phase: "closed", reason: "cancelled" });
    await waitFor(() => mini.sessions.get(s.id)?.status === "idle" && events(s.id).filter((e) => e.kind === "assistant_text").length === 6);
    expect(events(s.id).filter((e) => e.kind === "assistant_text").at(-1)!.payload).toEqual({ text: 'answer={"action":"decline"}' });
    off();
    await mini.sessions.stopSession(s.id);
  });

  test("a second send while busy is queued behind the turn; stop cancels and ends; a hook for the native id is answered {} and records nothing", async () => {
    const s = await spawn("slow one");
    await waitFor(() => mini.sessions.get(s.id)?.status === "busy");
    const r = await mini.sessions.send(s.id, "say hi");
    expect(r.status).toBe("queued");
    await sleep(50);
    expect(mini.sessions.get(s.id)?.status).toBe("busy");
    expect(events(s.id).filter((e) => e.kind === "user_turn")).toHaveLength(1);
    // The hook a spawned session fires: answered with nothing, and nothing is stored.
    const before = events(s.id).length;
    const answer = await mini.sessions.onHook("claude", { session_id: s.native.id, hook_event_name: "PermissionRequest", cwd, tool_name: "Bash", tool_input: { command: "x" } } as never, { via: "http" });
    expect(answer).toEqual({});
    expect(events(s.id).length).toBe(before);
    expect(nullAdapter.hooks).toEqual([]);
    await mini.sessions.stopSession(s.id);
    const ended = await waitFor(() => (mini.sessions.get(s.id)?.status === "ended" ? mini.sessions.get(s.id) : undefined));
    expect(ended!.endedAt).toBeDefined();
    expect(events(s.id).at(-1)!.payload).toEqual({ reason: "stopped" });
    expect(mini.sessions.list().map((x) => x.id)).not.toContain(s.id);
  });

  test("an agent that exits mid-turn ends the session; session.stop on an attached session is unsupported; spawn errors", async () => {
    const s = await spawn("exit now");
    await waitFor(() => mini.sessions.get(s.id)?.status === "ended", 5000);
    expect(events(s.id).at(-1)!.payload).toEqual({ reason: "exited" });
    const attached = mini.sessions.ensure({ harness: "claude", nativeId: "user-1", profile: mini.profiles.byHarness("claude")[0]!.id, cwd, transport: "pipe" });
    await expect(mini.sessions.stopSession(attached.session.id)).rejects.toMatchObject({ code: "unsupported" });
    await expect(mini.sessions.spawn({ harness: "codex", workspace: wsId, prompt: "x" }, { profiles: mini.profiles })).rejects.toMatchObject({ code: "unavailable" });
    await expect(mini.sessions.spawn({ harness: "claude", workspace: "ws_01ARZ3NDEKTSV4RRFFQ69G5FB9", prompt: "x" }, { profiles: mini.profiles })).rejects.toMatchObject({ code: "not_found" });
    await expect(mini.sessions.spawn({ harness: "claude", workspace: wsId, prompt: "x", profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB9" }, { profiles: mini.profiles })).rejects.toMatchObject({ code: "not_found" });
  });
});
