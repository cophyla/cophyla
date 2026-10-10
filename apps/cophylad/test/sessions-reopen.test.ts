// Closed sessions, taken up again: the sessions that ended lately are listed the last first,
// with why each ended and whether that was an interruption (its process gone) rather than the
// user closing it; one with no conversation saved, one running again and one that ran
// headless are not. A reopen starts the harness resuming the conversation (`claude --resume`)
// in a tether terminal in the session's folder, under its profile and with cophylad's settings
// file, and the same record comes back with its id, origin and workspace, holding the new
// terminal. One still running, one with nothing saved, one whose folder is gone and an
// unknown one are refused, and so is a second reopen while the first runs. The store's list
// leaves out the chat's own session and the ends that were none of a conversation.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

/** A conversation saved where Claude saves it, as it is from its first prompt. */
function saveTranscript(sessionId: string): void {
  const path = transcriptPathFor(profileDir, cwd, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ type: "user", sessionId, message: { role: "user", content: "hello" } }) + "\n");
}

/** A session of the user's own, running in a tether terminal: met, with its conversation saved when asked. */
async function usersOwn(sessionId: string, opts: { saved?: boolean } = {}): Promise<{ session: Session; pid: number; fs: FakeSession }> {
  const pid = nextPid++;
  const fs = fake.add({ argv: ["claude"], cwd }, pid);
  alive.add(pid);
  if (opts.saved !== false) saveTranscript(sessionId);
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
  fake = await new FakeTether(join(scratch, "tether")).start();
  // Claude writes its registry entry once it runs, a resumed conversation under its own id.
  fake.onSpawn = (s) => {
    s.setScreen(EMPTY);
    const id = conversationOf(s);
    if (!id) return;
    alive.add(s.pid);
    writeRegistry(registry, { pid: s.pid, sessionId: id, cwd, status: "idle" });
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
  mini = await miniSessions(
    `[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 100000\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(profileDir)}\n\n[acp]\nspawn_timeout_ms = 5000\n`,
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
