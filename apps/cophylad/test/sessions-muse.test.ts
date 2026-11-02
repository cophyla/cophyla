// The Muse adapter in pieces: the view fold, ids, logs and usage, the TUI's screen, the
// questions, the plugin and its install; then the adapter over the fake `muse serve`:
// sessions known from their hooks and read through the view, hooks (a child's answered at
// once, a held PermissionRequest answered in Muse's shape, a turn and a tool result recorded
// once whether the hook or the view says it first), liveness (a listed session has closed) and
// the plan's usage; the view's cursor over a restart; a session cophylad starts in a tether
// terminal, claimed by the process tree and typed into, or headless where its hooks are not
// approved; and one it runs headless, with its approvals and questions as asks.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TetherClient } from "@tether-pty/client";
import type { MuseHookEvent, Session, SessionEvent } from "@cophyla/protocol";
import { silentLogger } from "../src/log.ts";
import type { WindowRaiser } from "../src/sessions/focus.ts";
import { findSessionLog, MuseAdapter, usageLimits } from "../src/sessions/muse/adapter.ts";
import { activeBinary } from "../src/sessions/muse/locate.ts";
import { ensureMusePlugin, hookFile, MUSE_HOOK_EVENTS, MUSE_TIMEOUT_CAP_MS, museFiles, museManifest, writeMusePlugin } from "../src/sessions/muse/plugin.ts";
import { promptInput, waitingOn } from "../src/sessions/muse/screen.ts";
import { applyMuseEvent, newMuseState, settledEvents, statsFor } from "../src/sessions/muse/view.ts";
import type { ViewEvent } from "../src/sessions/muse/view.ts";
import { museAnswer, questionsFromMuse } from "../src/sessions/questions.ts";
import { SHIM_SOURCE, shimArgv } from "../src/sessions/shim.ts";
import { uuidv7, uuidv7Time } from "../src/sessions/uuidv7.ts";
import { Tether } from "../src/sessions/tether/index.ts";
import type { FakeSession } from "./fakes/tether.ts";
import { FakeTether } from "./fakes/tether.ts";
import { miniSessions, sleep, tempHome, tomlString, waitFor } from "./helpers.ts";
import type { Mini } from "./helpers.ts";

const FAKE_MUSE = join(import.meta.dir, "fakes", "muse-serve.ts");
const CHILD = "390eae17-6269-481e-88e6-2ddde8961664";
const RULE = "─".repeat(60);
const TITLED = `── Voice input (Alt+V to start) ${"─".repeat(40)}`;
const EMPTY: (string | [string, "dim"])[] = ["  Muse Code 1.4.0", "", TITLED, "❯", RULE, "  muse-spark · C:\\work · Auto-review"];

const iso = (t: number) => new Date(t).toISOString();

/** `<data>/muse/sessions/Y/M/D/<id>/session.jsonl` for a v7 id, by the local day its time falls on. */
function logPath(data: string, id: string): string {
  const d = new Date(uuidv7Time(id)!);
  return join(data, "muse", "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"), id, "session.jsonl");
}

/** A view event as the fake serves it. */
function ev(id: string, n: number, method: string, params: Record<string, unknown>): ViewEvent {
  return { method, params: { sessionId: id, ...params, viewCursor: `v:${id}:${n}` } };
}

/** A turn's events: started, the user's message, a tool call, the agent's reply, usage and completion. */
function turn(id: string, from: number, t: string, text: string, opts: { call?: string; tokens?: [number, number] } = {}): ViewEvent[] {
  const at = iso(Date.now() - 20000);
  const out: ViewEvent[] = [];
  const push = (method: string, params: Record<string, unknown>) => out.push(ev(id, from + out.length, method, params));
  push("turn/started", { turnId: t, commandId: t });
  push("item/completed", { item: { itemId: `u-${t}`, kind: "userMessage", turnId: t, revision: 1, status: "completed", recordedAt: at, text } });
  if (opts.call) {
    push("item/started", { item: { itemId: `tool-${t}`, kind: "toolCall", turnId: t, revision: 1, status: "inProgress", recordedAt: at, tool: "powershell", callId: opts.call, args: JSON.stringify({ command: "bun test" }) } });
    push("item/completed", { item: { itemId: `tool-${t}`, kind: "toolCall", turnId: t, revision: 2, status: "completed", recordedAt: at, tool: "powershell", callId: opts.call, args: JSON.stringify({ command: "bun test" }), visibleOutput: JSON.stringify({ exit_code: 0, output: "ok" }) } });
  }
  push("item/completed", { item: { itemId: `c-${t}`, kind: "reminderChild", turnId: t, revision: 2, status: "completed", recordedAt: at, childSessionId: CHILD } });
  push("item/completed", { item: { itemId: `a-${t}`, kind: "agentMessage", turnId: t, revision: 2, status: "completed", recordedAt: at, text: `done: ${text}` } });
  const [inT, outT] = opts.tokens ?? [500, 50];
  push("session/tokenUsage", { turnId: t, modelId: "muse-spark-1.3", usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, reasoningTokens: 0 }, promptTokens: 1, totalTokens: 2, cumulative: { promptTokens: inT, outputTokens: outT, totalTokens: inT + outT } });
  push("session/contextUsage", { usedTokens: inT + outT, windowTokens: 1000000, pressure: "normal" });
  push("turn/completed", { turnId: t, terminal: "completed", durationMs: 5 });
  return out;
}

describe("muse view fold", () => {
  const id = uuidv7();
  const state = newMuseState();
  const items = turn(id, 1, "t1", "fix the tests", { call: "call_a" }).flatMap((e) => applyMuseEvent(state, e, 0));

  test("yields the turn, the user's message, the tool call once and its result, and the agent's reply; a child is kept, not recorded", () => {
    expect(items.map((i) => i.kind)).toEqual(["turn_started", "user_turn", "tool_call", "tool_result", "assistant_text", "turn_completed"]);
    const call = items[2]!;
    expect(call.kind === "tool_call" && call.args).toEqual({ command: "bun test" });
    expect(call.kind === "tool_call" && call.callId).toBe("call_a");
    const result = items[3]!;
    expect(result.kind === "tool_result" && result.output).toEqual({ exit_code: 0, output: "ok" });
    expect(result.kind === "tool_result" && result.isError).toBe(false);
    expect(state.children.has(CHILD)).toBe(true);
    expect(state.cursor).toBe(`v:${id}:9`);
    expect(state.open.size).toBe(0);
  });

  test("stats come from the cumulative usage and the context window", () => {
    expect(statsFor(state)).toEqual({ turns: 1, cost: 0, tokens: { in: 500, out: 50 }, context: { used: 550, limit: 1000000 }, model: "muse-spark-1.3" });
  });

  test("a page read mid-turn is taken up to the closes Muse makes up for the turn in flight", () => {
    const at = (n: number, method: string, params: Record<string, unknown> = {}) => ev(id, n, method, params);
    const real = [at(1, "turn/started", { turnId: "t" }), at(2, "item/completed", { item: { itemId: "u", kind: "userMessage", status: "completed", text: "hi" } }), at(3, "item/started", { item: { itemId: "r", kind: "reminderChild", status: "inProgress" } })];
    const made = [at(4, "item/completed", { item: { itemId: "r", kind: "reminderChild", status: "failed" } }), at(5, "turn/completed", { turnId: "t", terminal: "failed", reason: "incomplete" })];
    expect(settledEvents([...real, ...made])).toEqual(real);
    expect(settledEvents(real)).toEqual(real);
    const done = [...real, at(4, "item/completed", { item: { itemId: "a", kind: "agentMessage", status: "completed", text: "ok" } }), at(5, "turn/completed", { turnId: "t", terminal: "completed" })];
    expect(settledEvents(done)).toEqual(done);
  });

  test("a failed tool call is an error result, and a cancelled turn says so", () => {
    const s = newMuseState();
    const out = [
      ev(id, 1, "item/completed", { item: { itemId: "x", kind: "toolCall", revision: 2, status: "rejected", tool: "powershell", callId: "c", args: "{}", failureReason: "rejected by the user" } }),
      ev(id, 2, "turn/completed", { turnId: "t", terminal: "cancelled", reason: "cancelled during end-of-turn reminder wait" }),
    ].flatMap((e) => applyMuseEvent(s, e, 5));
    expect(out).toEqual([
      { kind: "tool_call", callId: "c", tool: "powershell", args: {}, at: 5 },
      { kind: "tool_result", callId: "c", tool: "powershell", output: "rejected by the user", isError: true, at: 5 },
      { kind: "turn_completed", turnId: "t", terminal: "cancelled", reason: "cancelled during end-of-turn reminder wait", at: 5 },
    ]);
  });
});

describe("muse ids, logs, binaries and usage", () => {
  test("a UUIDv7 carries its time; a child's v4 carries none", () => {
    const t = Date.UTC(2026, 8, 25, 7, 14, 4, 462);
    const id = uuidv7(t);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidv7Time(id)).toBe(t);
    expect(uuidv7Time("01a0d76a-018b-775b-858d-c61e95ed564e")).toBe(0x01a0d76a018b);
    expect(uuidv7Time(CHILD)).toBeUndefined();
  });

  test("a root session's log is found by the day of its id; a child has none", () => {
    const data = tempHome();
    const id = uuidv7(Date.now() - 3600000);
    const path = logPath(data, id);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "");
    expect(findSessionLog(join(data, "muse"), id)).toBe(path);
    expect(findSessionLog(join(data, "muse"), uuidv7())).toBeUndefined();
    expect(findSessionLog(join(data, "muse"), CHILD)).toBeUndefined();
  });

  test("the launcher's active binary is the one its version file names", () => {
    const dir = tempHome();
    writeFileSync(join(dir, ".muse-version"), "1.4.0-R4161.1\n");
    expect(activeBinary(dir, "win32")).toBeUndefined();
    writeFileSync(join(dir, "muse-bin-1.4.0-R4161.1.exe"), "");
    expect(activeBinary(dir, "win32")).toEqual({ command: join(dir, "muse-bin-1.4.0-R4161.1.exe"), version: "1.4.0-R4161.1", versionFile: join(dir, ".muse-version") });
    writeFileSync(join(dir, ".muse-version"), "not a version");
    expect(activeBinary(dir, "win32")).toBeUndefined();
  });

  test("usage/read's window and week are the session's and the week's limits", () => {
    expect(usageLimits({ window: { usedPercent: 12, windowDurationMins: 300, resetsAtMs: 1790336519000 }, weekly: { usedPercent: 3, resetsAtMs: 1790553600000 }, tier: "x", observedAtMs: 1790320465717 })).toEqual({
      at: 1790320465717,
      session: { percent: 12, resetsAt: 1790336519000 },
      weekly: { percent: 3, resetsAt: 1790553600000 },
    });
    expect(usageLimits(undefined)).toBeUndefined();
    expect(usageLimits({})).toBeUndefined();
  });
});

describe("muse screen", () => {
  const screen = (rows: string[]) => ({ lines: rows });

  test("the prompt is the row under a titled rule, down to the plain one; its hint is empty", () => {
    expect(promptInput(screen(["  Muse Code 1.4.0", "", TITLED, "❯", RULE]))).toBe("");
    expect(promptInput(screen([TITLED, "❯ Start a message with ! to run a shell command yourself", RULE]))).toBe("");
    expect(promptInput(screen(["❯ hello typed from tether", "", "◆ echo: hello", "", TITLED, "❯ line one", "  line two", RULE, "  echo · C:\\ws"]))).toBe("line one\nline two");
    // A past turn echoed above is not the prompt, and a dialog has none.
    expect(promptInput(screen(["❯ hello typed from tether", "", "◆ echo: hello"]))).toBeUndefined();
  });

  test("an empty prompt shows a tip after the cursor; the words of one are the user's once the cursor is past them", () => {
    const rows = ["❯ hello", "", TITLED, "❯ Type @ to search and insert workspace file paths", RULE];
    expect(promptInput({ lines: rows, cursor: { row: 3, col: 2 } })).toBe("");
    expect(promptInput({ lines: [TITLED, "❯ Paste an image with Ctrl+V (file paths and URLs work too)", RULE], cursor: { row: 1, col: 2 } })).toBe("");
    expect(promptInput({ lines: [TITLED, "❯ Type @ to search", RULE], cursor: { row: 1, col: 20 } })).toBe("Type @ to search");
    // With no cursor to go by, a tip is known by its words.
    expect(promptInput({ lines: rows })).toBe("");
    expect(promptInput({ lines: [TITLED, "❯ half a thou", RULE] })).toBe("half a thou");
  });

  test("what a session that has not registered waits on", () => {
    expect(waitingOn(screen(["Do you trust this workspace?", "Workspace: C:\\ws", "> 1  Trust and continue", "  2  Quit"]))).toBe("the workspace trust dialog");
    expect(waitingOn(screen(["  Muse Code 1.4.0", "  Log in with browser · Enter to choose", "  Set an API key"]))).toBe("signing in");
    expect(waitingOn(screen(["", "Downloading muse 1.5.0-R5000.1 (120 MB)", "  45% Complete (54 MB of 120 MB)"]))).toBe("a Muse download");
    expect(waitingOn(screen(["muse: installed binary is missing; rerun the installer"]))).toBe("an error: installed binary is missing; rerun the installer");
    expect(waitingOn(screen(["", TITLED, "❯", RULE]))).toBeUndefined();
  });
});

describe("muse questions", () => {
  const params = {
    userInputId: "ui",
    questions: [
      { id: "q1", header: "Colour", question: "Which colour?", options: [{ label: "Red" }, { label: "Blue" }], selection: { mode: "single" } },
      { id: "q2", header: "Sizes", question: "Which sizes?", options: [{ label: "S" }, { label: "M" }], selection: { mode: "multiple" } },
      { id: "q3", header: "Name", question: "What name?", options: [], selection: { mode: "single" } },
      { nope: true },
    ],
  };

  test("each question is one ask; the answers go back by question id", () => {
    const qs = questionsFromMuse(params)!;
    expect(qs.map((q) => [q.key, q.kind, q.multiple])).toEqual([
      ["q1", "choice", false],
      ["q2", "choice", true],
      ["q3", "input", false],
    ]);
    const by = { kind: "user" as const, client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" };
    expect(museAnswer(qs[0]!, { option: "Blue", by, at: 1 })).toEqual({ questionId: "q1", selectedLabel: "Blue" });
    expect(museAnswer(qs[1]!, { option: "S", options: ["S", "M"], text: " and XL ", by, at: 1 })).toEqual({ questionId: "q2", selectedLabels: ["S", "M"], freeText: "and XL" });
    expect(museAnswer(qs[2]!, { option: "text", text: "Cophyla", by, at: 1 })).toEqual({ questionId: "q3", freeText: "Cophyla" });
    expect(questionsFromMuse({ questions: [] })).toBeUndefined();
  });
});

describe("muse plugin", () => {
  const argv = (shim: string) => shimArgv("C:/bun.exe", shim, "muse", "prof_x", "C:/cophyla/data/hook.json");

  test("one hook per event, each running its own copy of the shim with the hook.json it is told", () => {
    const m = museManifest(argv, 7200, "0.10.0") as { name: string; capabilities: { hooks: { id: string; event: string; command: string[]; timeoutMs: number }[] } };
    expect(m.name).toBe("cophylad");
    const hooks = m.capabilities.hooks;
    expect(hooks.map((h) => h.event)).toEqual([...MUSE_HOOK_EVENTS]);
    expect(new Set(hooks.map((h) => h.command[1])).size).toBe(hooks.length);
    expect(hooks[0]!.command).toEqual(["C:/bun.exe", "hooks/sessionstart.mjs", "muse", "prof_x", "C:/cophyla/data/hook.json"]);
    expect(hooks.find((h) => h.event === "PermissionRequest")!.timeoutMs).toBe(7_200_000);
    expect(hooks.find((h) => h.event === "SessionEnd")!.timeoutMs).toBe(3000);
    const long = museManifest(argv, 99999, "0.10.0") as typeof m;
    expect(long.capabilities.hooks[0]!.timeoutMs).toBe(MUSE_TIMEOUT_CAP_MS);
    const files = museFiles(m);
    expect([...files.keys()]).toEqual([".muse-plugin/plugin.json", ...MUSE_HOOK_EVENTS.map(hookFile)]);
    expect(files.get("hooks/permissionrequest.mjs")).toBe(SHIM_SOURCE);
  });

  test("the shim finds the daemon through the hook.json it is named, and answers {} for Muse when it cannot", () => {
    expect(SHIM_SOURCE).toContain("hookJson || join(dirname(fileURLToPath(import.meta.url)), \"hook.json\")");
    expect(SHIM_SOURCE).toContain('const silence = harness === "claude" ? "" : "{}";');
    expect(shimArgv("C:/bun.exe", "hooks/stop.mjs", "muse", "prof_x")).toEqual(["C:/bun.exe", "hooks/stop.mjs", "muse", "prof_x"]);
  });

  describe("installed and approved through the muse binary", () => {
    const data = tempHome();
    const dir = join(tempHome(), "plugin");
    const env = { ...process.env, XDG_DATA_HOME: data };
    const calls: string[][] = [];
    const run = async (args: string[], extra: Record<string, string> = {}) => {
      calls.push(args);
      const p = Bun.spawn([process.execPath, FAKE_MUSE, "plugins", ...args, "--json"], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      return { code: await p.exited, out };
    };
    const files = museFiles(museManifest(argv, 7200, "0.10.0"));

    test("installs, approves, then leaves an unchanged plugin alone", async () => {
      writeMusePlugin(dir, files);
      const r = await ensureMusePlugin({ dir, files, run, log: silentLogger, approveHint: "muse plugins approve cophylad" });
      expect(r).toEqual({ installed: true, approved: true });
      expect(calls.map((c) => c[0])).toEqual(["inspect", "install", "inspect", "approve", "inspect"]);
      calls.length = 0;
      expect(await ensureMusePlugin({ dir, files, run, log: silentLogger, approveHint: "x" })).toEqual({ installed: true, approved: true });
      expect(calls.map((c) => c[0])).toEqual(["inspect"]);
    });

    test("a changed plugin is installed again and approved again", async () => {
      calls.length = 0;
      const changed = museFiles(museManifest(argv, 60, "0.10.1"));
      writeMusePlugin(dir, changed);
      const r = await ensureMusePlugin({ dir, files: changed, run, log: silentLogger, approveHint: "x" });
      expect(r.approved).toBe(true);
      expect(calls.map((c) => c[0])).toEqual(["inspect", "install", "inspect", "approve", "inspect"]);
    });

    test("a refusal is reported with the command the user can run", async () => {
      const refusing = (args: string[]) => run(args, { FAKE_REFUSE_APPROVE: "1" });
      const other = museFiles(museManifest(argv, 30, "0.10.2"));
      writeMusePlugin(dir, other);
      const r = await ensureMusePlugin({ dir, files: other, run: refusing, log: silentLogger, approveHint: "muse plugins approve cophylad" });
      expect(r).toEqual({ installed: true, approved: false, refused: "hooks not approved (muse plugins approve cophylad)" });
    });
  });
});

// --- the adapter over the fake host ---------------------------------------------------------------

interface Kit {
  scratch: string;
  config: string;
  data: string;
  cwd: string;
}

function kit(): Kit {
  const scratch = tempHome();
  const k = { scratch, config: join(scratch, "config", "muse"), data: join(scratch, "data"), cwd: join(scratch, "work") };
  mkdirSync(k.config, { recursive: true });
  mkdirSync(join(k.data, "muse", "views"), { recursive: true });
  mkdirSync(k.cwd, { recursive: true });
  writeFileSync(join(k.config, "auth.json"), JSON.stringify({ schema_version: 1, providers: { meta: { access_token: "never read" } } }));
  return k;
}

function museToml(k: Kit, sessions: string): string {
  return `[sessions]\ndiscover = false\npoll_ms = 100000\n${sessions}\n\n[[profiles]]\nharness = "muse"\nname = "fake"\nconfig_dir = ${tomlString(k.config)}\ncommand = ${tomlString(process.execPath)}\nargs = [${tomlString(FAKE_MUSE)}, "--provider", "echo"]\nenv = { XDG_DATA_HOME = ${tomlString(k.data)} }\n\n[acp]\nspawn_timeout_ms = 5000\n`;
}

/** The fake, run by this runtime: what the adapter's own host and plugin calls run. A profile's `args` are its TUI's alone. */
const fakeMuse = () => ({ command: process.execPath, args: [FAKE_MUSE] });

const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2));
const readCalls = (k: Kit): { method: string; params: Record<string, unknown> }[] =>
  existsSync(join(k.data, "muse", "calls.jsonl"))
    ? readFileSync(join(k.data, "muse", "calls.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> })
    : [];

/** Seeds a session: its row in the list (left out while `open`), its view, and its log (touched, so the next pass reads). */
function seed(k: Kit, id: string, events: ViewEvent[], row: Record<string, unknown> = {}): void {
  const list = existsSync(join(k.data, "muse", "list.json")) ? (JSON.parse(readFileSync(join(k.data, "muse", "list.json"), "utf8")) as { sessionId: string }[]) : [];
  const path = logPath(k.data, id);
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, "{}\n");
  const rows = list.filter((r) => r.sessionId !== id);
  rows.push({ sessionId: id, path, status: "notLoaded", createdAt: iso(uuidv7Time(id)!), updatedAt: iso(Date.now() - 5000), workspaceRoot: `\\\\?\\${k.cwd}`, modelId: "muse-spark-1.3", turnCount: 1, title: "fix the tests", firstUserPrompt: "fix the tests", ...row } as { sessionId: string });
  writeJson(join(k.data, "muse", "list.json"), rows);
  writeJson(join(k.data, "muse", "views", `${id}.json`), events);
}

/** A session's TUI closed: Muse lists it from now on. */
function closed(k: Kit, id: string): void {
  const path = join(k.data, "muse", "list.json");
  const rows = JSON.parse(readFileSync(path, "utf8")) as { sessionId: string }[];
  writeJson(path, rows.map((r) => (r.sessionId === id ? { ...r, open: false, updatedAt: iso(Date.now()) } : r)));
}

/** The last time a log was stamped: each growth stamps later, even two in one millisecond. */
let stamped = 0;

/** More of a session's view, and its log written. */
function grow(k: Kit, id: string, more: ViewEvent[]): void {
  const path = join(k.data, "muse", "views", `${id}.json`);
  const events = JSON.parse(readFileSync(path, "utf8")) as ViewEvent[];
  writeJson(path, [...events, ...more]);
  const log = logPath(k.data, id);
  appendFileSync(log, "{}\n");
  // the adapter reads a log only when its mtime moved past the last read's
  stamped = Math.max(Date.now() + 1000, stamped + 1);
  const t = new Date(stamped);
  utimesSync(log, t, t);
}

function museHook(id: string, name: MuseHookEvent["hook_event_name"], extra: Partial<MuseHookEvent> = {}): MuseHookEvent {
  return { hook_event_name: name, session_id: id, cwd: "C:\\work", transcript_path: null, permission_mode: "default", ...extra };
}

describe("muse adapter over the fake serve", () => {
  let k: Kit;
  let mini: Mini;
  let adapter: MuseAdapter;
  const A = uuidv7(Date.now() - 120000);
  const B = uuidv7(Date.now() - 60000);
  const SHUT = uuidv7(Date.now() - 90000);
  const OLD = uuidv7(Date.now() - 3 * 3600000);
  const alive = new Set<number>();
  const chains = new Map<number, { pid: number; name: string }[]>();
  const tree = { ancestors: async (pid: number) => chains.get(pid) ?? [] };
  const events = (id: string): SessionEvent[] => mini.store.sessionEvents.history(id, { limit: 500 });
  const rec = () => mini.sessions.list().find((s) => s.native.id === A)!;

  beforeAll(async () => {
    k = kit();
    // A TUI has A open, so Muse lists it not; SHUT closed before cophylad looked, and is listed.
    seed(k, A, turn(A, 1, "t1", "fix the tests", { call: "call_a" }), { open: true });
    seed(k, SHUT, turn(SHUT, 1, "s1", "closed already"));
    seed(k, OLD, turn(OLD, 1, "o1", "old"), { updatedAt: iso(Date.now() - 3 * 3600000) });
    mini = await miniSessions(museToml(k, "install_hooks = true\nmuse_list_ms = 1\nmuse_recent_ms = 600000\nhook_timeout_s = 600"), (host, log) => {
      adapter = new MuseAdapter({ host, log, version: "0.10.0", dataDir: join(k.scratch, "cophylad-data"), locate: fakeMuse, raiser: tree, isAlive: (pid) => alive.has(pid), env: process.env });
      return [adapter];
    });
    await adapter.pluginsReady();
    await mini.sessions.onHook("muse", museHook(A, "SessionStart", { source: "resume", cwd: k.cwd }), { via: "command" });
    await mini.sessions.tick();
  }, 30_000);
  afterAll(() => mini.stop());

  test("installs and approves cophylad's plugin in the profile's data home", () => {
    expect(adapter.pluginStatus(mini.profiles.byHarness("muse")[0]!.id)).toEqual({ installed: true, approved: true });
    const plugin = JSON.parse(readFileSync(join(k.data, "muse", "plugin.json"), "utf8")) as { cache: string; trusted: boolean };
    expect(plugin.trusted).toBe(true);
    const manifest = JSON.parse(readFileSync(join(plugin.cache, ".muse-plugin", "plugin.json"), "utf8")) as { capabilities: { hooks: { command: string[] }[] } };
    const cmd = manifest.capabilities.hooks[0]!.command;
    expect(cmd[0]).toBe(process.execPath);
    expect(cmd.slice(1, 3)).toEqual(["hooks/sessionstart.mjs", "muse"]);
    expect(cmd[4]).toBe(join(mini.home, "data", "hook.json"));
  });

  test("a session is known from its hooks, never from the list, and its view is recorded: turn, tool call and result, reply, stats", () => {
    const list = mini.sessions.list();
    expect(list.map((s) => s.native.id)).toEqual([A]);
    const s = list[0]!;
    expect(s.harness).toBe("muse");
    expect(s.native.transport).toBe("msp");
    expect(s.cwd).toBe(k.cwd);
    expect(s.intent).toBe("fix the tests");
    expect(s.status).toBe("idle");
    expect(s.transcript?.path).toBe(logPath(k.data, A));
    expect(s.stats).toEqual({ turns: 1, cost: 0, tokens: { in: 500, out: 50 }, context: { used: 550, limit: 1000000 }, model: "muse-spark-1.3" });
    // Made by its SessionStart, then the view's turn.
    expect(events(s.id).map((e) => e.kind)).toEqual(["status", "status", "user_turn", "tool_call", "tool_result", "assistant_text"]);
    expect(events(s.id)[3]!.payload).toEqual({ tool: "powershell", id: "call_a", args: { command: "bun test" } });
    expect(mini.store.sessions.tail(s.id)).toMatchObject({ path: logPath(k.data, A), cursor: `v:${A}:9` });
  });

  test("a child's hook is answered at once and makes no session", async () => {
    const answer = await mini.sessions.onHook("muse", museHook(CHILD, "PermissionRequest", { tool_name: "submit_reminder_decision", tool_input: { decision: "none" } }), { via: "command" });
    expect(answer).toEqual({});
    expect(mini.asks.listOpen()).toHaveLength(0);
    expect(mini.store.sessions.getByNative("muse", CHILD)).toBeUndefined();
    // A v7 id with no log filed is a child's too, unless it starts.
    expect(await mini.sessions.onHook("muse", museHook(uuidv7(), "Stop"), { via: "command" })).toEqual({});
  });

  test("a turn and a tool result the hooks say first are not recorded again from the view", async () => {
    await mini.sessions.onHook("muse", museHook(A, "UserPromptSubmit", { turn_id: "t2", prompt: "now the docs" }), { via: "command" });
    expect(rec().status).toBe("busy");
    await mini.sessions.onHook("muse", museHook(A, "PostToolUse", { turn_id: "t2", tool_name: "powershell", tool_input: { command: "bun test" }, tool_response: '{"exit_code":0}', tool_use_id: "call_b" }), { via: "command" });
    await mini.sessions.onHook("muse", museHook(A, "Stop", { turn_id: "t2", last_assistant_message: "done" }), { via: "command" });
    expect(rec().status).toBe("idle");
    grow(k, A, turn(A, 10, "t2", "now the docs", { call: "call_b", tokens: [900, 90] }));
    await mini.sessions.tick();
    const kinds = events(rec().id).map((e) => e.kind);
    expect(kinds.filter((x) => x === "user_turn")).toHaveLength(2);
    expect(kinds.filter((x) => x === "tool_call")).toHaveLength(2);
    expect(kinds.filter((x) => x === "tool_result")).toHaveLength(2);
    expect(kinds.filter((x) => x === "assistant_text")).toHaveLength(2);
    expect(events(rec().id).find((e) => e.kind === "user_turn" && (e.payload as { text: string }).text === "now the docs")!.payload).toMatchObject({ source: "hook" });
    expect(rec().stats?.tokens).toEqual({ in: 900, out: 90 });
    expect(rec().status).toBe("idle");
  });

  test("a view read mid-turn records what is real, and the turn's end when it comes, once", async () => {
    const at = iso(Date.now() - 1000);
    const start = [
      ev(A, 19, "turn/started", { turnId: "t4", commandId: "t4" }),
      ev(A, 20, "item/completed", { item: { itemId: "u-t4", kind: "userMessage", turnId: "t4", revision: 1, status: "completed", recordedAt: at, text: "and a third" } }),
      ev(A, 21, "item/started", { item: { itemId: "r-t4", kind: "reminderChild", turnId: "t4", revision: 1, status: "inProgress", recordedAt: at, childSessionId: CHILD } }),
    ];
    // What Muse makes up for the turn in flight, at cursors the real events take later.
    grow(k, A, [...start, ev(A, 22, "item/completed", { item: { itemId: "r-t4", kind: "reminderChild", revision: 2, status: "failed" } }), ev(A, 23, "turn/completed", { turnId: "t4", terminal: "failed", reason: "incomplete" })]);
    await mini.sessions.tick();
    expect(rec().status).toBe("busy");
    expect(events(rec().id).some((e) => e.kind === "notification" && String((e.payload as { type: string }).type).startsWith("turn_"))).toBe(false);
    expect(mini.store.sessions.tail(rec().id)?.cursor).toBe(`v:${A}:21`);
    const path = join(k.data, "muse", "views", `${A}.json`);
    const kept = (JSON.parse(readFileSync(path, "utf8")) as ViewEvent[]).slice(0, 21);
    writeJson(path, kept);
    grow(k, A, [
      ev(A, 22, "item/completed", { item: { itemId: "a-t4", kind: "agentMessage", turnId: "t4", revision: 2, status: "completed", recordedAt: at, text: "third reply" } }),
      ev(A, 23, "turn/completed", { turnId: "t4", terminal: "completed" }),
    ]);
    await mini.sessions.tick();
    expect(rec().status).toBe("idle");
    expect(events(rec().id).filter((e) => e.kind === "assistant_text" && (e.payload as { text: string }).text === "third reply")).toHaveLength(1);
    expect(events(rec().id).filter((e) => e.kind === "user_turn" && (e.payload as { text: string }).text === "and a third")).toHaveLength(1);
  });

  test("a held PermissionRequest is an ask, answered in Muse's shape", async () => {
    const held = mini.sessions.onHook("muse", museHook(A, "PermissionRequest", { turn_id: "t3", tool_name: "powershell", tool_input: { command: "rm -r build", description: "Clean", workdir: "C:\\work" } }), { via: "command" });
    const ask = await waitFor(() => mini.asks.listOpen()[0]);
    expect(ask.title).toBe("powershell in work");
    expect(ask.detail).toContain("rm -r build");
    expect(rec().status).toBe("needs_permission");
    mini.asks.answer(ask.id, { option: "allow" }, { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" });
    expect(await held).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    const denied = mini.sessions.onHook("muse", museHook(A, "PermissionRequest", { turn_id: "t3", tool_name: "powershell", tool_input: { command: "rm -r src" } }), { via: "command" });
    const second = await waitFor(() => mini.asks.listOpen()[0]);
    mini.asks.answer(second.id, { option: "deny", text: "not src" }, { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" });
    expect(await denied).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "not src" } } });
  });

  test("the plan's usage comes from the host", async () => {
    const profile = mini.profiles.byHarness("muse")[0]!.id;
    expect(await adapter.limits(profile)).toBeUndefined();
    writeJson(join(k.data, "muse", "usage.json"), { window: { usedPercent: 41, windowDurationMins: 300, resetsAtMs: 1790336519000 }, weekly: { usedPercent: 7, resetsAtMs: 1790553600000 }, tier: "t", observedAtMs: 1790320465717 });
    expect(await adapter.limits(profile)).toEqual({ at: 1790320465717, session: { percent: 41, resetsAt: 1790336519000 }, weekly: { percent: 7, resetsAt: 1790553600000 } });
  });

  test("a session known from its SessionStart gets its process from the hook's ancestors, and ends with it", async () => {
    const fresh = uuidv7();
    chains.set(5100, [
      { pid: 5100, name: "muse-bin-1.4.0-R4161.1.exe" },
      { pid: 5101, name: "powershell.exe" },
      { pid: 5102, name: "cmd.exe" },
    ]);
    alive.add(5100);
    await mini.sessions.onHook("muse", museHook(fresh, "SessionStart", { source: "startup", cwd: k.cwd }), { via: "command", ppid: 5100, profile: mini.profiles.byHarness("muse")[0]!.id });
    const s = await waitFor(() => mini.sessions.list().find((x) => x.native.id === fresh && x.native.pid === 5100));
    expect(s.status).toBe("idle");
    expect(s.origin).toBe("user");
    alive.delete(5100);
    await mini.sessions.tick();
    expect(mini.store.sessions.get(s.id)?.status).toBe("ended");
    expect(events(s.id).at(-1)?.payload).toEqual({ reason: "gone" });
  });

  test("SessionEnd ends a session", async () => {
    const id = rec().id;
    await mini.sessions.onHook("muse", museHook(A, "SessionEnd", { reason: "other" }), { via: "command" });
    expect(mini.store.sessions.get(id)?.status).toBe("ended");
  });

  test("a message to a session in no terminal is refused", async () => {
    seed(k, B, turn(B, 1, "b1", "other"), { open: true });
    await mini.sessions.onHook("muse", museHook(B, "SessionStart", { source: "resume", cwd: k.cwd }), { via: "command" });
    const s = mini.sessions.list().find((x) => x.native.id === B)!;
    await expect(mini.sessions.send(s.id, "hi")).rejects.toThrow(/only in a terminal/);
  });

  test("a session whose TUI closed with no SessionEnd heard ends once Muse lists it", async () => {
    const id = mini.sessions.list().find((x) => x.native.id === B)!.id;
    await mini.sessions.tick();
    expect(mini.store.sessions.get(id)?.status).toBe("idle");
    closed(k, B);
    await mini.sessions.tick();
    expect(mini.store.sessions.get(id)?.status).toBe("ended");
    expect(events(id).at(-1)?.payload).toEqual({ reason: "closed" });
  });
});

describe("muse profiles that change after start", () => {
  let k: Kit;
  let mini: Mini;
  let adapter: MuseAdapter;
  const initializes = () => readCalls(k).filter((c) => c.method === "initialize").length;

  beforeAll(async () => {
    k = kit();
    rmSync(k.config, { recursive: true, force: true });
    mini = await miniSessions(museToml(k, "muse_list_ms = 100000"), (host, log) => {
      adapter = new MuseAdapter({ host, log, version: "0.10.0", dataDir: join(k.scratch, "cophylad-data"), locate: fakeMuse, env: process.env });
      return [adapter];
    });
  }, 30_000);
  afterAll(() => mini.stop());

  test("a profile whose home comes after start gets a host and cophylad's plugin, approved", async () => {
    const id = mini.profiles.byHarness("muse")[0]!.id;
    expect(mini.profiles.get(id)!.status).toBe("missing");
    expect(initializes()).toBe(0);
    mkdirSync(k.config, { recursive: true });
    writeFileSync(join(k.config, "auth.json"), JSON.stringify({ providers: { meta: {} } }));
    mini.profiles.check();
    await mini.sessions.tick();
    expect(mini.profiles.get(id)!.status).toBe("ok");
    expect(initializes()).toBe(1);
    await adapter.pluginsReady();
    expect(adapter.pluginStatus(id)).toEqual({ installed: true, approved: true });
  });

  test("a new login starts its host again, which reads the login afresh", async () => {
    writeFileSync(join(k.config, "auth.json"), JSON.stringify({ providers: { meta: { again: true } } }));
    mini.profiles.check();
    await mini.sessions.tick();
    await waitFor(() => initializes() === 2);
    // Nothing changed since: the next checks start nothing.
    mini.profiles.check();
    await mini.sessions.tick();
    expect(initializes()).toBe(2);
  });
});

describe("muse sessions over a restart", () => {
  test("a session never read is recorded from its last events; after a restart only what is new", async () => {
    const k = kit();
    const storePath = join(k.scratch, "store.db");
    const C = uuidv7(Date.now() - 60000);
    const replies = Array.from({ length: 205 }, (_, i) => ev(C, i + 1, "item/completed", { item: { itemId: `a${i}`, kind: "agentMessage", revision: 2, status: "completed", recordedAt: iso(Date.now() - 30000), text: `reply ${i}` } }));
    seed(k, C, replies, { open: true });
    const start = () => miniSessions(museToml(k, "install_hooks = false\nmuse_list_ms = 1\nmuse_recent_ms = 600000"), (host, log) => [new MuseAdapter({ host, log, version: "0.10.0", dataDir: join(k.scratch, "cophylad-data"), locate: fakeMuse, env: process.env })], { storePath });
    let mini = await start();
    await mini.sessions.onHook("muse", museHook(C, "SessionStart", { source: "resume", cwd: k.cwd }), { via: "command" });
    await mini.sessions.tick();
    const id = mini.sessions.list()[0]!.id;
    const texts = () =>
      mini.store.sessionEvents
        .history(id, { limit: 1000 })
        .filter((e) => e.kind === "assistant_text")
        .map((e) => (e.payload as { text: string }).text);
    expect(texts()).toHaveLength(200);
    expect(texts()[0]).toBe("reply 5");
    await mini.stop();
    grow(k, C, [ev(C, 206, "item/completed", { item: { itemId: "new", kind: "agentMessage", revision: 2, status: "completed", text: "after the restart" } })]);
    mini = await start();
    await mini.sessions.tick();
    await mini.sessions.tick();
    expect(texts()).toHaveLength(201);
    expect(texts().at(-1)).toBe("after the restart");
    expect(readCalls(k).filter((c) => c.method === "view/page").map((c) => c.params["direction"] ?? c.params["cursor"])).toEqual(["backward", `v:${C}:205`]);
    await mini.stop();
  }, 30_000);
});

// --- a session cophylad starts in a tether terminal ----------------------------------------------------

describe("a muse session cophylad starts in tether", () => {
  let k: Kit;
  let fake: FakeTether;
  let tether: Tether;
  let mini: Mini;
  let workspace: string;
  let s: Session;
  let fs: FakeSession;
  let adapter: MuseAdapter;
  const chains = new Map<number, { pid: number; name: string }[]>();
  const raiser: WindowRaiser = {
    raise: async () => "not_found",
    ancestors: async (pid) => chains.get(pid) ?? [],
    ancestorsOf: async (pids) => new Map(pids.map((pid) => [pid, chains.get(pid) ?? []])),
    commandLine: async () => undefined,
  };
  const events = (id: string): SessionEvent[] => mini.store.sessionEvents.history(id, { limit: 500 });
  const MUSE_ID = uuidv7();

  beforeAll(async () => {
    k = kit();
    fake = await new FakeTether(join(k.scratch, "tether")).start();
    // Muse starts and draws its prompt; the session is made at the first prompt, and its
    // plugin's SessionStart fires then, from below the terminal.
    fake.onSpawn = (fs) => {
      fs.setScreen(EMPTY);
      chains.set(9100, [
        { pid: 9100, name: "muse-bin-1.4.0-R4161.1.exe" },
        { pid: 9101, name: "powershell.exe" },
        { pid: fs.pid, name: "cmd.exe" },
      ]);
      void waitFor(() => fs.typed.includes("keys:Enter"), 5000).then(() => mini.sessions.onHook("muse", museHook(MUSE_ID, "SessionStart", { source: "startup", cwd: k.cwd }), { via: "command", ppid: 9100 }));
    };
    tether = new Tether({
      config: { idle_exit_s: 600, window: "auto", window_on_start: false, profiles: false, on_path: false, dir: fake.dir },
      env: {},
      dataDir: join(k.scratch, "tether-data"),
      nodeId: "node_test",
      log: silentLogger,
      exe: "C:/fake/tether.exe",
      run: async () => ({ code: 0, out: "tether 0.1.0\n", err: "" }),
      connectOrStart: (opts) => TetherClient.connect(fake.host, { name: opts.name ?? "cophylad" }),
    });
    await tether.start();
    mini = await miniSessions(museToml(k, "muse_list_ms = 100000\nlaunch = \"terminal\""), (host, log) => {
      adapter = new MuseAdapter({ host, log, version: "0.10.0", dataDir: join(k.scratch, "cophylad-data"), locate: fakeMuse, raiser, env: process.env });
      return [adapter];
    }, {
      raiser,
      acp: (config) => ({ config: config.acp, env: {} }),
      deps: { tether, env: { PATH: "x" } },
    });
    workspace = mini.workspaces.fromSession(k.cwd).id;
  }, 30_000);

  afterAll(async () => {
    await mini.stop();
    await tether.stop();
    await fake.stop();
  });

  test("runs `muse` in a tether terminal under the profile's homes, and is claimed by the process tree", async () => {
    s = await mini.sessions.spawn({ harness: "muse", workspace, prompt: "Fix the flaky test", task: "tsk_01ARZ3NDEKTSV4RRFFQ69G5FB7" }, { profiles: mini.profiles });
    fs = [...fake.sessions.values()].find((x) => x.spawn.labels["cophylad.spawn"])!;
    expect(fs.spawn.argv).toEqual([process.execPath, FAKE_MUSE, "--provider", "echo"]);
    expect(fs.spawn.cwd).toBe(k.cwd);
    expect(fs.spawn.env.set?.["XDG_CONFIG_HOME"]).toBe(join(k.scratch, "config"));
    expect(fs.spawn.env.set?.["XDG_DATA_HOME"]).toBe(k.data);
    expect(fs.spawn.env.set?.["PATH"]).toBe("x");
    expect(s.native.id).toBe(MUSE_ID);
    expect(s.origin).toBe("orchestrator");
    expect(s.task).toBe("tsk_01ARZ3NDEKTSV4RRFFQ69G5FB7");
    expect(s.workspace).toBe(workspace);
    expect(s.native.terminal).toEqual({ host: fake.host.host, id: fs.id });
    expect(s.native.pid).toBe(9100);
  });

  test("its first prompt was typed before the session existed, and its prompt hook lands it as the user's turn", async () => {
    expect(fs.typed).toEqual(["paste:Fix the flaky test", "keys:Enter"]);
    await mini.sessions.onHook("muse", museHook(MUSE_ID, "UserPromptSubmit", { turn_id: "t1", prompt: "Fix the flaky test" }), { via: "command" });
    const turn = events(s.id).find((e) => e.kind === "user_turn")!;
    expect(turn.payload).toMatchObject({ text: "Fix the flaky test", source: "hook" });
  });

  test("the user's and the brain's messages are typed alike, with nothing over what is half typed", async () => {
    fs.typed.length = 0;
    fs.setScreen([TITLED, "❯ half a thou", RULE]);
    const r = await mini.sessions.send(s.id, "and the docs", { from: "user" });
    await sleep(900);
    expect(fs.typed).toEqual([]);
    fs.setScreen(EMPTY);
    await waitFor(() => fs.typed.includes("keys:Enter"), 5000);
    expect(fs.typed).toEqual(["paste:and the docs", "keys:Enter"]);
    await mini.sessions.onHook("muse", museHook(MUSE_ID, "UserPromptSubmit", { turn_id: "t2", prompt: "and the docs" }), { via: "command" });
    expect(events(s.id).some((e) => e.kind === "user_turn" && (e.payload as { ref?: string }).ref === r.ref)).toBe(true);
    fs.typed.length = 0;
    await mini.sessions.send(s.id, "from the brain", { from: "brain" });
    await waitFor(() => fs.typed.includes("paste:from the brain"), 5000);
  }, 20_000);

  test("stop ends its terminal", async () => {
    await mini.sessions.stopSession(s.id);
    expect(fake.requests.some((r) => r.op === "kill" && r.body["session"] === fs.id)).toBe(true);
    expect(mini.sessions.get(s.id)?.status).toBe("ended");
  });

  test("a user's own Muse run straight in a terminal is met with it: its process is the terminal's", async () => {
    const own = fake.add({ argv: ["muse-bin-1.4.0-R4161.1.exe", "--provider", "echo"], cwd: k.cwd }, 8123);
    await waitFor(() => tether.byPid(8123));
    chains.set(8123, [{ pid: 8123, name: "muse-bin-1.4.0-R4161.1.exe" }]);
    const id = uuidv7();
    await mini.sessions.onHook("muse", museHook(id, "SessionStart", { source: "startup", cwd: k.cwd }), { via: "command", ppid: 8123 });
    const mine = await waitFor(() => mini.sessions.list().find((x) => x.native.id === id && x.native.terminal !== undefined));
    expect(mine.native.terminal).toEqual({ host: fake.host.host, id: own.id });
    expect(mine.native.pid).toBe(8123);
    expect(mine.origin).toBe("user");
  });

  test("where Muse has not approved cophylad's hooks, the session starts headless: in a terminal nothing would find it", async () => {
    const plugin = adapter.pluginStatus(mini.profiles.byHarness("muse")[0]!.id)!;
    expect(plugin.approved).toBe(true);
    plugin.approved = false;
    try {
      const h = await mini.sessions.spawn({ harness: "muse", workspace, prompt: "hello there" }, { profiles: mini.profiles });
      expect(h.native.terminal).toBeUndefined();
      expect(readCalls(k).find((c) => c.method === "session/start")?.params).toMatchObject({ sessionId: h.native.id, workspaceRoot: k.cwd });
      expect([...fake.sessions.values()].filter((x) => x.spawn.labels["cophylad.spawn"])).toHaveLength(1);
    } finally {
      plugin.approved = true;
    }
  });
});

// --- a muse session cophylad runs headless ---------------------------------------------------------------

describe("a muse session cophylad runs headless", () => {
  let k: Kit;
  let mini: Mini;
  let workspace: string;
  let s: Session;
  const events = (): SessionEvent[] => mini.store.sessionEvents.history(s.id, { limit: 500 });

  beforeAll(async () => {
    k = kit();
    mini = await miniSessions(museToml(k, "install_hooks = false\nmuse_list_ms = 100000\nlaunch = \"acp\""), (host, log) => [new MuseAdapter({ host, log, version: "0.10.0", dataDir: join(k.scratch, "cophylad-data"), locate: fakeMuse, env: process.env })], {
      acp: (config) => ({ config: config.acp, env: {} }),
    });
    workspace = mini.workspaces.fromSession(k.cwd).id;
  }, 30_000);
  afterAll(() => mini.stop());

  test("starts on the profile's host, and its first turn plays out in the timeline", async () => {
    s = await mini.sessions.spawn({ harness: "muse", workspace, prompt: "hello there" }, { profiles: mini.profiles });
    expect(s.native.transport).toBe("msp");
    expect(s.origin).toBe("orchestrator");
    expect(s.native.terminal).toBeUndefined();
    const start = readCalls(k).find((c) => c.method === "session/start")!;
    expect(start.params).toMatchObject({ sessionId: s.native.id, workspaceRoot: k.cwd });
    await waitFor(() => events().some((e) => e.kind === "assistant_text"));
    await waitFor(() => mini.sessions.get(s.id)?.status === "idle");
    expect(events().map((e) => e.kind)).toEqual(["status", "user_turn", "status", "assistant_text", "status"]);
    expect(events()[1]!.payload).toEqual({ text: "hello there", source: "orchestrator", ref: `cophylad-spawn-${s.native.id}` });
    expect(mini.sessions.get(s.id)?.stats).toMatchObject({ tokens: { in: 100, out: 10 }, context: { used: 110, limit: 1000000 }, model: "muse-spark-1.3" });
  });
});

describe("a muse session cophylad runs headless, asking", () => {
  let k: Kit;
  let mini: Mini;
  let workspace: string;
  let s: Session;
  const events = (): SessionEvent[] => mini.store.sessionEvents.history(s.id, { limit: 500 });
  const by = { kind: "user" as const, client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" };

  beforeAll(async () => {
    k = kit();
    mini = await miniSessions(
      museToml(k, "install_hooks = false\nmuse_list_ms = 100000\nlaunch = \"acp\""),
      (host, log, asks) => [new MuseAdapter({ host, log, version: "0.10.0", dataDir: join(k.scratch, "cophylad-data"), locate: fakeMuse, env: process.env, asks, askTimeoutS: 600 })],
      { acp: (config) => ({ config: config.acp, env: {} }) },
    );
    workspace = mini.workspaces.fromSession(k.cwd).id;
  }, 30_000);
  afterAll(() => mini.stop());

  test("an approval is a permission ask with Muse's own choices, decided with the one picked", async () => {
    s = await mini.sessions.spawn({ harness: "muse", workspace, prompt: "please approve the echo" }, { profiles: mini.profiles });
    const ask = await waitFor(() => mini.asks.listOpen()[0], 5000);
    expect(ask.type).toBe("permission");
    expect(ask.options.map((o) => [o.id, o.style])).toEqual([
      ["allow_once", "primary"],
      ["allow_local_prefix", "primary"],
      ["abort", "danger"],
    ]);
    expect(ask.detail).toContain("echo hi");
    expect(ask.allowsText).toBe(true);
    expect(mini.sessions.get(s.id)?.status).toBe("needs_permission");
    mini.asks.answer(ask.id, { option: "allow_once" }, by);
    await waitFor(() => events().some((e) => e.kind === "tool_result"), 5000);
    const decide = readCalls(k).find((c) => c.method === "approval/decide")!;
    expect(decide.params).toMatchObject({ approvalId: expect.stringMatching(/^ap-/), choiceId: "allow_once", requirementId: { sourceIndex: 0 } });
    await waitFor(() => mini.sessions.get(s.id)?.status === "idle", 5000);
    expect(events().find((e) => e.kind === "tool_result")!.payload).toMatchObject({ tool: "powershell", id: "call_1", result: "hi\r\n" });
  });

  test("a question is one ask per question in turn, answered together", async () => {
    await mini.sessions.send(s.id, "now ask me", { from: "user" });
    const first = await waitFor(() => mini.asks.listOpen()[0], 5000);
    expect(first.type).toBe("choice");
    expect(first.title).toBe("Which colour?");
    mini.asks.answer(first.id, { option: "Blue" }, by);
    const second = await waitFor(() => mini.asks.listOpen().find((a) => a.id !== first.id), 5000);
    expect(second.multiple).toBe(true);
    mini.asks.answer(second.id, { option: "S", options: ["S", "L"], text: "and XL" }, by);
    const answer = await waitFor(() => readCalls(k).find((c) => c.method === "userInput/answer"), 5000);
    expect(answer.params["answers"]).toEqual([
      { questionId: "q1", selectedLabel: "Blue" },
      { questionId: "q2", selectedLabels: ["S", "L"], freeText: "and XL" },
    ]);
    await waitFor(() => mini.sessions.get(s.id)?.status === "idle", 5000);
  });

  test("an ask that is cancelled rejects the approval", async () => {
    await mini.sessions.send(s.id, "approve once more", { from: "user" });
    const ask = await waitFor(() => mini.asks.listOpen()[0], 5000);
    mini.asks.cancel(ask.id);
    await waitFor(() => readCalls(k).filter((c) => c.method === "approval/decide").some((c) => c.params["choiceId"] === "abort"), 5000);
    await waitFor(() => mini.sessions.get(s.id)?.status === "idle", 5000);
    expect(events().find((e) => e.kind === "tool_result" && (e.payload as { isError?: boolean }).isError)).toBeDefined();
  });

  test("stop ends it", async () => {
    await mini.sessions.stopSession(s.id);
    expect(mini.sessions.get(s.id)?.status).toBe("ended");
    await expect(mini.sessions.send(s.id, "more")).rejects.toThrow(/ended/);
  });
});
