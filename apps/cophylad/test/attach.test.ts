// Milestone 1 over the socket, with no harness: a daemon whose config declares a Claude
// profile pointing at a fake `sessions/` directory. A client lists the session with its
// profile and workspace, hears the node run Claude once the profile is signed in, hook posts
// become asks the client answers, terminal answers close
// them, duplicates fold, sends are queued and confirmed, and a stopping daemon releases
// what it holds.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { join } from "node:path";
import type { Ask, AuditEntry, HarnessProfile, Session, SessionEvent, Workspace } from "@cophyla/protocol";
import { ClientSession as SessionSchema, ClientWorkspace as WorkspaceSchema } from "@cophyla/protocol";
import type { Daemon } from "../src/daemon.ts";
import { isMethod, removeHome, removeSocket, sleep, stopDaemon, tempHome, TestClient, testSocketPath, tomlString, waitFor } from "./helpers.ts";

const SESSION_ID = "3f0c1b2a-7a2e-4c1e-9f0e-1c2d3e4f5a6b";

function writeRegistry(dir: string, pid: number, pipe: string): void {
  mkdirSync(dir, { recursive: true });
  const procStart = "134341311020543343";
  writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: SESSION_ID, cwd: CWD, startedAt: Date.now() - 1000, procStart, version: "2.1.276", messagingSocketPath: pipe, name: "attach-test", nameSource: "auto", status: "idle" }));
  writeFileSync(join(dir, `${pid}.${"cd".repeat(32)}.key`), JSON.stringify({ peerToken: "peer-token", procStartFt: procStart }));
}

let CWD = "";

describe("attach: sessions over the socket", () => {
  let d: Daemon & { home: string };
  let c: TestClient;
  let profileDir: string;
  let pipeServer: Server;
  let pipe: string;
  let received = "";
  let hookUrl: string;
  let session: Session;
  let profile: HarnessProfile;

  const hookBase = (event: string, extra: Record<string, unknown> = {}) => ({
    session_id: SESSION_ID,
    transcript_path: join(profileDir, "projects", "x", `${SESSION_ID}.jsonl`),
    cwd: CWD,
    hook_event_name: event,
    permission_mode: "manual",
    ...extra,
  });
  const post = (body: unknown, opts: { token?: string; signal?: AbortSignal; via?: "http" | "command" } = {}) =>
    fetch(hookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.token ?? d.hookToken}`, ...(opts.via === "command" ? { "x-cophyla-pid": "1234", "x-cophyla-ppid": "1233" } : { "x-cophylad": "1" }) },
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  const permission = (input: unknown = { file_path: join(CWD, "x.txt"), content: "hello" }, promptId = "p-1") => hookBase("PermissionRequest", { prompt_id: promptId, tool_name: "Write", tool_input: input, permission_suggestions: [] });
  const question = (questions: unknown, promptId: string) => hookBase("PermissionRequest", { prompt_id: promptId, tool_name: "AskUserQuestion", tool_input: { questions }, permission_suggestions: [] });
  const exitPlan = (plan: string, promptId: string) => hookBase("PermissionRequest", { prompt_id: promptId, tool_name: "ExitPlanMode", tool_input: { plan }, permission_suggestions: [] });
  // `next` scans what arrived before, so an ask is taken once.
  const seenAsks = new Set<string>();
  const openAsk = async (pick: (a: Ask) => boolean) => {
    const n = await c.next(isMethod("ask.state", (p) => (p as Ask).status === "open" && (p as Ask).source.kind === "harness" && !seenAsks.has((p as Ask).id) && pick(p as Ask)));
    seenAsks.add((n.params as Ask).id);
    return n.params as Ask;
  };
  const decisionOf = async (r: Promise<Response>) => ((await (await r).json()) as { hookSpecificOutput: { decision: Record<string, unknown> } }).hookSpecificOutput.decision;
  const history = (): SessionEvent[] => d.store.sessionEvents.history(session.id, { limit: 500 });
  const askEvents = () => history().filter((e) => e.kind === "ask").map((e) => e.payload as { ask: string; phase: string; reason?: string });
  // The always-idle fake registry races the poll back to idle within a tick, so busy is checked on the event log, from a mark.
  const wentBusy = (from: number) => history().slice(from).some((e) => e.kind === "status" && (e.payload as { status: string }).status === "busy");

  beforeAll(async () => {
    const scratch = tempHome();
    profileDir = join(scratch, "claude-profile");
    CWD = join(scratch, "repo");
    mkdirSync(CWD, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: CWD });
    pipe = testSocketPath("attach");
    pipeServer = createServer((conn) => {
      conn.setEncoding("utf8");
      conn.on("data", (x: string) => (received += x));
    });
    await new Promise<void>((resolve) => pipeServer.listen(pipe, resolve));
    writeRegistry(join(profileDir, "sessions"), process.pid, pipe);

    const home = tempHome(
      `[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 200\nreceipt_timeout_ms = 60000\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(profileDir)}\n`,
    );
    const { startDaemon } = await import("../src/daemon.ts");
    const { silentLogger } = await import("../src/log.ts");
    d = Object.assign(await startDaemon({ home, port: 0, log: silentLogger, brain: false }), { home });
    hookUrl = `http://127.0.0.1:${d.api.port}/hooks/claude`;
    c = await TestClient.connect(d.api.url);
    await c.hello(d.token, { name: "attach" });
  });
  afterAll(async () => {
    c.close();
    await stopDaemon(d);
    pipeServer.close();
    removeSocket(pipe);
  });

  test("session.list shows the session under its profile, with a discovered workspace at the repository root", async () => {
    const { profiles } = await c.request<{ profiles: HarnessProfile[] }>("profile.list", {});
    expect(profiles).toHaveLength(1);
    profile = profiles[0]!;
    expect(profile.harness).toBe("claude");
    expect(profile.name).toBe("fake");
    expect(profile.origin).toBe("user");
    expect(profile.default).toBe(true);
    expect(profile.configDir.toLowerCase()).toBe(profileDir.toLowerCase());
    expect(profile.env["CLAUDE_CONFIG_DIR"]?.toLowerCase()).toBe(profileDir.toLowerCase());

    const { sessions } = await c.request<{ sessions: Session[] }>("session.list", {});
    expect(sessions).toHaveLength(1);
    session = sessions[0]!;
    expect(SessionSchema.safeParse(session).success).toBe(true);
    expect(session.profile).toBe(profile.id);
    expect(session.native).toEqual({ id: SESSION_ID, pid: process.pid, transport: "pipe" });
    expect(session.status).toBe("idle");
    expect(session.title).toBe("attach-test");

    const { workspaces } = await c.request<{ workspaces: Workspace[] }>("workspace.list", {});
    const ws = workspaces.find((w) => w.id === session.workspace)!;
    expect(ws).toBeDefined();
    expect(WorkspaceSchema.safeParse(ws).success).toBe(true);
    expect(ws.origin).toBe("discovered");
    expect(ws.path.toLowerCase()).toBe(CWD.toLowerCase());
    expect(ws.repo?.root.toLowerCase()).toBe(CWD.toLowerCase());
    expect(ws.name).toBe("repo");

    // A client that connects later is told about the live session and the workspace at once.
    const late = await TestClient.connect(d.api.url);
    await late.hello(d.token);
    await late.next(isMethod("session.state", (p) => (p as Session).id === session.id));
    await late.next(isMethod("workspace.state", (p) => (p as Workspace).id === ws.id));
    late.close();
  });

  test("the node lists no harness as ready while the fake profile has no credentials", async () => {
    const { nodes } = await c.request<{ nodes: { capabilities: { harnesses: string[] } }[] }>("node.list", {});
    expect(nodes[0]!.capabilities.harnesses).toEqual([]);
  });

  test("signing the profile in is noticed within seconds, with no profile.list: the node's row says it runs Claude now", async () => {
    // Claude's login for a directory it is named: its credentials, and its own global config past the first run.
    writeFileSync(join(profileDir, ".credentials.json"), "{}");
    writeFileSync(join(profileDir, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
    const n = await c.next(isMethod("node.state", (p) => (p as { capabilities: { harnesses: string[] } }).capabilities.harnesses.includes("claude")), 9000);
    expect((n.params as { capabilities: { harnesses: string[] } }).capabilities.harnesses).toEqual(["claude"]);
  }, 10_000);

  test("profile.update sets the usual account and a launch, which profile.list then shows; a launch cophylad cannot start is invalid; profile.limits answers", async () => {
    const node = d.identity.id;
    const { profile: set } = await c.request<{ profile: HarnessProfile }>("profile.update", { node, id: profile.id, patch: { usual: true, launch: { mode: "auto", args: ["--effort", "high"] } } });
    expect(set).toMatchObject({ id: profile.id, default: true, defaultBy: "you", launch: { mode: "auto", args: ["--effort", "high"], source: "you" } });
    const { profiles } = await c.request<{ profiles: HarnessProfile[] }>("profile.list", {});
    expect(profiles[0]!.launch).toEqual({ mode: "auto", args: ["--effort", "high"], source: "you" });
    const bad = await c.call("profile.update", { node, id: profile.id, patch: { launch: { args: ["--resume", "x"] } } });
    expect("error" in bad && (bad.error.data as { code: string }).code).toBe("invalid");
    const { profile: back } = await c.request<{ profile: HarnessProfile }>("profile.update", { node, id: profile.id, patch: { usual: null, launch: null } });
    expect(back.default).toBe(true);
    expect(back.defaultBy).not.toBe("you");
    expect(back.launch?.source).not.toBe("you");
    expect(await c.request<{ limits: object }>("profile.limits", {})).toEqual({ limits: {} });
    const actions = d.store.audit.list({ limit: 50 }).map((e) => e.action);
    expect(actions).toContain("profile.update");
  });

  test("workspace.put broadcasts workspace.state and lands in the audit", async () => {
    const path = join(d.home, "another");
    mkdirSync(path);
    const { id } = await c.request<{ id: string }>("workspace.put", { node: d.identity.id, path, name: "another" });
    const n = await c.next(isMethod("workspace.state", (p) => (p as Workspace).id === id));
    expect((n.params as Workspace).origin).toBe("user");
    expect((n.params as Workspace).name).toBe("another");
    const again = await c.request<{ id: string }>("workspace.put", { node: d.identity.id, path, name: "renamed" });
    expect(again.id).toBe(id);
    expect(d.workspaces.get(id)?.name).toBe("renamed");
    // A path that names nothing, or a file, is refused rather than stored.
    const ghost = await c.call("workspace.put", { node: d.identity.id, path: join(d.home, "nowhere"), name: "ghost" });
    expect("error" in ghost && ghost.error.data?.code).toBe("not_found");
    const file = await c.call("workspace.put", { node: d.identity.id, path: join(d.home, "config.toml"), name: "file" });
    expect("error" in file && file.error.data?.code).toBe("not_found");
  });

  test("a bad hook token is 401 with an empty body", async () => {
    const r = await post(hookBase("Stop"), { token: "wrong" });
    expect(r.status).toBe(401);
    expect(await r.text()).toBe("");
    const bad = await fetch(hookUrl, { method: "POST", headers: { authorization: `Bearer ${d.hookToken}` }, body: "{not json" });
    expect(bad.status).toBe(200);
    expect(await bad.json()).toEqual({});
  });

  test("a PermissionRequest becomes an open ask, the session needs permission, and ask.answer releases the allow", async () => {
    const inFlight = post(permission());
    const opened = await c.next(isMethod("ask.state", (p) => (p as Ask).status === "open" && (p as Ask).source.kind === "harness"));
    const ask = opened.params as Ask;
    expect(ask.type).toBe("permission");
    expect(ask.source).toEqual({ kind: "harness", session: session.id });
    expect(ask.title).toBe("Write in attach-test");
    expect(ask.detail).toContain("x.txt");
    expect(ask.answerableBy).toEqual(["user", "brain"]);
    expect(ask.expiresAt).toBeGreaterThan(Date.now() + 7000 * 1000);
    const state = await c.next(isMethod("session.state", (p) => (p as Session).id === session.id && (p as Session).status === "needs_permission"));
    expect((state.params as Session).ask).toBe(ask.id);
    expect(d.store.sessions.get(session.id)?.status).toBe("needs_permission");

    const race = await Promise.race([inFlight.then(() => "resolved"), sleep(150).then(() => "held")]);
    expect(race).toBe("held");

    const mark = history().length;
    await c.request("ask.answer", { id: ask.id, option: "allow" });
    const r = await inFlight;
    expect(await r.json()).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    await waitFor(() => wentBusy(mark));
    expect(askEvents()).toEqual([
      { ask: ask.id, phase: "opened", tool: "Write" } as never,
      { ask: ask.id, phase: "answered", answer: expect.objectContaining({ option: "allow" }) } as never,
    ]);
    expect(d.store.asks.get(ask.id)?.status).toBe("answered");
  });

  test("a deny answer carries the client's text as the message", async () => {
    const inFlight = post(permission({ file_path: "y.txt" }, "p-2"));
    const opened = await c.next(isMethod("ask.state", (p) => (p as Ask).status === "open" && (p as Ask).source.kind === "harness" && (p as Ask).detail!.includes("y.txt")));
    await c.request("ask.answer", { id: (opened.params as Ask).id, option: "deny", text: "not that file" });
    const r = await inFlight;
    expect(await r.json()).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "not that file" } } });
  });

  test("a PostToolUse for the same tool and input closes the ask as answered in the terminal, releasing {}", async () => {
    const input = { file_path: join(CWD, "z.txt"), content: "z" };
    const inFlight = post(permission(input, "p-3"));
    const opened = await c.next(isMethod("ask.state", (p) => (p as Ask).status === "open" && (p as Ask).source.kind === "harness" && (p as Ask).detail!.includes("z.txt")));
    const ask = opened.params as Ask;
    const other = await post(hookBase("PostToolUse", { tool_name: "Write", tool_input: { file_path: "elsewhere.txt", content: "no" }, tool_response: {} }));
    expect(await other.json()).toEqual({});
    expect(d.store.asks.get(ask.id)?.status).toBe("open");
    const same = await post(hookBase("PostToolUse", { tool_name: "Write", tool_input: { content: "z", file_path: join(CWD, "z.txt") }, tool_response: { success: true } }));
    expect(await same.json()).toEqual({});
    const r = await inFlight;
    expect(await r.json()).toEqual({});
    expect(d.store.asks.get(ask.id)?.status).toBe("cancelled");
    expect(askEvents().at(-1)).toEqual({ ask: ask.id, phase: "closed", reason: "terminal" });
    const closed = await c.next(isMethod("ask.state", (p) => (p as Ask).id === ask.id && (p as Ask).status === "cancelled"));
    expect(closed).toBeDefined();
    const results = history().filter((e) => e.kind === "tool_result");
    expect(results).toHaveLength(2);
  });

  test("a Stop closes an open ask as stopped and the session goes idle", async () => {
    const inFlight = post(permission({ file_path: "s.txt" }, "p-4"));
    const opened = await c.next(isMethod("ask.state", (p) => (p as Ask).status === "open" && (p as Ask).source.kind === "harness" && (p as Ask).detail!.includes("s.txt")));
    const ask = opened.params as Ask;
    await post(hookBase("Stop", { stop_hook_active: false }));
    expect(await (await inFlight).json()).toEqual({});
    expect(askEvents().at(-1)).toEqual({ ask: ask.id, phase: "closed", reason: "stopped" });
    expect(d.store.sessions.get(session.id)?.status).toBe("idle");
  });

  test("an aborted request closes the ask as aborted", async () => {
    const ac = new AbortController();
    const inFlight = post(permission({ file_path: "a.txt" }, "p-5"), { signal: ac.signal }).catch(() => "aborted");
    const opened = await c.next(isMethod("ask.state", (p) => (p as Ask).status === "open" && (p as Ask).source.kind === "harness" && (p as Ask).detail!.includes("a.txt")));
    const ask = opened.params as Ask;
    const mark = history().length;
    ac.abort();
    expect(await inFlight).toBe("aborted");
    await waitFor(() => d.store.asks.get(ask.id)?.status === "cancelled");
    expect(askEvents().at(-1)).toEqual({ ask: ask.id, phase: "closed", reason: "aborted" });
    await waitFor(() => wentBusy(mark));
  });

  test("a duplicate PermissionRequest within 2 s joins the open ask; one after settlement opens a new one", async () => {
    const input = { file_path: "dup.txt" };
    const first = post(permission(input, "p-6"));
    const opened = await c.next(isMethod("ask.state", (p) => (p as Ask).status === "open" && (p as Ask).source.kind === "harness" && (p as Ask).detail!.includes("dup.txt")));
    const ask = opened.params as Ask;
    const second = post(permission(input, "p-6"), { via: "command" });
    await sleep(100);
    expect(d.store.asks.listOpen().filter((a) => a.source.kind === "harness")).toHaveLength(1);
    await c.request("ask.answer", { id: ask.id, option: "allow" });
    const answers = await Promise.all([first, second].map(async (p) => (await p).json()));
    expect(answers[0]).toEqual(answers[1]);
    expect((answers[0] as { hookSpecificOutput: { decision: { behavior: string } } }).hookSpecificOutput.decision.behavior).toBe("allow");

    const third = post(permission(input, "p-6"));
    const reopened = await c.next(isMethod("ask.state", (p) => (p as Ask).status === "open" && (p as Ask).source.kind === "harness" && (p as Ask).id !== ask.id && (p as Ask).detail!.includes("dup.txt")));
    expect((reopened.params as Ask).id).not.toBe(ask.id);
    await c.request("ask.answer", { id: (reopened.params as Ask).id, option: "deny" });
    expect(((await (await third).json()) as { hookSpecificOutput: { decision: { behavior: string } } }).hookSpecificOutput.decision.behavior).toBe("deny");
  });

  const CACHE = { question: "Which cache?", header: "Cache", options: [{ label: "Redis", description: "In-memory, persistent" }, { label: "Memcached" }] };
  const TOOLS = { question: "Which tools?", header: "Tools", multiSelect: true, options: [{ label: "ESLint" }, { label: "Prettier" }] };

  test("an AskUserQuestion is a choice ask with the question's options; the answer is released in the tool's input", async () => {
    const inFlight = post(question([CACHE], "q-1"));
    const ask = await openAsk((a) => a.title === "Which cache?");
    expect(ask.type).toBe("choice");
    expect(ask.detail).toBe("Cache");
    expect(ask.options).toEqual([{ id: "Redis", label: "Redis", description: "In-memory, persistent" }, { id: "Memcached", label: "Memcached" }]);
    expect(ask.multiple).toBeUndefined();
    expect(ask.allowsText).toBe(true);
    expect(ask.answerableBy).toEqual(["user", "brain"]);
    const state = await c.next(isMethod("session.state", (p) => (p as Session).id === session.id && (p as Session).status === "needs_input"));
    expect((state.params as Session).ask).toBe(ask.id);
    expect(await Promise.race([inFlight.then(() => "resolved"), sleep(150).then(() => "held")])).toBe("held");

    const mark = history().length;
    await c.request("ask.answer", { id: ask.id, option: "Redis" });
    expect(await decisionOf(inFlight)).toEqual({ behavior: "allow", updatedInput: { questions: [CACHE], answers: { "Which cache?": "Redis" } } });
    await waitFor(() => wentBusy(mark));
    expect(d.store.sessions.get(session.id)?.ask).toBeUndefined();
    expect(askEvents().slice(-2)).toEqual([
      { ask: ask.id, phase: "opened", tool: "AskUserQuestion", question: 1, of: 1 } as never,
      { ask: ask.id, phase: "answered", answer: expect.objectContaining({ option: "Redis" }) } as never,
    ]);
  });

  test("two questions open in turn, one ask at a time; a multi-select answer joins the picks and the text", async () => {
    const inFlight = post(question([CACHE, TOOLS], "q-2"));
    const first = await openAsk((a) => a.detail === "Cache · 1 of 2");
    expect(first.title).toBe("Which cache?");
    expect(d.store.asks.listOpen().filter((a) => a.source.kind === "harness")).toHaveLength(1);
    await c.request("ask.answer", { id: first.id, option: "Memcached" });
    const second = await openAsk((a) => a.detail === "Tools · 2 of 2");
    expect(second.title).toBe("Which tools?");
    expect(second.multiple).toBe(true);
    expect(d.store.asks.get(first.id)?.status).toBe("answered");
    expect(d.store.asks.listOpen().filter((a) => a.source.kind === "harness").map((a) => a.id)).toEqual([second.id]);
    expect(d.store.sessions.get(session.id)?.status).toBe("needs_input");
    expect(d.store.sessions.get(session.id)?.ask).toBe(second.id);
    expect(await Promise.race([inFlight.then(() => "resolved"), sleep(100).then(() => "held")])).toBe("held");
    const mark = history().length;
    await c.request("ask.answer", { id: second.id, option: "ESLint", options: ["ESLint", "Prettier"], text: "Biome" });
    expect(await decisionOf(inFlight)).toEqual({
      behavior: "allow",
      updatedInput: { questions: [CACHE, TOOLS], answers: { "Which cache?": "Memcached", "Which tools?": "ESLint, Prettier, Biome" } },
    });
    await waitFor(() => wentBusy(mark));
    expect(askEvents().slice(-4).map((e) => [e.phase, (e as { question?: number }).question])).toEqual([["opened", 1], ["answered", undefined], ["opened", 2], ["answered", undefined]]);
  });

  test("text alone answers a question; a pick with a note is an annotation; the text option needs text", async () => {
    const inFlight = post(question([CACHE], "q-3"));
    const ask = await openAsk((a) => a.title === "Which cache?");
    const bare = await c.call("ask.answer", { id: ask.id, option: "text" });
    expect("error" in bare && bare.error.data?.code).toBe("invalid");
    await c.request("ask.answer", { id: ask.id, option: "text", text: "Valkey" });
    expect(await decisionOf(inFlight)).toEqual({ behavior: "allow", updatedInput: { questions: [CACHE], answers: { "Which cache?": "Valkey" } } });

    const noted = post(question([CACHE], "q-4"));
    const again = await openAsk((a) => a.title === "Which cache?" && a.id !== ask.id);
    await c.request("ask.answer", { id: again.id, option: "Redis", text: "managed please" });
    expect(await decisionOf(noted)).toEqual({
      behavior: "allow",
      updatedInput: { questions: [CACHE], answers: { "Which cache?": "Redis" }, annotations: { "Which cache?": { notes: "managed please" } } },
    });
  });

  test("a PostToolUse for the questions mid-sequence closes the open ask as answered in the terminal; an abort closes it as aborted", async () => {
    const inFlight = post(question([CACHE, TOOLS], "q-5"));
    const first = await openAsk((a) => a.detail === "Cache · 1 of 2");
    await c.request("ask.answer", { id: first.id, option: "Redis" });
    const second = await openAsk((a) => a.detail === "Tools · 2 of 2");
    let before = history().length;
    const done = await post(hookBase("PostToolUse", { tool_name: "AskUserQuestion", tool_input: { questions: [CACHE, TOOLS], answers: { "Which cache?": "Redis", "Which tools?": "ESLint" } }, tool_response: {} }));
    expect(await done.json()).toEqual({});
    expect(await (await inFlight).json()).toEqual({});
    expect(d.store.asks.get(first.id)?.status).toBe("answered");
    expect(d.store.asks.get(second.id)?.status).toBe("cancelled");
    expect(askEvents().at(-1)).toEqual({ ask: second.id, phase: "closed", reason: "terminal" });
    expect(wentBusy(before)).toBe(true);

    const ac = new AbortController();
    const aborted = post(question([CACHE, TOOLS], "q-6"), { signal: ac.signal }).catch(() => "aborted");
    const one = await openAsk((a) => a.detail === "Cache · 1 of 2" && a.id !== first.id);
    await c.request("ask.answer", { id: one.id, option: "Redis" });
    const two = await openAsk((a) => a.detail === "Tools · 2 of 2" && a.id !== second.id);
    before = history().length;
    ac.abort();
    expect(await aborted).toBe("aborted");
    await waitFor(() => d.store.asks.get(two.id)?.status === "cancelled");
    expect(askEvents().at(-1)).toEqual({ ask: two.id, phase: "closed", reason: "aborted" });
    expect(wentBusy(before)).toBe(true);
  });

  test("an AskUserQuestion with no usable question is an ordinary permission ask", async () => {
    const inFlight = post(question([{ question: "x" }], "q-7"));
    const ask = await openAsk((a) => a.title === "AskUserQuestion in attach-test");
    expect(ask.type).toBe("permission");
    expect(ask.options.map((o) => o.id)).toEqual(["allow", "deny"]);
    await c.request("ask.answer", { id: ask.id, option: "deny" });
    expect(await decisionOf(inFlight)).toEqual({ behavior: "deny", message: "Denied through cophylad" });
  });

  test("an ExitPlanMode ask is the plan itself, and its answer moves the session out of plan mode", async () => {
    const plan = "## Plan\n\n1. Read the file\n2. Write the file";
    const inFlight = post(exitPlan(plan, "x-1"));
    const ask = await openAsk((a) => a.title === "Ready to code in attach-test?");
    expect(ask.type).toBe("permission");
    expect(ask.detail).toBe(plan);
    expect(ask.allowsText).toBe(true);
    // Started with no flag or setting for bypass or auto mode: the edits row, and clear context before it.
    expect(ask.options.map((o) => o.id)).toEqual(["clear", "accept_edits", "allow", "deny"]);
    expect(d.store.sessions.get(session.id)?.status).toBe("needs_permission");
    await c.request("ask.answer", { id: ask.id, option: "accept_edits" });
    expect(await decisionOf(inFlight)).toEqual({ behavior: "allow", updatedInput: { plan }, updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] });

    // Keeping planning is a deny, and the note goes back as its message.
    const kept = post(exitPlan(plan, "x-2"));
    const again = await openAsk((a) => a.title === "Ready to code in attach-test?" && a.id !== ask.id);
    await c.request("ask.answer", { id: again.id, option: "deny", text: "use the other library" });
    expect(await decisionOf(kept)).toEqual({ behavior: "deny", message: "use the other library" });
  });

  test("session.send is queued with a ref, goes down the pipe, and a later UserPromptSubmit is its delivery receipt", async () => {
    received = "";
    const r = await c.request<{ status: string; ref: string }>("session.send", { id: session.id, text: "run the tests" });
    expect(r.status).toBe("queued");
    expect(r.ref.startsWith("cophylad-")).toBe(true);
    await waitFor(() => received.split("\n").length >= 3);
    const lines = received.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ type: "auth", token: "peer-token" });
    expect(lines[1]).toEqual({ type: "user", message: { role: "user", content: "[cophylad, relaying the user]\nrun the tests" }, from: "cophylad" });

    const before = history().length;
    await post(hookBase("UserPromptSubmit", { prompt: "[cophylad, relaying the user]\nrun the tests" }));
    const n = history().find((e) => e.kind === "notification" && (e.payload as { ref?: string }).ref === r.ref);
    expect(n?.payload).toEqual({ type: "message", ref: r.ref, state: "delivered" });
    expect(history().filter((e) => e.kind === "user_turn")).toHaveLength(0);
    // The always-idle fake registry races the poll back to idle, so busy is checked on the event log.
    expect(history().slice(before).some((e) => e.kind === "status" && (e.payload as { status: string }).status === "busy")).toBe(true);

    // A prompt the user typed is a user turn and sets the intent.
    await post(hookBase("UserPromptSubmit", { prompt: "and then lint" }));
    expect(history().filter((e) => e.kind === "user_turn")).toHaveLength(1);
    expect(d.store.sessions.get(session.id)?.intent).toBe("and then lint");
  });

  test("a UserPromptSubmit reaches a client watching the session as session.event at once, without raw, before the debounced session.state; one not watching hears no event", async () => {
    const other = await TestClient.connect(d.api.url);
    await other.hello(d.token);
    await c.request("session.watch", { ids: [session.id] });
    await post(hookBase("UserPromptSubmit", { prompt: "one more thing" }));
    const isTurn = (text: string) => (n: { method: string; params?: unknown }) =>
      n.method === "session.event" && (n.params as SessionEvent).kind === "user_turn" && (n.params as { payload: { text: string } }).payload.text === text;
    const event = await c.next(isTurn("one more thing"));
    const e = event.params as SessionEvent;
    expect(e.session).toBe(session.id);
    expect(typeof e.seq).toBe("number");
    expect(e.payload).toMatchObject({ text: "one more thing" });
    expect("raw" in e).toBe(false);
    const stored = history().find((x) => x.seq === e.seq)!;
    expect(stored.raw).toBeDefined();
    // The row follows on the debounce, after the event.
    const at = c.notifications.indexOf(event);
    const state = await c.next((n) => c.notifications.indexOf(n) > at && n.method === "session.state" && (n.params as Session).id === session.id);
    expect((state.params as Session).lastActivity).toBeGreaterThanOrEqual(e.at);
    expect(other.notifications.some((n) => n.method === "session.event")).toBe(false);
    // Watching nothing: the next prompt is stored, and no client hears it as an event.
    await c.request("session.watch", { ids: [] });
    await post(hookBase("UserPromptSubmit", { prompt: "and another" }));
    await waitFor(() => history().some((x) => x.kind === "user_turn" && (x.payload as { text?: string }).text === "and another"));
    await Bun.sleep(300);
    expect(c.notifications.some(isTurn("and another"))).toBe(false);
    expect(other.notifications.some((n) => n.method === "session.event")).toBe(false);
    other.close();
    await c.request("session.watch", { ids: [session.id] });
  });

  test("session.history serves the newest window and session.focus is refused without a window", async () => {
    const { events } = await c.request<{ events: SessionEvent[] }>("session.history", { id: session.id, limit: 3 });
    expect(events).toHaveLength(3);
    expect(events[2]!.seq).toBeGreaterThan(events[0]!.seq);
    const earlier = await c.request<{ events: SessionEvent[] }>("session.history", { id: session.id, before: events[0]!.seq, limit: 2 });
    expect(earlier.events.every((e) => e.seq < events[0]!.seq)).toBe(true);
    const missing = await c.call("session.history", { id: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB9" });
    expect("error" in missing && missing.error.data?.code).toBe("not_found");
    const focus = await c.call("session.focus", { id: session.id });
    expect("error" in focus).toBe(true);
  });

  test("session.send, session.list and ask.answer are in the audit table", () => {
    const actions = d.store.audit.list({ limit: 200 }).map((e: AuditEntry) => e.action);
    for (const a of ["session.send", "session.list", "ask.answer", "session.history", "workspace.put", "profile.list"]) expect(actions).toContain(a);
    const send = d.store.audit.list({ limit: 200 }).find((e) => e.action === "session.send")!;
    expect(send.target).toBe(session.id);
    expect(send.outcome).toBe("ok");
  });

  test("a Notification of a permission prompt without an ask marks the session, and SessionEnd ends it", async () => {
    // The fake registry says idle on every poll, so the marked state is checked on the event log rather than the live row.
    const before = history().length;
    await post(hookBase("Notification", { message: "Claude needs your permission to use Bash", notification_type: "permission_prompt" }));
    const marked = history().slice(before);
    expect(marked.some((e) => e.kind === "notification" && (e.payload as { type: string }).type === "permission_prompt")).toBe(true);
    expect(marked.some((e) => e.kind === "status" && (e.payload as { status: string }).status === "needs_permission")).toBe(true);
    await post(hookBase("Stop"));
    expect(d.store.sessions.get(session.id)?.status).toBe("idle");
    // Claude removes its registry entry as it exits.
    rmSync(join(profileDir, "sessions", `${process.pid}.json`));
    const r = await post(hookBase("SessionEnd", { reason: "exit" }));
    expect(await r.json()).toEqual({});
    const ended = await c.next(isMethod("session.state", (p) => (p as Session).id === session.id && (p as Session).status === "ended"));
    expect((ended.params as Session).endedAt).toBeDefined();
    expect(history().at(-1)?.kind).toBe("ended");
    const { sessions } = await c.request<{ sessions: Session[] }>("session.list", {});
    expect(sessions).toHaveLength(0);
    const refused = await c.call("session.send", { id: session.id, text: "x" });
    expect("error" in refused && refused.error.data?.code).toBe("conflict");
  });

  test("the registry brings the session back under the same id after it ended, under a new process only", async () => {
    // Still listed under the process it ended in: a session on its way out.
    writeRegistry(join(profileDir, "sessions"), process.pid, pipe);
    await d.sessions.tick();
    expect(d.sessions.list()).toHaveLength(0);
    expect(d.store.sessions.get(session.id)?.status).toBe("ended");
    rmSync(join(profileDir, "sessions", `${process.pid}.json`));
    // A resume: another process (the test runner's parent, which is alive) under the same session id.
    writeRegistry(join(profileDir, "sessions"), process.ppid, pipe);
    await d.sessions.tick();
    await waitFor(() => d.sessions.list().length === 1, 3000);
    expect(d.sessions.list()[0]!.id).toBe(session.id);
    expect(d.sessions.list()[0]!.native.pid).toBe(process.ppid);
    expect(d.sessions.list()[0]!.status).toBe("idle");
    expect(d.sessions.list()[0]!.endedAt).toBeUndefined();
    rmSync(join(profileDir, "sessions", `${process.ppid}.json`));
  });
});

describe("attach: a stopping daemon releases what it holds", () => {
  test("a held PermissionRequest resolves with {} and the asks are closed", async () => {
    const scratch = tempHome();
    const profileDir = join(scratch, "p");
    CWD = join(scratch, "w");
    mkdirSync(CWD);
    writeRegistry(join(profileDir, "sessions"), process.pid, testSocketPath("none"));
    const home = tempHome(`[sessions]\ndiscover = false\ninstall_hooks = false\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(profileDir)}\n`);
    const { startDaemon } = await import("../src/daemon.ts");
    const { silentLogger } = await import("../src/log.ts");
    const d = await startDaemon({ home, port: 0, log: silentLogger, brain: false });
    const url = `http://127.0.0.1:${d.api.port}/hooks/claude`;
    const inFlight = fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${d.hookToken}`, "x-cophylad": "1" },
      body: JSON.stringify({ session_id: SESSION_ID, transcript_path: "t", cwd: CWD, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } }),
    });
    await waitFor(() => d.store.asks.listOpen().length === 1);
    const askId = d.store.asks.listOpen()[0]!.id;
    await d.stop();
    const r = await inFlight;
    expect(await r.json()).toEqual({});
    const again = await startDaemon({ home, port: 0, log: silentLogger, brain: false });
    try {
      expect(again.store.asks.get(askId)?.status).toBe("cancelled");
      const events = again.store.sessionEvents.history(again.sessions.list()[0]!.id, { limit: 100 });
      expect(events.some((e) => e.kind === "ask" && (e.payload as { reason?: string }).reason === "daemon_stop")).toBe(true);
      expect(again.sessions.list()[0]!.status).not.toBe("needs_permission");
    } finally {
      await again.stop();
      // Like `removeHome`: Windows may hold the SQLite file a moment after a held hook's daemon stops.
      removeHome(home);
    }
  });
});
