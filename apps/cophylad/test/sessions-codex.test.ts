// The Codex adapter in pieces: the rollout parser over a redacted capture, the app-server
// client against the fake stdio child, the hooks installer and the trust grant, the
// injection bookkeeping with an injected clock, and the adapter over the fake: listing,
// tailing, sending, withdrawing after the receipt window and holding while busy; then an
// ended thread over a store file: history not resetting the inactivity clock, a listing with
// nothing new leaving it ended, a grown rollout resuming it with only the new lines recorded,
// and a restart tailing again without adding events. A profile that comes after start gets its
// app-server and hooks, a new login restarts the app-server, a quit before the first prompt
// leaves no session, a sub-agent's hook under its parent's id leaves the parent's transcript
// be, and a thread the app-server daemon runs takes its CLI's terminal: never on a command
// line that could not be read, which is read again a while later; again after a daemon update
// or a resume the thread list shows; never the daemon's pid, which a record from before lets
// go and a stop never ends; not for a `codex exec` under the daemon; a terminal freed by a
// session that ended goes to one waiting, and its CLI started again is marked again; of two
// CLIs, the one started just before the thread, or none when that cannot be told; a CLI's
// `/new` and `/resume` hand its terminal over; and a desktop app's thread takes none. A thread
// met again after a restart is judged by its CLI while that runs, however long it sat idle; a
// pid another program or a later process holds by then is let go, and recency judges it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CodexHookEvent, SessionEvent } from "@cophyla/protocol";
import { TetherClient } from "@tether-pty/client";
import { createLogger, silentLogger } from "../src/log.ts";
import { CodexAdapter, isManagedDaemon } from "../src/sessions/codex/adapter.ts";
import { CodexAppServer } from "../src/sessions/codex/appserver.ts";
import { installCodexHooks, isCophyladCodexGroup, readHooksFile, trustCodexHooks, trustEdit, uninstallCodexHooks } from "../src/sessions/codex/hooks.ts";
import { applyCodexRow, findRollout, newCodexState, readSessionIndex, statsFor } from "../src/sessions/codex/rollout.ts";
import type { CodexItem } from "../src/sessions/codex/rollout.ts";
import type { WindowRaiser } from "../src/sessions/focus.ts";
import { Injections } from "../src/sessions/injections.ts";
import type { PendingSend } from "../src/sessions/injections.ts";
import type { ProcessRow } from "../src/sessions/tether/cli.ts";
import { Tether } from "../src/sessions/tether/index.ts";
import { uuidv7 } from "../src/sessions/uuidv7.ts";
import { FakeTether } from "./fakes/tether.ts";
import { FAKE_CODEX, miniSessions, removeHome, sleep, tempHome, tomlString, waitFor } from "./helpers.ts";
import type { Mini } from "./helpers.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "codex-rollout.jsonl");
const THREAD = "01a0af79-2976-7752-8597-4e480c5860cd";

function fakeServer(home: string, extraEnv: Record<string, string> = {}): CodexAppServer {
  const log = process.env["COPHYLA_TEST_DEBUG"] ? createLogger("debug") : silentLogger;
  return new CodexAppServer({ command: process.execPath, args: [FAKE_CODEX], env: { ...process.env, CODEX_HOME: home, ...extraEnv }, log, version: "0.1.0" });
}

const readJson = <T>(path: string, fallback: T): T => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback);

describe("codex rollout parser", () => {
  const state = newCodexState();
  const items: CodexItem[] = [];
  for (const line of readFileSync(FIXTURE, "utf8").split("\n")) {
    if (line.trim()) items.push(...applyCodexRow(state, JSON.parse(line)));
  }

  test("yields the session meta, turns, typed and queued user messages, tool calls and results, assistant text", () => {
    expect(items.map((i) => i.kind)).toEqual([
      "meta",
      "task_started",
      "turn_context",
      "user_message",
      "assistant_text",
      "task_complete",
      "task_started",
      "user_message",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "assistant_text",
      "task_complete",
    ]);
    const meta = items[0]!;
    expect(meta.kind === "meta" && meta.sessionId).toBe(THREAD);
    expect(meta.kind === "meta" && meta.cwd).toBe("C:\\D\\orchestrator\\spikes\\05-codex\\target");
    const typed = items[3]!;
    expect(typed.kind === "user_message" && typed.text).toBe("reply with the single word ok");
    expect(typed.kind === "user_message" && typed.clientId).toBeUndefined();
    const queued = items[7]!;
    expect(queued.kind === "user_message" && queued.clientId).toBe("cophylad-01ARZ3NDEKTSV4RRFFQ69G5FC0");
    const shell = items[8]!;
    expect(shell.kind === "tool_call" && shell.name).toBe("shell");
    expect(shell.kind === "tool_call" && shell.input).toEqual({ command: ["bun", "test"] });
    const shellOut = items[9]!;
    expect(shellOut.kind === "tool_result" && shellOut.name).toBe("shell");
    expect(shellOut.kind === "tool_result" && (shellOut.output as { output: string }).output).toBe("ok");
    const done = items[13]!;
    expect(done.kind === "task_complete" && done.lastMessage).toBe("Tests pass.");
    expect(state.busyTurn).toBeUndefined();
    expect(state.model).toBe("gpt-5.6-luna");
  });

  test("stats come from the cumulative token_count, with the window from the last usage", () => {
    expect(statsFor(state)).toEqual({ turns: 1, cost: 0, tokens: { in: 30000, out: 50, cacheRead: 20000, cacheWrite: 100 }, context: { used: 12545, limit: 258400 }, model: "gpt-5.6-luna" });
  });

  test("finds a rollout by thread id and reads the session index", () => {
    const home = tempHome();
    const dir = join(home, "sessions", "2026", "09", "17");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-2026-09-17T15-05-48-${THREAD}.jsonl`);
    writeFileSync(path, "");
    expect(findRollout(home, THREAD)).toBe(path);
    expect(findRollout(home, "nope")).toBeUndefined();
    writeFileSync(join(home, "session_index.jsonl"), `{"id":"${THREAD}","thread_name":"first","updated_at":"x"}\n{"id":"${THREAD}","thread_name":"renamed","updated_at":"y"}\n{"id":"other","thread_name":"o","updated_at":"z"}\n{"id":"part`);
    const names = readSessionIndex(home);
    expect(names.get(THREAD)).toBe("renamed");
    expect(names.size).toBe(2);
  });
});

describe("codex app-server client against the fake", () => {
  let home: string;
  beforeAll(() => {
    home = tempHome();
    const threads = Array.from({ length: 120 }, (_, i) => ({ id: `t-${i}`, sessionId: `t-${i}`, cwd: "C:\\D\\x", name: `thread ${i}`, preview: `preview ${i}`, path: null, createdAt: 1789650000 + i, updatedAt: 1789650000 + i, status: { type: "notLoaded" } }));
    writeFileSync(join(home, "threads.json"), JSON.stringify(threads));
  });

  test("initializes, pages thread/list by cursor, queues and deletes", async () => {
    const server = fakeServer(home);
    try {
      const init = await server.start();
      expect(init.codexHome).toBe(home);
      expect(server.alive).toBe(true);
      const seen: string[] = [];
      let cursor: string | null | undefined;
      let pages = 0;
      do {
        const r = await server.call<{ data: { id: string }[]; nextCursor: string | null }>("thread/list", { limit: 50, ...(cursor ? { cursor } : {}), sortKey: "updated_at", sortDirection: "desc", useStateDbOnly: true });
        seen.push(...r.data.map((t) => t.id));
        cursor = r.nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(3);
      expect(seen).toHaveLength(120);
      expect(seen[0]).toBe("t-119");
      const added = await server.call<{ queuedSubmission: { id: string; clientUserMessageId: string } }>("thread/queue/add", { threadId: "t-1", clientUserMessageId: "cophylad-x", input: [{ type: "text", text: "hi" }] });
      expect(added.queuedSubmission.clientUserMessageId).toBe("cophylad-x");
      const deleted = await server.call<{ deleted: boolean }>("thread/queue/delete", { threadId: "t-1", queuedSubmissionId: added.queuedSubmission.id });
      expect(deleted.deleted).toBe(true);
      const log = readJson<{ op: string }[]>(join(home, "queue.json"), []);
      expect(log.map((l) => l.op)).toEqual(["add", "delete"]);
      const unknown = await server.call("no/such", {}).then(
        () => "resolved",
        (e: Error) => e.message,
      );
      expect(unknown).toMatch(/unknown method/);
    } finally {
      await server.stop();
    }
    expect(server.alive).toBe(false);
  });

  test("declines a server request", async () => {
    const server = fakeServer(home, { FAKE_SERVER_REQUEST: "1" });
    try {
      await server.start();
      const answers = await waitFor(() => {
        const a = readJson<{ result?: unknown; error?: unknown }[]>(join(home, "requests.json"), []);
        return a.length > 0 ? a : undefined;
      });
      expect(answers[0]!.result).toEqual({ decision: "decline" });
    } finally {
      await server.stop();
    }
  });
});

describe("codex hooks installer and trust", () => {
  const command = '"C:/bun.exe" "C:/cophyla/data/cophylad-hook-shim.mjs" codex prof_x';
  const commandWindows = `& ${command}`;
  const foreign = { hooks: [{ type: "command", command: "node C:/tools/other.mjs" }] };

  test("install keeps foreign hooks, is idempotent, clamps SessionEnd, and uninstall removes only ours", () => {
    const home = tempHome();
    const path = join(home, "hooks.json");
    writeFileSync(path, JSON.stringify({ hooks: { Stop: [foreign] } }));
    installCodexHooks(path, { command, commandWindows, timeoutS: 7200 });
    let doc = readHooksFile(path) as { hooks: Record<string, { hooks: Record<string, unknown>[] }[]> };
    expect(doc.hooks["Stop"]).toHaveLength(2);
    expect(doc.hooks["Stop"]![0]).toEqual(foreign);
    expect(isCophyladCodexGroup(doc.hooks["Stop"]![1])).toBe(true);
    expect(doc.hooks["SessionStart"]![0]!.hooks[0]).toEqual({ type: "command", command, commandWindows, timeout: 7200, async: false, statusMessage: "cophylad" });
    expect(doc.hooks["SessionEnd"]![0]!.hooks[0]!["timeout"]).toBe(3);
    expect(Object.keys(doc.hooks)).toHaveLength(6);
    installCodexHooks(path, { command, commandWindows, timeoutS: 7200 });
    doc = readHooksFile(path) as typeof doc;
    expect(doc.hooks["Stop"]).toHaveLength(2);
    uninstallCodexHooks(path);
    expect(readHooksFile(path)).toEqual({ hooks: { Stop: [foreign] } });
    const fresh = join(home, "fresh", "hooks.json");
    mkdirSync(join(home, "fresh"));
    installCodexHooks(fresh, { command, commandWindows, timeoutS: 10 });
    expect(Object.keys((readHooksFile(fresh) as { hooks: object }).hooks)).toHaveLength(6);
  });

  test("a trust edit escapes the key's backslashes and keeps the hash as reported", () => {
    const e = trustEdit({ key: "C:\\Users\\me\\.codex\\hooks.json:stop:0:0", eventName: "stop", currentHash: "sha256:abc", trustStatus: "untrusted" });
    expect(e).toEqual({ keyPath: 'hooks.state."C:\\\\Users\\\\me\\\\.codex\\\\hooks.json:stop:0:0".trusted_hash', value: "sha256:abc", mergeStrategy: "upsert" });
    expect(trustEdit({ key: "k", eventName: "stop", currentHash: "abc", trustStatus: "untrusted" }).value).toBe("sha256:abc");
  });

  test("the grant turns untrusted entries trusted through hooks/list and config/batchWrite", async () => {
    const home = tempHome();
    const path = join(home, "hooks.json");
    installCodexHooks(path, { command, commandWindows, timeoutS: 7200 });
    const server = fakeServer(home);
    try {
      await server.start();
      const r = await trustCodexHooks(server, { hooksPath: path, codexHome: home, log: silentLogger });
      expect(r.refused).toBeUndefined();
      expect(r.trusted).toBe(6);
      expect(r.untrusted).toBe(0);
      expect(r.entries.every((e) => e.sourcePath === path)).toBe(true);
      const trust = readJson<Record<string, string>>(join(home, "trust.json"), {});
      expect(Object.keys(trust)).toHaveLength(6);
      expect(Object.keys(trust)[0]).toContain(path);
      const again = await trustCodexHooks(server, { hooksPath: path, codexHome: home, log: silentLogger });
      expect(again.trusted).toBe(6);
    } finally {
      await server.stop();
    }
  });

  test("a refused grant is reported, not thrown", async () => {
    const home = tempHome();
    const path = join(home, "hooks.json");
    installCodexHooks(path, { command, commandWindows, timeoutS: 7200 });
    const server = fakeServer(home, { FAKE_REFUSE_TRUST: "1" });
    try {
      await server.start();
      const r = await trustCodexHooks(server, { hooksPath: path, codexHome: home, log: silentLogger });
      expect(r.refused).toMatch(/refused/);
      expect(r.untrusted).toBe(6);
    } finally {
      await server.stop();
    }
  });
});

describe("injections with an injected clock", () => {
  test("times out, holds while busy, re-arms on idle, and a late receipt still delivers", () => {
    let now = 1000;
    const timers: { fn: () => void; at: number; id: number }[] = [];
    let seq = 0;
    const fired: PendingSend[] = [];
    const inj = new Injections({
      timeoutMs: 100,
      now: () => now,
      schedule: (fn, ms) => {
        const t = { fn, at: now + ms, id: ++seq };
        timers.push(t);
        return t.id;
      },
      cancel: (id) => {
        const i = timers.findIndex((t) => t.id === id);
        if (i >= 0) timers.splice(i, 1);
      },
      onTimeout: (p) => fired.push(p),
    });
    const advance = (ms: number) => {
      now += ms;
      for (const t of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    };
    const p = inj.add({ ref: "r1", session: "s", harness: "codex", text: "hi", body: "[cophylad]\nhi", at: now });
    expect(inj.pending("s")).toHaveLength(1);
    advance(99);
    expect(fired).toHaveLength(0);
    advance(1);
    expect(fired).toHaveLength(1);
    inj.hold(p);
    expect(p.waitingForIdle).toBe(true);
    advance(500);
    expect(fired).toHaveLength(1);
    inj.rearm("s");
    expect(p.waitingForIdle).toBeUndefined();
    advance(100);
    expect(fired).toHaveLength(2);
    expect(inj.settle("r1", "unconfirmed")?.state).toBe("unconfirmed");
    expect(inj.matchText("s", "prefix [cophylad]\nhi suffix")?.ref).toBe("r1");
    expect(inj.settle("r1", "delivered")?.state).toBe("delivered");
    expect(inj.settle("r1", "withdrawn")).toBeUndefined();
    expect(inj.pending("s")).toHaveLength(0);
    expect(inj.matchText("s", "nothing")).toBeUndefined();
  });
});

describe("codex adapter over the fake app-server", () => {
  let mini: Mini;
  let home: string;
  let cwd: string;
  let rolloutPath: string;
  const events = (id: string): SessionEvent[] => mini.store.sessionEvents.history(id, { limit: 500 });
  const queueLog = () => readJson<{ op: string; clientUserMessageId?: string }[]>(join(home, "queue.json"), []);

  beforeAll(async () => {
    const scratch = tempHome();
    home = join(scratch, "codex-home");
    cwd = join(scratch, "work");
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(home, "auth.json"), "{}");
    const dir = join(home, "sessions", "2026", "09", "17");
    mkdirSync(dir, { recursive: true });
    rolloutPath = join(dir, `rollout-2026-09-17T15-05-48-${THREAD}.jsonl`);
    const lines = readFileSync(FIXTURE, "utf8").split("\n").filter((l) => l.trim());
    writeFileSync(rolloutPath, lines.slice(0, 10).join("\n") + "\n");
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(
      join(home, "threads.json"),
      JSON.stringify([
        { id: THREAD, sessionId: THREAD, cwd, name: "spike thread", preview: "reply with the single word ok", path: rolloutPath, createdAt: now - 60, updatedAt: now - 30, status: { type: "notLoaded" } },
        { id: "old-thread", sessionId: "old-thread", cwd, name: "old", preview: "old", path: null, createdAt: now - 100000, updatedAt: now - 90000, status: { type: "notLoaded" } },
      ]),
    );
    mini = await miniSessions(
      `[sessions]\ndiscover = false\ninstall_hooks = true\npoll_ms = 100000\ncodex_list_ms = 1\nreceipt_timeout_ms = 250\ncodex_recent_ms = 600000\n\n[[profiles]]\nharness = "codex"\nname = "fake"\nconfig_dir = ${tomlString(home)}\ncommand = ${tomlString(process.execPath)}\nargs = [${tomlString(FAKE_CODEX)}]\n`,
      (host, log) => [new CodexAdapter({ host, log, version: "0.1.0", raiser: tree })],
    );
  });
  afterAll(() => mini.stop());

  /** The process tree a hook's `x-cophyla-ppid` is walked up: the shim's parent is the shell Codex spawned, and Codex is above it. */
  const walked: number[] = [];
  const tree = {
    async ancestors(pid: number) {
      walked.push(pid);
      return pid === 4242 ? [{ pid: 4242, name: "sh" }, { pid: 4100, name: process.platform === "win32" ? "codex.exe" : "codex-x86_64-unknown-linux-musl" }, { pid: 4000, name: "zsh" }] : [];
    },
  };

  test("installs and trusts hooks in the fake home, and lists only the recent thread", async () => {
    const doc = readHooksFile(join(home, "hooks.json")) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(doc.hooks)).toHaveLength(6);
    const hook = (doc.hooks["Stop"]![0] as { hooks: { command: string; commandWindows: string }[] }).hooks[0]!;
    expect(hook.command.startsWith('"')).toBe(true);
    expect(hook.command).toContain('cophylad-hook-shim.mjs" codex prof_');
    expect(hook.commandWindows).toBe(`& ${hook.command}`);
    expect(Object.keys(readJson<Record<string, string>>(join(home, "trust.json"), {}))).toHaveLength(6);
    const list = mini.sessions.list();
    expect(list.map((s) => s.native.id)).toEqual([THREAD]);
    const s = list[0]!;
    expect(s.native.transport).toBe("app-server");
    expect(s.title).toBe("spike thread");
    expect(s.transcript?.path).toBe(rolloutPath);
    expect(s.intent).toBe("reply with the single word ok");
    expect(s.status).toBe("idle");
    expect(s.stats).toEqual({ turns: 1, cost: 0, tokens: { in: 17443, out: 5, cacheRead: 11008 }, context: { used: 17448, limit: 258400 }, model: "gpt-5.6-luna" });
    expect(events(s.id).map((e) => e.kind)).toEqual(["status", "status", "user_turn", "assistant_text", "status"]);
  });

  test("a send is queued through thread/queue/add, and withdrawn after the receipt window when idle", async () => {
    const s = mini.sessions.list()[0]!;
    const r = await mini.sessions.send(s.id, "hello");
    expect(r.status).toBe("queued");
    expect(r.ref!.startsWith("cophylad-")).toBe(true);
    await waitFor(() => queueLog().some((q) => q.op === "add" && q.clientUserMessageId === r.ref));
    await waitFor(() => queueLog().some((q) => q.op === "delete"), 2000);
    const n = await waitFor(() => events(s.id).find((e) => e.kind === "notification" && (e.payload as { ref: string }).ref === r.ref));
    expect(n.payload).toEqual({ type: "message", ref: r.ref, state: "withdrawn" });
  });

  test("the receipt lands when the rollout shows cophylad's client_id, before the window closes", async () => {
    const s = mini.sessions.list()[0]!;
    const r = await mini.sessions.send(s.id, "run the tests");
    const lines = readFileSync(FIXTURE, "utf8").split("\n").filter((l) => l.trim());
    const queuedRow = lines[11]!.replace("cophylad-01ARZ3NDEKTSV4RRFFQ69G5FC0", r.ref!);
    writeFileSync(rolloutPath, lines.slice(0, 11).join("\n") + "\n" + queuedRow + "\n", { flag: "w" });
    await mini.sessions.tick();
    const n = events(s.id).find((e) => e.kind === "notification" && (e.payload as { ref: string }).ref === r.ref);
    expect(n?.payload).toEqual({ type: "message", ref: r.ref, state: "delivered" });
    expect(events(s.id).filter((e) => e.kind === "user_turn")).toHaveLength(1);
    expect(mini.store.sessions.get(s.id)?.status).toBe("busy");
    await sleep(400);
    expect(queueLog().filter((q) => q.op === "delete")).toHaveLength(1);
  });

  test("the withdrawal timer is held while the thread is busy and re-armed at its Stop", async () => {
    const s = mini.sessions.list()[0]!;
    expect(mini.store.sessions.get(s.id)?.status).toBe("busy");
    const r = await mini.sessions.send(s.id, "later");
    await sleep(450);
    expect(queueLog().filter((q) => q.op === "delete")).toHaveLength(1);
    const answer = await mini.sessions.onHook("codex", { hook_event_name: "Stop", session_id: THREAD, turn_id: "t", cwd, last_assistant_message: "ok", stop_hook_active: false }, { via: "command", ppid: 4242 });
    expect(answer).toEqual({});
    expect(mini.store.sessions.get(s.id)?.status).toBe("idle");
    // the hook's ppid is walked once, and the `codex` ancestor becomes the session's pid
    await waitFor(() => mini.sessions.list().find((x) => x.id === s.id)?.native.pid === 4100);
    expect(walked).toEqual([4242]);
    await mini.sessions.onHook("codex", { hook_event_name: "Stop", session_id: THREAD, turn_id: "t2", cwd, last_assistant_message: "ok", stop_hook_active: false }, { via: "command", ppid: 4242 });
    expect(walked).toEqual([4242]);
    await waitFor(() => queueLog().filter((q) => q.op === "delete").length === 2, 2000);
    const n = await waitFor(() => events(s.id).find((e) => e.kind === "notification" && (e.payload as { ref: string }).ref === r.ref));
    expect(n.payload).toEqual({ type: "message", ref: r.ref, state: "withdrawn" });
  });

  test("a SessionStart hook creates a session the store does not have yet, and SessionEnd ends it", async () => {
    const answer = await mini.sessions.onHook("codex", { hook_event_name: "SessionStart", session_id: "fresh-thread", cwd, transcript_path: null, model: "gpt-5.6-luna", permission_mode: "default", source: "startup" }, { via: "command", profile: mini.profiles.byHarness("codex")[0]!.id });
    expect(answer).toEqual({});
    const s = mini.sessions.list().find((x) => x.native.id === "fresh-thread")!;
    expect(s.status).toBe("idle");
    expect(s.cwd).toBe(cwd);
    await mini.sessions.onHook("codex", { hook_event_name: "sessionEnd", session_id: "fresh-thread", cwd, reason: "exit" }, { via: "command" });
    expect(mini.sessions.list().find((x) => x.native.id === "fresh-thread")).toBeUndefined();
    expect(mini.store.sessions.get(s.id)?.status).toBe("ended");
    expect(events(s.id).at(-1)?.kind).toBe("ended");
  });

  test("a SessionEnd for a thread no session stands for makes none: a CLI quit before its first prompt", async () => {
    const answer = await mini.sessions.onHook("codex", { hook_event_name: "sessionEnd", session_id: "never-prompted", cwd, reason: "exit" }, { via: "command" });
    expect(answer).toEqual({});
    expect(mini.store.sessions.getByNative("codex", "never-prompted")).toBeUndefined();
  });

  test("a sub-agent's hook under its parent's id is the parent's, but the sub-agent's rollout is not the parent's transcript", async () => {
    const s = mini.sessions.list().find((x) => x.native.id === THREAD)!;
    const child = "01a0af90-1111-7222-8333-444455556666";
    const childPath = join(dirname(rolloutPath), `rollout-2026-09-17T15-20-00-${child}.jsonl`);
    const usage = { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1, total_tokens: 6 };
    writeFileSync(childPath, JSON.stringify({ timestamp: "2026-09-17T13:20:00.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage, model_context_window: 258400 } } }) + "\n");
    const postToolUse = (sessionId: string, id: string) => ({ hook_event_name: "PostToolUse" as const, session_id: sessionId, turn_id: "sub-turn", cwd, transcript_path: childPath, tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "ok", tool_use_id: id });
    expect(await mini.sessions.onHook("codex", postToolUse(THREAD, "call_sub_1"), { via: "command" })).toEqual({});
    await mini.sessions.tick();
    const after = mini.sessions.list().find((x) => x.id === s.id)!;
    expect(after.transcript?.path).toBe(rolloutPath);
    expect(after.stats).toEqual(s.stats);
    expect(events(s.id).some((e) => e.kind === "tool_result" && (e.payload as { id?: string }).id === "call_sub_1")).toBe(true);
    // A thread first heard of through a sub-agent's hook does not take its rollout either.
    await mini.sessions.onHook("codex", postToolUse("unseen-parent", "call_sub_2"), { via: "command", profile: mini.profiles.byHarness("codex")[0]!.id });
    const unseen = mini.sessions.list().find((x) => x.native.id === "unseen-parent")!;
    expect(unseen.transcript?.path).not.toBe(childPath);
  });
});

describe("codex profiles that change after start", () => {
  let scratch: string;
  let home: string;
  let trace: string;
  let mini: Mini;
  const initializes = () => (existsSync(trace) ? readFileSync(trace, "utf8").split("\n").filter((l) => l.startsWith("IN ") && l.includes('"method":"initialize"')).length : 0);

  beforeAll(async () => {
    scratch = tempHome();
    home = join(scratch, "codex-later");
    trace = join(scratch, "trace.log");
    mini = await miniSessions(
      `[sessions]\ndiscover = false\ninstall_hooks = true\npoll_ms = 100000\ncodex_list_ms = 1\n\n[[profiles]]\nharness = "codex"\nname = "later"\nconfig_dir = ${tomlString(home)}\ncommand = ${tomlString(process.execPath)}\nargs = [${tomlString(FAKE_CODEX)}]\n`,
      (host, log) => [new CodexAdapter({ host, log, version: "0.1.0", env: { ...process.env, FAKE_TRACE: trace } })],
    );
  });
  afterAll(async () => {
    await mini.stop();
    removeHome(scratch);
  });

  test("a profile whose directory comes after start gets an app-server, cophylad's hooks and their trust", async () => {
    const id = mini.profiles.byHarness("codex")[0]!.id;
    expect(mini.profiles.get(id)!.status).toBe("missing");
    expect(initializes()).toBe(0);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "auth.json"), "{}");
    mini.profiles.check();
    await mini.sessions.tick();
    expect(mini.profiles.get(id)!.status).toBe("ok");
    expect(initializes()).toBe(1);
    expect(Object.keys((readHooksFile(join(home, "hooks.json")) as { hooks: object }).hooks)).toHaveLength(6);
    expect(Object.keys(readJson<Record<string, string>>(join(home, "trust.json"), {}))).toHaveLength(6);
  });

  test("a new login starts its app-server again, which reads the login afresh", async () => {
    writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: "after a new login" }));
    mini.profiles.check();
    await mini.sessions.tick();
    await waitFor(() => initializes() === 2);
    // Nothing changed since: the next checks start nothing.
    mini.profiles.check();
    await mini.sessions.tick();
    expect(initializes()).toBe(2);
  });
});

describe("a codex thread the app-server daemon runs", () => {
  let scratch: string;
  let home: string;
  let cwd: string;
  let fake: FakeTether;
  let tether: Tether;
  let mini: Mini;
  let profile: string;
  const table: ProcessRow[] = [];
  const alive = new Set<number>();
  const chains = new Map<number, { pid: number; name: string }[]>();
  const commandLines = new Map<number, string[]>();
  /** Processes whose command line cannot be read now (a timed-out read). */
  const failing = new Set<number>();
  const read: number[] = [];
  const tree = {
    async ancestors(pid: number) {
      return chains.get(pid) ?? [];
    },
    async commandLine(pid: number) {
      read.push(pid);
      return failing.has(pid) ? undefined : commandLines.get(pid);
    },
  };
  const raiser: WindowRaiser = { ...tree, raise: async () => "not_found" };
  /** The pids a stop ended, instead of the processes themselves. */
  const killed: number[] = [];
  const RETRY_MS = 150;
  const DAEMON = 9602;
  const DAEMON_ARGV = ["C:/Users/u/.codex/packages/app-server-daemon/codex.exe", "app-server", "--listen", "unix://", "--managed-daemon"];
  const hook = (name: string, sessionId: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: name, session_id: sessionId, cwd, transcript_path: null, ...extra }) as unknown as CodexHookEvent;
  const reads = (pid: number) => read.filter((p) => p === pid).length;

  beforeAll(async () => {
    scratch = tempHome();
    home = join(scratch, "codex-home");
    cwd = join(scratch, "proj");
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(home, "auth.json"), "{}");
    writeFileSync(join(home, "threads.json"), "[]");
    fake = await new FakeTether(join(scratch, "tether")).start();
    tether = new Tether({
      config: { idle_exit_s: 600, window: "auto", window_on_start: false, profiles: false, on_path: false, dir: fake.dir },
      env: {},
      dataDir: join(scratch, "data"),
      nodeId: "node_test",
      log: silentLogger,
      exe: "C:/fake/tether.exe",
      run: async () => ({ code: 0, out: "tether 0.1.0\n", err: "" }),
      connectOrStart: (opts) => TetherClient.connect(fake.host, { name: opts.name ?? "cophylad" }),
    });
    await tether.start();
    // The daemon, its command line as Codex starts it, and the shell its hooks run in.
    commandLines.set(DAEMON, DAEMON_ARGV);
    chains.set(9700, [
      { pid: 9700, name: "pwsh.exe" },
      { pid: DAEMON, name: "codex.exe" },
    ]);
    for (const pid of [DAEMON, 9700]) alive.add(pid);
    mini = await miniSessions(
      `[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 100000\ncodex_list_ms = 100000\n\n[[profiles]]\nharness = "codex"\nname = "fake"\nconfig_dir = ${tomlString(home)}\ncommand = ${tomlString(process.execPath)}\nargs = [${tomlString(FAKE_CODEX)}]\n`,
      (host, log) => [new CodexAdapter({ host, log, version: "0.1.0", raiser: tree, isAlive: (pid) => alive.has(pid), retryMs: RETRY_MS })],
      { raiser, deps: { tether, processes: () => table, isAlive: (pid) => alive.has(pid), cliTiming: { debounceMs: 20, gapMs: 100 }, kill: (pid) => killed.push(pid), clearGraceMs: 100 } },
    );
    profile = mini.profiles.byHarness("codex")[0]!.id;
  }, 30_000);
  afterAll(async () => {
    await mini.stop();
    await tether.stop();
    await fake.stop();
    removeHome(scratch);
  });

  /** A shell in `cwd` running a Codex CLI, started at `startedAt` where given, marked once it titles its terminal. */
  const cli = async (shellPid: number, tuiPid: number, title = "proj", at = cwd, startedAt?: number) => {
    const shell = fake.add({ argv: ["pwsh.exe"], cwd: at }, shellPid);
    table.push({ pid: shellPid, parent: 1, name: "pwsh.exe" }, { pid: tuiPid, parent: shellPid, name: "codex.exe", ...(startedAt !== undefined ? { startedAt } : {}) });
    alive.add(shellPid);
    alive.add(tuiPid);
    await waitFor(() => tether.byPid(shellPid));
    fake.emit({ ev: "title", session: shell.id, title });
    const ref = { host: fake.host.host, id: shell.id };
    await waitFor(() => mini.sessions.cliOf(ref) === "codex");
    return { shell, ref };
  };

  test("the command line tells the daemon apart", () => {
    expect(isManagedDaemon(commandLines.get(DAEMON))).toBe(true);
    expect(isManagedDaemon(["codex.exe", "app-server", "--stdio"])).toBe(false);
    expect(isManagedDaemon(["codex.exe"])).toBe(false);
    expect(isManagedDaemon(undefined)).toBe(false);
  });

  test("its first prompt's hooks come from under the daemon: the session takes the CLI's terminal and the CLI as its process, and ends with it", async () => {
    const { shell, ref } = await cli(9500, 9501);
    // Before the first prompt there is a terminal with a CLI, and no session.
    expect(mini.sessions.list()).toEqual([]);
    await mini.sessions.onHook("codex", hook("SessionStart", "daemon-thread", { source: "startup", model: "m", permission_mode: "default" }), { via: "command", ppid: 9700, profile });
    await mini.sessions.onHook("codex", hook("UserPromptSubmit", "daemon-thread", { prompt: "hello", turn_id: "t1" }), { via: "command", ppid: 9700, profile });
    const rec = mini.sessions.find("codex", "daemon-thread")!;
    await waitFor(() => rec.session.native.terminal, 3000);
    expect(rec.hostedBy).toBe("daemon");
    expect(rec.session.native.terminal).toEqual(ref);
    expect(rec.session.native.pid).toBe(9501);
    expect(mini.sessions.sessionOfTerminal(ref)?.id).toBe(rec.session.id);
    // The daemon's command line was read once, for all the hooks it runs.
    expect(read.filter((p) => p === DAEMON)).toHaveLength(1);
    // The CLI quits: the session ends with its process, and the mark goes.
    alive.delete(9501);
    await mini.sessions.tick();
    expect(mini.store.sessions.get(rec.session.id)?.status).toBe("ended");
    expect(mini.sessions.cliOf(ref)).toBeUndefined();
    shell.exit(0);
  });

  test("a thread that fits two terminals takes neither, and no pid of the daemon's", async () => {
    const other = join(scratch, "twin");
    mkdirSync(other, { recursive: true });
    const a = await cli(9510, 9511, "twin", other);
    const b = await cli(9520, 9521, "twin", other);
    await mini.sessions.onHook("codex", hook("SessionStart", "twin-thread", { cwd: other }), { via: "command", ppid: 9700, profile });
    const rec = mini.sessions.find("codex", "twin-thread")!;
    await waitFor(() => rec.hostedBy === "daemon");
    await sleep(50);
    expect(rec.session.native.terminal).toBeUndefined();
    expect(rec.session.native.pid).toBeUndefined();
    // One of them quits: its mark goes, and the one left fits.
    alive.delete(9521);
    await mini.sessions.tick();
    expect(rec.session.native.terminal).toEqual(a.ref);
    expect(rec.session.native.pid).toBe(9511);
    for (const t of [a, b]) t.shell.exit(0);
  });

  /** A folder of the scratch's own, named as its CLI titles its terminal. */
  const folder = (name: string) => {
    const at = join(scratch, name);
    mkdirSync(at, { recursive: true });
    return at;
  };
  /** A record the daemon hosts, made without a hook. */
  const hostedRecord = (nativeId: string, at: string) => {
    const r = mini.sessions.ensure({ harness: "codex", nativeId, profile, cwd: at, transport: "app-server", liveness: "hook" });
    r.hostedBy = "daemon";
    return r;
  };
  const prompt = (sessionId: string, at: string, extra: Record<string, unknown> = {}) => hook("UserPromptSubmit", sessionId, { cwd: at, prompt: "hi", turn_id: "t1", ...extra });
  /** A hook's meta from a shell under a daemon: the first one's unless named. */
  const daemonMeta = (ppid = 9700) => ({ via: "command" as const, ppid, profile });

  test("a daemon whose command line cannot be read leaves the thread as it is; a hook past the wait reads it again and links", async () => {
    const at = folder("unread");
    const UNREAD = 9610;
    commandLines.set(UNREAD, DAEMON_ARGV);
    failing.add(UNREAD);
    chains.set(9710, [
      { pid: 9710, name: "pwsh.exe" },
      { pid: UNREAD, name: "codex.exe" },
    ]);
    for (const pid of [UNREAD, 9710]) alive.add(pid);
    const { shell, ref } = await cli(9530, 9531, "unread", at);
    const meta = daemonMeta(9710);
    await mini.sessions.onHook("codex", hook("SessionStart", "unread-thread", { cwd: at }), meta);
    const rec = mini.sessions.find("codex", "unread-thread")!;
    await waitFor(() => reads(UNREAD) === 1);
    await sleep(30);
    // Not taken for "not the daemon": no pid of the daemon's, and nothing cached.
    expect(rec.hostedBy).toBeUndefined();
    expect(rec.session.native.pid).toBeUndefined();
    expect(rec.session.native.terminal).toBeUndefined();
    // Another hook at once reads nothing.
    await mini.sessions.onHook("codex", prompt("unread-thread", at), meta);
    await sleep(30);
    expect(reads(UNREAD)).toBe(1);
    // The read works now: a hook past the wait reads it once more, and the CLI's terminal is taken.
    failing.delete(UNREAD);
    await sleep(RETRY_MS);
    await mini.sessions.onHook("codex", hook("Stop", "unread-thread", { cwd: at, turn_id: "t1", last_assistant_message: "ok", stop_hook_active: false }), meta);
    await waitFor(() => rec.session.native.terminal, 3000);
    expect(rec.hostedBy).toBe("daemon");
    expect(rec.session.native.terminal).toEqual(ref);
    expect(rec.session.native.pid).toBe(9531);
    expect(reads(UNREAD)).toBe(2);
    mini.sessions.end(rec, "exit");
    shell.exit(0);
  });

  test("a daemon update ends the thread and the new daemon runs it on: it is resumed in the same terminal with the CLI as its process, never a daemon's", async () => {
    const at = folder("update");
    const { shell, ref } = await cli(9540, 9541, "update", at);
    await mini.sessions.onHook("codex", prompt("update-thread", at), daemonMeta());
    const rec = mini.sessions.find("codex", "update-thread")!;
    await waitFor(() => rec.session.native.terminal, 3000);
    // Codex ends the thread as its daemon goes, and the TUI resumes it under the new one.
    await mini.sessions.onHook("codex", hook("SessionEnd", "update-thread", { cwd: at, reason: "other" }), daemonMeta());
    expect(rec.session.status).toBe("ended");
    const DAEMON2 = 9603;
    commandLines.set(DAEMON2, DAEMON_ARGV);
    chains.set(9701, [
      { pid: 9701, name: "pwsh.exe" },
      { pid: DAEMON2, name: "codex.exe" },
    ]);
    for (const pid of [DAEMON2, 9701]) alive.add(pid);
    await mini.sessions.onHook("codex", prompt("update-thread", at, { prompt: "again", turn_id: "t2" }), daemonMeta(9701));
    expect(rec.session.status).not.toBe("ended");
    await waitFor(() => rec.session.native.terminal, 3000);
    expect(rec.session.native.terminal).toEqual(ref);
    expect(rec.session.native.pid).toBe(9541);
    const pids = mini.store.sessionEvents.history(rec.session.id, { limit: 500 }).flatMap((e) => (e.payload as { pid?: number }).pid ?? []);
    expect(pids).not.toContain(DAEMON);
    expect(pids).not.toContain(DAEMON2);
    mini.sessions.end(rec, "exit");
    shell.exit(0);
  });

  test("a thread its list shows active after it ended is resumed in its CLI's terminal before any hook", async () => {
    const at = folder("listed");
    const { shell, ref } = await cli(9550, 9551, "listed", at);
    await mini.sessions.onHook("codex", prompt("listed-thread", at), daemonMeta());
    const rec = mini.sessions.find("codex", "listed-thread")!;
    await waitFor(() => rec.session.native.terminal, 3000);
    await mini.sessions.onHook("codex", hook("SessionEnd", "listed-thread", { cwd: at, reason: "other" }), daemonMeta());
    expect(rec.session.status).toBe("ended");
    // What thread/list says of a thread resumed in its TUI, before the TUI's first prompt.
    mini.sessions.ensure({ harness: "codex", nativeId: "listed-thread", profile, cwd: at, transport: "app-server", activeAt: Date.now() + 1000, handles: { configDir: home } });
    expect(rec.session.status).not.toBe("ended");
    expect(rec.session.native.terminal).toEqual(ref);
    expect(rec.session.native.pid).toBe(9551);
    mini.sessions.end(rec, "exit");
    shell.exit(0);
  });

  test("a record holding the daemon's pid, from before that was told apart, lets it go at the next tick and takes its CLI's terminal", async () => {
    const at = folder("stale");
    const { shell, ref } = await cli(9560, 9561, "stale", at);
    const rec = mini.sessions.ensure({ harness: "codex", nativeId: "stale-thread", profile, cwd: at, transport: "app-server", liveness: "hook" });
    mini.sessions.patch(rec, { native: { ...rec.session.native, pid: DAEMON } });
    expect(rec.hostedBy).toBeUndefined();
    await mini.sessions.tick();
    await waitFor(() => rec.session.native.terminal, 3000);
    expect(rec.hostedBy).toBe("daemon");
    expect(rec.session.native.terminal).toEqual(ref);
    expect(rec.session.native.pid).toBe(9561);
    mini.sessions.end(rec, "exit");
    shell.exit(0);
  });

  test("a thread whose CLI is not known is never stopped through its pid: the daemon it may be runs every CLI's threads", async () => {
    const at = folder("nostop");
    await mini.sessions.onHook("codex", hook("SessionStart", "nostop-thread", { cwd: at }), daemonMeta());
    const rec = mini.sessions.find("codex", "nostop-thread")!;
    await waitFor(() => rec.hostedBy === "daemon");
    // The pid a record from before held.
    mini.sessions.patch(rec, { native: { ...rec.session.native, pid: DAEMON } });
    await expect(mini.sessions.stopSession(rec.session.id, { as: "user" })).rejects.toThrow(/shared app-server/);
    // Not told apart yet (met again from the store): its command line says it is the daemon.
    delete rec.hostedBy;
    await expect(mini.sessions.stopSession(rec.session.id, { as: "user" })).rejects.toThrow(/shared app-server/);
    // One that cannot be read may be the daemon too.
    failing.add(DAEMON);
    await expect(mini.sessions.stopSession(rec.session.id, { as: "user" })).rejects.toThrow(/shared app-server/);
    failing.delete(DAEMON);
    expect(killed).toEqual([]);
    expect(rec.session.status).not.toBe("ended");
    mini.sessions.end(rec, "exit");
  });

  test("a `codex exec` a daemon thread runs as a tool is its own session's process, and not hosted", async () => {
    chains.set(9720, [
      { pid: 9720, name: "pwsh.exe" },
      { pid: 9721, name: "codex.exe" },
      { pid: 9722, name: "pwsh.exe" },
      { pid: DAEMON, name: "codex.exe" },
    ]);
    commandLines.set(9721, ["codex.exe", "exec", "--json", "list the files"]);
    for (const pid of [9720, 9721, 9722]) alive.add(pid);
    await mini.sessions.onHook("codex", hook("SessionStart", "exec-thread", { cwd: folder("exec") }), daemonMeta(9720));
    const rec = mini.sessions.find("codex", "exec-thread")!;
    await waitFor(() => rec.session.native.pid === 9721);
    expect(rec.hostedBy).toBeUndefined();
    mini.sessions.end(rec, "exit");
  });

  test("a thread that ends frees its terminal for one waiting, also when it ends by a clear", async () => {
    const at = folder("freed");
    const { shell, ref } = await cli(9570, 9571, "freed", at);
    const holder = hostedRecord("freed-holder", at);
    mini.sessions.linkMarked(holder);
    expect(holder.session.native.terminal).toEqual(ref);
    const next = hostedRecord("freed-next", at);
    mini.sessions.linkMarked(next);
    expect(next.session.native.terminal).toBeUndefined();
    await mini.sessions.onHook("codex", hook("SessionEnd", "freed-holder", { cwd: at, reason: "other" }), { via: "command", profile });
    expect(next.session.native.terminal).toEqual(ref);
    expect(next.session.native.pid).toBe(9571);
    // A clear: the record waits a moment for a new id, then ends, and the terminal goes on.
    const last = hostedRecord("freed-last", at);
    await mini.sessions.onHook("codex", hook("SessionEnd", "freed-next", { cwd: at, reason: "clear" }), { via: "command", profile });
    expect(last.session.native.terminal).toBeUndefined();
    await waitFor(() => last.session.native.terminal, 3000);
    expect(last.session.native.terminal).toEqual(ref);
    expect(next.session.status).toBe("ended");
    mini.sessions.end(last, "exit");
    shell.exit(0);
  });

  test("a CLI started again in the terminal of a session that ended is marked again, with no new title", async () => {
    const at = folder("again");
    const { shell, ref } = await cli(9580, 9581, "again", at);
    await mini.sessions.onHook("codex", prompt("again-1", at), daemonMeta());
    const first = mini.sessions.find("codex", "again-1")!;
    await waitFor(() => first.session.native.terminal, 3000);
    // The CLI quits and the user starts it again in the same shell; the title stays as it was.
    alive.delete(9581);
    table.splice(
      table.findIndex((p) => p.pid === 9581),
      1,
      { pid: 9582, parent: 9580, name: "codex.exe" },
    );
    alive.add(9582);
    await mini.sessions.tick();
    expect(first.session.status).toBe("ended");
    await waitFor(() => mini.sessions.cliOf(ref) === "codex", 3000);
    await mini.sessions.onHook("codex", prompt("again-2", at), daemonMeta());
    const second = mini.sessions.find("codex", "again-2")!;
    await waitFor(() => second.session.native.terminal, 3000);
    expect(second.session.native.terminal).toEqual(ref);
    expect(second.session.native.pid).toBe(9582);
    mini.sessions.end(second, "exit");
    shell.exit(0);
  });

  test("of two CLIs in one folder, a thread takes the one that started just before it, by its id's time", async () => {
    const at = folder("pair");
    const T0 = Date.now() - 60_000;
    const a = await cli(9800, 9801, "pair", at, T0);
    const b = await cli(9802, 9803, "pair", at, T0 + 10_000);
    const late = hostedRecord(uuidv7(T0 + 10_300), at);
    mini.sessions.linkMarked(late);
    expect(late.session.native.terminal).toEqual(b.ref);
    expect(late.session.native.pid).toBe(9803);
    mini.sessions.end(late, "exit");
    const early = hostedRecord(uuidv7(T0 + 300), at);
    mini.sessions.linkMarked(early);
    expect(early.session.native.terminal).toEqual(a.ref);
    expect(early.session.native.pid).toBe(9801);
    mini.sessions.end(early, "exit");
    // Made 30 s after the later CLI started: neither made it.
    const after = hostedRecord(uuidv7(T0 + 40_000), at);
    mini.sessions.linkMarked(after);
    expect(after.session.native.terminal).toBeUndefined();
    mini.sessions.end(after, "exit");
    for (const t of [a, b]) t.shell.exit(0);
  });

  test("none is taken when two CLIs started too close together, when one started after the thread with another not long before, or when a start is not known", async () => {
    const T1 = Date.now() - 120_000;
    const close = folder("close");
    const c = [await cli(9810, 9811, "close", close, T1), await cli(9812, 9813, "close", close, T1 + 1000)];
    for (const t of [T1 + 300, T1 + 1300]) {
      const rec = hostedRecord(uuidv7(t), close);
      mini.sessions.linkMarked(rec);
      expect(rec.session.native.terminal).toBeUndefined();
      mini.sessions.end(rec, "exit");
    }
    const T2 = Date.now() - 100_000;
    const skew = folder("skew");
    const s = [await cli(9820, 9821, "skew", skew, T2 - 5000), await cli(9822, 9823, "skew", skew, T2 + 500)];
    const skewed = hostedRecord(uuidv7(T2), skew);
    mini.sessions.linkMarked(skewed);
    expect(skewed.session.native.terminal).toBeUndefined();
    mini.sessions.end(skewed, "exit");
    const T3 = Date.now() - 80_000;
    const unknown = folder("unknown");
    const u = [await cli(9830, 9831, "unknown", unknown), await cli(9832, 9833, "unknown", unknown, T3)];
    const untold = hostedRecord(uuidv7(T3 + 300), unknown);
    mini.sessions.linkMarked(untold);
    expect(untold.session.native.terminal).toBeUndefined();
    mini.sessions.end(untold, "exit");
    for (const t of [...c, ...s, ...u]) t.shell.exit(0);
  });

  test("a CLI that goes on to a new thread (/new) hands it its terminal; one it resumes (/resume) takes it back; the one left lives on with neither", async () => {
    const at = folder("handover");
    const { shell, ref } = await cli(9840, 9841, "handover", at);
    await mini.sessions.onHook("codex", prompt("hand-1", at), daemonMeta());
    const first = mini.sessions.find("codex", "hand-1")!;
    await waitFor(() => first.session.native.terminal, 3000);
    // /new: Codex says nothing to the first thread; the second's first hook takes the CLI.
    await sleep(5);
    await mini.sessions.onHook("codex", prompt("hand-2", at), daemonMeta());
    const second = mini.sessions.find("codex", "hand-2")!;
    await waitFor(() => second.session.native.terminal, 3000);
    expect(second.session.native.terminal).toEqual(ref);
    expect(second.session.native.pid).toBe(9841);
    expect(first.session.native.terminal).toBeUndefined();
    expect(first.session.native.pid).toBeUndefined();
    await mini.sessions.tick();
    expect(first.session.status).not.toBe("ended");
    // /resume of the first: Codex ends it, and starts it again at its first prompt.
    await mini.sessions.onHook("codex", hook("SessionEnd", "hand-1", { cwd: at, reason: "other" }), daemonMeta());
    expect(first.session.status).toBe("ended");
    await sleep(5);
    await mini.sessions.onHook("codex", prompt("hand-1", at, { prompt: "again", turn_id: "t2" }), daemonMeta());
    await waitFor(() => first.session.native.terminal, 3000);
    expect(first.session.native.terminal).toEqual(ref);
    expect(first.session.native.pid).toBe(9841);
    expect(second.session.native.terminal).toBeUndefined();
    // The thread left behind takes nothing back at a later hook of its own.
    await mini.sessions.onHook("codex", hook("Stop", "hand-2", { cwd: at, turn_id: "t1", last_assistant_message: "ok", stop_hook_active: false }), daemonMeta());
    await sleep(30);
    expect(second.session.native.terminal).toBeUndefined();
    expect(first.session.native.terminal).toEqual(ref);
    for (const r of [first, second]) mini.sessions.end(r, "exit");
    shell.exit(0);
  });

  test("a thread a Codex desktop app started gives back a CLI's terminal once its rollout says so, and takes none after", async () => {
    const at = folder("desk");
    const { shell } = await cli(9850, 9851, "desk", at);
    const dir = join(home, "sessions", "2026", "10", "01");
    mkdirSync(dir, { recursive: true });
    const id = "01a0f700-0000-7000-8000-000000000001";
    const path = join(dir, `rollout-2026-10-01T12-00-00-${id}.jsonl`);
    writeFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id, session_id: id, cwd: at, originator: "Codex Desktop", cli_version: "0.159.3", source: "vscode" } }) + "\n");
    await mini.sessions.onHook("codex", prompt(id, at, { transcript_path: path }), daemonMeta());
    const rec = mini.sessions.find("codex", id)!;
    // Its hook comes before its rollout is read.
    await waitFor(() => rec.session.native.terminal, 3000);
    await mini.sessions.tick();
    expect(rec.originator).toBe("Codex Desktop");
    expect(rec.session.native.terminal).toBeUndefined();
    expect(rec.session.native.pid).toBeUndefined();
    mini.sessions.linkMarked(rec);
    expect(rec.session.native.terminal).toBeUndefined();
    mini.sessions.end(rec, "exit");
    shell.exit(0);
  });
});

describe("codex sessions end and resume on evidence", () => {
  // Wide enough that a slow start still lists the thread before it falls out of the window.
  const RECENT_MS = 6000;
  const MOVED_AGO = 1000;
  let scratch: string;
  let home: string;
  let cwd: string;
  let rolloutPath: string;
  let storePath: string;
  let setupAt: number;
  let mini: Mini;
  const lines = readFileSync(FIXTURE, "utf8").split("\n").filter((l) => l.trim());
  const toml = () =>
    `[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 100000\ncodex_list_ms = 1\ncodex_recent_ms = ${RECENT_MS}\n\n[[profiles]]\nharness = "codex"\nname = "fake"\nconfig_dir = ${tomlString(home)}\ncommand = ${tomlString(process.execPath)}\nargs = [${tomlString(FAKE_CODEX)}]\n`;
  const start = () => miniSessions(toml(), (host, log) => [new CodexAdapter({ host, log, version: "0.1.0" })], { storePath });
  const listed = (updatedAt: number) =>
    writeFileSync(join(home, "threads.json"), JSON.stringify([{ id: THREAD, sessionId: THREAD, cwd, name: "t", preview: "p", path: rolloutPath, createdAt: setupAt - 60000, updatedAt, status: { type: "notLoaded" } }]));
  const record = () => mini.store.sessions.getByNative("codex", THREAD)!;
  const events = (): SessionEvent[] => mini.store.sessionEvents.history(record().id, { limit: 500 });

  beforeAll(async () => {
    scratch = tempHome();
    home = join(scratch, "codex-home");
    cwd = join(scratch, "work");
    storePath = join(scratch, "cophyla.sqlite");
    const dir = join(home, "sessions", "2026", "09", "17");
    mkdirSync(dir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(home, "auth.json"), "{}");
    rolloutPath = join(dir, `rollout-2026-09-17T15-05-48-${THREAD}.jsonl`);
    // One whole turn of history, written an hour ago; the thread store says it moved a second ago.
    writeFileSync(rolloutPath, lines.slice(0, 10).join("\n") + "\n");
    const hourAgo = new Date(Date.now() - 3600_000);
    utimesSync(rolloutPath, hourAgo, hourAgo);
    setupAt = Date.now();
    listed(setupAt - MOVED_AGO);
    mini = await start();
  });
  afterAll(async () => {
    await mini.stop();
    removeHome(scratch);
  });

  test("history read by a fresh tail does not reset the inactivity clock", async () => {
    expect(mini.sessions.list().map((s) => s.native.id)).toEqual([THREAD]);
    expect(events().filter((e) => e.kind === "user_turn")).toHaveLength(1);
    // The window runs from the thread store's second ago, not from the read.
    await sleep(Math.max(0, setupAt - MOVED_AGO + RECENT_MS + 500 - Date.now()));
    await mini.sessions.tick();
    expect(record().status).toBe("ended");
    expect(events().at(-1)?.payload).toEqual({ reason: "inactive" });
  });

  test("an ended thread listed again with nothing new since stays ended across ticks", async () => {
    listed(Date.now());
    const before = events().length;
    for (let i = 0; i < 3; i++) await mini.sessions.tick();
    expect(record().status).toBe("ended");
    expect(events()).toHaveLength(before);
    expect(mini.sessions.list()).toEqual([]);
  });

  test("a rollout grown past where it was recorded resumes it, and only the new lines are recorded", async () => {
    const before = events().length;
    writeFileSync(rolloutPath, lines.join("\n") + "\n");
    listed(Date.now());
    // threads are listed once a millisecond at most here: let one pass since the last test's ticks
    await sleep(2);
    await mini.sessions.tick();
    const s = record();
    expect(s.status).not.toBe("ended");
    expect(s.endedAt).toBeUndefined();
    const added = events().slice(before);
    expect(added[0]).toMatchObject({ kind: "status", payload: { resumed: true } });
    // The first turn is not recorded a second time.
    expect(events().filter((e) => e.kind === "user_turn" && (e.payload as { text: string }).text === "reply with the single word ok")).toHaveLength(1);
    expect(added.map((e) => e.kind)).toContain("tool_call");
    expect(mini.store.sessions.tail(s.id)).toEqual({ path: rolloutPath, offset: statSync(rolloutPath).size });
  });

  test("a daemon restart over the same store tails the rollout again without adding events", async () => {
    const id = record().id;
    const before = events().length;
    // the thread store says it moved just now, however long the last test took on a slow runner
    listed(Date.now());
    await mini.stop();
    mini = await start();
    expect(mini.sessions.list().map((s) => s.id)).toEqual([id]);
    await mini.sessions.tick();
    expect(events()).toHaveLength(before);
    // A line written while the daemon was down is new, and recorded once.
    const extra = lines[18]!.replace('"msg_a2"', '"msg_a3"');
    writeFileSync(rolloutPath, lines.join("\n") + "\n" + extra + "\n");
    await mini.sessions.tick();
    expect(events().slice(before).map((e) => e.kind)).toEqual(["assistant_text"]);
  });
});

describe("a codex session met again after a restart", () => {
  // Short, so a thread judged by recency would end within the test.
  const RECENT_MS = 400;
  let scratch: string;
  let home: string;
  let cwd: string;
  let storePath: string;
  let profile: string;
  let mini: Mini;
  const alive = new Set<number>();
  const chains = new Map<number, { pid: number; name: string; startedAt?: number }[]>();
  /** No command line to read: a `codex` above a hook is the session's own process, never the daemon. */
  const tree = {
    async ancestors(pid: number) {
      return chains.get(pid) ?? [];
    },
  };
  const raiser: WindowRaiser = { ...tree, commandLine: async () => undefined, raise: async () => "not_found" };
  const toml = () =>
    `[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 100000\ncodex_list_ms = 100000\ncodex_recent_ms = ${RECENT_MS}\n\n[[profiles]]\nharness = "codex"\nname = "fake"\nconfig_dir = ${tomlString(home)}\ncommand = ${tomlString(process.execPath)}\nargs = [${tomlString(FAKE_CODEX)}]\n`;
  const start = () =>
    miniSessions(toml(), (host, log) => [new CodexAdapter({ host, log, version: "0.1.0", raiser: tree, isAlive: (pid) => alive.has(pid) })], { storePath, raiser, deps: { isAlive: (pid) => alive.has(pid) } });
  const record = (thread: string) => mini.sessions.find("codex", thread)!;
  const lastEvent = (thread: string) => mini.store.sessionEvents.history(record(thread).session.id, { limit: 50 }).at(-1);
  /** A CLI in a shell, its thread's first prompt's hook run below it: the CLI becomes the session's process. */
  const prompted = async (thread: string, shellPid: number, cliPid: number, startedAt: number) => {
    chains.set(shellPid, [
      { pid: shellPid, name: "pwsh.exe" },
      { pid: cliPid, name: "codex.exe", startedAt },
    ]);
    alive.add(cliPid);
    const hook = { hook_event_name: "UserPromptSubmit", session_id: thread, turn_id: "t1", cwd, transcript_path: null, prompt: "hello" } as unknown as CodexHookEvent;
    await mini.sessions.onHook("codex", hook, { via: "command", ppid: shellPid, profile });
    await waitFor(() => record(thread).session.native.pid === cliPid);
  };

  beforeAll(async () => {
    scratch = tempHome();
    home = join(scratch, "codex-home");
    cwd = join(scratch, "work");
    storePath = join(scratch, "cophyla.sqlite");
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(home, "auth.json"), "{}");
    writeFileSync(join(home, "threads.json"), "[]");
    mini = await start();
    profile = mini.profiles.byHarness("codex")[0]!.id;
  });
  afterAll(async () => {
    await mini.stop();
    removeHome(scratch);
  });

  test("its CLI still running keeps it live past the window, until the CLI goes; a pid another process took is let go, and the window ends that one", async () => {
    const before = Date.now() - 60_000;
    await prompted("kept", 7000, 7001, before);
    await prompted("renamed", 7100, 7101, before);
    await prompted("reused", 7200, 7201, before);
    await mini.stop();
    // While the daemon was down, 7101 went to another program and 7201 to a later codex.
    chains.set(7001, [{ pid: 7001, name: "codex.exe", startedAt: before }, { pid: 7000, name: "pwsh.exe" }]);
    chains.set(7101, [{ pid: 7101, name: "notepad.exe", startedAt: before }]);
    chains.set(7201, [{ pid: 7201, name: "codex.exe", startedAt: Date.now() + 5000 }]);
    await sleep(RECENT_MS + 200);
    mini = await start();
    // The process table is read once: the pids that are no longer the sessions' are let go.
    await waitFor(() => record("renamed").session.native.pid === undefined && record("reused").session.native.pid === undefined);
    expect(record("renamed").liveness).toBe("heuristic");
    expect(record("reused").liveness).toBe("heuristic");
    await mini.sessions.tick();
    expect(record("kept").session.status).not.toBe("ended");
    expect(record("kept").session.native.pid).toBe(7001);
    expect(record("kept").liveness).toBe("hook");
    for (const t of ["renamed", "reused"]) {
      expect(record(t).session.status).toBe("ended");
      expect(lastEvent(t)?.payload).toEqual({ reason: "inactive" });
    }
    // The CLI quits: the session ends with it.
    alive.delete(7001);
    await mini.sessions.tick();
    expect(record("kept").session.status).toBe("ended");
    expect(lastEvent("kept")?.payload).toEqual({ reason: "gone" });
  });
});
