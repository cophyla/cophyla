// brain-link over the socket with the fake brain: the handshake and an audit row for every
// brain request with `principal.kind = brain` and the event's correlation; an out-of-range
// brain refused; `session.spawn` under an `ask` rule held as `pending` and answered; `cancel`
// on a held request; `ui.ask` as a choice Ask whose answer comes back; `ui.say` quoting a
// prior result verbatim with a source and an unknown cite left unresolved; `chat.delta` then
// `chat.message` under one id for a completion flagged `reply`, nothing for one that is not,
// and a `chat.retract` for a reply step that ended in a tool call; a crash restarted with the
// message sent meanwhile delivered and the brain's asks cancelled; unsupported requests
// answered `unsupported`; the brain's listeners added unasked, their fires heard after the
// event that caused them, and one removed by the user; the brain's `ui.progress` signal
// relayed as `chat.progress`, told to a client that connects mid-turn and cleared when the
// brain exits. `brain.context` is off without `[brain] show_context`; on, `check` asks the
// brain nothing, and a request is the brain's `context.preview`, checked, with the prompt kept
// out of the audit row; a brain from before it answers `unsupported`.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId } from "@cophyla/protocol";
import type { AuditEntry, Hit, Message, Task, TurnProgress } from "@cophyla/protocol";
import type { Daemon } from "../src/daemon.ts";
import { brainFrames, isMethod, removeHome, sleep, stopDaemon, tempHome, TestClient, tomlString, waitFor } from "./helpers.ts";
import type { GeminiFake, Script } from "./fakes/gemini.ts";
import { call as geminiCall, finish, startGeminiFake, text as geminiText } from "./fakes/gemini.ts";

const FAKE_BRAIN = join(import.meta.dir, "fakes", "brain.ts");
/** The brain's write and exec actions a test allows by default; a test narrows one to `ask`. */
const DEFAULT_RULES: Record<string, string> = {
  "brain:session.spawn": "allow",
  "brain:session.send": "allow",
  "brain:ui.say": "allow",
  "brain:ui.ask": "allow",
  "brain:thread.start": "allow",
  "brain:task.create": "allow",
  "brain:task.update": "allow",
  "brain:llm.complete": "allow",
  "brain:store.put": "allow",
  "brain:voice.speak": "allow",
  "brain:remote.screenshot": "allow",
  "brain:compute.embed": "allow",
};
const FAKE_AGENT = join(import.meta.dir, "fakes", "acp-agent.ts");

interface Started {
  d: Daemon & { home: string };
  c: TestClient;
  log: string;
  scratch: string;
  gemini?: GeminiFake;
}

let current: Started | undefined;

afterEach(async () => {
  if (!current) return;
  current.c.close();
  await stopDaemon(current.d);
  await current.gemini?.stop();
  removeHome(current.scratch);
  current = undefined;
});

/**
 * A daemon with the fake brain running the given script, a fake Claude profile and a workspace.
 * The script may be a function of the workspace and node ids, applied once they exist: the
 * fake brain rereads its script at every event.
 */
async function start(script: object | ((ctx: { ws: string; node: string }) => object), opts: { range?: string; rules?: Record<string, string>; builtin?: string[]; gemini?: boolean | Record<string, Script>; brain?: string } = {}): Promise<Started & { ws: string }> {
  const scratch = tempHome();
  const cwd = join(scratch, "work");
  const configDir = join(scratch, "claude-home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const scriptPath = join(scratch, "brain-script.json");
  writeFileSync(scriptPath, JSON.stringify(typeof script === "function" ? { on: [] } : script));
  const log = join(scratch, "brain.log");
  const scripts = typeof opts.gemini === "object" ? opts.gemini : { default: [geminiText("Hello <quote request=\"r1\" lines=\"1-1\"/>"), geminiText(" there."), finish("STOP")] };
  const gemini = opts.gemini ? startGeminiFake({ delayMs: 40, scripts }) : undefined;
  const providers = gemini ? `[providers.gemini]\napi_key = "k"\nbase_url = "${gemini.url}"\n` : "";
  const toml =
    `[nodes]\ndiscovery = false\n\n[sessions]\ndiscover = false\ninstall_hooks = false\nlaunch = "acp"\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(configDir)}\n\n` +
    `[brain]\ncommand = ${tomlString(FAKE_BRAIN)}\nrestart_backoff_ms = 100\nhello_timeout_ms = 5000\n${opts.brain ?? ""}\n[acp.claude]\ncommand = ${tomlString(FAKE_AGENT)}\n\n` +
    `[gate.rules]\n${Object.entries({ ...DEFAULT_RULES, ...opts.rules })
      .filter(([k]) => !opts.builtin?.includes(k))
      .map(([k, v]) => `"${k}" = "${v}"`)
      .join("\n")}\n\n${providers}`;
  writeFileSync(join(scratch, "config.toml"), toml);
  const { startDaemon } = await import("../src/daemon.ts");
  const { silentLogger } = await import("../src/log.ts");
  const d = Object.assign(
    await startDaemon({ home: scratch, port: 0, log: silentLogger, env: { ...process.env, FAKE_BRAIN_SCRIPT: scriptPath, FAKE_BRAIN_LOG: log, FAKE_BRAIN_RANGE: opts.range ?? "1-1", GEMINI_API_KEY: undefined } }),
    { home: scratch },
  );
  const ws = d.workspaces.put({ node: d.identity.id, path: cwd, name: "work" }).id;
  if (typeof script === "function") writeFileSync(scriptPath, JSON.stringify(script({ ws, node: d.identity.id })));
  const c = await TestClient.connect(d.api.url);
  await c.hello(d.token, { name: "test" });
  current = { d, c, log, scratch, ...(gemini ? { gemini } : {}) };
  return { ...current, ws };
}

const brainAudit = (d: Daemon): AuditEntry[] => d.store.audit.list({ limit: 500 }).filter((e) => e.principal.kind === "brain").reverse();

describe("brain-link", () => {
  test("handshake, then every brain request is audited as the brain with the event's correlation", async () => {
    const { d, c, log } = await start({
      on: [
        { event: "hello", requests: [{ method: "node.list" }, { method: "session.list", params: { filter: {} } }, { method: "profile.list", params: {} }] },
        { event: "user.message", requests: [{ method: "task.list", params: {} }, { method: "ui.say", params: { blocks: [{ type: "text", text: "You said: $event.text" }] } }] },
      ],
    });
    await waitFor(() => d.brain?.state === "up");
    expect(d.brain!.instanceId).toMatch(/^brain-/);
    expect(d.brain!.brainVersion).toBe("fake-0.1");
    await waitFor(() => brainAudit(d).length >= 3);
    const hello = brainFrames(log).find((f) => f.dir === "in" && f.frame["method"] === "hello")!;
    expect(hello.frame["params"]).toMatchObject({ protocolVersion: 1, nodeId: d.identity.id, role: "primary", tz: d.tz });
    expect(typeof (hello.frame["params"] as { tz: unknown }).tz).toBe("string");
    const startup = brainAudit(d);
    expect(startup.map((e) => e.action)).toEqual(["node.list", "session.list", "profile.list"]);
    for (const e of startup) {
      expect(e.principal).toEqual({ kind: "brain" });
      expect(e.decision).toBe("allow");
      expect(e.outcome).toBe("ok");
    }
    const r = await c.request<{ message: string }>("chat.send", { text: "hello brain" });
    const reply = await c.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "orchestrator"));
    const m = (reply.params as { message: Message }).message;
    expect(m.content).toEqual([{ type: "text", text: "You said: hello brain" }]);
    expect(m.thread).toBe(d.chat.current().id);
    const userMessage = brainFrames(log).find((f) => f.dir === "in" && f.frame["method"] === "user.message")!;
    const params = userMessage.frame["params"] as { eventId: string; message: string; text: string; at: number };
    expect(params.message).toBe(r.message);
    expect(params.text).toBe("hello brain");
    expect(params.eventId).toMatch(/^evt_/);
    const afterMessage = brainAudit(d).filter((e) => e.action === "task.list" || e.action === "ui.say");
    expect(afterMessage).toHaveLength(2);
    for (const e of afterMessage) {
      expect(e.correlation).toBe(params.eventId);
      expect(e.thread).toBe(m.thread);
    }
  });

  test("listeners: the brain adds them unasked, a fire reaches it after the event that caused it, the last one removes it, the user removes one, the store refuses their namespace", async () => {
    const { d, c, log } = await start({
      on: [
        {
          event: "hello",
          requests: [
            { method: "listener.add", params: { on: ["node.pressure"], level: "critical", deliver: "wake", times: 1, why: "the machine is struggling" } },
            { method: "listener.add", params: { on: ["session.said"], origin: "user", deliver: "note", why: "what the user's agents say" } },
            { method: "store.put", params: { ns: "listeners", key: "x", value: {} } },
          ],
        },
      ],
    });
    await waitFor(() => brainAudit(d).filter((e) => e.action.startsWith("listener.") || e.action === "store.put").length === 3);
    const adds = brainAudit(d).filter((e) => e.action === "listener.add");
    expect(adds.map((e) => e.decision)).toEqual(["allow", "allow"]);
    expect(adds.every((e) => e.outcome === "ok")).toBe(true);
    expect(brainAudit(d).find((e) => e.action === "store.put")?.outcome).toBe("error");
    const listed = await c.request<{ listeners: { id: string; on: string[]; fired: number }[] }>("listener.list", {});
    expect(listed.listeners.map((l) => l.on)).toEqual([["node.pressure"], ["session.said"]]);
    const [pressure, said] = listed.listeners;
    // A warn is not what it listens for; a critical is, once.
    d.bus.emit("node.pressure", { at: Date.now(), node: d.identity.id, resource: "cpu", level: "warn" });
    d.bus.emit("node.pressure", { at: Date.now(), node: d.identity.id, resource: "cpu", level: "critical" });
    await waitFor(() => brainFrames(log).some((f) => f.dir === "in" && f.frame["method"] === "listener.removed"));
    const seen = brainFrames(log).filter((f) => f.dir === "in" && typeof f.frame["method"] === "string" && ["node.pressure", "listener.fired", "listener.removed"].includes(f.frame["method"] as string));
    expect(seen.map((f) => f.frame["method"])).toEqual(["node.pressure", "node.pressure", "listener.fired", "listener.removed"]);
    const fired = seen[2]!.frame["params"] as { listener: { id: string; fired: number; times: number }; event: { name: string; params: { level: string; at: number } }; last: boolean; eventId: string };
    expect(fired.listener).toMatchObject({ id: pressure!.id, fired: 1, times: 0 });
    expect(fired.event.name).toBe("node.pressure");
    expect(fired.event.params.level).toBe("critical");
    expect(typeof fired.event.params.at).toBe("number");
    expect(fired.last).toBe(true);
    expect(fired.eventId).toMatch(/^evt_/);
    expect(seen[3]!.frame["params"]).toMatchObject({ id: pressure!.id, why: "spent" });
    // The user takes the other away: the brain hears why.
    await c.request("listener.remove", { id: said!.id });
    await waitFor(() => brainFrames(log).filter((f) => f.dir === "in" && f.frame["method"] === "listener.removed").length === 2);
    expect(brainFrames(log).filter((f) => f.dir === "in" && f.frame["method"] === "listener.removed")[1]!.frame["params"]).toMatchObject({ id: said!.id, why: "user" });
    expect((await c.request<{ listeners: unknown[] }>("listener.list", {})).listeners).toEqual([]);
    const gone = await c.call("listener.remove", { id: said!.id });
    expect("error" in gone && gone.error.data?.code).toBe("not_found");
    expect(d.store.kv.list("listeners")).toEqual([]);
  });

  test("a brain whose protocol range excludes ours is refused and not restarted", async () => {
    const { d } = await start({ on: [] }, { range: "2-3" });
    await waitFor(() => d.brain?.state === "refused");
    await sleep(300);
    expect(d.brain!.state).toBe("refused");
    expect(d.brain!.spawnCount).toBe(1);
    expect(d.brain!.instanceId).toBeUndefined();
  });

  test("session.spawn under an ask rule: pending notice, ask.state, the result after ask.answer; cancel on a held request", async () => {
    const { d, c, log } = await start(
      ({ ws }) => ({
        on: [
          { event: "user.message", match: { text: "spawn" }, requests: [{ method: "session.spawn", params: { harness: "claude", workspace: ws, prompt: "say hi" } }, { method: "ui.say", params: { blocks: [{ type: "text", text: "started $last.id" }] } }] },
        ],
      }),
      { rules: { "brain:session.spawn": "ask" } },
    );
    await waitFor(() => d.brain?.state === "up");
    await c.request("chat.send", { text: "spawn one" });
    const askState = await c.next(isMethod("ask.state", (p) => (p as { status: string }).status === "open"));
    const ask = askState.params as { id: string; source: unknown; type: string; title: string; detail: string; options: { id: string }[] };
    expect(ask.source).toEqual({ kind: "gate", action: "session.spawn", principal: { kind: "brain" } });
    expect(ask.type).toBe("permission");
    expect(ask.title).toBe("Start a Claude session in work?");
    expect(ask.detail).toBe("say hi");
    const pending = await waitFor(() => brainFrames(log).find((f) => f.dir === "in" && f.frame["method"] === "pending"));
    const pp = pending.frame["params"] as { id: string; ask: { id: string }; at: number };
    expect(pp.id).toBe("r1");
    expect(pp.ask.id).toBe(ask.id);
    expect(typeof pp.at).toBe("number");
    expect(d.brain!.state).toBe("up");
    await c.request("ask.answer", { id: ask.id, option: "allow" });
    const reply = await c.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "orchestrator"));
    const text = ((reply.params as { message: Message }).message.content[0] as { text: string }).text;
    expect(text).toMatch(/^started sess_/);
    const spawned = d.sessions.get(text.slice("started ".length))!;
    expect(spawned.native.transport).toBe("acp");
    expect(spawned.origin).toBe("orchestrator");
    const audit = brainAudit(d).find((e) => e.action === "session.spawn")!;
    expect(audit.decision).toBe("ask");
    expect(audit.outcome).toBe("ok");
    expect(audit.ask).toBe(ask.id);

  });

  test("by the built-in rules the brain starts a session and messages it unasked; a session of the user's is still asked about", async () => {
    const { d, c, log, scratch } = await start({ on: [] }, { builtin: ["brain:session.spawn", "brain:session.send"] });
    await waitFor(() => d.brain?.state === "up");
    const users = d.sessions.ensure({ harness: "claude", nativeId: "users-own", profile: d.profiles.byHarness("claude")[0]!.id, cwd: join(scratch, "work"), transport: "pipe" });
    const ws = d.workspaces.list()[0]!.id;
    writeFileSync(
      join(scratch, "brain-script.json"),
      JSON.stringify({
        on: [
          {
            event: "user.message",
            match: { text: "spawn" },
            requests: [
              { method: "session.spawn", params: { harness: "claude", workspace: ws, prompt: "say hi" } },
              { method: "session.send", params: { id: "$last.id", text: "and the docs" } },
              { method: "profile.limits", params: {} },
              { method: "session.send", params: { id: users.session.id, text: "hello there" } },
            ],
          },
        ],
      }),
    );
    await c.request("chat.send", { text: "spawn one" });
    const askState = await c.next(isMethod("ask.state", (p) => (p as { status: string }).status === "open"));
    const ask = askState.params as { id: string; source: { action: string } };
    expect(ask.source.action).toBe("session.send");
    const audit = brainAudit(d);
    expect(audit.filter((e) => e.action === "session.spawn").map((e) => [e.decision, e.outcome])).toEqual([["allow", "ok"]]);
    const sends = audit.filter((e) => e.action === "session.send");
    expect(sends.map((e) => [e.decision, e.target === users.session.id])).toEqual([
      ["allow", false],
      ["ask", true],
    ]);
    // No limits are read under test: the answer is an empty map, not a failure.
    const limits = await waitFor(() => brainFrames(log).find((f) => f.dir === "in" && f.frame["id"] === "r3" && f.frame["result"] !== undefined));
    expect(limits.frame["result"]).toEqual({ limits: {} });
    await c.request("ask.answer", { id: ask.id, option: "deny" });
  });

  test("cancel withdraws a held request: the ask is cancelled and the brain gets cancelled", async () => {
    const { d, c, log } = await start(
      ({ ws }) => ({ cancelOnUserMessage: true, on: [{ event: "user.message", match: { text: "spawn" }, requests: [{ method: "session.spawn", params: { harness: "claude", workspace: ws, prompt: "say hi" } }] }] }),
      { rules: { "brain:session.spawn": "ask" } },
    );
    await waitFor(() => d.brain?.state === "up");
    await c.request("chat.send", { text: "spawn one" });
    const askState = await c.next(isMethod("ask.state", (p) => (p as { status: string }).status === "open"));
    const askId = (askState.params as { id: string }).id;
    await c.request("chat.send", { text: "never mind" });
    await waitFor(() => d.asks.get(askId)?.status === "cancelled");
    const cancelAudit = await waitFor(() => brainAudit(d).find((e) => e.action === "cancel"));
    expect(cancelAudit.decision).toBe("allow");
    expect(cancelAudit.outcome).toBe("ok");
    expect(cancelAudit.target).toBe("r1");
    const spawnAudit = brainAudit(d).find((e) => e.action === "session.spawn")!;
    expect(spawnAudit.outcome).toBe("cancelled");
    const errorFrame = await waitFor(() => brainFrames(log).find((f) => f.dir === "in" && f.frame["id"] === "r1" && f.frame["error"] !== undefined));
    expect((errorFrame.frame["error"] as { data: { code: string } }).data.code).toBe("cancelled");
    expect(d.sessions.list()).toEqual([]);
  });

  test("ui.ask opens a choice ask answerable by the user; the answer is the request's result", async () => {
    const { d, c, log } = await start({
      on: [
        {
          event: "user.message",
          requests: [
            { method: "ui.ask", params: { question: "Which one?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } },
            { method: "ui.say", params: { blocks: [{ type: "text", text: "You picked $last.answer.option" }] } },
          ],
        },
      ],
    });
    await waitFor(() => d.brain?.state === "up");
    await c.request("chat.send", { text: "choose" });
    const askState = await c.next(isMethod("ask.state", (p) => (p as { status: string }).status === "open"));
    const ask = askState.params as { id: string; type: string; source: unknown; title: string; answerableBy: string[]; options: { id: string; label: string }[] };
    expect(ask.type).toBe("choice");
    expect(ask.source).toEqual({ kind: "brain" });
    expect(ask.title).toBe("Which one?");
    expect(ask.answerableBy).toEqual(["user"]);
    expect(ask.options.map((o) => o.id)).toEqual(["a", "b"]);
    await waitFor(() => brainFrames(log).some((f) => f.dir === "in" && f.frame["method"] === "pending"));
    await c.request("ask.answer", { id: ask.id, option: "b" });
    const reply = await c.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "orchestrator"));
    expect((reply.params as { message: Message }).message.content).toEqual([{ type: "text", text: "You picked b" }]);
    expect(brainAudit(d).find((e) => e.action === "ui.ask")!.outcome).toBe("ok");
  });

  test("ui.say quotes a prior session.history or fs.read result verbatim with a source; an unknown cite is unresolved", async () => {
    const { d, c, ws, scratch } = await start(({ ws, node }) => ({
      on: [
        {
          event: "user.message",
          match: { text: "history" },
          requests: [
            { method: "session.history", params: { id: "$text[1]" } },
            { method: "ui.say", params: { blocks: [{ type: "text", text: "It said:" }, { type: "quote", cite: { request: "$prev", lines: [3, 3] } }, { type: "quote", cite: { request: "r999" }, text: "fallback" }, { type: "quote", text: "you said so" }] } },
          ],
        },
        {
          event: "user.message",
          match: { text: "read" },
          requests: [
            { method: "tool.run", params: { name: "fs.read", args: { path: "notes.md", workspace: ws } } },
            { method: "ui.say", params: { blocks: [{ type: "quote", cite: { request: "$prev", lines: [2, 3] } }, { type: "ref", file: { node, path: "C:\\notes.md", line: 2 } }] } },
          ],
        },
        {
          event: "user.message",
          match: { text: "cite" },
          requests: [{ method: "ui.say", params: { blocks: [{ type: "quote", cite: { request: "$text[1]", lines: [2, 3] }, text: "not mine" }] } }],
        },
      ],
    }));
    await waitFor(() => d.brain?.state === "up");
    writeFileSync(join(scratch, "work", "notes.md"), ["# Notes", "line two", "line three", "line four", ""].join("\n"));
    // A session with a few events, from the spawned fake agent; seq 3 is its reply.
    const spawned = await d.sessions.spawn({ harness: "claude", workspace: ws, prompt: "say hi" }, { profiles: d.profiles });
    await waitFor(() => d.sessions.get(spawned.id)?.status === "idle");

    await c.request("chat.send", { text: `history ${spawned.id}` });
    const reply = await c.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "orchestrator"));
    const blocks = (reply.params as { message: Message }).message.content;
    expect(blocks[0]).toEqual({ type: "text", text: "It said:" });
    expect(blocks[1]).toEqual({ type: "quote", text: "Hi there.", source: { kind: "session", session: spawned.id, seq: [3, 3] } });
    expect(blocks[2]).toEqual({ type: "quote", text: "fallback", unresolved: true });
    expect(blocks[3]).toEqual({ type: "quote", text: "you said so" });

    await c.request("chat.send", { text: "read the notes" });
    const reply2 = await c.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "orchestrator" && (p as { message: Message }).message.id !== (reply.params as { message: Message }).message.id));
    const blocks2 = (reply2.params as { message: Message }).message.content;
    expect(blocks2[0]).toEqual({ type: "quote", text: ["line two", "line three"].join("\n"), source: { kind: "file", node: d.identity.id, path: expect.stringMatching(/notes\.md$/), lines: [2, 3] } });
    expect(blocks2[1]).toMatchObject({ type: "ref", file: { line: 2 } });
    // The audit row of the read keeps the body the quote came from.
    const read = brainAudit(d).find((e) => e.action === "tool.run")!;
    expect(read.target).toBe("fs.read");
    expect((read.result!.body as { result: { text: string } }).result.text).toContain("2\tline two");

    // The same read in another node's row of the table (a workspace node's, say) is not the brain's to quote.
    const replied = (ms: TestClient["notifications"][number][]) => (p: unknown) => (p as { message: Message }).message.role === "orchestrator" && !ms.some((r) => (r.params as { message: Message }).message.id === (p as { message: Message }).message.id);
    const foreign: AuditEntry = { ...read, id: newId("audit"), node: newId("node") };
    d.store.audit.insert(foreign);
    await c.request("chat.send", { text: `cite ${foreign.id}` });
    const reply3 = await c.next(isMethod("chat.message", replied([reply, reply2])));
    expect((reply3.params as { message: Message }).message.content).toEqual([{ type: "quote", text: "not mine", unresolved: true }]);
    // this node's own row, cited by its id, resolves
    await c.request("chat.send", { text: `cite ${read.id}` });
    const reply4 = await c.next(isMethod("chat.message", replied([reply, reply2, reply3])));
    expect((reply4.params as { message: Message }).message.content[0]).toMatchObject({ type: "quote", text: ["line two", "line three"].join("\n") });
  });

  test("llm.complete deltas become chat.delta on a provisional id that the ui.say then stores under", async () => {
    const { d, c } = await start(
      {
        on: [
          {
            event: "user.message",
            requests: [
              { method: "llm.complete", params: { model: { tier: "fast" }, messages: [{ role: "user", content: [{ type: "text", text: "$event.text" }] }], reply: true } },
              { method: "ui.say", params: { blocks: [{ type: "text", text: "$last.content[0].text" }] } },
            ],
          },
        ],
      },
      { gemini: true },
    );
    await waitFor(() => d.brain?.state === "up");
    await c.request("chat.send", { text: "stream it" });
    const first = await c.next(isMethod("chat.delta"));
    const id = (first.params as { message: string }).message;
    expect(id).toMatch(/^msg_/);
    const reply = await c.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "orchestrator"));
    const m = (reply.params as { message: Message }).message;
    expect(m.id).toBe(id);
    const deltas = c.notifications.filter((n) => n.method === "chat.delta").map((n) => (n.params as { delta: { text: string } }).delta.text).join("");
    expect(deltas).toBe("Hello  there.");
    expect(m.content).toEqual([{ type: "text", text: 'Hello <quote request="r1" lines="1-1"/> there.' }]);
    const llm = brainAudit(d).find((e) => e.action === "llm.complete")!;
    expect(llm.target).toBe("fast");
    expect(llm.outcome).toBe("ok");
  });

  test("ui.progress reaches the chat as chat.progress, is told to a client connecting mid-turn, and a brain that exits clears it", async () => {
    const turn: TurnProgress = { steps: [{ text: "Checked agent sessions", status: "done" }, { text: "Reading plan.md", status: "running" }], thinking: false };
    const { d, c } = await start({
      on: [
        {
          event: "user.message",
          requests: [
            // A malformed one is dropped; the good one goes to the clients.
            { method: "ui.progress", notify: true, params: { turn: { steps: "nope", thinking: 1 } } },
            { method: "ui.progress", notify: true, params: { turn } },
          ],
        },
      ],
    });
    await waitFor(() => d.brain?.state === "up");
    await c.request("chat.send", { text: "what's the plan?" });
    const seen = await c.next(isMethod("chat.progress"));
    expect(seen.params).toEqual({ turn });
    expect(d.brain!.progress).toEqual(turn);
    // A client that says hello now hears the turn right after.
    const late = await TestClient.connect(d.api.url);
    try {
      await late.hello(d.token, { name: "late" });
      const told = await late.next(isMethod("chat.progress"));
      expect(told.params).toEqual({ turn });
    } finally {
      late.close();
    }
    // A brain that exits mid-turn leaves nothing in progress.
    d.brain!.kill();
    const cleared = await c.next(isMethod("chat.progress", (p) => (p as { turn?: unknown }).turn === undefined));
    expect(cleared.params).toEqual({});
    expect(d.brain!.progress).toBeUndefined();
    expect(brainAudit(d).some((e) => e.action === "ui.progress")).toBe(false);
  });

  test("a reply keeps the steps its turn took: in the chat.message, the store and chat.load", async () => {
    const steps: TurnProgress["steps"] = [{ text: "Checked agent sessions", status: "done" }, { text: "Reading notes.md", status: "failed" }];
    const { d, c } = await start({ on: [{ event: "user.message", requests: [{ method: "ui.say", params: { blocks: [{ type: "text", text: "Done." }], steps } }] }] });
    await waitFor(() => d.brain?.state === "up");
    await c.request("chat.send", { text: "anything?" });
    const reply = await c.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "orchestrator"));
    const m = (reply.params as { message: Message }).message;
    expect(m.steps).toEqual(steps);
    expect(d.store.messages.get(m.id)!.steps).toEqual(steps);
    const loaded = (await c.request("chat.load", {})) as { messages: Message[] };
    expect(loaded.messages.find((x) => x.id === m.id)!.steps).toEqual(steps);
  });

  /** Every placeholder a client saw ended: in the `chat.message` that took its id, or in a `chat.retract`. */
  const expectEveryPlaceholderEnded = (c: TestClient) => {
    const ids = new Set(c.notifications.filter((n) => n.method === "chat.delta").map((n) => (n.params as { message: string }).message));
    for (const id of ids) {
      const ended = c.notifications.some(
        (n) => (n.method === "chat.message" && (n.params as { message: Message }).message.id === id) || (n.method === "chat.retract" && (n.params as { message: string }).message === id),
      );
      expect(ended).toBe(true);
    }
  };

  test("a completion the brain does not flag as a reply never reaches the chat, after a reply or on its own", async () => {
    const { d, c } = await start(
      {
        on: [
          {
            event: "user.message",
            requests: [
              { method: "llm.complete", params: { model: { tier: "fast" }, messages: [{ role: "user", content: [{ type: "text", text: "$event.text" }] }], reply: true } },
              { method: "ui.say", params: { blocks: [{ type: "text", text: "$last.content[0].text" }] } },
              // The brain's own housekeeping, e.g. the archive filing a thread.
              { method: "llm.complete", params: { model: { tier: "fast" }, system: "File this.", messages: [{ role: "user", content: [{ type: "text", text: "archive this" }] }] } },
              { method: "llm.complete", params: { model: { tier: "fast" }, system: "File this.", messages: [{ role: "user", content: [{ type: "text", text: "archive this" }] }] } },
            ],
          },
        ],
      },
      { gemini: { archive: [geminiText('{"summary": "filed", '), geminiText('"tags": ["x"]}'), finish("STOP")], default: [geminiText("Hi"), geminiText(" there."), finish("STOP")] } },
    );
    await waitFor(() => d.brain?.state === "up");
    await c.request("chat.send", { text: "hello" });
    await c.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "orchestrator"));
    await waitFor(() => brainAudit(d).filter((e) => e.action === "llm.complete" && e.outcome === "ok").length >= 3, 5000);
    await sleep(100);
    const deltas = c.notifications.filter((n) => n.method === "chat.delta").map((n) => (n.params as { delta: { text: string } }).delta.text);
    expect(deltas.join("")).toBe("Hi there.");
    expect(deltas.join("")).not.toContain("summary");
    expect(c.notifications.filter((n) => n.method === "chat.retract")).toEqual([]);
    expectEveryPlaceholderEnded(c);
  });

  test("a reply step that ends in a tool call is retracted, and the said reply is a new message", async () => {
    const { d, c } = await start(
      {
        on: [
          {
            event: "user.message",
            requests: [
              { method: "llm.complete", params: { model: { tier: "fast" }, messages: [{ role: "user", content: [{ type: "text", text: "look it up" }] }], reply: true } },
              { method: "llm.complete", params: { model: { tier: "fast" }, messages: [{ role: "user", content: [{ type: "text", text: "now answer" }] }], reply: true } },
              { method: "ui.say", params: { blocks: [{ type: "text", text: "$last.content[0].text" }] } },
            ],
          },
        ],
      },
      { gemini: { look: [geminiText("Let me check."), geminiCall("files", { action: "Read" }), finish("STOP")], answer: [geminiText("It is 4."), finish("STOP")] } },
    );
    await waitFor(() => d.brain?.state === "up");
    await c.request("chat.send", { text: "what is it" });
    const retract = await c.next(isMethod("chat.retract"));
    const reply = await c.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "orchestrator"));
    const retracted = (retract.params as { message: string }).message;
    const m = (reply.params as { message: Message }).message;
    expect(m.id).not.toBe(retracted);
    expect(m.content).toEqual([{ type: "text", text: "It is 4." }]);
    const first = c.notifications.find((n) => n.method === "chat.delta")!;
    expect((first.params as { message: string; delta: { text: string } }).message).toBe(retracted);
    expect((first.params as { delta: { text: string } }).delta.text).toBe("Let me check.");
    expectEveryPlaceholderEnded(c);
  });

  test("a crash restarts the brain; a user message sent meanwhile is delivered; brain asks are cancelled and blocked tasks go ready", async () => {
    const { d, c, log } = await start({
      crashAfter: 2,
      on: [
        { event: "hello", once: true, requests: [{ method: "task.create", params: { title: "waiting" } }, { method: "ui.ask", params: { question: "Go on?", options: [{ id: "y", label: "Yes" }], task: "$last.id" } }] },
        { event: "user.message", requests: [{ method: "ui.say", params: { blocks: [{ type: "text", text: "got $event.text" }] } }] },
      ],
    });
    await waitFor(() => d.brain?.state === "up");
    const askState = await c.next(isMethod("ask.state", (p) => (p as { status: string }).status === "open"));
    const ask = askState.params as { id: string; source: { task?: string } };
    const taskId = ask.source.task!;
    await c.request("task.update", { id: taskId, patch: { blocker: { kind: "ask", ask: ask.id } } });
    expect(d.tasks.get(taskId)!.status).toBe("blocked");
    const instance = d.brain!.instanceId;
    // The second response (task.create was the first; the ui.ask is still pending) crashes the brain.
    await c.request("chat.send", { text: "one" });
    await c.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "orchestrator"));
    await waitFor(() => d.brain?.state !== "up", 5000);
    // While it is down, a message is queued rather than dropped.
    const r = await c.request<{ message: string }>("chat.send", { text: "two" });
    await waitFor(() => d.asks.get(ask.id)?.status === "cancelled");
    expect(d.tasks.get(taskId)!.status).toBe("ready");
    const taskState = c.notifications.filter((n) => n.method === "task.state").map((n) => n.params as Task);
    expect(taskState.at(-1)!.status).toBe("ready");
    await waitFor(() => d.brain?.state === "up" && d.brain.instanceId !== instance, 10000);
    const reply = await c.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "orchestrator" && ((p as { message: Message }).message.content[0] as { text: string }).text === "got two"), 10000);
    expect(reply).toBeDefined();
    const delivered = brainFrames(log).filter((f) => f.dir === "in" && f.frame["method"] === "user.message").map((f) => (f.frame["params"] as { message: string }).message);
    expect(delivered).toContain(r.message);
    const hellos = brainFrames(log).filter((f) => f.dir === "in" && f.frame["method"] === "hello");
    expect(hellos.length).toBeGreaterThanOrEqual(2);
  }, 20_000);

  test("requests from later milestones are answered unsupported; voice.speak and metrics.query are served; a bad request is invalid", async () => {
    const { d, log } = await start({
      on: [
        {
          event: "hello",
          requests: [
            { method: "voice.speak", params: { blocks: [], interrupt: false } },
            { method: "metrics.query", params: { node: "$event.nodeId" } },
            { method: "compute.embed", params: { texts: ["a"] } },
            { method: "made.up", params: {} },
            { method: "task.get", params: { nope: 1 } },
            { method: "store.get", params: { ns: "wake", key: "rules" } },
            { method: "store.put", params: { ns: "wake", key: "rules", value: { a: 1 } } },
            { method: "store.get", params: { ns: "wake", key: "rules" } },
            { method: "event.list", params: {} },
            { method: "tool.list", params: {} },
            { method: "event.history", params: { name: "my.nothing" } },
            // The grants' namespaces are the daemon's own, whichever store request asks.
            { method: "store.get", params: { ns: "grants", key: "grt_x" } },
            { method: "store.put", params: { ns: "grants.local", key: "ctl_x", value: {} } },
            { method: "store.delete", params: { ns: "cluster", key: "id" } },
            { method: "store.list", params: { ns: "controllers" } },
          ],
        },
      ],
    });
    await waitFor(() => d.brain?.state === "up");
    await waitFor(() => brainFrames(log).filter((f) => f.dir === "in" && (f.frame["result"] !== undefined || f.frame["error"] !== undefined)).length >= 15);
    const responses = brainFrames(log).filter((f) => f.dir === "in" && (f.frame["result"] !== undefined || f.frame["error"] !== undefined));
    const codes = responses.map((f) => (f.frame["error"] as { data?: { code: string } } | undefined)?.data?.code ?? "ok");
    // `voice.speak` answers now: with voice off there is nothing to speak to, and the call still succeeds.
    // `metrics.query` on this node answers with what the sampler has, possibly nothing yet.
    expect(codes).toEqual(["ok", "ok", "unsupported", "unsupported", "invalid", "ok", "ok", "ok", "ok", "ok", "ok", "denied", "denied", "denied", "denied"]);
    expect(d.store.kv.get("grants.local", "ctl_x")).toBeUndefined();
    expect(Array.isArray((responses[1]!.frame["result"] as { samples: unknown[] }).samples)).toBe(true);
    expect(responses[5]!.frame["result"]).toEqual({ value: null });
    expect(responses[7]!.frame["result"]).toEqual({ value: { a: 1 } });
    expect((responses[8]!.frame["result"] as { events: { name: string }[] }).events.map((e) => e.name)).toContain("session.ask");
    expect((responses[9]!.frame["result"] as { tools: { name: string }[] }).tools.map((t) => t.name)).toContain("fs.outline");
    expect(responses[10]!.frame["result"]).toEqual({ events: [] });
    // Unsupported and invalid requests are audited too, except the unknown method, which never reaches the gate.
    const audited = brainAudit(d).map((e) => e.action);
    expect(audited).toContain("voice.speak");
    expect(brainAudit(d).find((e) => e.action === "voice.speak")?.outcome).toBe("ok");
    expect(audited).not.toContain("made.up");
  });

  test("recall goes through the gate and the audit; a ui.say cites one hit with its source, two hits as text", async () => {
    const { d, c, ws } = await start({
      on: [
        {
          event: "user.message",
          match: { text: "recall" },
          requests: [
            { method: "recall", params: { query: "$text[1]", in: ["session"], limit: 5 } },
            {
              method: "ui.say",
              params: {
                blocks: [
                  { type: "quote", cite: { request: "$req[0]", lines: [1, 1] } },
                  { type: "quote", cite: { request: "$req[0]", lines: [1, 2] } },
                  { type: "quote", cite: { request: "$req[0]", lines: [9, 9] }, text: "none" },
                ],
              },
            },
          ],
        },
        { event: "user.message", match: { text: "around" }, requests: [{ method: "session.history", params: { id: "$text[1]", around: 2, limit: 2 } }] },
        { event: "user.message", match: { text: "empty" }, requests: [{ method: "recall", params: { query: "   " } }] },
      ],
    });
    await waitFor(() => d.brain?.state === "up");
    const spawned = await d.sessions.spawn({ harness: "claude", workspace: ws, prompt: "say hi" }, { profiles: d.profiles });
    await waitFor(() => d.sessions.get(spawned.id)?.status === "idle");

    await c.request("chat.send", { text: "recall hi" });
    const reply = await c.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "orchestrator"));
    const blocks = (reply.params as { message: Message }).message.content;
    const audit = brainAudit(d).find((e) => e.action === "recall")!;
    expect(audit.decision).toBe("allow");
    expect(audit.outcome).toBe("ok");
    expect(audit.args).toEqual({ query: "hi", in: ["session"], limit: 5 });
    const hits = (audit.result!.body as { hits: Hit[] }).hits;
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.every((h) => h.corpus === "session")).toBe(true);
    expect(blocks[0]).toEqual({ type: "quote", text: hits[0]!.snippet, source: hits[0]!.source });
    expect((blocks[0] as { source: { kind: string; session: string; seq: [number, number] } }).source).toMatchObject({ kind: "session", session: spawned.id });
    expect(blocks[1]).toEqual({ type: "quote", text: `${hits[0]!.snippet}\n${hits[1]!.snippet}` });
    expect(blocks[2]).toEqual({ type: "quote", text: "none", unresolved: true });

    await c.request("chat.send", { text: `around ${spawned.id}` });
    await waitFor(() => brainAudit(d).some((e) => e.action === "session.history" && e.outcome === "ok"));
    const history = brainAudit(d).find((e) => e.action === "session.history")!;
    expect((history.result!.body as { events: { seq: number }[] }).events.map((e) => e.seq)).toEqual([2, 3]);

    await c.request("chat.send", { text: "recall empty" });
    await waitFor(() => brainAudit(d).filter((e) => e.action === "recall").length >= 2 && brainAudit(d).filter((e) => e.action === "recall").every((e) => e.outcome !== undefined));
    expect(brainAudit(d).filter((e) => e.action === "recall").at(-1)!.outcome).toBe("error");
  });

  test("brain.context: off without show_context; on, check asks the brain nothing and a request is its context.preview, kept out of the audit row", async () => {
    const off = await start({ on: [] });
    await waitFor(() => off.d.brain?.state === "up");
    const refused = await off.c.call("brain.context", { check: true });
    expect("error" in refused && refused.error.data?.code).toBe("unsupported");
    expect("error" in refused && refused.error.message).toContain("show_context");
    off.c.close();
    await stopDaemon(off.d);
    removeHome(off.scratch);
    current = undefined;

    const preview = {
      thread: "thr_01ARZ3NDEKTSV4RRFFQ69G5FB3",
      at: 1758196800000,
      tokens: { situation: 12, working: 8, loaded: 0, log: 5, total: 25 },
      rules: "You are Cophyla.",
      situation: "Now: Tuesday",
      log: "Instructions:\nL1 11:02 the series, one section at a time",
      messages: [{ role: "user", content: [{ type: "text", text: "what is open?" }] }],
      tools: ["agents", "tasks"],
    };
    const { d, c, log, scratch } = await start({ on: [], preview }, { brain: "show_context = true\n" });
    await waitFor(() => d.brain?.state === "up");
    expect(await c.request<object>("brain.context", { check: true })).toEqual({});
    expect(brainFrames(log).some((f) => f.frame["method"] === "context.preview")).toBe(false);
    expect(await c.request<object>("brain.context", {})).toEqual({ context: preview });
    const asked = brainFrames(log).find((f) => f.dir === "in" && f.frame["method"] === "context.preview")!;
    expect(asked.frame["params"]).toEqual({});
    const rows = d.store.audit.list({ limit: 50 }).filter((e) => e.action === "brain.context" && e.outcome === "ok");
    expect(rows.map((e) => e.result?.body)).toContainEqual({ context: { thread: preview.thread, at: preview.at, tokens: preview.tokens } });
    expect(JSON.stringify(rows)).not.toContain("You are Cophyla.");

    // A brain from before the request, and one whose answer is not a context.
    writeFileSync(join(scratch, "brain-script.json"), JSON.stringify({ on: [] }));
    const old = await c.call("brain.context", {});
    expect("error" in old && old.error.data?.code).toBe("unsupported");
    writeFileSync(join(scratch, "brain-script.json"), JSON.stringify({ on: [], preview: { thread: 7 } }));
    const bad = await c.call("brain.context", {});
    expect("error" in bad && bad.error.data?.code).toBe("unavailable");
  });

  test("a session annotated by the daemon reaches the brain as one session.updated without an event", async () => {
    const { d, log, ws } = await start({ on: [] });
    await waitFor(() => d.brain?.state === "up");
    const spawned = await d.sessions.spawn({ harness: "claude", workspace: ws, prompt: "say hi" }, { profiles: d.profiles });
    await waitFor(() => d.sessions.get(spawned.id)?.status === "idle");
    await sleep(300);
    const updates = () => brainFrames(log).filter((f) => f.dir === "in" && f.frame["method"] === "session.updated").map((f) => f.frame["params"] as { session: { id: string; summary?: string; tags: string[] }; event?: unknown });
    expect(updates().every((u) => u.event !== undefined)).toBe(true);
    d.sessions.annotate(spawned.id, { summary: "said hi", tags: ["greeting"] });
    await waitFor(() => updates().some((u) => u.event === undefined));
    await sleep(300);
    const bare = updates().filter((u) => u.event === undefined);
    expect(bare).toHaveLength(1);
    expect(bare[0]!.session).toMatchObject({ id: spawned.id, summary: "said hi", tags: ["greeting"] });
    // The same annotation again changes nothing, so nothing is announced.
    d.sessions.annotate(spawned.id, { summary: "said hi" });
    await sleep(300);
    expect(updates().filter((u) => u.event === undefined)).toHaveLength(1);
  });
});
