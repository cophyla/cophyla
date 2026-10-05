// The chat's own session in tether, against a fake host speaking the real protocol and a
// registry the test writes as the CLI would: `spawnAssistant` starts the CLI itself in a
// terminal labelled as the chat's, with the command line it was given, under an id decided
// here, in the profile's environment, and the record is the chat's from the moment it is met.
// Nothing is typed at its start. A message sent to it is typed as the user's, and its prompt
// hook reaches the assistant module with the ref the send answered, also when the harness
// hands a prompt of several lines back as pasted; words typed there by hand carry none. A
// message sent while its turn runs is typed into that turn, and no key is pressed to cut it
// short. It is stopped through its own partition alone, and its terminal ends with it; a
// resume goes on under the id it had. The folder trust dialog of its own
// folder is answered by moving onto the row that trusts and pressing Enter only once the
// pointer is seen there; a CLI that never registers fails the start saying what it waits on.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RpcError } from "@cophyla/protocol";
import type { ClaudeHookEvent, HarnessProfile, Session } from "@cophyla/protocol";
import { TetherClient } from "@tether-pty/client";
import { silentLogger } from "../src/log.ts";
import { ClaudeAdapter } from "../src/sessions/claude/adapter.ts";
import { ASSISTANT_PART } from "../src/sessions/index.ts";
import type { NormalisedHook } from "../src/sessions/model.ts";
import { Tether } from "../src/sessions/tether/index.ts";
import { ASSISTANT_LABEL } from "../src/sessions/tether/streams.ts";
import { FakeTether } from "./fakes/tether.ts";
import type { FakeSession } from "./fakes/tether.ts";
import { clearRegistry, miniSessions, removeHome, tempHome, tomlString, waitFor, writeRegistry } from "./helpers.ts";
import type { Mini } from "./helpers.ts";

const RULE = "─".repeat(40);
const EMPTY: (string | [string, "dim"])[] = ["", RULE, ['❯ Try "fix the flaky test"', "dim"], RULE, "  ⏵⏵ accept edits on"];
/** The folder trust dialog as 2.1.289 draws it, and after the pointer was moved down a row. */
const TRUST = [" Accessing workspace:", " ❯ No, exit", "   Yes, I trust this folder", " Enter to confirm · Esc to cancel"];
const TRUSTING = [" Accessing workspace:", "   No, exit", " ❯ Yes, I trust this folder", " Enter to confirm · Esc to cancel"];
const ARGS = ["--name", "Cophyla", "--model", "sonnet", "--strict-mcp-config", "--permission-mode", "dontAsk"];

let scratch: string;
let fake: FakeTether;
let tether: Tether;
let mini: Mini;
let registry: string;
let profileDir: string;
let cwd: string;
let profile: HarnessProfile;
const alive = new Set<number>();
/** What the CLI does as it starts: registers at once, or shows a screen first. */
let starting: "registers" | "trust" | "login" = "registers";
/** Every session's row and event the bus carried. */
const heard: string[] = [];
/** What the assistant module was handed. */
const hooks: { hook: NormalisedHook; info: { ref?: string } }[] = [];
const changed: Session[] = [];

/** The id a CLI was started under, from its command line. */
function idOf(fs: FakeSession): string | undefined {
  const argv = fs.spawn.argv;
  const at = Math.max(argv.indexOf("--session-id"), argv.indexOf("--resume"));
  return at >= 0 ? argv[at + 1] : undefined;
}

/** The CLI registers, as Claude writes its registry entry once it runs. */
function register(fs: FakeSession): void {
  fs.setScreen(EMPTY);
  alive.add(fs.pid);
  writeRegistry(registry, { pid: fs.pid, sessionId: idOf(fs)!, cwd: fs.spawn.cwd, status: "idle" });
}

/** The CLI went with its terminal: its process is gone, and its registry entry with it. */
function gone(fs: FakeSession): void {
  alive.delete(fs.pid);
  clearRegistry(registry, fs.pid);
}

const terminalOf = (s: Session): FakeSession => fake.sessions.get(s.native.terminal!.id)!;
const hook = (s: Session, event: ClaudeHookEvent["hook_event_name"], extra: Record<string, unknown> = {}): ClaudeHookEvent =>
  ({ session_id: s.native.id, cwd, hook_event_name: event, permission_mode: "default", ...extra }) as ClaudeHookEvent;

beforeAll(async () => {
  scratch = tempHome();
  profileDir = join(scratch, "claude-profile");
  registry = join(profileDir, "sessions");
  cwd = join(scratch, "data", "assistant", "work");
  for (const dir of [registry, cwd]) mkdirSync(dir, { recursive: true });
  fake = await new FakeTether(join(scratch, "tether")).start();
  fake.onSpawn = (fs) => {
    if (idOf(fs) === undefined) return;
    if (starting === "registers") return register(fs);
    if (starting === "login") return fs.setScreen(["Select login method:", "❯ 1. Claude account with subscription", "  2. Anthropic Console account"]);
    // The dialog holds the screen until it is answered: the pointer moves with the arrows, and Enter on the trusting row lets the CLI start.
    fs.setScreen(TRUST);
    fs.onKeys = (keys) => {
      for (const key of keys) {
        const on = fs.lines()[2]!.includes("❯");
        if (key === "Down") fs.setScreen(TRUSTING);
        else if (key === "Up") fs.setScreen(TRUST);
        else if (key === "Enter" && on) register(fs);
      }
    };
  };
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
  mini = await miniSessions(
    `[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 100000\nreceipt_timeout_ms = 30000\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(profileDir)}\n`,
    (host, log) => [new ClaudeAdapter({ host, log, isAlive: (pid) => alive.has(pid), inject: async () => undefined, sharedSettings: join(profileDir, "no-such-shared-settings.json") })],
    { deps: { tether, env: { PATH: "x", CLAUDE_CONFIG_DIR: "C:/inherited" }, kill: () => undefined, isAlive: (pid) => alive.has(pid), home: scratch } },
  );
  profile = mini.profiles.defaultFor("claude")!;
  mini.bus.onAll("session.state", (s) => heard.push(s.id));
  mini.bus.onAll("session.event", (e) => heard.push(e.session));
  mini.sessions.setAssistant({
    hook: (h, info) => {
      hooks.push({ hook: h, info });
      return {};
    },
    changed: (s) => changed.push(s),
  });
}, 30_000);

afterAll(async () => {
  await mini.stop();
  await tether.stop();
  await fake.stop();
  removeHome(scratch);
});

describe("the chat's own session started in tether", () => {
  let own: Session;
  let fs: FakeSession;

  test("it is the CLI itself in a terminal labelled as the chat's, with the command line it was given, in the profile's environment", async () => {
    own = await mini.sessions.spawnAssistant({ profile, cwd, args: ARGS, env: { MCP_TOOL_TIMEOUT: "300000" }, timeoutMs: 5000 });
    fs = terminalOf(own);
    expect(fs.spawn.labels).toEqual({ app: "cophylad", [ASSISTANT_LABEL]: "1", "cophylad.session": own.native.id });
    // the id is decided here and handed to the CLI, before the command line the module built
    expect(own.native.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(fs.spawn.argv.slice(1)).toEqual(["--session-id", own.native.id, ...ARGS]);
    expect(fs.spawn.cwd).toBe(cwd);
    expect(fs.spawn.env.base).toBe("empty");
    expect(fs.spawn.env.set).toMatchObject({ PATH: "x", CLAUDE_CONFIG_DIR: profileDir, MCP_TOOL_TIMEOUT: "300000" });
    // nothing is typed at its start: the module does that
    expect(fs.typed).toEqual([]);
  });

  test("the record is the chat's from the moment it is met: no list holds it, and nothing of it was told", () => {
    expect(own).toMatchObject({ role: "assistant", origin: "orchestrator", harness: "claude", profile: profile.id, status: "idle", cwd, native: { transport: "pipe", pid: fs.pid, terminal: { host: fake.host.host, id: fs.id } } });
    expect(own.workspace).toBeUndefined();
    expect(mini.workspaces.list()).toEqual([]);
    expect(mini.sessions.list()).toEqual([]);
    expect(mini.sessions.get(own.id)).toBeUndefined();
    expect(mini.sessions.assistantSession()?.id).toBe(own.id);
    expect(mini.store.sessions.get(own.id)?.role).toBe("assistant");
    expect(mini.store.sessionEvents.count(own.id)).toBe(0);
    expect(heard).toEqual([]);
    // the terminal's session is known to what follows a terminal wherever it is
    expect(mini.sessions.sessionOfTerminal({ host: fake.host.host, id: fs.id })?.id).toBe(own.id);
  });

  test("a message sent to it is typed as the user's, and its prompt hook reaches the module with the ref the send answered", async () => {
    const r = await mini.sessions.send(own.id, "what is open?", { from: "user" }, ASSISTANT_PART);
    expect(r).toEqual({ status: "queued", ref: expect.stringMatching(/^cophylad-/) });
    await waitFor(() => fs.typed.includes("keys:Enter"), 5000);
    expect(fs.typed).toEqual(["paste:what is open?", "keys:Enter"]);
    await mini.sessions.onHook("claude", hook(own, "UserPromptSubmit", { prompt: "what is open?", prompt_id: "p1" }), { via: "http" });
    expect(hooks.at(-1)).toMatchObject({ hook: { harness: "claude", name: "UserPromptSubmit", sessionId: own.native.id, prompt: "what is open?", promptId: "p1" }, info: { ref: r.ref } });
    await mini.sessions.onHook("claude", hook(own, "Stop", { last_assistant_message: "Two sessions are open." }), { via: "http" });
    await waitFor(() => hooks.at(-1)?.hook.name === "Stop");
    expect(hooks.at(-1)!.hook.lastAssistantMessage).toBe("Two sessions are open.");
  }, 20_000);

  test("a message of several lines is pasted, and is known by its prompt though the harness hands that back inside its tags", async () => {
    fs.typed.length = 0;
    const body = "the log says:\n  error: no such file";
    const r = await mini.sessions.send(own.id, body, { from: "user" }, ASSISTANT_PART);
    await waitFor(() => fs.typed.includes("keys:Enter"), 5000);
    expect(fs.typed).toEqual([`paste:${body}`, "keys:Enter"]);
    const wrapped = `\n\n<pasted_content id="d39b">\n${body}\n</pasted_content id="d39b">\n`;
    await mini.sessions.onHook("claude", hook(own, "UserPromptSubmit", { prompt: wrapped, prompt_id: "p2" }), { via: "http" });
    expect(hooks.at(-1)).toMatchObject({ hook: { name: "UserPromptSubmit", prompt: wrapped }, info: { ref: r.ref } });
    // the same words pasted there again by hand are the user's own: no send of cophylad's stands for them
    await mini.sessions.onHook("claude", hook(own, "UserPromptSubmit", { prompt: wrapped, prompt_id: "p3" }), { via: "http" });
    expect(hooks.at(-1)!.info).toEqual({});
  }, 20_000);

  test("words typed there by hand reach the module with no ref, and none of it is stored or told", async () => {
    await mini.sessions.onHook("claude", hook(own, "UserPromptSubmit", { prompt: "typed by hand", prompt_id: "p4" }), { via: "http" });
    expect(hooks.at(-1)).toMatchObject({ hook: { prompt: "typed by hand" }, info: {} });
    await mini.sessions.onHook("claude", hook(own, "Stop", { last_assistant_message: "Yes." }), { via: "http" });
    expect(mini.store.sessionEvents.count(own.id)).toBe(0);
    expect(heard).toEqual([]);
    await waitFor(() => changed.some((s) => s.id === own.id));
  });

  test("a message sent while its turn runs is typed into that turn: pasted and entered, with no key pressed to cut it short", async () => {
    fs.typed.length = 0;
    await mini.sessions.onHook("claude", hook(own, "UserPromptSubmit", { prompt: "a long piece of work", prompt_id: "p5" }), { via: "http" });
    expect(mini.sessions.get(own.id, ASSISTANT_PART)?.status).toBe("busy");
    const r = await mini.sessions.send(own.id, "and one more thing", { from: "user" }, ASSISTANT_PART);
    await waitFor(() => fs.typed.includes("keys:Enter"), 5000);
    expect(fs.typed).toEqual(["paste:and one more thing", "keys:Enter"]);
    await mini.sessions.onHook("claude", hook(own, "UserPromptSubmit", { prompt: "and one more thing", prompt_id: "p6" }), { via: "http" });
    expect(hooks.at(-1)!.info).toEqual({ ref: r.ref });
    await mini.sessions.onHook("claude", hook(own, "Stop", { last_assistant_message: "Both done." }), { via: "http" });
    await waitFor(() => hooks.at(-1)?.hook.name === "Stop");
    expect(fs.typed).toEqual(["paste:and one more thing", "keys:Enter"]);
  }, 20_000);

  test("it is stopped through its own partition alone, and its terminal ends with it", async () => {
    const refused = await mini.sessions.stopSession(own.id, { as: "user" }).then(
      () => "ok",
      (e: unknown) => (e instanceof RpcError ? `${e.code}: ${e.message}` : String(e)),
    );
    expect(refused).toBe(`not_found: no session ${own.id}`);
    expect(fake.requests.some((q) => q.op === "kill" && q.body["session"] === fs.id)).toBe(false);
    await mini.sessions.stopSession(own.id, { as: "brain" }, ASSISTANT_PART);
    gone(fs);
    expect(fake.requests.some((q) => q.op === "kill" && q.body["session"] === fs.id)).toBe(true);
    expect(mini.sessions.get(own.id, ASSISTANT_PART)?.status).toBe("ended");
    expect(mini.sessions.assistantSession()).toBeUndefined();
    // the module hears its end, to start it again; no client does
    await waitFor(() => changed.some((s) => s.id === own.id && s.status === "ended"));
    expect(heard).toEqual([]);
  });

  test("a resume goes on under the id the conversation had", async () => {
    const again = await mini.sessions.spawnAssistant({ profile, cwd, args: ARGS, resume: own.native.id, timeoutMs: 5000 });
    const term = terminalOf(again);
    expect(term.id).not.toBe(fs.id);
    expect(term.spawn.argv.slice(1)).toEqual(["--resume", own.native.id, ...ARGS]);
    expect(again.native.id).toBe(own.native.id);
    expect(again).toMatchObject({ role: "assistant", status: "idle", native: { terminal: { host: fake.host.host, id: term.id } } });
    // the conversation's record is the one it was: met again, not a second
    expect(again.id).toBe(own.id);
    expect(mini.sessions.list()).toEqual([]);
    expect(heard).toEqual([]);
    await mini.sessions.stopSession(again.id, { as: "brain" }, ASSISTANT_PART);
    gone(term);
  }, 20_000);
});

describe("a start that meets a dialog", () => {
  test("the trust dialog of its own folder is answered: the pointer is moved onto the row that trusts, and Enter pressed only once it is seen there", async () => {
    starting = "trust";
    const own = await mini.sessions.spawnAssistant({ profile, cwd, args: ARGS, timeoutMs: 10_000 });
    const fs = terminalOf(own);
    expect(fs.typed).toEqual(["keys:Down", "keys:Enter"]);
    expect(own.role).toBe("assistant");
    await mini.sessions.stopSession(own.id, { as: "brain" }, ASSISTANT_PART);
    gone(fs);
  }, 20_000);

  test("any other question is left as it is: the start fails saying what the CLI waits on, and its terminal is ended", async () => {
    starting = "login";
    const before = new Set(fake.sessions.keys());
    const failed = await mini.sessions.spawnAssistant({ profile, cwd, args: ARGS, timeoutMs: 1500 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failed).toBeInstanceOf(RpcError);
    expect((failed as RpcError).code).toBe("unavailable");
    expect((failed as RpcError).message).toBe("the chat's session did not start within 2s: it is waiting on signing in");
    const fs = [...fake.sessions.values()].find((s) => !before.has(s.id))!;
    // nothing was pressed in it
    expect(fs.typed).toEqual([]);
    expect(fake.requests.some((q) => q.op === "kill" && q.body["session"] === fs.id)).toBe(true);
    expect(mini.sessions.assistantSession()).toBeUndefined();
    starting = "registers";
  }, 20_000);

  test("with no tether on the node it cannot run, and says so", async () => {
    const bare = await miniSessions(`[sessions]\ndiscover = false\ninstall_hooks = false\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(profileDir)}\n`, (host, log) => [new ClaudeAdapter({ host, log, isAlive: () => false, inject: async () => undefined })]);
    try {
      await expect(bare.sessions.spawnAssistant({ profile: bare.profiles.defaultFor("claude")!, cwd, args: ARGS })).rejects.toMatchObject({ code: "unavailable", message: "tether is not on this node, and the chat's session runs in a terminal" });
      expect(bare.sessions.assistantSession()).toBeUndefined();
    } finally {
      await bare.stop();
    }
  });
});
