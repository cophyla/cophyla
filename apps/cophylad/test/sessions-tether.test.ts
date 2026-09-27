// Sessions in tether, against a fake host speaking the real protocol: a session cophylad starts
// runs in a tether terminal with cophylad's settings, gets a window, and has its first prompt
// typed; the user's messages are typed and land as their turns, the brain's go over the pipe;
// nothing is typed while an ask is open or the prompt holds the user's half-typed text; focus
// raises the window used on it, or opens one; stop ends the terminal; a session the user
// started in tether is met with its terminal, and loses it when the terminal goes, also when a
// wrapper or a shell stands between them, but never through another Claude above it; the
// brain cannot stop it, the user can, and its process ends while the shell's terminal stays.
// An agent CLI in a terminal no session holds is marked from one read of the process table
// when the terminal retitles itself, reads coalesced and spaced, never for a held terminal;
// a Codex thread the app-server daemon runs takes the one terminal whose CLI fits it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeHookEvent, Session, SessionEvent } from "@cophyla/protocol";
import { TetherClient } from "@tether-pty/client";
import type { TetherConfig } from "../src/config/schema.ts";
import { silentLogger } from "../src/log.ts";
import { ClaudeAdapter } from "../src/sessions/claude/adapter.ts";
import type { WindowRaiser } from "../src/sessions/focus.ts";
import { SEND_PREFIX } from "../src/sessions/index.ts";
import { cliOfName, findCli } from "../src/sessions/tether/cli.ts";
import type { ProcessRow } from "../src/sessions/tether/cli.ts";
import { Tether } from "../src/sessions/tether/index.ts";
import type { Run } from "../src/sessions/tether/index.ts";
import { TerminalRows } from "../src/sessions/tether/streams.ts";
import { FakeTether } from "./fakes/tether.ts";
import type { FakeSession } from "./fakes/tether.ts";
import { miniSessions, sleep, tempHome, tomlString, waitFor, writeRegistry } from "./helpers.ts";
import type { Mini } from "./helpers.ts";

const RULE = "─".repeat(40);
const EMPTY: (string | [string, "dim"])[] = ["", RULE, ['❯ Try "fix the flaky test"', "dim"], RULE, "  ⏵⏵ accept edits on"];

let fake: FakeTether;
let tether: Tether;
let tetherConfig: TetherConfig;
/** Claude's own directory under the test's home: named to a session by leaving CLAUDE_CONFIG_DIR unset. */
let ownDir: string;
let mini: Mini;
let registry: string;
let profileDir: string;
let cwd: string;
let workspace: string;
const alive = new Set<number>();
const injected: { text: string }[] = [];
const runs: string[][] = [];
const raised: number[] = [];
const windowPids = new Set<number>();
/** Each process's chain, itself first, as the process tree reads it; what was asked for. */
const chains = new Map<number, { pid: number; name: string }[]>();
const asked: number[] = [];
/** The pids a stop ended, instead of the processes themselves. */
const killed: number[] = [];
/** Harness commands run to their end (`claude stop`), instead of run. */
const ran: { argv: string[]; env: Record<string, string> }[] = [];
/** Each process's command line, as the raiser reads it. */
const commandLines = new Map<number, string[]>();
/** The process table a terminal's CLI is looked for in, and how many times it was read. */
const table: ProcessRow[] = [];
let reads = 0;
const DEBOUNCE_MS = 30;
const GAP_MS = 400;

/** A `tether` command's arguments without the state folder it is told. */
const bare = (args: string[]) => (args[0] === "--dir" ? args.slice(2) : args);

const run: Run = async (_exe, all) => {
  const args = bare(all);
  runs.push(args);
  if (args[0] === "--version") return { code: 0, out: "tether 0.1.0\n", err: "" };
  if (args[0] === "open") return { code: 0, out: JSON.stringify({ session: args[1], terminal: "wt" }), err: "" };
  return { code: 0, out: "", err: "" };
};

const raiser: WindowRaiser = {
  async raise(pid) {
    raised.push(pid);
    return windowPids.has(pid) ? "raised" : "not_found";
  },
  async ancestors(pid) {
    asked.push(pid);
    return chains.get(pid) ?? [];
  },
  async ancestorsOf(pids) {
    asked.push(...pids);
    return new Map(pids.map((pid) => [pid, chains.get(pid) ?? []]));
  },
  async commandLine(pid) {
    return commandLines.get(pid);
  },
};

const events = (id: string): SessionEvent[] => mini.store.sessionEvents.history(id, { limit: 1000 });

function hook(s: Session, event: ClaudeHookEvent["hook_event_name"], extra: Record<string, unknown> = {}): ClaudeHookEvent {
  return { session_id: s.native.id, transcript_path: join(cwd, `${s.native.id}.jsonl`), cwd, hook_event_name: event, permission_mode: "default", ...extra } as ClaudeHookEvent;
}

/** The session's id from the argv it was started with. */
function sessionIdOf(fs: FakeSession): string {
  return fs.spawn.argv[fs.spawn.argv.indexOf("--session-id") + 1]!;
}

beforeAll(async () => {
  const scratch = tempHome();
  profileDir = join(scratch, "claude-profile");
  registry = join(profileDir, "sessions");
  cwd = join(scratch, "work");
  ownDir = join(scratch, ".claude");
  mkdirSync(registry, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(ownDir, { recursive: true });
  fake = await new FakeTether(join(scratch, "tether")).start();
  // The harness registers once it runs, as Claude writes its registry entry.
  fake.onSpawn = (s) => {
    s.setScreen(EMPTY);
    if (!s.spawn.argv.includes("--session-id")) return;
    alive.add(s.pid);
    writeRegistry(registry, { pid: s.pid, sessionId: sessionIdOf(s), cwd, status: "idle" });
  };
  tetherConfig = { idle_exit_s: 600, window: "auto", window_on_start: false, profiles: false, on_path: false, dir: fake.dir };
  tether = new Tether({
    config: tetherConfig,
    env: {},
    dataDir: join(scratch, "data"),
    nodeId: "node_test",
    log: silentLogger,
    exe: "C:/fake/tether.exe",
    run,
    connectOrStart: (opts) => TetherClient.connect(fake.host, { name: opts.name ?? "cophylad" }),
  });
  await tether.start();
  mini = await miniSessions(
    `[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 100000\nreceipt_timeout_ms = 30000\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(profileDir)}\n\n[[profiles]]\nharness = "claude"\nname = "own"\nconfig_dir = ${tomlString(ownDir)}\n\n[acp]\nspawn_timeout_ms = 5000\n`,
    (host, log) => [
      new ClaudeAdapter({
        host,
        log,
        isAlive: (pid) => alive.has(pid),
        inject: async (_pipe, _token, text) => {
          injected.push({ text });
        },
        sharedSettings: join(profileDir, "no-such-shared-settings.json"),
      }),
    ],
    {
      raiser,
      acp: (config) => ({ config: config.acp, env: {} }),
      deps: {
        tether,
        env: { PATH: "x", CLAUDE_CODE_CHILD: "never", CLAUDE_CONFIG_DIR: "C:/inherited" },
        kill: (pid) => killed.push(pid),
        processes: () => {
          reads++;
          return [...table];
        },
        isAlive: (pid) => alive.has(pid),
        cliTiming: { debounceMs: DEBOUNCE_MS, gapMs: GAP_MS },
        run: async (argv, env) => {
          ran.push({ argv, env });
          return { code: 0, out: "" };
        },
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

describe("a session cophylad starts in tether", () => {
  let s: Session;
  let fs: FakeSession;

  test("runs in a tether terminal with cophylad's settings, in the profile's environment, with no window of its own", async () => {
    s = await mini.sessions.spawn({ harness: "claude", workspace, prompt: "Fix the flaky test", task: "tsk_01ARZ3NDEKTSV4RRFFQ69G5FB7" }, { profiles: mini.profiles });
    fs = [...fake.sessions.values()].find((x) => x.spawn.labels["cophylad.session"] === s.native.id)!;
    expect(fs).toBeDefined();
    expect(s.origin).toBe("orchestrator");
    expect(s.task).toBe("tsk_01ARZ3NDEKTSV4RRFFQ69G5FB7");
    expect(s.native.terminal).toEqual({ host: fake.host.host, id: fs.id });
    const argv = fs.spawn.argv;
    expect(argv[argv.indexOf("--settings") + 1]).toBe(join(mini.home, "data", "claude", `settings-${s.profile}.json`));
    expect(fs.spawn.cwd).toBe(cwd);
    expect(fs.spawn.env.base).toBe("empty");
    expect(fs.spawn.env.set?.["CLAUDE_CONFIG_DIR"]).toBe(profileDir);
    expect(fs.spawn.env.set?.["PATH"]).toBe("x");
    // It shows in the apps, as a terminal opened there does; a window opens when the user raises it.
    expect(runs.some((a) => a[0] === "open")).toBe(false);
  });

  test("its first prompt is typed once the prompt is free, and lands as the user's turn", async () => {
    await waitFor(() => fs.typed.includes("keys:Enter"), 5000);
    expect(fs.typed).toEqual(["paste:Fix the flaky test", "keys:Enter"]);
    await mini.sessions.onHook("claude", hook(s, "UserPromptSubmit", { prompt: "Fix the flaky test", prompt_id: "p1" }), { via: "http" });
    const turn = events(s.id).find((e) => e.kind === "user_turn")!;
    expect(turn.payload).toEqual({ text: "Fix the flaky test", source: "typed", ref: `cophylad-start-${s.native.id}`, promptId: "p1" });
    // The transcript's copy of the same prompt is not a second turn; the user typing the same words later is.
    expect(mini.sessions.isOwnText(mini.sessions.find("claude", s.native.id)!, "Fix the flaky test", "p1")).toBe(true);
    expect(mini.sessions.isOwnText(mini.sessions.find("claude", s.native.id)!, "Fix the flaky test", "p9")).toBe(false);
  });

  test("the user's messages are typed, with no prefix, and receipted by the prompt hook", async () => {
    fs.typed.length = 0;
    const r = await mini.sessions.send(s.id, "and the docs", { from: "user" });
    expect(r.status).toBe("queued");
    await waitFor(() => fs.typed.includes("keys:Enter"), 5000);
    expect(fs.typed).toEqual(["paste:and the docs", "keys:Enter"]);
    expect(injected).toHaveLength(0);
    await mini.sessions.onHook("claude", hook(s, "UserPromptSubmit", { prompt: "and the docs", prompt_id: "p2" }), { via: "http" });
    expect(events(s.id).some((e) => e.kind === "user_turn" && (e.payload as { ref?: string }).ref === r.ref)).toBe(true);
  });

  test("the brain's go over the pipe, as another agent's", async () => {
    await mini.sessions.send(s.id, "from the brain", { from: "brain" }).catch(() => undefined);
    // The fake registry carries no live pipe; the adapter was asked all the same.
    expect(injected.at(-1)?.text).toBe(`${SEND_PREFIX}\nfrom the brain`);
  });

  test("nothing is typed over what the user has half typed", async () => {
    fs.typed.length = 0;
    fs.setScreen(["", RULE, "❯ half a thou", RULE]);
    await mini.sessions.send(s.id, "later", { from: "user" });
    await sleep(900);
    expect(fs.typed).toEqual([]);
    fs.setScreen(EMPTY);
    await waitFor(() => fs.typed.includes("paste:later"), 5000);
  }, 20_000);

  test("nothing is typed while an ask is open", async () => {
    await waitFor(() => fs.typed.includes("keys:Enter"), 5000);
    fs.typed.length = 0;
    const decision = mini.sessions.onHook("claude", hook(s, "PermissionRequest", { tool_name: "Bash", tool_input: { command: "ls" }, prompt_id: "p3" }), { via: "http" });
    const ask = await waitFor(() => mini.asks.listOpen().find((a) => a.source.kind === "harness" && a.source.session === s.id), 5000);
    await mini.sessions.send(s.id, "after the ask", { from: "user" });
    await sleep(900);
    expect(fs.typed).toEqual([]);
    mini.asks.answer(ask.id, { option: "allow" }, { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" });
    await decision;
    await waitFor(() => fs.typed.includes("paste:after the ask"), 5000);
  }, 20_000);

  test("focus raises the window used on it, and opens one when there is none", async () => {
    runs.length = 0;
    fs.attachWindow(4242);
    windowPids.add(4242);
    await waitFor(() => tether.windows(s.native.terminal!).length > 0);
    await mini.sessions.focus(s.id);
    expect(raised.at(-1)).toBe(4242);
    expect(runs.some((a) => a[0] === "open")).toBe(false);
    windowPids.delete(4242);
    fs.clients = [];
    await mini.sessions.focus(s.id);
    expect(runs.some((a) => a[0] === "open" && a[1] === fs.id)).toBe(true);
  });

  test("stop ends its terminal", async () => {
    await mini.sessions.stopSession(s.id);
    expect(fake.requests.some((r) => r.op === "kill" && r.body["session"] === fs.id)).toBe(true);
    expect(mini.sessions.get(s.id)?.status).toBe("ended");
  });
});

describe("a session the user started in tether", () => {
  test("is met with its terminal, and loses it when the terminal goes", async () => {
    const own = fake.add({ argv: ["claude"], cwd }, 8123);
    alive.add(8123);
    writeRegistry(registry, { pid: 8123, sessionId: "users-own", cwd, status: "idle" });
    await waitFor(() => tether.byPid(8123));
    await mini.sessions.tick();
    const rec = mini.sessions.find("claude", "users-own")!;
    expect(rec.session.origin).toBe("user");
    expect(rec.session.native.terminal).toEqual({ host: fake.host.host, id: own.id });
    expect(mini.sessions.sessionOfTerminal({ host: fake.host.host, id: own.id })?.id).toBe(rec.session.id);
    own.exit(0);
    await waitFor(() => mini.sessions.find("claude", "users-own")!.session.native.terminal === undefined);
  });

  test("is met with its terminal when a wrapper script started it", async () => {
    // `tether run -- claude-work.cmd`: the terminal's process is cmd.exe, and claude.exe its child.
    const own = fake.add({ argv: ["cmd.exe", "/d", "/c", "claude-work.cmd"], cwd }, 8200);
    chains.set(8201, [
      { pid: 8201, name: "claude.exe" },
      { pid: 8200, name: "cmd.exe" },
      { pid: 90, name: "tether.exe" },
    ]);
    alive.add(8201);
    writeRegistry(registry, { pid: 8201, sessionId: "wrapped", cwd, status: "idle" });
    await waitFor(() => tether.byPid(8200));
    await mini.sessions.tick();
    await waitFor(() => mini.sessions.find("claude", "wrapped")?.session.native.terminal, 5000);
    expect(mini.sessions.find("claude", "wrapped")!.session.native.terminal).toEqual({ host: fake.host.host, id: own.id });
    own.exit(0);
    await waitFor(() => mini.sessions.find("claude", "wrapped")!.session.native.terminal === undefined);
  });

  test("is not given the terminal of another Claude that started it", async () => {
    // A `claude -p` from a tool of a Claude in tether that cophylad does not know of.
    const outer = fake.add({ argv: ["claude"], cwd }, 8300);
    chains.set(8302, [
      { pid: 8302, name: "claude.exe" },
      { pid: 8301, name: "bash.exe" },
      { pid: 8300, name: "claude.exe" },
    ]);
    alive.add(8302);
    writeRegistry(registry, { pid: 8302, sessionId: "nested", cwd, status: "idle" });
    await waitFor(() => tether.byPid(8300));
    await mini.sessions.tick();
    await waitFor(() => asked.includes(8302));
    await sleep(50);
    expect(mini.sessions.find("claude", "nested")!.session.native.terminal).toBeUndefined();
    outer.exit(0);
  });

  test("is met with its terminal when the terminal is seen after it registered", async () => {
    // A shell in tether, `claude` typed into it; the host's announcement comes late.
    chains.set(8402, [
      { pid: 8402, name: "claude.exe" },
      { pid: 8401, name: "pwsh.exe" },
    ]);
    alive.add(8402);
    writeRegistry(registry, { pid: 8402, sessionId: "shelled", cwd, status: "idle" });
    await mini.sessions.tick();
    expect(mini.sessions.find("claude", "shelled")!.session.native.terminal).toBeUndefined();
    const shell = fake.add({ argv: ["pwsh.exe"], cwd }, 8401);
    await waitFor(() => mini.sessions.find("claude", "shelled")?.session.native.terminal, 5000);
    expect(mini.sessions.find("claude", "shelled")!.session.native.terminal).toEqual({ host: fake.host.host, id: shell.id });
    shell.exit(0);
  });

  test("is stopped by the user alone: its process ends, the shell's terminal stays", async () => {
    const shell = fake.add({ argv: ["pwsh.exe"], cwd }, 8501);
    chains.set(8502, [
      { pid: 8502, name: "claude.exe" },
      { pid: 8501, name: "pwsh.exe" },
    ]);
    alive.add(8502);
    writeRegistry(registry, { pid: 8502, sessionId: "killed-by-hand", cwd, status: "idle" });
    await waitFor(() => tether.byPid(8501));
    await mini.sessions.tick();
    await waitFor(() => mini.sessions.find("claude", "killed-by-hand")?.session.native.terminal, 5000);
    const id = mini.sessions.find("claude", "killed-by-hand")!.session.id;
    await expect(mini.sessions.stopSession(id)).rejects.toMatchObject({ code: "unsupported" });
    expect(killed).not.toContain(8502);
    await mini.sessions.stopSession(id, { as: "user" });
    expect(killed.filter((pid) => pid === 8502)).toHaveLength(1);
    expect(fake.requests.some((r) => r.op === "kill" && r.body["session"] === shell.id)).toBe(false);
    expect(mini.sessions.get(id)?.status).toBe("ended");
    expect(events(id).at(-1)!.payload).toEqual({ reason: "stopped" });
    // Ended, its pid may be another process's by now: a second stop is refused and ends nothing.
    await expect(mini.sessions.stopSession(id, { as: "user" })).rejects.toMatchObject({ code: "conflict" });
    expect(killed.filter((pid) => pid === 8502)).toHaveLength(1);
    // One whose process the node never learned has nothing to end.
    const unknown = mini.sessions.ensure({ harness: "claude", nativeId: "no-pid", profile: mini.profiles.byHarness("claude")[0]!.id, cwd, transport: "pipe" });
    await expect(mini.sessions.stopSession(unknown.session.id, { as: "user" })).rejects.toMatchObject({ code: "unsupported" });
    shell.exit(0);
  });
});

describe("Claude's background jobs and agents screen", () => {
  test("a job has no window: focus opens `claude attach` in a terminal, which is then the job's, until it goes to the agents screen", async () => {
    alive.add(8701);
    writeRegistry(registry, { pid: 8701, sessionId: "job-x-0000", cwd, status: "idle", kind: "bg", jobId: "jobx" });
    await mini.sessions.tick();
    const rec = mini.sessions.find("claude", "job-x-0000")!;
    expect(rec.session.native).toEqual({ id: "job-x-0000", pid: 8701, transport: "pipe", job: "jobx" });
    runs.length = 0;
    await mini.sessions.focus(rec.session.id);
    const att = [...fake.sessions.values()].find((x) => x.spawn.labels["cophylad.attach"] === "jobx")!;
    expect(att.spawn.argv.slice(1)).toEqual(["attach", "jobx"]);
    expect(att.spawn.env.set?.["CLAUDE_CONFIG_DIR"]).toBe(profileDir);
    const ref = { host: fake.host.host, id: att.id };
    expect(mini.sessions.get(rec.session.id)!.native.terminal).toEqual(ref);
    expect(mini.sessions.sessionOfTerminal(ref)?.id).toBe(rec.session.id);
    expect(runs.some((a) => a[0] === "open" && a[1] === att.id)).toBe(true);
    // ← in the viewer: the agents screen, where what is typed would start a job of its own.
    fake.emit({ ev: "title", session: att.id, title: "claude agents" });
    await waitFor(() => mini.sessions.get(rec.session.id)!.native.terminal === undefined);
    expect(mini.sessions.agentsOf(ref)).toBe("claude");
    // It counts what waits in its title, and is still the agents screen.
    fake.emit({ ev: "title", session: att.id, title: "1 awaiting input · claude agents" });
    await waitFor(() => tether.get(ref)?.info.title === "1 awaiting input · claude agents");
    expect(mini.sessions.agentsOf(ref)).toBe("claude");
    fake.emit({ ev: "title", session: att.id, title: "✳ Claude Code" });
    await waitFor(() => tether.get(ref)?.info.title === "✳ Claude Code");
    expect(mini.sessions.agentsOf(ref)).toBeUndefined();
    att.exit(0);
  });

  test("stopping a job asks its harness (`claude stop`): a killed job would be started again", async () => {
    const id = mini.sessions.find("claude", "job-x-0000")!.session.id;
    await mini.sessions.stopSession(id, { as: "user" });
    expect(ran.at(-1)!.argv.slice(1)).toEqual(["stop", "jobx"]);
    expect(ran.at(-1)!.env["CLAUDE_CONFIG_DIR"]).toBe(profileDir);
    expect(killed).not.toContain(8701);
    expect(mini.sessions.get(id)?.status).toBe("ended");
  });

  test("focus that opens no window (`open: false`): a window on it is raised, and with none the answer is the tether command that opens one", async () => {
    alive.add(8711);
    writeRegistry(registry, { pid: 8711, sessionId: "job-y-0000", cwd, status: "idle", kind: "bg", jobId: "joby" });
    await mini.sessions.tick();
    const rec = mini.sessions.find("claude", "job-y-0000")!;
    runs.length = 0;
    // A job has no terminal: it is attached into one, and no window opens on it.
    const first = await mini.sessions.focus(rec.session.id, { open: false });
    const att = [...fake.sessions.values()].find((x) => x.spawn.labels["cophylad.attach"] === "joby")!;
    expect(att.spawn.argv.slice(1)).toEqual(["attach", "joby"]);
    expect(mini.sessions.get(rec.session.id)!.native.terminal).toEqual({ host: fake.host.host, id: att.id });
    expect(runs.some((a) => a[0] === "open")).toBe(false);
    // `tether` by name where the PATH has it, else the node's copy; the state folder the node runs it with.
    expect(first.attach).toMatch(new RegExp(`^(tether|\\S*tether(\\.exe)?|".*tether(\\.exe)?") --dir .+ attach ${att.id}$`));
    // A window on its terminal: raised, and nothing to copy.
    att.attachWindow(4711);
    windowPids.add(4711);
    await waitFor(() => tether.windows(mini.sessions.get(rec.session.id)!.native.terminal!).length > 0);
    expect(await mini.sessions.focus(rec.session.id, { open: false })).toEqual({});
    expect(raised.at(-1)).toBe(4711);
    // The window gone: the command again, still no window opened and no second attach.
    windowPids.delete(4711);
    att.clients = [];
    expect((await mini.sessions.focus(rec.session.id, { open: false })).attach).toBe(first.attach);
    expect(runs.some((a) => a[0] === "open")).toBe(false);
    expect([...fake.sessions.values()].filter((x) => x.spawn.labels["cophylad.attach"] === "joby")).toHaveLength(1);
    // One outside tether is raised through its process as ever: with none known, `unsupported`.
    const outside = mini.sessions.ensure({ harness: "claude", nativeId: "outside", profile: mini.profiles.byHarness("claude")[0]!.id, cwd, transport: "pipe" });
    await expect(mini.sessions.focus(outside.session.id, { open: false })).rejects.toMatchObject({ code: "unsupported" });
    att.exit(0);
  });

  test("a window parked on the agents screen: its terminal is Claude's agents, until the window takes a conversation again", async () => {
    const shell = fake.add({ argv: ["pwsh.exe"], cwd }, 8801);
    chains.set(8802, [
      { pid: 8802, name: "claude.exe" },
      { pid: 8801, name: "pwsh.exe" },
    ]);
    alive.add(8802);
    writeRegistry(registry, { pid: 8802, sessionId: "parked-conv", cwd, status: "idle" });
    await waitFor(() => tether.byPid(8801));
    await mini.sessions.tick();
    await waitFor(() => mini.sessions.find("claude", "parked-conv")?.session.native.terminal, 5000);
    const id = mini.sessions.find("claude", "parked-conv")!.session.id;
    const ref = { host: fake.host.host, id: shell.id };
    expect(mini.sessions.agentsOf(ref)).toBeUndefined();
    const marked: string[] = [];
    const off = mini.sessions.onAgents((r) => marked.push(r.id));
    // ←: the window parks its conversation, which goes on as a job.
    writeRegistry(registry, { pid: 8802, sessionId: "parked-conv", cwd, status: "idle", parkedJobId: "jobp" });
    alive.add(8803);
    writeRegistry(registry, { pid: 8803, sessionId: "job-p-0000", cwd, status: "busy", kind: "bg", jobId: "jobp" });
    await mini.sessions.tick();
    expect(mini.sessions.get(id)!.native).toEqual({ id: "job-p-0000", pid: 8803, transport: "pipe", job: "jobp" });
    await waitFor(() => mini.sessions.agentsOf(ref) === "claude");
    expect(marked).toContain(shell.id);
    // The window starts a new conversation: a session in that terminal again, and no mark.
    writeRegistry(registry, { pid: 8802, sessionId: "fresh-conv", cwd, status: "idle" });
    await mini.sessions.tick();
    expect(mini.sessions.agentsOf(ref)).toBeUndefined();
    await waitFor(() => mini.sessions.find("claude", "fresh-conv")?.session.native.terminal, 5000);
    expect(mini.sessions.find("claude", "fresh-conv")!.session.native.terminal).toEqual(ref);
    off();
    shell.exit(0);
  });
});

describe("which process is a terminal's CLI", () => {
  test("the topmost one below the terminal's program, breadth first; names as each platform gives them", () => {
    const rows: ProcessRow[] = [
      { pid: 10, parent: 1, name: "pwsh.exe" },
      { pid: 11, parent: 10, name: "node.exe" },
      { pid: 12, parent: 10, name: "git.exe" },
      { pid: 13, parent: 11, name: "codex.exe" },
      { pid: 14, parent: 13, name: "codex.exe" },
      { pid: 20, parent: 1, name: "claude.exe" },
    ];
    expect(findCli(10, rows)).toEqual({ harness: "codex", pid: 13 });
    expect(findCli(20, rows)).toEqual({ harness: "claude", pid: 20 });
    expect(findCli(12, rows)).toBeUndefined();
    expect(findCli(99, rows)).toBeUndefined();
    expect(cliOfName("codex")).toBe("codex");
    expect(cliOfName("/usr/lib/node_modules/@openai/codex/vendor/codex")).toBe("codex");
    // Linux cuts a process's name to 15 characters: the old musl binary's reads so.
    expect(cliOfName("codex-x86_64-un")).toBe("codex");
    expect(cliOfName("Claude.EXE")).toBe("claude");
    expect(cliOfName("codexbar.exe")).toBeUndefined();
    expect(cliOfName("claude-helper")).toBeUndefined();
    // Muse is its binary, never the launcher above it, which a Muse session's walk up passes.
    expect(cliOfName("C:\\Users\\u\\AppData\\Local\\Programs\\muse\\muse-bin-1.4.0-R4161.1.exe")).toBe("muse");
    expect(cliOfName("muse")).toBeUndefined();
  });
});

describe("an agent CLI in a terminal no session stands for yet", () => {
  const refOf = (s: FakeSession) => ({ host: fake.host.host, id: s.id });
  const retitle = (s: FakeSession, title: string) => fake.emit({ ev: "title", session: s.id, title });
  const codexRecord = (nativeId: string, at = cwd) => mini.sessions.ensure({ harness: "codex", nativeId, profile: "prof_codex", cwd: at, transport: "app-server", liveness: "hook" });
  let rows: TerminalRows;
  let shell: FakeSession;

  beforeAll(() => {
    rows = new TerminalRows({ tether, bus: mini.bus, nodeId: "node_test", workspaces: mini.workspaces, env: {}, sessionOf: (r) => mini.sessions.sessionOfTerminal(r), agentsOf: (r) => mini.sessions.agentsOf(r), onAgents: (fn) => mini.sessions.onAgents(fn), cliOf: (r) => mini.sessions.cliOf(r), log: silentLogger });
  });
  afterAll(() => rows.stop());

  test("a title change looks: the Codex CLI a shell runs is marked, and its row says so", async () => {
    shell = fake.add({ argv: ["pwsh.exe"], cwd }, 9100);
    // npm's `codex` is node running the binary; the binary's own child is the app-server daemon it started.
    table.push({ pid: 9100, parent: 1, name: "pwsh.exe" }, { pid: 9101, parent: 9100, name: "node.exe" }, { pid: 9102, parent: 9101, name: "codex.exe" }, { pid: 9103, parent: 9102, name: "codex.exe" });
    for (const pid of [9100, 9101, 9102, 9103]) alive.add(pid);
    await waitFor(() => tether.byPid(9100));
    const before = reads;
    expect(mini.sessions.cliOf(refOf(shell))).toBeUndefined();
    retitle(shell, "work");
    await waitFor(() => mini.sessions.cliOf(refOf(shell)) === "codex");
    expect(reads).toBe(before + 1);
    expect(rows.row(tether.get(refOf(shell))!).harness).toBe("codex");
  });

  test("the thread the daemon runs takes the terminal whose CLI stands for it, and the CLI as its process, never the daemon", async () => {
    const rec = codexRecord("daemon-thread");
    rec.hostedBy = "daemon";
    mini.sessions.linkMarked(rec);
    expect(rec.session.native.terminal).toEqual(refOf(shell));
    expect(rec.session.native.pid).toBe(9102);
    // Held now: the row is the session's, and the CLI mark is not shown beside it.
    const row = rows.row(tether.get(refOf(shell))!);
    expect(row.session).toBe(rec.session.id);
    expect(row.harness).toBeUndefined();
    mini.sessions.end(rec, "exit");
  });

  test("with two terminals that fit, none is taken", async () => {
    const other = fake.add({ argv: ["pwsh.exe"], cwd }, 9110);
    table.push({ pid: 9110, parent: 1, name: "pwsh.exe" }, { pid: 9111, parent: 9110, name: "codex.exe" });
    alive.add(9111);
    await waitFor(() => tether.byPid(9110));
    retitle(other, "work");
    await waitFor(() => mini.sessions.cliOf(refOf(other)) === "codex", 3000);
    const rec = codexRecord("ambiguous-thread");
    rec.hostedBy = "daemon";
    mini.sessions.linkMarked(rec);
    expect(rec.session.native.terminal).toBeUndefined();
    expect(rec.session.native.pid).toBeUndefined();
    // One CLI quits: its mark goes at the next tick, and one terminal fits.
    alive.delete(9111);
    await mini.sessions.tick();
    expect(mini.sessions.cliOf(refOf(other))).toBeUndefined();
    mini.sessions.linkMarked(rec);
    expect(rec.session.native.terminal).toEqual(refOf(shell));
    mini.sessions.end(rec, "exit");
    other.exit(0);
  });

  test("title changes together are looked at in one read, and a terminal that keeps retitling costs one read per gap at most", async () => {
    const a = fake.add({ argv: ["pwsh.exe"], cwd }, 9200);
    const b = fake.add({ argv: ["pwsh.exe"], cwd }, 9210);
    table.push({ pid: 9200, parent: 1, name: "pwsh.exe" }, { pid: 9210, parent: 1, name: "pwsh.exe" });
    await waitFor(() => tether.byPid(9210));
    // Clear of the reads before.
    await sleep(GAP_MS);
    const before = reads;
    retitle(a, "1");
    retitle(b, "1");
    retitle(a, "2");
    retitle(b, "2");
    await waitFor(() => reads === before + 1);
    await sleep(DEBOUNCE_MS * 3);
    expect(reads).toBe(before + 1);
    // Again at once: the next read waits out the gap.
    retitle(a, "3");
    await sleep(GAP_MS / 3);
    expect(reads).toBe(before + 1);
    await waitFor(() => reads === before + 2);
    // At rest, none.
    await sleep(GAP_MS + DEBOUNCE_MS * 2);
    expect(reads).toBe(before + 2);
    a.exit(0);
    b.exit(0);
  });

  test("a terminal a session holds is not looked at", async () => {
    const held = fake.add({ argv: ["pwsh.exe"], cwd }, 9300);
    chains.set(9301, [
      { pid: 9301, name: "claude.exe" },
      { pid: 9300, name: "pwsh.exe" },
    ]);
    alive.add(9301);
    writeRegistry(registry, { pid: 9301, sessionId: "holds-its-shell", cwd, status: "idle" });
    await waitFor(() => tether.byPid(9300));
    await mini.sessions.tick();
    await waitFor(() => mini.sessions.find("claude", "holds-its-shell")?.session.native.terminal, 5000);
    await sleep(GAP_MS);
    const before = reads;
    retitle(held, "Claude Code");
    await sleep(GAP_MS + DEBOUNCE_MS * 2);
    expect(reads).toBe(before);
    held.exit(0);
  });

  test("a CLI that is the terminal's own program is marked by its name, with no read, and a Codex session with its pid is met there", async () => {
    const before = reads;
    const own = fake.add({ argv: ["codex"], cwd }, 9400);
    alive.add(9400);
    await waitFor(() => mini.sessions.cliOf(refOf(own)) === "codex");
    expect(reads).toBe(before);
    const rec = codexRecord("own-program");
    mini.sessions.patch(rec, { native: { ...rec.session.native, pid: 9400 } });
    expect(rec.session.native.terminal).toEqual(refOf(own));
    mini.sessions.end(rec, "exit");
    own.exit(0);
  });

  test("a Codex session whose process is a CLI below a shell is met in the shell's terminal; a dead CLI's mark goes", async () => {
    const rec = codexRecord("below-shell");
    chains.set(9102, [
      { pid: 9102, name: "codex.exe" },
      { pid: 9101, name: "node.exe" },
      { pid: 9100, name: "pwsh.exe" },
    ]);
    mini.sessions.patch(rec, { native: { ...rec.session.native, pid: 9102 } });
    await waitFor(() => rec.session.native.terminal, 5000);
    expect(rec.session.native.terminal).toEqual(refOf(shell));
    mini.sessions.end(rec, "exit");
    const told: string[] = [];
    const off = mini.sessions.onAgents((r) => told.push(r.id));
    alive.delete(9102);
    await mini.sessions.tick();
    expect(mini.sessions.cliOf(refOf(shell))).toBeUndefined();
    expect(told).toContain(shell.id);
    off();
    shell.exit(0);
  });
});

describe("how a session cophylad starts is launched", () => {
  const spawned = async (prompt: string, extra: { profile?: string; model?: { model: string } } = {}) => {
    const started = await mini.sessions.spawn({ harness: "claude", workspace, prompt, ...extra }, { profiles: mini.profiles });
    return { s: started, fs: [...fake.sessions.values()].find((x) => x.spawn.labels["cophylad.session"] === started.native.id)! };
  };
  const profileId = (name: string) => mini.profiles.byHarness("claude").find((p) => p.name === name)!.id;

  test("a session the user starts under a profile lends it its flags, which cophylad's next session there takes", async () => {
    commandLines.set(8601, ["claude", "--resume", "abc", "--permission-mode", "acceptEdits", "--effort", "high"]);
    alive.add(8601);
    writeRegistry(registry, { pid: 8601, sessionId: "lends-flags", cwd, status: "idle", startedAt: Date.now() + 60_000 });
    await mini.sessions.tick();
    await waitFor(() => mini.profiles.launch(profileId("fake"))?.source === "mirrored", 6000);
    expect(mini.profiles.launch(profileId("fake"))).toMatchObject({ mode: "acceptEdits", args: ["--effort", "high"], source: "mirrored" });
    const { fs } = await spawned("Mirror me");
    const argv = fs.spawn.argv;
    expect(argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 4)).toEqual(["--permission-mode", "acceptEdits", "--effort", "high"]);
    expect(argv).not.toContain("--resume");
  }, 15_000);

  test("what the user set wins; the brain's model replaces the launch's, and one --settings carries the launch's own", async () => {
    const own = join(cwd, "my-settings.json");
    writeFileSync(own, JSON.stringify({ permissions: { defaultMode: "auto" }, env: { A: "1" } }));
    mini.profiles.update(profileId("fake"), { launch: { mode: "bypassPermissions", args: ["--settings", own, "--model", "opus", "--add-dir", cwd] } });
    const { fs } = await spawned("Launch me", { model: { model: "anthropic/claude-sonnet-5" } });
    const argv = fs.spawn.argv;
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv.filter((a) => a === "--settings")).toHaveLength(1);
    expect(argv.filter((a) => a === "--model")).toHaveLength(1);
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(argv.slice(argv.indexOf("--add-dir"), argv.indexOf("--add-dir") + 2)).toEqual(["--add-dir", cwd]);
    const merged = JSON.parse(readFileSync(argv[argv.indexOf("--settings") + 1]!, "utf8"));
    expect(merged).toEqual({ permissions: { defaultMode: "auto" }, env: { A: "1" }, showClearContextOnPlanAccept: true });
    mini.profiles.update(profileId("fake"), { launch: null });
  });

  test("under Claude's own directory the variable is left unset, and an inherited one taken out", async () => {
    const { fs } = await spawned("Own dir", { profile: profileId("own") });
    expect(fs.spawn.env.base).toBe("empty");
    expect(fs.spawn.env.set?.["CLAUDE_CONFIG_DIR"]).toBeUndefined();
    expect(fs.spawn.env.set?.["PATH"]).toBe("x");
  });

  test("[tether].window_on_start opens a window on it at once", async () => {
    runs.length = 0;
    tetherConfig.window_on_start = true;
    try {
      const { fs } = await spawned("With a window");
      expect(runs.some((a) => a[0] === "open" && a[1] === fs.id && a.includes("--terminal") && a.includes("auto"))).toBe(true);
    } finally {
      tetherConfig.window_on_start = false;
    }
  });
});
