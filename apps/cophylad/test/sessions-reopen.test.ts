// Closed sessions, taken up again: the sessions that ended lately are listed the last first,
// with why each ended and whether that was an interruption (its process gone) rather than the
// user closing it; one with no conversation saved, one running again and one that ran
// headless are not. A reopen starts the harness resuming the conversation (`claude --resume`)
// in a tether terminal in the session's folder, under its profile and with cophylad's settings
// file, and the same record comes back with its id, origin and workspace, holding the new
// terminal. One still running, one with nothing saved, one whose folder is gone and an
// unknown one are refused, and so is a second reopen while the first runs. A reopen under
// another profile copies the conversation and its sub-agents' folder into that profile's
// `projects/`, or copies nothing where the two share it by a link, and the session comes back
// under that profile, reading on from the copy with nothing recorded twice; a profile that is
// not there, one of another harness, and a Codex session moved are refused. The brain ends a
// session of the user's on the machine's own once the gate let it. The store's list leaves
// out the chat's own session and the ends that were none of a conversation.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Session } from "@cophyla/protocol";
import { TetherClient } from "@tether-pty/client";
import { silentLogger } from "../src/log.ts";
import { ClaudeAdapter } from "../src/sessions/claude/adapter.ts";
import { transcriptPathFor } from "../src/sessions/claude/registry.ts";
import { Tether } from "../src/sessions/tether/index.ts";
import type { Run } from "../src/sessions/tether/index.ts";
import { Store } from "../src/store/index.ts";
import { FakeTether } from "./fakes/tether.ts";
import type { FakeSession } from "./fakes/tether.ts";
import { miniSessions, tempHome, tomlString, waitFor, writeRegistry } from "./helpers.ts";
import type { Mini } from "./helpers.ts";

const RULE = "─".repeat(40);
const EMPTY: (string | [string, "dim"])[] = ["", RULE, ['❯ Try "fix the flaky test"', "dim"], RULE, "  ⏵⏵ accept edits on"];

let fake: FakeTether;
let tether: Tether;
let mini: Mini;
let registry: string;
let profileDir: string;
let otherDir: string;
let sharedDir: string;
let cwd: string;
let workspace: string;
const alive = new Set<number>();
let nextPid = 9100;

const run: Run = async (_exe, all) => {
  const args = all[0] === "--dir" ? all.slice(2) : all;
  if (args[0] === "--version") return { code: 0, out: "tether 0.1.0\n", err: "" };
  return { code: 0, out: "", err: "" };
};

/** The conversation a Claude command line names, by `--session-id` or `--resume`. */
function conversationOf(fs: FakeSession): string | undefined {
  const argv = fs.spawn.argv;
  for (const flag of ["--session-id", "--resume"]) {
    const i = argv.indexOf(flag);
    if (i >= 0) return argv[i + 1];
  }
  return undefined;
}

/** A conversation saved where Claude saves it, as it is from its first prompt: given in `mode`, as Claude writes it, when one is named. */
function saveTranscript(sessionId: string, mode?: string): void {
  const path = transcriptPathFor(profileDir, cwd, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ type: "user", sessionId, message: { role: "user", content: "hello" }, ...(mode ? { permissionMode: mode } : {}) }) + "\n");
}

/** A session of the user's own, running in a tether terminal: met, with its conversation saved when asked. */
async function usersOwn(sessionId: string, opts: { saved?: boolean; mode?: string } = {}): Promise<{ session: Session; pid: number; fs: FakeSession }> {
  const pid = nextPid++;
  const fs = fake.add({ argv: ["claude"], cwd }, pid);
  alive.add(pid);
  if (opts.saved !== false) saveTranscript(sessionId, opts.mode);
  writeRegistry(registry, { pid, sessionId, cwd, status: "idle" });
  await waitFor(() => tether.byPid(pid));
  await mini.sessions.tick();
  const rec = await waitFor(() => mini.sessions.find("claude", sessionId));
  return { session: { ...rec.session }, pid, fs };
}

/** Its process goes, as when the machine or its window goes under it: no hook, the registry entry left behind. */
async function interrupt(pid: number, fs: FakeSession): Promise<void> {
  alive.delete(pid);
  fs.exit(1);
  await mini.sessions.tick();
}

beforeAll(async () => {
  const scratch = tempHome();
  profileDir = join(scratch, "claude-profile");
  registry = join(profileDir, "sessions");
  cwd = join(scratch, "work");
  mkdirSync(registry, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  // Another account with its own conversations, and one that shares the first's by a link.
  otherDir = join(scratch, "claude-other");
  sharedDir = join(scratch, "claude-shared");
  mkdirSync(join(otherDir, "sessions"), { recursive: true });
  mkdirSync(join(sharedDir, "sessions"), { recursive: true });
  mkdirSync(join(profileDir, "projects"), { recursive: true });
  symlinkSync(join(profileDir, "projects"), join(sharedDir, "projects"), "junction");
  const codexA = join(scratch, "codex-a");
  const codexB = join(scratch, "codex-b");
  for (const dir of [codexA, codexB]) mkdirSync(dir, { recursive: true });
  fake = await new FakeTether(join(scratch, "tether")).start();
  // Claude writes its registry entry once it runs, a resumed conversation under its own id, in its profile's directory.
  fake.onSpawn = (s) => {
    s.setScreen(EMPTY);
    const id = conversationOf(s);
    if (!id) return;
    alive.add(s.pid);
    writeRegistry(join(s.spawn.env.set?.["CLAUDE_CONFIG_DIR"] ?? profileDir, "sessions"), { pid: s.pid, sessionId: id, cwd, status: "idle" });
  };
  tether = new Tether({
    config: { idle_exit_s: 600, window: "auto", window_on_start: false, profiles: false, on_path: false, dir: fake.dir },
    env: {},
    dataDir: join(scratch, "data"),
    nodeId: "node_test",
    log: silentLogger,
    exe: "C:/fake/tether.exe",
    run,
    connectOrStart: (opts) => TetherClient.connect(fake.host, { name: opts.name ?? "cophylad" }),
  });
  await tether.start();
  const PROFILES: [string, string, string][] = [
    ["claude", "fake", profileDir],
    ["claude", "other", otherDir],
    ["claude", "shared", sharedDir],
    ["codex", "codex-a", codexA],
    ["codex", "codex-b", codexB],
  ];
  mini = await miniSessions(
    `[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 100000\n\n${PROFILES.map(([harness, name, dir]) => `[[profiles]]\nharness = "${harness}"\nname = "${name}"\nconfig_dir = ${tomlString(dir)}\n`).join("\n")}\n[acp]\nspawn_timeout_ms = 5000\n`,
    (host, log) => [new ClaudeAdapter({ host, log, isAlive: (pid) => alive.has(pid), inject: async () => undefined, sharedSettings: join(profileDir, "no-such-shared-settings.json") })],
    {
      acp: (config) => ({ config: config.acp, env: {} }),
      deps: { tether, env: { PATH: "x" }, isAlive: (pid) => alive.has(pid), kill: () => undefined, home: scratch },
    },
  );
  workspace = mini.workspaces.fromSession(cwd).id;
}, 30_000);

afterAll(async () => {
  await mini.stop();
  await tether.stop();
  await fake.stop();
});

describe("closed sessions", () => {
  let crashed: { session: Session; pid: number; fs: FakeSession };

  test("one whose process went is listed as interrupted, with when it ended", async () => {
    crashed = await usersOwn("conv-crashed");
    expect(crashed.session.transcript).toBeDefined();
    await interrupt(crashed.pid, crashed.fs);
    expect(mini.sessions.get(crashed.session.id)?.status).toBe("ended");
    const row = mini.sessions.closed().find((c) => c.session.id === crashed.session.id)!;
    expect(row).toMatchObject({ reason: "gone", interrupted: true, session: { status: "ended", cwd, workspace } });
    expect(row.session.endedAt).toBeGreaterThan(0);
  });

  test("one the user stopped is listed as closed by them, and the last to end comes first", async () => {
    const stopped = await usersOwn("conv-stopped");
    await mini.sessions.stopSession(stopped.session.id, { as: "user" });
    const closed = mini.sessions.closed();
    expect(closed[0]).toMatchObject({ session: { id: stopped.session.id }, reason: "stopped", interrupted: false });
    expect(closed.map((c) => c.session.id)).toContain(crashed.session.id);
  });

  test("one with no conversation saved, and a live one, are not listed; since and limit cut the list", async () => {
    const unsaved = await usersOwn("conv-unsaved", { saved: false });
    const running = await usersOwn("conv-running");
    await interrupt(unsaved.pid, unsaved.fs);
    const ids = mini.sessions.closed().map((c) => c.session.id);
    expect(ids).not.toContain(unsaved.session.id);
    expect(ids).not.toContain(running.session.id);
    expect(mini.sessions.closed({ limit: 1 })).toHaveLength(1);
    expect(mini.sessions.closed({ since: Date.now() + 60_000 })).toEqual([]);
    await expect(mini.sessions.reopen(unsaved.session.id, { profiles: mini.profiles })).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("saved no conversation") });
    await expect(mini.sessions.reopen(running.session.id, { profiles: mini.profiles })).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("still running") });
  });

  test("a reopen resumes the conversation in a tether terminal in its folder, and the same session comes back holding it", async () => {
    const back = await mini.sessions.reopen(crashed.session.id, { profiles: mini.profiles });
    const fs = [...fake.sessions.values()].find((x) => x.spawn.labels["cophylad.reopen"] === crashed.session.id)!;
    expect(fs).toBeDefined();
    const argv = fs.spawn.argv;
    expect(argv[argv.indexOf("--resume") + 1]).toBe("conv-crashed");
    expect(argv).not.toContain("--session-id");
    expect(argv).not.toContain("--name");
    // Nothing said what mode it was in, and its profile's launch names none.
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("--permission-mode");
    expect(argv[argv.indexOf("--settings") + 1]).toBe(join(mini.home, "data", "claude", `settings-${crashed.session.profile}.json`));
    expect(fs.spawn.cwd).toBe(cwd);
    expect(fs.spawn.env.set?.["CLAUDE_CONFIG_DIR"]).toBe(profileDir);
    expect(back).toMatchObject({ id: crashed.session.id, status: "idle", origin: "user", workspace, native: { id: "conv-crashed", pid: fs.pid, terminal: { host: fake.host.host, id: fs.id } } });
    expect(back.endedAt).toBeUndefined();
    const resumed = mini.store.sessionEvents.history(back.id, { limit: 100 }).findLast((e) => e.kind === "status");
    expect(resumed?.payload).toMatchObject({ resumed: true });
    expect(mini.sessions.closed().map((c) => c.session.id)).not.toContain(back.id);
    await expect(mini.sessions.reopen(back.id, { profiles: mini.profiles })).rejects.toMatchObject({ code: "conflict" });
  });

  test("an unknown session, a folder gone, and a second reopen at once are refused", async () => {
    await expect(mini.sessions.reopen("sess_01ARZ3NDEKTSV4RRFFQ69G5FZZ", { profiles: mini.profiles })).rejects.toMatchObject({ code: "not_found" });
    const twice = await usersOwn("conv-twice");
    await interrupt(twice.pid, twice.fs);
    const first = mini.sessions.reopen(twice.session.id, { profiles: mini.profiles });
    await expect(mini.sessions.reopen(twice.session.id, { profiles: mini.profiles })).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("being reopened") });
    await first;
    const elsewhere = join(cwd, "gone");
    mkdirSync(elsewhere);
    const pid = nextPid++;
    const fs = fake.add({ argv: ["claude"], cwd: elsewhere }, pid);
    alive.add(pid);
    const path = transcriptPathFor(profileDir, elsewhere, "conv-gone");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{}\n");
    writeRegistry(registry, { pid, sessionId: "conv-gone", cwd: elsewhere, status: "idle" });
    await mini.sessions.tick();
    const gone = await waitFor(() => mini.sessions.find("claude", "conv-gone"));
    await interrupt(pid, fs);
    rmSync(elsewhere, { recursive: true, force: true });
    await expect(mini.sessions.reopen(gone.session.id, { profiles: mini.profiles })).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("is gone") });
  });
});

const profileNamed = (name: string) => mini.profiles.list().find((p) => p.name === name)!;

/** The user turns recorded on a session's timeline. */
const turns = (id: string) => mini.store.sessionEvents.history(id, { limit: 200 }).filter((e) => e.kind === "user_turn").length;

/** A line the resumed conversation adds, as Claude appends it. */
function goOn(path: string, sessionId: string): void {
  appendFileSync(path, JSON.stringify({ type: "user", sessionId, message: { role: "user", content: "go on" } }) + "\n");
}

describe("reopened under another profile", () => {
  test("its conversation and its sub-agents' folder are copied to that profile's projects, and it comes back under it with nothing recorded twice", async () => {
    const s = await usersOwn("conv-moved");
    const original = s.session.transcript!.path;
    const sub = join(dirname(original), "conv-moved", "subagents", "agent-a1.jsonl");
    mkdirSync(dirname(sub), { recursive: true });
    writeFileSync(sub, JSON.stringify({ type: "user", isSidechain: true, message: { role: "user", content: "look" } }) + "\n");
    await mini.sessions.tick();
    expect(turns(s.session.id)).toBe(1);
    await interrupt(s.pid, s.fs);
    const other = profileNamed("other");
    const back = await mini.sessions.reopen(s.session.id, { profiles: mini.profiles, profile: other.id });
    const copy = transcriptPathFor(otherDir, cwd, "conv-moved");
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(original, "utf8"));
    expect(readFileSync(join(dirname(copy), "conv-moved", "subagents", "agent-a1.jsonl"), "utf8")).toBe(readFileSync(sub, "utf8"));
    const fs = [...fake.sessions.values()].find((x) => x.spawn.labels["cophylad.reopen"] === s.session.id)!;
    expect(fs.spawn.argv[fs.spawn.argv.indexOf("--resume") + 1]).toBe("conv-moved");
    expect(fs.spawn.env.set?.["CLAUDE_CONFIG_DIR"]).toBe(otherDir);
    expect(fs.spawn.argv[fs.spawn.argv.indexOf("--settings") + 1]).toBe(join(mini.home, "data", "claude", `settings-${other.id}.json`));
    expect(back).toMatchObject({ id: s.session.id, profile: other.id, status: "idle", origin: "user", workspace, transcript: { path: copy } });
    // What it says next is read from the copy, after what was recorded from the first.
    goOn(copy, "conv-moved");
    await mini.sessions.tick();
    await waitFor(() => turns(s.session.id) === 2);
    await mini.sessions.tick();
    expect(turns(s.session.id)).toBe(2);
  });

  test("profiles that share their conversations by a link copy nothing, and it reads on where it was", async () => {
    const s = await usersOwn("conv-shared");
    const original = s.session.transcript!.path;
    const saved = readFileSync(original, "utf8");
    await mini.sessions.tick();
    expect(turns(s.session.id)).toBe(1);
    await interrupt(s.pid, s.fs);
    const shared = profileNamed("shared");
    const back = await mini.sessions.reopen(s.session.id, { profiles: mini.profiles, profile: shared.id });
    const through = transcriptPathFor(sharedDir, cwd, "conv-shared");
    expect(back).toMatchObject({ id: s.session.id, profile: shared.id, transcript: { path: through } });
    expect(realpathSync(through)).toBe(realpathSync(original));
    expect(readFileSync(original, "utf8")).toBe(saved);
    goOn(original, "conv-shared");
    await mini.sessions.tick();
    await waitFor(() => turns(s.session.id) === 2);
    await mini.sessions.tick();
    expect(turns(s.session.id)).toBe(2);
  });

  test("a profile not there, one of another harness, and a Codex session moved are refused, and nothing is copied", async () => {
    const s = await usersOwn("conv-refused");
    await interrupt(s.pid, s.fs);
    await expect(mini.sessions.reopen(s.session.id, { profiles: mini.profiles, profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FZZ" })).rejects.toMatchObject({ code: "not_found", message: expect.stringContaining("no profile") });
    await expect(mini.sessions.reopen(s.session.id, { profiles: mini.profiles, profile: profileNamed("codex-a").id })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("a codex profile") });
    expect(existsSync(transcriptPathFor(otherDir, cwd, "conv-refused"))).toBe(false);
    const thread = mini.sessions.ensure({ harness: "codex", nativeId: "thread-moved", profile: profileNamed("codex-a").id, cwd, transport: "app-server" });
    mini.sessions.end(thread, "gone");
    await expect(mini.sessions.reopen(thread.session.id, { profiles: mini.profiles, profile: profileNamed("codex-b").id })).rejects.toMatchObject({ code: "unsupported", message: expect.stringContaining("under the profile it ran under") });
  });
});

describe("reopened in the mode it was last in", () => {
  /** The command line a session was reopened with. */
  const reopenedArgv = (id: string) => [...fake.sessions.values()].findLast((x) => x.spawn.labels["cophylad.reopen"] === id)!.spawn.argv;

  test("one that bypassed permissions bypasses them again, though its profile's launch does not, and under another profile too", async () => {
    // Its transcript says so; its record never learned it, as after a restart.
    const s = await usersOwn("conv-bypass", { mode: "bypassPermissions" });
    expect(mini.sessions.get(s.session.id)?.mode).toBeUndefined();
    expect(mini.profiles.launch(s.session.profile)?.mode).toBeUndefined();
    await interrupt(s.pid, s.fs);
    await mini.sessions.reopen(s.session.id, { profiles: mini.profiles });
    const argv = reopenedArgv(s.session.id);
    expect(argv[argv.indexOf("--resume") + 1]).toBe("conv-bypass");
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("--permission-mode");
    const moved = await usersOwn("conv-bypass-moved", { mode: "bypassPermissions" });
    await interrupt(moved.pid, moved.fs);
    await mini.sessions.reopen(moved.session.id, { profiles: mini.profiles, profile: profileNamed("other").id });
    expect(reopenedArgv(moved.session.id)).toContain("--dangerously-skip-permissions");
  });

  test("its record's mode, when one was learned, over what its transcript last saved", async () => {
    const s = await usersOwn("conv-edits", { mode: "bypassPermissions" });
    mini.sessions.noteMode(mini.sessions.find("claude", "conv-edits")!, "acceptEdits");
    await interrupt(s.pid, s.fs);
    await mini.sessions.reopen(s.session.id, { profiles: mini.profiles });
    const argv = reopenedArgv(s.session.id);
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(argv).not.toContain("--dangerously-skip-permissions");
  });

  test("a mode named goes over the one it was last in, stricter or looser", async () => {
    const bypassed = await usersOwn("conv-named-plan", { mode: "bypassPermissions" });
    await interrupt(bypassed.pid, bypassed.fs);
    await mini.sessions.reopen(bypassed.session.id, { profiles: mini.profiles, mode: "plan" });
    const planned = reopenedArgv(bypassed.session.id);
    expect(planned[planned.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(planned).not.toContain("--dangerously-skip-permissions");
    const asked = await usersOwn("conv-named-bypass", { mode: "auto" });
    await interrupt(asked.pid, asked.fs);
    await mini.sessions.reopen(asked.session.id, { profiles: mini.profiles, mode: "bypassPermissions" });
    const bypassing = reopenedArgv(asked.session.id);
    expect(bypassing).toContain("--dangerously-skip-permissions");
    expect(bypassing).not.toContain("--permission-mode");
  });

  test("a Codex session named a mode it has not is refused before anything starts", async () => {
    const thread = mini.sessions.ensure({ harness: "codex", nativeId: "thread-named-plan", profile: profileNamed("codex-a").id, cwd, transport: "app-server" });
    mini.sessions.end(thread, "gone");
    const before = fake.sessions.size;
    await expect(mini.sessions.reopen(thread.session.id, { profiles: mini.profiles, mode: "plan" })).rejects.toMatchObject({ code: "unsupported", message: expect.stringContaining("default or bypassPermissions") });
    expect(fake.sessions.size).toBe(before);
  });
});

describe("stopped by the brain", () => {
  test("a session of the user's on the machine's own ends once the gate let it; a caller that says neither is refused", async () => {
    const s = await usersOwn("conv-brain-stop");
    await mini.sessions.stopSession(s.session.id, { as: "brain" });
    expect(mini.sessions.get(s.session.id)?.status).toBe("ended");
    expect(mini.sessions.closed().find((c) => c.session.id === s.session.id)).toMatchObject({ reason: "stopped", interrupted: false });
    const t = await usersOwn("conv-nobody-stop");
    await expect(mini.sessions.stopSession(t.session.id)).rejects.toMatchObject({ code: "unsupported" });
    expect(mini.sessions.get(t.session.id)?.status).not.toBe("ended");
  });
});

describe("the store's closed sessions", () => {
  test("leave out the chat's own and the ends that were none of a conversation", () => {
    const store = new Store(":memory:");
    store.migrate();
    const base = { node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV", harness: "claude" as const, profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8", origin: "user" as const, cwd: "C:/work", tags: [], status: "ended" as const, startedAt: 1000, lastActivity: 2000 };
    const end = (id: string, native: string, endedAt: number, reason: string, extra: Partial<Session> = {}) => {
      store.sessions.insert({ ...base, id, native: { id: native, transport: "pipe" }, endedAt, ...extra });
      store.sessionEvents.append({ session: id, at: endedAt, kind: "ended", payload: { reason } });
    };
    end("sess_01ARZ3NDEKTSV4RRFFQ69G5FC1", "a", 5000, "gone");
    end("sess_01ARZ3NDEKTSV4RRFFQ69G5FC2", "b", 6000, "spare");
    end("sess_01ARZ3NDEKTSV4RRFFQ69G5FC3", "c", 7000, "backgrounded");
    end("sess_01ARZ3NDEKTSV4RRFFQ69G5FC4", "d", 8000, "prompt_input_exit", { role: "assistant" });
    end("sess_01ARZ3NDEKTSV4RRFFQ69G5FC5", "e", 9000, "stopped");
    end("sess_01ARZ3NDEKTSV4RRFFQ69G5FC6", "f", 1000, "gone");
    expect(store.sessions.closed(2000, 10).map((r) => [r.session.id, r.reason])).toEqual([
      ["sess_01ARZ3NDEKTSV4RRFFQ69G5FC5", "stopped"],
      ["sess_01ARZ3NDEKTSV4RRFFQ69G5FC1", "gone"],
    ]);
    expect(store.sessions.closed(0, 1)).toHaveLength(1);
    store.close();
  });
});
