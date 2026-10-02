// A plan held from a terminal session, through `Sessions` with the fake ACP agent: the rows
// its ask offers follow what the session was started with (its command line, read through
// the raiser, and the modes it was seen in), the row's answer hands back the call and moves
// the session into that mode, and "Yes, clear context" builds the plan in a fresh session in the same directory
// and mode, starting from the plan, while the old session's turn ends; when no session can
// start, the plan is built where it is. A session in a tether terminal that shows the CLI's
// own clear-context row has that row pressed by key instead, in the same terminal, pressed
// again while the row stays on the screen; when the row is not on its screen, the row naming
// the same mode is pressed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ask, ClaudeHookEvent, Session, SessionEvent } from "@cophyla/protocol";
import { TetherClient } from "@tether-pty/client";
import { silentLogger } from "../src/log.ts";
import type { WindowRaiser } from "../src/sessions/focus.ts";
import type { HarnessAdapter, HookInstallSpec, NormalisedHook, SessionRecord } from "../src/sessions/model.ts";
import { Tether } from "../src/sessions/tether/index.ts";
import { FakeTether } from "./fakes/tether.ts";
import { miniSessions, tempHome, tomlString, waitFor } from "./helpers.ts";
import type { Mini } from "./helpers.ts";

const FAKE_AGENT = join(import.meta.dir, "fakes", "acp-agent.ts");
const PLAN = "## Plan\n\n1. Read the file\n2. Write the file";
const CLIENT = "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7";

/** An attached adapter that owns nothing: the records are made by the test. */
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

/** The command lines of the terminal sessions, by pid; every read is counted. */
const argvs: Record<number, string[]> = {
  5001: ["C:\\Users\\me\\.local\\bin\\claude.exe", "--settings", "C:\\Users\\me\\.claude\\settings.json", "--dangerously-skip-permissions"],
  5002: ["claude"],
  5003: ["claude", "--dangerously-skip-permissions"],
};
const reads: number[] = [];
const raiser: WindowRaiser = {
  async raise() {
    return "unsupported";
  },
  async ancestors() {
    return [];
  },
  async commandLine(pid) {
    reads.push(pid);
    return argvs[pid];
  },
};

let mini: Mini;
let cwd: string;
let blocked: string;
let profile: string;
const asks: Ask[] = [];

const events = (id: string): SessionEvent[] => mini.store.sessionEvents.history(id, { limit: 1000 });

beforeAll(async () => {
  const scratch = tempHome();
  cwd = join(scratch, "work");
  blocked = join(scratch, "no-session");
  const configDir = join(scratch, "claude-home");
  for (const dir of [cwd, blocked, configDir]) mkdirSync(dir, { recursive: true });
  const toml = `[sessions]\ndiscover = false\ninstall_hooks = false\nlaunch = "acp"\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(configDir)}\n\n[acp]\nspawn_timeout_ms = 10000\n[acp.claude]\ncommand = ${tomlString(FAKE_AGENT)}\n`;
  mini = await miniSessions(toml, () => [new NullAdapter()], { raiser, acp: (config) => ({ config: config.acp, env: { ...process.env } }) });
  profile = mini.profiles.defaultFor("claude")!.id;
  mini.bus.on("ask.state", (a) => asks.push(a));
}, 30_000);

afterAll(async () => {
  await mini.stop();
});

/** A terminal session planning under the fake profile. */
function attached(nativeId: string, pid: number, dir = cwd): Session {
  return mini.sessions.ensure({ harness: "claude", nativeId, profile, cwd: dir, transport: "pipe", pid, status: "busy", title: nativeId, transcriptPath: join(dir, `${nativeId}.jsonl`) }).session;
}

function hook(nativeId: string, event: ClaudeHookEvent["hook_event_name"], extra: Record<string, unknown> = {}, dir = cwd): ClaudeHookEvent {
  return { session_id: nativeId, transcript_path: join(dir, `${nativeId}.jsonl`), cwd: dir, hook_event_name: event, permission_mode: "plan", ...extra } as ClaudeHookEvent;
}

/** Posts the session's `ExitPlanMode` and waits for the ask it opens. */
async function exitPlan(s: Session, dir = cwd): Promise<{ ask: Ask; decision: Promise<unknown> }> {
  const decision = mini.sessions.onHook("claude", hook(s.native.id, "PermissionRequest", { prompt_id: `p-${s.id}`, tool_name: "ExitPlanMode", tool_input: { plan: PLAN, planFilePath: join(dir, "plan.md") } }, dir), { via: "http" });
  const ask = await waitFor(() => asks.find((a) => a.status === "open" && a.source.kind === "harness" && a.source.session === s.id), 5000);
  return { ask, decision };
}

const decisionOf = async (p: Promise<unknown>) => ((await p) as { hookSpecificOutput: { decision: Record<string, unknown> } }).hookSpecificOutput.decision;

describe("plan approval from a terminal session", () => {
  test("a session started bypassing permissions is offered bypass, with and without a fresh context", async () => {
    const s = attached("bypass-1", 5001);
    // Going into plan mode reads what the session was started with, once.
    await mini.sessions.onHook("claude", hook("bypass-1", "UserPromptSubmit", { prompt: "plan it" }), { via: "http" });
    await waitFor(() => reads.includes(5001));
    const { ask, decision } = await exitPlan(s);
    expect(reads.filter((p) => p === 5001)).toHaveLength(1);
    expect(ask.title).toBe("Ready to code in bypass-1?");
    expect(ask.detail).toBe(PLAN);
    expect(ask.options.map((o) => [o.id, o.label])).toEqual([
      ["clear", "Yes, clear context and bypass permissions"],
      ["bypass", "Yes, and bypass permissions"],
      ["allow", "Yes, manually approve edits"],
      ["deny", "No, keep planning"],
    ]);
    mini.asks.answer(ask.id, { option: "bypass" }, { kind: "user", client: CLIENT });
    expect(await decisionOf(decision)).toEqual({ behavior: "allow", updatedInput: {}, updatedPermissions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }] });
  });

  test("a session seen in auto mode is offered auto mode; one with no such sign, accepting edits", async () => {
    const auto = attached("auto-1", 5002);
    await mini.sessions.onHook("claude", hook("auto-1", "UserPromptSubmit", { prompt: "go", permission_mode: "auto" }), { via: "http" });
    const first = await exitPlan(auto);
    expect(first.ask.options.map((o) => o.id)).toEqual(["clear", "auto", "allow", "deny"]);
    expect(first.ask.options[0]!.label).toBe("Yes, clear context and use auto mode");
    mini.asks.answer(first.ask.id, { option: "auto" }, { kind: "user", client: CLIENT });
    expect(await decisionOf(first.decision)).toEqual({ behavior: "allow", updatedInput: {}, updatedPermissions: [{ type: "setMode", mode: "auto", destination: "session" }] });

    const plain = attached("plain-1", 5002);
    const second = await exitPlan(plain);
    expect(second.ask.options.map((o) => [o.id, o.label])).toEqual([
      ["clear", "Yes, clear context and auto-accept edits"],
      ["accept_edits", "Yes, auto-accept edits"],
      ["allow", "Yes, manually approve edits"],
      ["deny", "No, keep planning"],
    ]);
    mini.asks.answer(second.ask.id, { option: "deny", text: "smaller steps" }, { kind: "user", client: CLIENT });
    expect(await decisionOf(second.decision)).toEqual({ behavior: "deny", message: "smaller steps" });
  });

  test("clear context builds the plan in a fresh session in the same place and mode, and ends the old turn", async () => {
    const s = attached("clear-1", 5003);
    const before = new Set(mini.sessions.list({}).map((x) => x.id));
    const { ask, decision } = await exitPlan(s);
    mini.asks.answer(ask.id, { option: "clear", text: "keep it small" }, { kind: "user", client: CLIENT });
    expect(await decisionOf(decision)).toEqual({ behavior: "deny", message: "Approved. The plan is being built in a new session with a clear context, so this one stops here.", interrupt: true });

    const fresh = mini.sessions.list({}).find((x) => !before.has(x.id))!;
    expect(fresh).toBeDefined();
    expect(fresh.native.transport).toBe("acp");
    expect(fresh.origin).toBe("orchestrator");
    expect(fresh.cwd).toBe(cwd);
    expect(fresh.profile).toBe(profile);
    const turn = await waitFor(() => events(fresh.id).find((e) => e.kind === "user_turn"));
    const text = (turn.payload as { text: string }).text;
    expect(text.startsWith(`Implement this plan:\n\n${PLAN}\n\n`)).toBe(true);
    expect(text).toContain(`read the full transcript at: ${join(cwd, "clear-1.jsonl")}`);
    expect(text.endsWith("User feedback on this plan: keep it small")).toBe(true);
    // The fresh session was put in the row's mode before its first prompt.
    const said = await waitFor(() => events(fresh.id).find((e) => e.kind === "assistant_text"), 5000);
    expect(said.payload).toEqual({ text: "mode=bypassPermissions" });

    const note = events(s.id).find((e) => e.kind === "notification" && (e.payload as { type?: string }).type === "plan_continued")!;
    expect(note.payload).toMatchObject({ session: fresh.id, mode: "bypassPermissions" });
    expect(mini.sessions.get(s.id)?.status).toBe("idle");
    await mini.sessions.stopSession(fresh.id);
  });

  test("the task the planning session worked on goes with the plan: the fresh session carries it, the old one drops it", async () => {
    const task = "task_01ARZ3NDEKTSV4RRFFQ69G5FB2";
    const s = attached("clear-task", 5003);
    mini.sessions.patch(mini.sessions.find("claude", s.native.id)!, { task });
    const before = new Set(mini.sessions.list({}).map((x) => x.id));
    const { ask, decision } = await exitPlan(s);
    mini.asks.answer(ask.id, { option: "clear" }, { kind: "user", client: CLIENT });
    await decision;
    const fresh = mini.sessions.list({}).find((x) => !before.has(x.id))!;
    expect(fresh.task).toBe(task);
    expect(mini.sessions.get(s.id)!.task).toBeUndefined();
    await mini.sessions.stopSession(fresh.id);
  });

  test("a start in plan mode puts the session in it over the profile's launch; Codex has no plan mode", async () => {
    const ws = mini.workspaces.put({ node: mini.sessions.nodeId, path: cwd, name: "work" });
    const s = await mini.sessions.spawn({ harness: "claude", workspace: ws.id, prompt: "Implement this plan: section 1", mode: "plan" }, { profiles: mini.profiles });
    const said = await waitFor(() => events(s.id).find((e) => e.kind === "assistant_text"), 5000);
    expect(said.payload).toEqual({ text: "mode=plan" });
    await mini.sessions.stopSession(s.id);
    const refused = await mini.sessions.spawn({ harness: "codex", workspace: ws.id, prompt: "x", mode: "plan" }, { profiles: mini.profiles }).then(() => undefined, (e: unknown) => e);
    expect(refused).toMatchObject({ code: "unsupported", message: "a Codex session starts in default or bypassPermissions mode, not plan" });
  });

  test("when no session can start, clear context builds the plan where it is, in the row's mode", async () => {
    const s = attached("clear-2", 5003, blocked);
    const { ask, decision } = await exitPlan(s, blocked);
    expect(ask.options[0]!.id).toBe("clear");
    mini.asks.answer(ask.id, { option: "clear" }, { kind: "user", client: CLIENT });
    expect(await decisionOf(decision)).toEqual({ behavior: "allow", updatedInput: {}, updatedPermissions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }] });
    const note = events(s.id).find((e) => e.kind === "notification" && (e.payload as { type?: string }).type === "plan_continued")!;
    expect((note.payload as { message: string }).message).toContain("A new session could not start");
    expect(mini.sessions.get(s.id)?.status).toBe("busy");
  });
});

describe("plan approval in a tether terminal", () => {
  const RULE = "─".repeat(40);
  const EMPTY = ["", RULE, "❯ ", RULE, "  ⏵⏵ accept edits on"];
  const BOX = ["╭────────────────────╮", "│ Plan to implement  │", "╰────────────────────╯"];
  let fake: FakeTether;
  let tether: Tether;
  let tm: Mini;
  let dir: string;
  let settings: string;
  const tasks: Ask[] = [];
  const cmdlines: Record<number, string[]> = {};
  const tRaiser: WindowRaiser = {
    async raise() {
      return "unsupported";
    },
    async ancestors() {
      return [];
    },
    async commandLine(pid) {
      return cmdlines[pid];
    },
  };

  beforeAll(async () => {
    const scratch = tempHome();
    dir = join(scratch, "work");
    const configDir = join(scratch, "claude-home");
    for (const d of [dir, configDir]) mkdirSync(d, { recursive: true });
    settings = join(scratch, "cophylad-settings.json");
    writeFileSync(settings, JSON.stringify({ showClearContextOnPlanAccept: true }));
    fake = await new FakeTether(join(scratch, "tether")).start();
    tether = new Tether({
      config: { idle_exit_s: 600, window: "none", window_on_start: false, profiles: false, on_path: false, dir: fake.dir },
      env: {},
      dataDir: join(scratch, "data"),
      nodeId: "node_test",
      log: silentLogger,
      exe: "C:/fake/tether.exe",
      run: async () => ({ code: 0, out: "tether 0.1.0\n", err: "" }),
      connectOrStart: (opts) => TetherClient.connect(fake.host, { name: opts.name ?? "cophylad" }),
    });
    await tether.start();
    const toml = `[sessions]\ndiscover = false\ninstall_hooks = false\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(configDir)}\n`;
    tm = await miniSessions(toml, () => [new NullAdapter()], { raiser: tRaiser, deps: { tether } });
    tm.bus.on("ask.state", (a) => tasks.push(a));
  }, 30_000);

  afterAll(async () => {
    await tm.stop();
    await tether.stop();
    await fake.stop();
  });

  /** A Claude session in a tether terminal, started with cophylad's settings file. */
  function inTether(nativeId: string, pid: number) {
    const term = fake.add({ argv: ["claude", "--settings", settings], cwd: dir }, pid);
    cmdlines[pid] = ["claude", "--settings", settings];
    term.setScreen(EMPTY);
    const s = tm.sessions.ensure({ harness: "claude", nativeId, profile: tm.profiles.defaultFor("claude")!.id, cwd: dir, transport: "pipe", pid, status: "busy", title: nativeId, terminal: { host: fake.host.host, id: term.id } }).session;
    return { s, term };
  }

  async function exitPlanIn(s: Session): Promise<{ ask: Ask; decision: Promise<unknown> }> {
    const decision = tm.sessions.onHook("claude", hook(s.native.id, "PermissionRequest", { prompt_id: `p-${s.id}`, tool_name: "ExitPlanMode", tool_input: { plan: PLAN } }, dir), { via: "http" });
    const ask = await waitFor(() => tasks.find((a) => a.status === "open" && a.source.kind === "harness" && a.source.session === s.id), 5000);
    return { ask, decision };
  }

  const tevents = (id: string): SessionEvent[] => tm.store.sessionEvents.history(id, { limit: 1000 });
  const continued = (id: string) => tevents(id).find((e) => e.kind === "notification" && (e.payload as { type?: string }).type === "plan_continued");

  test("clear context presses the terminal's own row: its digit once seen, then Enter, and types the note after", async () => {
    const { s, term } = inTether("tether-clear-1", 6101);
    const { ask, decision } = await exitPlanIn(s);
    expect(ask.options[0]).toMatchObject({ id: "clear", label: "Yes, clear context and auto-accept edits", description: "Build it in this terminal, starting from the plan alone" });
    // The CLI draws its dialog once the hook is released.
    term.setScreen([...BOX, "   ❯ 1. Yes, clear context (6% used) and auto-accept edits", "     2. Yes, auto-accept edits", "     3. Yes, manually approve edits", "     4. Tell Claude what to change"]);
    tm.asks.answer(ask.id, { option: "clear", text: "keep it small" }, { kind: "user", client: CLIENT });
    expect(await decision).toEqual({});
    await waitFor(() => term.typed.includes("keys:Enter"), 5000);
    expect(term.typed).toEqual(["keys:1", "keys:Enter"]);
    // The CLI takes it: the dialog goes, and its prompt comes back.
    term.setScreen(EMPTY);
    const note = await waitFor(() => continued(s.id), 5000);
    expect((note.payload as { message: string }).message).toBe("The plan is being built in this terminal with a clear context");
    // No session was started for it.
    expect(tm.sessions.list({}).filter((x) => x.cwd === dir)).toHaveLength(1);
    // The note is typed as the user's once the prompt is free.
    await waitFor(() => term.typed.includes("paste:User feedback on this plan: keep it small"), 5000);
  });

  test("a terminal whose Claude draws the ASCII pointer has its row pressed the same way, and the note typed after", async () => {
    // As 2.1.283 draws it where the environment names no Unicode terminal.
    const asciiEmpty = ["", RULE, "> ", RULE, "  ⏸ plan mode on (shift+tab to cycle)"];
    const { s, term } = inTether("tether-clear-ascii", 6105);
    term.setScreen(asciiEmpty);
    const { ask, decision } = await exitPlanIn(s);
    term.setScreen([RULE, " Ready to code?", " Claude has written up a plan and is ready to execute. Would you like to proceed?", "", " > 1. Yes, clear context (5% used) and auto-accept edits", "   2. Yes, auto-accept edits", "   3. Yes, manually approve edits", "   4. Tell Claude what to change", "      shift+tab to approve with this feedback"]);
    tm.asks.answer(ask.id, { option: "clear", text: "keep it small" }, { kind: "user", client: CLIENT });
    expect(await decision).toEqual({});
    await waitFor(() => term.typed.includes("keys:Enter"), 5000);
    expect(term.typed).toEqual(["keys:1", "keys:Enter"]);
    term.setScreen(asciiEmpty);
    const note = await waitFor(() => continued(s.id), 5000);
    expect((note.payload as { message: string }).message).toBe("The plan is being built in this terminal with a clear context");
    await waitFor(() => term.typed.includes("paste:User feedback on this plan: keep it small"), 5000);
  });

  test("a press the CLI dropped, taken before it had the hook's answer, is pressed again", async () => {
    const { s, term } = inTether("tether-clear-3", 6104);
    const { ask, decision } = await exitPlanIn(s);
    term.setScreen([...BOX, "   ❯ 1. Yes, clear context (6% used) and auto-accept edits", "     2. Yes, auto-accept edits", "     3. Yes, manually approve edits", "     4. Tell Claude what to change"]);
    tm.asks.answer(ask.id, { option: "clear" }, { kind: "user", client: CLIENT });
    expect(await decision).toEqual({});
    // The first Enter changes nothing on the screen; the second is taken.
    await waitFor(() => term.typed.filter((k) => k === "keys:Enter").length === 2, 10_000);
    term.setScreen(EMPTY);
    const note = await waitFor(() => continued(s.id), 5000);
    expect(term.typed).toEqual(["keys:1", "keys:Enter", "keys:1", "keys:Enter"]);
    expect((note.payload as { message: string }).message).toBe("The plan is being built in this terminal with a clear context");
  }, 20_000);

  test("with no clear-context row on the screen, the row naming the same mode is pressed", async () => {
    const { s, term } = inTether("tether-clear-2", 6102);
    const { ask, decision } = await exitPlanIn(s);
    term.setScreen([...BOX, "   ❯ 1. Yes, auto-accept edits", "     2. Yes, manually approve edits", "     3. Tell Claude what to change"]);
    tm.asks.answer(ask.id, { option: "clear" }, { kind: "user", client: CLIENT });
    expect(await decision).toEqual({});
    await waitFor(() => term.typed.length > 0, 5000);
    expect(term.typed).toEqual(["keys:1,Enter"]);
    expect((continued(s.id)!.payload as { message: string }).message).toBe("The terminal offered no clear context, so the plan is built here");
  });

  test("a session started without the row is offered a fresh session instead, and any other row is the hook's answer", async () => {
    const term = fake.add({ argv: ["claude"], cwd: dir }, 6103);
    cmdlines[6103] = ["claude"];
    const s = tm.sessions.ensure({ harness: "claude", nativeId: "tether-plain", profile: tm.profiles.defaultFor("claude")!.id, cwd: dir, transport: "pipe", pid: 6103, status: "busy", terminal: { host: fake.host.host, id: term.id } }).session;
    const { ask, decision } = await exitPlanIn(s);
    // No ACP here, so no fresh session either: there is no clear row to offer.
    expect(ask.options.map((o) => o.id)).toEqual(["accept_edits", "allow", "deny"]);
    tm.asks.answer(ask.id, { option: "accept_edits" }, { kind: "user", client: CLIENT });
    expect(await decisionOf(decision)).toEqual({ behavior: "allow", updatedInput: { plan: PLAN }, updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] });
    expect(term.typed).toEqual([]);
  });
});
