// A message that prepares its session first: the task it works on from now written on it, its
// context cleared (`/clear` typed into its tether terminal, whatever `brain_sends` says, and
// the record followed to the new id), then its mode set, then the text sent. What the session
// cannot take is refused before anything is typed; empty text only prepares. A session that
// starts again while it works is not recorded as idle. The fake tether plays Claude: `/clear`
// and Enter end the old conversation and start a new one through the hooks, Shift+Tab goes
// round the footer's modes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeHookEvent, Session } from "@cophyla/protocol";
import { TetherClient } from "@tether-pty/client";
import { sendAsk } from "../src/brain-link/methods.ts";
import { silentLogger } from "../src/log.ts";
import type { WindowRaiser } from "../src/sessions/focus.ts";
import type { HarnessAdapter, HookInstallSpec, NormalisedHook, SessionRecord } from "../src/sessions/model.ts";
import { Tether } from "../src/sessions/tether/index.ts";
import { FakeTether } from "./fakes/tether.ts";
import type { FakeSession } from "./fakes/tether.ts";
import { miniSessions, tempHome, tomlString, waitFor } from "./helpers.ts";
import type { Mini } from "./helpers.ts";

const RULE = "─".repeat(140);
const FOOTER = {
  default: "  ⏸ manual mode on · ? for shortcuts",
  acceptEdits: "  ⏵⏵ accept edits on (shift+tab to cycle)",
  plan: "  ⏸ plan mode on (shift+tab to cycle)",
  auto: "  ⏵⏵ auto mode on (shift+tab to cycle)",
} as const;
type Mode = keyof typeof FOOTER;
const CYCLE: Mode[] = ["default", "acceptEdits", "plan", "auto"];
const idle = (mode: Mode): (string | [string, "dim"])[] => [" ▐▛███▛█   Claude Code v2.1.285", "", RULE, ['❯ Try "how does <filepath> work?"', "dim"], RULE, FOOTER[mode]];
const TASK = "task_01ARZ3NDEKTSV4RRFFQ69G5FB2";

/** An attached adapter that owns nothing, and keeps what goes over the pipe. */
class PipeAdapter implements HarnessAdapter {
  readonly harness = "claude" as const;
  sent: { session: string; body: string }[] = [];
  async start(_p: unknown, _h: HookInstallSpec | undefined): Promise<void> {}
  async stop(): Promise<void> {}
  async tick(): Promise<void> {}
  async send(rec: SessionRecord, body: string): Promise<{ status: "queued" }> {
    this.sent.push({ session: rec.session.id, body });
    return { status: "queued" };
  }
  onHook(_hook: NormalisedHook, rec: SessionRecord | undefined): SessionRecord | undefined {
    return rec;
  }
}

describe("a message that prepares its session", () => {
  let fake: FakeTether;
  let tether: Tether;
  let tm: Mini;
  let dir: string;
  let nextPid = 8300;
  const pipe = new PipeAdapter();
  const raiser: WindowRaiser = {
    async raise() {
      return "unsupported";
    },
    async ancestors() {
      return [];
    },
    async commandLine() {
      return ["claude"];
    },
  };

  beforeAll(async () => {
    const scratch = tempHome();
    dir = join(scratch, "work");
    const configDir = join(scratch, "claude-home");
    for (const d of [dir, configDir]) mkdirSync(d, { recursive: true });
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
    tm = await miniSessions(toml, () => [pipe], { raiser, deps: { tether, clearWaitMs: 1500 } });
  }, 30_000);

  afterAll(async () => {
    await tm.stop();
    await tether.stop();
    await fake.stop();
  });

  const hook = (native: string, event: Record<string, unknown>) => tm.sessions.onHook("claude", { session_id: native, transcript_path: join(dir, `${native}.jsonl`), cwd: dir, ...event } as ClaudeHookEvent, { via: "http" });

  /**
   * A Claude session in a tether terminal: Shift+Tab goes round the modes, and `/clear` then
   * Enter clears its context as the CLI does, unless `clears` is false.
   */
  function claudeIn(opts: { start?: Mode; status?: Session["status"]; clears?: boolean } = {}): { s: Session; term: FakeSession; mode: () => Mode; natives: string[] } {
    const pid = nextPid++;
    const term = fake.add({ argv: ["claude"], cwd: dir }, pid);
    let at = CYCLE.indexOf(opts.start ?? "default");
    const natives = [`prep-${pid}`];
    term.setScreen(idle(CYCLE[at]!));
    term.onKeys = (keys) => {
      for (const k of keys) if (k === "S-Tab") at = (at + 1) % CYCLE.length;
      term.setScreen(idle(CYCLE[at]!));
      const pasted = term.typed.filter((t) => t.startsWith("paste:")).at(-1);
      if (keys.includes("Enter") && pasted === "paste:/clear" && opts.clears !== false) {
        const from = natives.at(-1)!;
        const to = `${from}-c${natives.length}`;
        natives.push(to);
        setTimeout(() => {
          void hook(from, { hook_event_name: "SessionEnd", reason: "clear" }).then(() => hook(to, { hook_event_name: "SessionStart", source: "clear" }));
        }, 30);
      }
    };
    const s = tm.sessions.ensure({ harness: "claude", nativeId: natives[0]!, profile: tm.profiles.defaultFor("claude")!.id, cwd: dir, transport: "pipe", pid, status: opts.status ?? "idle", terminal: { host: fake.host.host, id: term.id } }).session;
    return { s, term, mode: () => CYCLE[at]!, natives };
  }

  const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
  const tabs = (term: FakeSession) => term.typed.filter((k) => k === "keys:S-Tab").length;

  test("clears the context, sets the mode, writes the task, then sends the text over the pipe", async () => {
    const { s, term, mode, natives } = claudeIn();
    const seen: { kind: string; task?: string }[] = [];
    const off = tm.bus.on("session.event", (e) => {
      if (e.session !== s.id) return;
      const type = (e.payload as { type?: string }).type;
      if (type === "context_cleared") seen.push({ kind: "cleared", ...(tm.sessions.get(s.id)?.task ? { task: tm.sessions.get(s.id)!.task! } : {}) });
    });
    const r = await tm.sessions.send(s.id, "Plan section 2 of the README", { from: "brain", task: TASK, clear: true, mode: "plan" });
    off();
    expect(r.status).toBe("queued");
    expect(r.ref).toBeDefined();
    expect(term.typed.slice(0, 2)).toEqual(["paste:/clear", "keys:Enter"]);
    expect(tabs(term)).toBe(2);
    expect(mode()).toBe("plan");
    const now = tm.sessions.get(s.id)!;
    expect(now.native.id).toBe(natives[1]!);
    expect(now.mode).toBe("plan");
    expect(now.task).toBe(TASK);
    // The task went on after the new context started: its start is not the task's session going idle.
    expect(seen).toEqual([{ kind: "cleared" }]);
    expect(pipe.sent.filter((x) => x.session === s.id).map((x) => x.body)).toEqual([expect.stringContaining("Plan section 2 of the README")]);
    // The typed /clear is no intent of the session's.
    await waitFor(() => tm.store.sessionEvents.history(s.id, { limit: 50 }).some((e) => e.kind === "user_turn" && (e.payload as { text: string }).text === "/clear"), 8000);
    expect(tm.sessions.get(s.id)!.intent).toBeUndefined();
  }, 20_000);

  test("empty text only prepares: nothing is sent, and no ref comes back", async () => {
    const { s, term } = claudeIn({ start: "plan" });
    const before = pipe.sent.length;
    const r = await tm.sessions.send(s.id, "", { from: "brain", clear: true, mode: "default", task: TASK });
    expect(r).toEqual({ status: "queued" });
    expect(pipe.sent.length).toBe(before);
    expect(term.typed[0]).toBe("paste:/clear");
    expect(tm.sessions.get(s.id)!.mode).toBe("default");
    expect(tm.sessions.get(s.id)!.task).toBe(TASK);
  }, 20_000);

  test("a task alone is written on the session and the text goes as it would", async () => {
    const { s, term } = claudeIn();
    await tm.sessions.send(s.id, "go on", { from: "brain", task: TASK });
    expect(tm.sessions.get(s.id)!.task).toBe(TASK);
    expect(term.typed).toEqual([]);
    expect(pipe.sent.at(-1)!.body).toContain("go on");
  });

  test("what the session cannot take is refused before anything is typed", async () => {
    const busy = claudeIn({ status: "busy" });
    expect(await failure(tm.sessions.send(busy.s.id, "x", { from: "brain", clear: true }))).toMatchObject({ code: "conflict", message: expect.stringContaining("the session is working") });
    expect(busy.term.typed).toEqual([]);
    const shells = claudeIn();
    tm.sessions.setStatus(tm.sessions.find("claude", shells.s.native.id)!, "idle", undefined, { waiting: { on: "shell" } });
    expect(await failure(tm.sessions.send(shells.s.id, "x", { from: "brain", clear: true }))).toMatchObject({ code: "conflict", message: expect.stringContaining("waiting on its shells") });
    const codex = tm.sessions.ensure({ harness: "codex", nativeId: "prep-codex", profile: tm.profiles.defaultFor("claude")!.id, cwd: dir, transport: "pipe", status: "idle" }).session;
    expect(await failure(tm.sessions.send(codex.id, "x", { from: "brain", mode: "plan" }))).toMatchObject({ code: "unsupported", message: expect.stringContaining("codex") });
    const windowed = tm.sessions.ensure({ harness: "claude", nativeId: "prep-window", profile: tm.profiles.defaultFor("claude")!.id, cwd: dir, transport: "pipe", pid: 9998, status: "idle" }).session;
    expect(await failure(tm.sessions.send(windowed.id, "x", { from: "brain", clear: true }))).toMatchObject({ code: "unsupported", message: expect.stringContaining("/clear in its own window") });
    expect(await failure(tm.sessions.send(windowed.id, "x", { from: "brain", mode: "plan" }))).toMatchObject({ code: "unsupported", message: expect.stringContaining("Shift+Tab in its own window") });
    expect(tm.sessions.get(windowed.id)!.task).toBeUndefined();
  });

  test("a clear while a typed message has not landed is refused", async () => {
    const { s, term } = claudeIn();
    // The user's message is typed and waits for its receipt.
    await tm.sessions.send(s.id, "what next", { from: "user" });
    await waitFor(() => term.typed.includes("paste:what next"), 5000);
    expect(await failure(tm.sessions.send(s.id, "x", { from: "brain", clear: true }))).toMatchObject({ code: "conflict", message: expect.stringContaining("still going into the session") });
  });

  test("a context that never clears fails the send, and nothing else happens", async () => {
    const { s, term } = claudeIn({ clears: false });
    const before = pipe.sent.length;
    expect(await failure(tm.sessions.send(s.id, "x", { from: "brain", clear: true, mode: "plan", task: TASK }))).toMatchObject({ code: "unavailable", message: expect.stringContaining("not cleared") });
    expect(tabs(term)).toBe(0);
    expect(pipe.sent.length).toBe(before);
    expect(tm.sessions.get(s.id)!.task).toBeUndefined();
  }, 10_000);

  test("a session that starts again while it works stays busy; one that starts idle is idle", async () => {
    const { s, natives } = claudeIn({ status: "busy" });
    await hook(natives[0]!, { hook_event_name: "SessionStart", source: "compact" });
    const last = () => tm.store.sessionEvents.history(s.id, { limit: 50 }).filter((e) => e.kind === "status").at(-1)!;
    expect(last().payload).toMatchObject({ status: "busy", source: "compact" });
    expect(tm.sessions.get(s.id)!.status).toBe("busy");
    const other = claudeIn();
    await hook(other.natives[0]!, { hook_event_name: "SessionStart", source: "startup" });
    expect(tm.store.sessionEvents.history(other.s.id, { limit: 50 }).filter((e) => e.kind === "status").at(-1)!.payload).toMatchObject({ status: "idle", source: "startup" });
  });
});

describe("the ask before the brain prepares and messages a session of the user's", () => {
  const s = { title: "Assembly Implementer", cwd: "C:\\D\\faircase" } as Session;
  test("names each step in order, then the message; one ask for all of it", () => {
    expect(sendAsk({ id: "sess_x", text: "Plan section 2", clear: true, mode: "plan" }, s)).toEqual({ title: "Prepare Assembly Implementer and message it?", detail: "Clear its context, put it in plan mode, then send:\n\nPlan section 2" });
    expect(sendAsk({ id: "sess_x", text: "go on" }, s)).toEqual({ title: "Message Assembly Implementer?", detail: "go on" });
    expect(sendAsk({ id: "sess_x", text: "", clear: true }, { cwd: "C:\\D\\faircase" } as Session)).toEqual({ title: "Prepare faircase?", detail: "Clear its context; nothing is sent." });
  });
});
