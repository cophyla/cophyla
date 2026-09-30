// `session.mode`: putting a Claude session in a permission mode from outside it. The footer
// under the prompt names the mode (rows as Claude Code 2.1.285 draws them, read through tether
// in a probe), Shift+Tab moves it round a cycle whose bypass and auto steps depend on the
// session, and a session in a tether terminal has Shift+Tab pressed, the footer read after
// each press, until it names the mode asked for: never while an ask is open or no prompt
// shows, never through a looser mode while the session works, and a full turn back to the
// start says the mode is not on offer. The fake tether plays Claude answering the key.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Ask, ClaudeHookEvent, Session } from "@cophyla/protocol";
import { sessionModeRisk } from "@cophyla/protocol";
import { TetherClient } from "@tether-pty/client";
import { modeAsk } from "../src/brain-link/methods.ts";
import { silentLogger } from "../src/log.ts";
import { looserOnTheWay } from "../src/sessions/claude/launch.ts";
import type { PermissionMode } from "../src/sessions/claude/launch.ts";
import { autoUnavailable, footerMode } from "../src/sessions/claude/screen.ts";
import type { WindowRaiser } from "../src/sessions/focus.ts";
import type { HarnessAdapter, HookInstallSpec, NormalisedHook, SessionRecord } from "../src/sessions/model.ts";
import { Tether } from "../src/sessions/tether/index.ts";
import { FakeTether } from "./fakes/tether.ts";
import type { FakeSession } from "./fakes/tether.ts";
import { miniSessions, tempHome, tomlString, waitFor } from "./helpers.ts";
import type { Mini } from "./helpers.ts";

const RULE = "─".repeat(140);
const FOOTER: Record<Exclude<PermissionMode, "dontAsk">, string> = {
  default: "  ⏸ manual mode on · ? for shortcuts · ← 2 agents",
  acceptEdits: "  ⏵⏵ accept edits on (shift+tab to cycle) · ← 2 agents",
  plan: "  ⏸ plan mode on (shift+tab to cycle) · ← 2 agents",
  auto: "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 2 agents",
  bypassPermissions: "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents",
};

const screenOf = (rows: string[]) => ({ lines: rows });
const idle = (mode: keyof typeof FOOTER, prompt = '❯ Try "how does <filepath> work?"') => [" ▐▛███▛█   Claude Code v2.1.285", "", RULE, prompt, RULE, FOOTER[mode]];

describe("the footer", () => {
  test("names the mode under the prompt: empty, typed into, busy, and with Claude's ASCII pointer", () => {
    expect(footerMode(screenOf(idle("default")))).toBe("default");
    expect(footerMode(screenOf([RULE, "❯ half typed words", RULE, "  ⏵⏵ accept edits on (shift+tab to cycle)                          auto mode unavailable for this model"]))).toBe("acceptEdits");
    expect(footerMode(screenOf(["❯ Write the numbers from 1 to 200", "✢ Gallivanting… (2s · ↓ 124 tokens · thinking)", RULE, "❯", RULE, "  ⏸ plan mode on (shift+tab to cycle) · esc to interrupt · ← 2 agents"]))).toBe("plan");
    expect(footerMode(screenOf(["", RULE, "> ", RULE, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"]))).toBe("bypassPermissions");
    expect(footerMode(screenOf(idle("auto")))).toBe("auto");
  });

  test("names none when a dialog or the slash menu has the prompt's place, or a past turn only quotes the words", () => {
    expect(footerMode(screenOf(["  /autocompact      Set how full the context gets", "  /background       Send this session to the background"]))).toBeUndefined();
    expect(footerMode(screenOf([RULE, " Ready to code?", " > 1. Yes, auto-accept edits", "   2. Yes, manually approve edits", "      shift+tab to approve with this feedback"]))).toBeUndefined();
    expect(footerMode(screenOf(["❯ why does it say plan mode on?", "  Because plan mode on means…"]))).toBeUndefined();
  });

  test("says when the model has no auto mode", () => {
    expect(autoUnavailable(screenOf([RULE, "❯ ", RULE, "  ⏸ manual mode on                                        auto mode unavailable for this model"]))).toBe(true);
    expect(autoUnavailable(screenOf(idle("default")))).toBe(false);
  });
});

describe("the way round the cycle", () => {
  test("a looser mode between the two ends is named; only the modes on offer are passed", () => {
    // manual → accept edits → plan → bypass → auto → manual
    expect(looserOnTheWay("default", "plan")).toBe("acceptEdits");
    expect(looserOnTheWay("acceptEdits", "plan")).toBeUndefined();
    expect(looserOnTheWay("plan", "default")).toBe("bypassPermissions");
    expect(looserOnTheWay("plan", "default", (m) => m !== "bypassPermissions")).toBe("auto");
    expect(looserOnTheWay("plan", "default", (m) => m !== "bypassPermissions" && m !== "auto")).toBeUndefined();
    expect(looserOnTheWay("auto", "plan")).toBeUndefined();
    expect(looserOnTheWay("bypassPermissions", "default")).toBeUndefined();
    expect(looserOnTheWay("default", "dontAsk")).toBeUndefined();
  });

  test("the gate's risk: exec into a looser mode, write into manual or a stricter one", () => {
    expect(["default", "plan", "dontAsk"].map((m) => sessionModeRisk(m as PermissionMode))).toEqual(["write", "write", "write"]);
    expect(["acceptEdits", "auto", "bypassPermissions"].map((m) => sessionModeRisk(m as PermissionMode))).toEqual(["exec", "exec", "exec"]);
  });

  test("the ask before the brain changes a mode says where and what it means", () => {
    const s = { title: "fix the build", cwd: "C:\\D\\app" } as Session;
    expect(modeAsk({ id: "sess_x", mode: "bypassPermissions" }, s)).toEqual({ title: "Put fix the build in bypass permissions mode?", detail: "It will run every tool without asking." });
    expect(modeAsk({ id: "sess_x", mode: "plan" }, { cwd: "C:\\D\\app" } as Session).title).toBe("Put app in plan mode?");
  });
});

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

describe("a session in a tether terminal", () => {
  let fake: FakeTether;
  let tether: Tether;
  let tm: Mini;
  let dir: string;
  let nextPid = 8100;
  const cmdlines: Record<number, string[]> = {};
  const asks: Ask[] = [];
  const raiser: WindowRaiser = {
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
    tm = await miniSessions(toml, () => [new NullAdapter()], { raiser, deps: { tether } });
    tm.bus.on("ask.state", (a) => asks.push(a));
  }, 30_000);

  afterAll(async () => {
    await tm.stop();
    await tether.stop();
    await fake.stop();
  });

  /**
   * A Claude session in a tether terminal, started with `argv`, whose Shift+Tab goes round
   * `cycle` from `start`; the first `drop` presses are lost, as a key pressed too early is.
   */
  function claudeIn(opts: { cycle: (keyof typeof FOOTER)[]; start: keyof typeof FOOTER; argv?: string[]; status?: "idle" | "busy"; drop?: number; extra?: string }): { s: Session; term: FakeSession; at: () => string } {
    const pid = nextPid++;
    const argv = opts.argv ?? ["claude"];
    const term = fake.add({ argv, cwd: dir }, pid);
    cmdlines[pid] = argv;
    let at = opts.cycle.indexOf(opts.start);
    let drop = opts.drop ?? 0;
    const draw = () => term.setScreen([...idle(opts.cycle[at]!).slice(0, -1), FOOTER[opts.cycle[at]!] + (opts.extra ?? "")]);
    draw();
    term.onKeys = (keys) => {
      for (const k of keys) {
        if (k !== "S-Tab") continue;
        if (drop > 0) drop--;
        else at = (at + 1) % opts.cycle.length;
      }
      draw();
    };
    const s = tm.sessions.ensure({ harness: "claude", nativeId: `mode-${pid}`, profile: tm.profiles.defaultFor("claude")!.id, cwd: dir, transport: "pipe", pid, status: opts.status ?? "idle", terminal: { host: fake.host.host, id: term.id } }).session;
    return { s, term, at: () => opts.cycle[at]! };
  }

  const tabs = (term: FakeSession) => term.typed.filter((k) => k === "keys:S-Tab").length;
  // A change's error, awaited as a value: Bun's `expect(promise).rejects` can stall on one
  // whose tether request follows the presses' unref'd sleeps, the pipe's answer unread.
  const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
  const WITH_AUTO: (keyof typeof FOOTER)[] = ["default", "acceptEdits", "plan", "auto"];

  test("Shift+Tab is pressed until the footer names the mode, and the session shows it", async () => {
    const { s, term, at } = claudeIn({ cycle: WITH_AUTO, start: "default" });
    expect(await tm.sessions.setMode(s.id, "plan")).toEqual({ mode: "plan" });
    expect(tabs(term)).toBe(2);
    expect(at()).toBe("plan");
    expect(tm.sessions.get(s.id)?.mode).toBe("plan");
    // Round past bypass, which it does not offer, and on to manual.
    expect(await tm.sessions.setMode(s.id, "default")).toEqual({ mode: "default" });
    expect(tabs(term)).toBe(4);
    expect(tm.sessions.get(s.id)?.mode).toBe("default");
  });

  test("a session already in the mode is left alone", async () => {
    const { s, term } = claudeIn({ cycle: WITH_AUTO, start: "acceptEdits" });
    expect(await tm.sessions.setMode(s.id, "acceptEdits")).toEqual({ mode: "acceptEdits" });
    expect(term.typed).toEqual([]);
    expect(tm.sessions.get(s.id)?.mode).toBe("acceptEdits");
  });

  test("bypass is pressed into for a session started allowing it, and refused unpressed for one that was not", async () => {
    const allowed = claudeIn({ cycle: ["default", "acceptEdits", "plan", "bypassPermissions", "auto"], start: "default", argv: ["claude", "--allow-dangerously-skip-permissions"] });
    const plain = claudeIn({ cycle: WITH_AUTO, start: "default" });
    expect(await tm.sessions.setMode(allowed.s.id, "bypassPermissions")).toEqual({ mode: "bypassPermissions" });
    expect(tabs(allowed.term)).toBe(3);
    expect(await failure(tm.sessions.setMode(plain.s.id, "bypassPermissions"))).toMatchObject({ code: "unsupported", message: expect.stringContaining("--allow-dangerously-skip-permissions") });
    expect(plain.term.typed).toEqual([]);
  });

  test("a mode the cycle never reaches is found by going round it once, back to where it began", async () => {
    // Started allowing bypass, but its settings turned bypassing off: the cycle holds no such step.
    const { s, term, at } = claudeIn({ cycle: ["default", "acceptEdits", "plan"], start: "acceptEdits", argv: ["claude", "--allow-dangerously-skip-permissions"] });
    expect(await failure(tm.sessions.setMode(s.id, "bypassPermissions"))).toMatchObject({ code: "unsupported", message: "bypass permissions mode is not on offer in this session (it was not started allowing it): Shift+Tab goes round accept edits, plan, manual" });
    expect(tabs(term)).toBe(3);
    expect(at()).toBe("acceptEdits");
    expect(tm.sessions.get(s.id)?.mode).toBe("acceptEdits");
  });

  test("auto is refused unpressed where the footer says the model has none", async () => {
    const { s, term } = claudeIn({ cycle: ["default", "acceptEdits", "plan"], start: "default", extra: "                    auto mode unavailable for this model" });
    expect(await failure(tm.sessions.setMode(s.id, "auto"))).toMatchObject({ code: "unsupported", message: "auto mode is unavailable for the session's model" });
    expect(term.typed).toEqual([]);
  });

  test("a working session is not pressed through a looser mode, but may go where the way is no looser", async () => {
    const { s, term } = claudeIn({ cycle: WITH_AUTO, start: "plan", status: "busy" });
    expect(await failure(tm.sessions.setMode(s.id, "default"))).toMatchObject({ code: "conflict", message: expect.stringContaining("only through auto, where a tool could run unasked") });
    expect(term.typed).toEqual([]);
    const other = claudeIn({ cycle: WITH_AUTO, start: "default", status: "busy" });
    expect(await tm.sessions.setMode(other.s.id, "acceptEdits")).toEqual({ mode: "acceptEdits" });
    expect(await tm.sessions.setMode(other.s.id, "plan")).toEqual({ mode: "plan" });
  });

  test("nothing is pressed while no prompt shows, or while an ask is open", async () => {
    const menu = claudeIn({ cycle: WITH_AUTO, start: "default" });
    menu.term.setScreen(["  /autocompact      Set how full the context gets", "  /background       Send this session to the background"]);
    expect(await failure(tm.sessions.setMode(menu.s.id, "plan"))).toMatchObject({ code: "conflict", message: expect.stringContaining("no prompt shows") });
    expect(menu.term.typed).toEqual([]);

    const asking = claudeIn({ cycle: WITH_AUTO, start: "default" });
    const hook = { session_id: asking.s.native.id, transcript_path: join(dir, "x.jsonl"), cwd: dir, hook_event_name: "PermissionRequest", permission_mode: "default", tool_name: "Bash", tool_input: { command: "rm -rf build" } } as ClaudeHookEvent;
    const decision = tm.sessions.onHook("claude", hook, { via: "http" });
    const ask = await waitFor(() => asks.find((a) => a.status === "open" && a.source.kind === "harness" && a.source.session === asking.s.id), 5000);
    expect(await failure(tm.sessions.setMode(asking.s.id, "plan"))).toMatchObject({ code: "conflict", message: expect.stringContaining("asking something") });
    expect(asking.term.typed).toEqual([]);
    tm.asks.answer(ask.id, { option: "deny" }, { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" });
    await decision;
  });

  test("a press the footer never shows is pressed again", async () => {
    const { s, term } = claudeIn({ cycle: WITH_AUTO, start: "default", drop: 1 });
    expect(await tm.sessions.setMode(s.id, "acceptEdits")).toEqual({ mode: "acceptEdits" });
    expect(tabs(term)).toBe(2);
  }, 10_000);

  test("two changes asked for together are pressed one after the other", async () => {
    const { s, at } = claudeIn({ cycle: WITH_AUTO, start: "default" });
    const [a, b] = await Promise.all([tm.sessions.setMode(s.id, "plan"), tm.sessions.setMode(s.id, "auto")]);
    expect([a.mode, b.mode]).toEqual(["plan", "auto"]);
    expect(at()).toBe("auto");
  });

  test("a hook's mode shows as the session's", async () => {
    const { s } = claudeIn({ cycle: WITH_AUTO, start: "default" });
    await tm.sessions.onHook("claude", { session_id: s.native.id, transcript_path: join(dir, "y.jsonl"), cwd: dir, hook_event_name: "UserPromptSubmit", permission_mode: "acceptEdits", prompt: "go" } as ClaudeHookEvent, { via: "http" });
    expect(tm.sessions.get(s.id)?.mode).toBe("acceptEdits");
  });

  test("what cannot be pressed at all is unsupported: another harness, don't-ask, no terminal", async () => {
    const codex = tm.sessions.ensure({ harness: "codex", nativeId: "codex-mode", profile: tm.profiles.defaultFor("claude")!.id, cwd: dir, transport: "pipe", status: "idle" }).session;
    expect(await failure(tm.sessions.setMode(codex.id, "plan"))).toMatchObject({ code: "unsupported", message: expect.stringContaining("only a Claude Code session") });
    const { s } = claudeIn({ cycle: WITH_AUTO, start: "default" });
    expect(await failure(tm.sessions.setMode(s.id, "dontAsk"))).toMatchObject({ code: "unsupported" });
    const windowed = tm.sessions.ensure({ harness: "claude", nativeId: "mode-window", profile: tm.profiles.defaultFor("claude")!.id, cwd: dir, transport: "pipe", pid: 9999, status: "idle" }).session;
    expect(await failure(tm.sessions.setMode(windowed.id, "plan"))).toMatchObject({ code: "unsupported", message: expect.stringContaining("cannot type") });
  });
});
