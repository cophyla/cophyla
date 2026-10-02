// Codex sessions in tether, against a fake host speaking the real protocol and a stand-in for
// the Codex adapter whose threads the test makes, as Codex makes one at its first prompt. A
// session cophylad starts runs `codex` in a tether terminal with its first prompt as the CLI's
// argument after `--`, in bypass when asked, under the profile's directory (Codex's own by
// leaving CODEX_HOME unset), and the thread that takes the terminal is the session, carrying
// its task, whether its hooks run below the CLI or below the shared daemon; a thread older
// than the prompt that draws the terminal is not claimed. A batch-file CLI has the prompt
// typed once the composer shows. With hooks untrusted it starts headless, bypass being the
// ACP adapter's full access. A CLI of the user's waiting at its first prompt is given one,
// typed, and the session it becomes stays the user's, with the task.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessProfile, Session, SessionEvent } from "@cophyla/protocol";
import { TetherClient } from "@tether-pty/client";
import type { TetherConfig } from "../src/config/schema.ts";
import { silentLogger } from "../src/log.ts";
import type { WindowRaiser } from "../src/sessions/focus.ts";
import type { HarnessAdapter, SendOutcome, SessionRecord } from "../src/sessions/model.ts";
import { codexArgv, codexEnv, runsUnderCmd } from "../src/sessions/codex/start.ts";
import { composerUp, waitingOn } from "../src/sessions/codex/screen.ts";
import type { ProcessRow } from "../src/sessions/tether/cli.ts";
import { Tether } from "../src/sessions/tether/index.ts";
import type { Run } from "../src/sessions/tether/index.ts";
import { uuidv7 } from "../src/sessions/uuidv7.ts";
import { FakeTether } from "./fakes/tether.ts";
import type { FakeSession } from "./fakes/tether.ts";
import { miniSessions, tempHome, tomlString, waitFor } from "./helpers.ts";
import type { Mini } from "./helpers.ts";

const FAKE_AGENT = join(import.meta.dir, "fakes", "acp-agent.ts");
/** A Codex TUI at its composer, as 0.159 draws it. */
const COMPOSER = ["  >_ OpenAI Codex (v0.159.3)", "", "› Ask Codex to do anything", "  GPT-6.1-Sol default · C:\\work", "  ← for agents · ? for shortcuts"];
/** Its folder-trust question, before the composer. */
const TRUST = ["  Folder access", "  Trust this folder? Codex can read, edit, and run files here.", "› 1. Trust and continue", "  2. Back to Agent Command Center", "  enter continue · esc back"];

/** The Codex adapter's part a spawn leans on: whether hooks are trusted; the test makes the threads. */
class FakeCodex implements HarnessAdapter {
  readonly harness = "codex" as const;
  trusted = true;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async tick(): Promise<void> {}
  async send(): Promise<SendOutcome> {
    return { status: "queued" };
  }
  onHook(): SessionRecord | undefined {
    return undefined;
  }
  async hooked(): Promise<boolean> {
    return this.trusted;
  }
}

let fake: FakeTether;
let tether: Tether;
let mini: Mini;
let codex: FakeCodex;
let scratch: string;
let cwd: string;
let workspace: string;
let ownDir: string;
let otherDir: string;
const alive = new Set<number>();
const table: ProcessRow[] = [];
/** How the next thread of a spawned CLI runs: below the CLI, below the daemon, or not at all. */
let threadMode: "cli" | "daemon" | "none" = "cli";
/** A thread made at a CLI's first prompt, before the test looks. */
const threads: SessionRecord[] = [];

const run: Run = async () => ({ code: 0, out: "tether 0.1.0\n", err: "" });
const raiser: WindowRaiser = {
  async raise() {
    return "not_found";
  },
  async ancestors() {
    return [];
  },
  async commandLine() {
    return undefined;
  },
};

const profileOf = (name: string): HarnessProfile => mini.profiles.byHarness("codex").find((p) => p.name === name)!;
const spawnedBy = (prompt: string): FakeSession | undefined => [...fake.sessions.values()].find((s) => s.spawn.argv.includes(prompt) || s.typed.includes(`paste:${prompt}`));
const events = (id: string): SessionEvent[] => mini.store.sessionEvents.history(id, { limit: 1000 });

/** The thread Codex makes at a CLI's first prompt, met as the adapter meets one: its CLI's pid from a hook, or the daemon's, which the CLI's mark then stands for. */
function makeThread(s: FakeSession, at = Date.now()): SessionRecord {
  const rec = mini.sessions.ensure({ harness: "codex", nativeId: uuidv7(at), profile: profileOf("own").id, cwd: s.spawn.cwd, transport: "app-server", liveness: "hook" });
  threads.push(rec);
  if (threadMode === "daemon") {
    rec.hostedBy = "daemon";
    mini.sessions.linkMarked(rec);
  } else {
    mini.sessions.patch(rec, { native: { ...rec.session.native, pid: s.pid } });
  }
  return rec;
}

beforeAll(async () => {
  scratch = tempHome();
  cwd = join(scratch, "work");
  ownDir = join(scratch, ".codex");
  otherDir = join(scratch, "codex-other");
  const npmDir = join(scratch, "codex-npm");
  for (const d of [cwd, ownDir, otherDir, npmDir]) mkdirSync(d, { recursive: true });
  for (const d of [ownDir, otherDir, npmDir]) writeFileSync(join(d, "auth.json"), "{}");
  fake = await new FakeTether(join(scratch, "tether")).start();
  fake.onSpawn = (s) => {
    alive.add(s.pid);
    s.setScreen(COMPOSER);
    // Codex makes its thread at its first prompt: at once when it is the CLI's argument, at Enter when typed.
    if (s.spawn.argv.includes("--") && threadMode !== "none") setTimeout(() => makeThread(s), 30);
    s.onKeys = (keys) => {
      if (keys.includes("Enter") && s.typed.some((t) => t.startsWith("paste:")) && threadMode !== "none") makeThread(s);
    };
  };
  const tetherConfig: TetherConfig = { idle_exit_s: 600, window: "auto", window_on_start: false, profiles: false, on_path: false, dir: fake.dir };
  tether = new Tether({ config: tetherConfig, env: {}, dataDir: join(scratch, "data"), nodeId: "node_test", log: silentLogger, exe: "C:/fake/tether.exe", run, connectOrStart: (opts) => TetherClient.connect(fake.host, { name: opts.name ?? "cophylad" }) });
  await tether.start();
  mini = await miniSessions(
    `[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 100000\n\n[[profiles]]\nharness = "codex"\nname = "own"\nconfig_dir = ${tomlString(ownDir)}\ndefault = true\n\n[[profiles]]\nharness = "codex"\nname = "other"\nconfig_dir = ${tomlString(otherDir)}\n\n[[profiles]]\nharness = "codex"\nname = "npm"\nconfig_dir = ${tomlString(npmDir)}\ncommand = "C:/npm/codex.cmd"\n\n[acp]\nspawn_timeout_ms = 3000\n[acp.codex]\ncommand = ${tomlString(FAKE_AGENT)}\n`,
    () => {
      codex = new FakeCodex();
      return [codex];
    },
    {
      raiser,
      acp: (config) => ({ config: config.acp, env: {} }),
      deps: {
        tether,
        env: { PATH: "x", CODEX_HOME: "C:/inherited" },
        kill: () => undefined,
        processes: () => [...table],
        isAlive: (pid) => alive.has(pid),
        cliTiming: { debounceMs: 30, gapMs: 400 },
        home: scratch,
      },
    },
  );
  workspace = mini.workspaces.fromSession(cwd).id;
}, 30_000);

afterAll(async () => {
  await mini.stop();
  await tether.stop();
  await fake.stop();
});

describe("how a Codex CLI is started", () => {
  test("the first prompt after `--`, so a word like `resume` is never a subcommand; bypass, the model and the profile's own arguments", () => {
    expect(codexArgv({ command: "codex", prompt: "resume" })).toEqual(["codex", "--", "resume"]);
    expect(codexArgv({ command: "codex", args: ["-c", "x=1"], model: "gpt-6.1", bypass: true, prompt: "-v" })).toEqual(["codex", "-c", "x=1", "--model", "gpt-6.1", "--dangerously-bypass-approvals-and-sandbox", "--", "-v"]);
    expect(codexArgv({ command: "codex" })).toEqual(["codex"]);
  });

  test("Codex's own directory is named by leaving CODEX_HOME unset; another by naming it", () => {
    expect(codexEnv(join("/home/me", ".codex"), "/home/me")).toEqual({ set: {}, unset: ["CODEX_HOME"] });
    expect(codexEnv("/home/me/work-codex", "/home/me")).toEqual({ set: { CODEX_HOME: "/home/me/work-codex" }, unset: [] });
  });

  test("only a batch file on Windows runs under cmd, which would re-read a prompt", () => {
    expect(runsUnderCmd("C:/npm/codex.cmd", "win32")).toBe(true);
    expect(runsUnderCmd("C:/npm/codex.BAT", "win32")).toBe(true);
    expect(runsUnderCmd("C:/Codex/bin/codex.exe", "win32")).toBe(false);
    expect(runsUnderCmd("/usr/bin/codex.cmd", "linux")).toBe(false);
  });

  test("the screen says when the composer is up, and what a first screen waits on", () => {
    const screen = (rows: string[]) => ({ lines: rows });
    expect(composerUp(screen(COMPOSER))).toBe(true);
    expect(composerUp(screen(TRUST))).toBe(false);
    expect(waitingOn(screen(TRUST))).toBe("the question whether to trust the folder");
    expect(waitingOn(screen(["  Set up the Codex agent sandbox to protect your files"]))).toBe("the question how to set up its sandbox");
    expect(waitingOn(screen(COMPOSER))).toBeUndefined();
  });
});

describe("a Codex session cophylad starts", () => {
  let s: Session;
  let fs: FakeSession;

  test("runs `codex` in a tether terminal, its prompt the CLI's argument, and the thread that takes the terminal is the session, with its task", async () => {
    threadMode = "cli";
    s = await mini.sessions.spawn({ harness: "codex", workspace, prompt: "Check the Unreal MCP", task: "task_01ARZ3NDEKTSV4RRFFQ69G5FB7" }, { profiles: mini.profiles });
    fs = spawnedBy("Check the Unreal MCP")!;
    expect(fs).toBeDefined();
    expect(fs.spawn.argv.slice(-2)).toEqual(["--", "Check the Unreal MCP"]);
    expect(fs.spawn.argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(fs.spawn.cwd).toBe(cwd);
    // Codex's own directory: CODEX_HOME left unset, the inherited one taken out.
    expect(fs.spawn.env.set?.["CODEX_HOME"]).toBeUndefined();
    expect(fs.spawn.env.set?.["PATH"]).toBe("x");
    expect(s.harness).toBe("codex");
    expect(s.origin).toBe("orchestrator");
    expect(s.task).toBe("task_01ARZ3NDEKTSV4RRFFQ69G5FB7");
    expect(s.workspace).toBe(workspace);
    expect(s.native.terminal).toEqual({ host: fake.host.host, id: fs.id });
    // Nothing typed: the CLI submitted its own argument.
    expect(fs.typed).toEqual([]);
  });

  test("stop ends its terminal", async () => {
    await mini.sessions.stopSession(s.id, { as: "brain" });
    expect(mini.sessions.get(s.id)?.status).toBe("ended");
    expect(fake.requests.some((r) => r.op === "kill" && r.body["session"] === fs.id)).toBe(true);
  });

  test("in bypass permissions under another profile: the CLI's bypass flag, its directory named", async () => {
    threadMode = "cli";
    const started = await mini.sessions.spawn({ harness: "codex", workspace, prompt: "Build section 2", mode: "bypassPermissions", profile: profileOf("other").id }, { profiles: mini.profiles });
    const f = spawnedBy("Build section 2")!;
    expect(f.spawn.argv).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(f.spawn.env.set?.["CODEX_HOME"]).toBe(otherDir);
    expect(started.native.terminal?.id).toBe(f.id);
    await mini.sessions.stopSession(started.id, { as: "brain" });
  });

  test("a thread the shared daemon runs takes the terminal by its CLI's mark, and is the session", async () => {
    threadMode = "daemon";
    const started = await mini.sessions.spawn({ harness: "codex", workspace, prompt: "Run the daemon case" }, { profiles: mini.profiles });
    const f = spawnedBy("Run the daemon case")!;
    expect(started.native.terminal?.id).toBe(f.id);
    expect(started.native.pid).toBe(f.pid);
    expect(started.origin).toBe("orchestrator");
    await mini.sessions.stopSession(started.id, { as: "brain" });
  });

  test("a thread older than the prompt that draws the terminal is not claimed; the prompt's own is", async () => {
    threadMode = "none";
    const spawning = mini.sessions.spawn({ harness: "codex", workspace, prompt: "Older thread case" }, { profiles: mini.profiles });
    await waitFor(() => spawnedBy("Older thread case"));
    const f = spawnedBy("Older thread case")!;
    await waitFor(() => mini.sessions.cliOf({ host: fake.host.host, id: f.id }) === "codex");
    // A thread a minute old, its CLI gone, draws the lone marked terminal in its folder.
    threadMode = "daemon";
    const stale = makeThread(f, Date.now() - 60_000);
    expect(stale.session.native.terminal?.id).toBe(f.id);
    expect(stale.session.origin).not.toBe("orchestrator");
    // The prompt's own thread arrives, and takes the terminal over from the older one through the same CLI.
    (stale as { since?: number }).since = Date.now() - 60_000;
    const own = makeThread(f);
    (own as { since?: number }).since = Date.now();
    mini.sessions.linkMarked(own, { handOver: true });
    const started = await spawning;
    expect(started.id).toBe(own.session.id);
    expect(started.origin).toBe("orchestrator");
    expect(stale.session.native.terminal).toBeUndefined();
    await mini.sessions.stopSession(started.id, { as: "brain" });
    mini.sessions.end(stale, "exit");
  });

  test("a session that never arrives is reported with what its screen waits on", async () => {
    threadMode = "none";
    const previous = fake.onSpawn;
    fake.onSpawn = (x) => {
      previous?.(x);
      x.setScreen(TRUST);
    };
    try {
      await expect(mini.sessions.spawn({ harness: "codex", workspace, prompt: "Untrusted folder case" }, { profiles: mini.profiles })).rejects.toThrow(/waiting on the question whether to trust the folder/);
    } finally {
      fake.onSpawn = previous;
    }
    spawnedBy("Untrusted folder case")?.exit(0);
  }, 10_000);

  test.skipIf(process.platform !== "win32")("a batch-file CLI has the prompt typed once its composer shows, never on cmd's command line", async () => {
    threadMode = "cli";
    const started = await mini.sessions.spawn({ harness: "codex", workspace, prompt: 'say "hi" & echo 100%', profile: profileOf("npm").id }, { profiles: mini.profiles });
    const f = spawnedBy('say "hi" & echo 100%')!;
    expect(f.spawn.argv).toEqual(["C:/npm/codex.cmd"]);
    expect(f.typed).toEqual(['paste:say "hi" & echo 100%', "keys:Enter"]);
    expect(started.native.terminal?.id).toBe(f.id);
    await mini.sessions.stopSession(started.id, { as: "brain" });
  });

  test("a mode Codex does not have is refused", async () => {
    await expect(mini.sessions.spawn({ harness: "codex", workspace, prompt: "x", mode: "plan" }, { profiles: mini.profiles })).rejects.toThrow(/default or bypassPermissions/);
  });

  test("with its hooks untrusted it starts headless, and bypass is the ACP adapter's full access", async () => {
    codex.trusted = false;
    const before = fake.sessions.size;
    try {
      const started = await mini.sessions.spawn({ harness: "codex", workspace, prompt: "Implement this plan: headless", mode: "bypassPermissions" }, { profiles: mini.profiles });
      expect(fake.sessions.size).toBe(before);
      expect(started.native.transport).toBe("acp");
      await waitFor(() => events(started.id).some((e) => e.kind === "assistant_text"), 5000);
      expect(events(started.id).find((e) => e.kind === "assistant_text")!.payload).toMatchObject({ text: "mode=agent-full-access" });
      await mini.sessions.stopSession(started.id, { as: "brain" });
    } finally {
      codex.trusted = true;
    }
  }, 15_000);
});

describe("a CLI of the user's waiting at its first prompt", () => {
  const refOf = (s: FakeSession) => ({ host: fake.host.host, id: s.id });

  test("is given its first prompt, typed; the session it becomes stays the user's, with the task", async () => {
    threadMode = "daemon";
    const shell = fake.add({ argv: ["pwsh.exe"], cwd }, 9500);
    shell.setScreen(COMPOSER);
    shell.onKeys = (keys) => {
      if (keys.includes("Enter")) makeThread(shell);
    };
    table.push({ pid: 9500, parent: 1, name: "pwsh.exe" }, { pid: 9501, parent: 9500, name: "codex.exe" });
    alive.add(9500);
    alive.add(9501);
    await waitFor(() => tether.byPid(9500));
    fake.emit({ ev: "title", session: shell.id, title: "work" });
    await waitFor(() => mini.sessions.cliOf(refOf(shell)) === "codex", 3000);
    const s = await mini.sessions.promptTerminal(shell.id, "Look into the Unreal MCP", { task: "task_01ARZ3NDEKTSV4RRFFQ69G5FB9" });
    expect(shell.typed).toEqual(["paste:Look into the Unreal MCP", "keys:Enter"]);
    expect(s.origin).toBe("user");
    expect(s.task).toBe("task_01ARZ3NDEKTSV4RRFFQ69G5FB9");
    expect(s.workspace).toBe(workspace);
    expect(s.native.terminal).toEqual(refOf(shell));
    expect(s.native.pid).toBe(9501);
    // Held now: a second first prompt is refused, and says to send instead.
    await expect(mini.sessions.promptTerminal(shell.id, "again")).rejects.toThrow(/send to it instead/);
    mini.sessions.end(mini.sessions.find("codex", s.native.id)!, "exit");
    shell.exit(0);
  });

  test("a terminal with no CLI waiting, or none at all, is refused", async () => {
    const bare = fake.add({ argv: ["pwsh.exe"], cwd }, 9600);
    await waitFor(() => tether.byPid(9600));
    await expect(mini.sessions.promptTerminal(bare.id, "hello")).rejects.toThrow(/no agent CLI waiting/);
    await expect(mini.sessions.promptTerminal("t-none", "hello")).rejects.toThrow(/no running terminal/);
    bare.exit(0);
  });
});
