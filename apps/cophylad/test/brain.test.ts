// Milestone 3 over the socket, with the fake brain, the fake ACP agent and the fake Gemini:
// a `chat.send` reaches the brain as `user.message`; the brain quotes a session's history
// under a session source; asked for a change it creates a task, spawns an agent in the
// workspace (transport acp, task set) and blocks the task on the session; the agent's
// permission request arrives as `ask.state` with a harness source and the brain parks the
// task on it; a second `chat.send` is answered meanwhile; the user's answer and the session
// going idle each raise `task.ready`; the brain reports with a quote and marks the task done;
// a quick `chat.send` yields an `llm.complete` audit row with no tools; a `chat.send` mid-turn
// yields a `cancel`; killing the brain mid-task leaves the task, thread and ask visible and
// the next brain picks the task up.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ask, AuditEntry, Message, Task } from "@cophyla/protocol";
import type { Daemon } from "../src/daemon.ts";
import type { GeminiFake } from "./fakes/gemini.ts";
import { finish, startGeminiFake, text as geminiText } from "./fakes/gemini.ts";
import { isMethod, removeHome, stopDaemon, tempHome, TestClient, tomlString, waitFor } from "./helpers.ts";

const FAKE_BRAIN = join(import.meta.dir, "fakes", "brain.ts");
const FAKE_AGENT = join(import.meta.dir, "fakes", "acp-agent.ts");
const RULES: Record<string, string> = {
  "brain:session.spawn": "allow",
  "brain:session.send": "allow",
  "brain:ui.say": "allow",
  "brain:ui.ask": "allow",
  "brain:thread.start": "allow",
  "brain:task.create": "allow",
  "brain:task.update": "allow",
  "brain:llm.complete": "allow",
  "brain:store.put": "allow",
};

interface Started {
  d: Daemon & { home: string };
  c: TestClient;
  log: string;
  scratch: string;
  gemini: GeminiFake;
  ws: string;
  scriptPath: string;
}

let current: Started | undefined;

afterEach(async () => {
  if (!current) return;
  current.c.close();
  await stopDaemon(current.d);
  await current.gemini.stop();
  removeHome(current.scratch);
  current = undefined;
});

/** The whole milestone as one brain script, a function of the workspace id; the restarted brain gets a hello handler too. */
function script(ws: string, restarted = false): object {
  return {
    cancelOnUserMessage: true,
    on: [
      // A restarted brain finds the task it left and brings it up.
      ...(restarted ? [{ event: "hello", requests: [{ method: "task.list", params: { filter: { status: ["blocked", "ready", "active"] } } }, { method: "ui.say", params: { blocks: [{ type: "text", text: "Back. Still open:" }, { type: "ref", task: "$last.tasks[0].id" }] } }] }] : []),
      // What is that session doing? Quote it.
      {
        event: "user.message",
        match: { text: "what is" },
        requests: [
          { method: "session.history", params: { id: "$text[2]", limit: 20 } },
          { method: "ui.say", params: { blocks: [{ type: "text", text: "It said:" }, { type: "quote", cite: { request: "$prev", lines: [3, 3] } }] } },
        ],
      },
      // A change in a workspace: task → active → spawn → block on the session → reply with both refs.
      {
        event: "user.message",
        match: { text: "fix the build" },
        requests: [
          { method: "task.create", params: { title: "fix the build", detail: "$event.text", workspace: ws, thread: "$event.thread" } },
          { method: "task.update", params: { id: "$res[0].id", patch: { status: "active" } } },
          { method: "session.spawn", params: { harness: "claude", workspace: ws, prompt: "please ask before you fix the build", task: "$res[0].id" } },
          { method: "task.update", params: { id: "$res[0].id", patch: { sessions: ["$res[2].id"], blocker: { kind: "session", session: "$res[2].id" } } } },
          { method: "ui.say", params: { blocks: [{ type: "text", text: "Started an agent." }, { type: "ref", session: "$res[2].id" }, { type: "ref", task: "$res[0].id" }] } },
        ],
      },
      // The agent asks: park the task on the ask and say so in one line.
      {
        event: "session.ask",
        requests: [
          { method: "task.list", params: { filter: { status: ["blocked"] } } },
          { method: "task.update", params: { id: "$res[0].tasks[0].id", patch: { blocker: { kind: "ask", ask: "$event.ask.id" } } } },
          { method: "ui.say", params: { blocks: [{ type: "text", text: "The agent asks: $event.ask.title" }, { type: "ref", ask: "$event.ask.id" }] } },
        ],
      },
      // An unrelated question meanwhile.
      { event: "user.message", match: { text: "what else" }, requests: [{ method: "ui.say", params: { blocks: [{ type: "text", text: "Nothing else is running." }] } }] },
      // The ask was answered: the task waits on the session again.
      {
        event: "task.ready",
        nth: 1,
        requests: [
          { method: "task.get", params: { id: "$event.id" } },
          { method: "task.update", params: { id: "$event.id", patch: { blocker: { kind: "session", session: "$res[0].task.sessions[0]" } } } },
        ],
      },
      // The session went idle: read its history, report with a quote, complete the task.
      {
        event: "task.ready",
        nth: 2,
        requests: [
          { method: "task.get", params: { id: "$event.id" } },
          { method: "session.history", params: { id: "$res[0].task.sessions[0]", limit: 40 } },
          { method: "ui.say", params: { blocks: [{ type: "text", text: "The agent finished:" }, { type: "quote", cite: { request: "$prev", lines: [1, 40] } }, { type: "ref", task: "$event.id" }] } },
          { method: "task.update", params: { id: "$event.id", patch: { status: "done", result: { summary: "the agent finished" } } } },
        ],
      },
      // A quick question goes to the model with no tools.
      {
        event: "user.message",
        match: { mode: "quick" },
        requests: [
          { method: "llm.complete", params: { model: { tier: "fast" }, system: "Answer in one line.", messages: [{ role: "user", content: [{ type: "text", text: "$event.text" }] }] } },
          { method: "ui.say", params: { blocks: [{ type: "text", text: "$last.content[0].text" }] } },
        ],
      },
      // A slow turn, to be cut short by the next message.
      {
        event: "user.message",
        match: { text: "think hard" },
        requests: [
          { method: "llm.complete", params: { model: { tier: "fast" }, messages: [{ role: "user", content: [{ type: "text", text: "slow" }] }] } },
          { method: "ui.say", params: { blocks: [{ type: "text", text: "$last.content[0].text" }] } },
        ],
      },
      { event: "user.message", match: { text: "never mind" }, requests: [{ method: "ui.say", params: { blocks: [{ type: "text", text: "Dropped it." }] } }] },
    ],
  };
}

async function start(): Promise<Started> {
  const scratch = tempHome();
  const cwd = join(scratch, "work");
  const configDir = join(scratch, "claude-home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const scriptPath = join(scratch, "brain-script.json");
  writeFileSync(scriptPath, JSON.stringify({ on: [] }));
  const log = join(scratch, "brain.log");
  const gemini = startGeminiFake({
    delayMs: 20,
    scripts: {
      default: [geminiText("Yes, it is done."), finish("STOP")],
      slow: [...Array.from({ length: 150 }, () => geminiText(".")), finish("STOP")],
    },
  });
  const toml =
    `[nodes]\ndiscovery = false\n\n[sessions]\ndiscover = false\ninstall_hooks = false\nlaunch = "acp"\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(configDir)}\n\n` +
    `[brain]\ncommand = ${tomlString(FAKE_BRAIN)}\nrestart_backoff_ms = 100\nhello_timeout_ms = 5000\n\n[acp.claude]\ncommand = ${tomlString(FAKE_AGENT)}\n\n` +
    `[providers.gemini]\napi_key = "k"\nbase_url = "${gemini.url}"\n\n[gate.rules]\n${Object.entries(RULES)
      .map(([k, v]) => `"${k}" = "${v}"`)
      .join("\n")}\n`;
  writeFileSync(join(scratch, "config.toml"), toml);
  const { startDaemon } = await import("../src/daemon.ts");
  const { silentLogger } = await import("../src/log.ts");
  const d = Object.assign(await startDaemon({ home: scratch, port: 0, log: silentLogger, env: { ...process.env, FAKE_BRAIN_SCRIPT: scriptPath, FAKE_BRAIN_LOG: log, GEMINI_API_KEY: undefined } }), { home: scratch });
  const ws = d.workspaces.put({ node: d.identity.id, path: cwd, name: "work" }).id;
  writeFileSync(scriptPath, JSON.stringify(script(ws)));
  const c = await TestClient.connect(d.api.url);
  await c.hello(d.token, { name: "test" });
  current = { d, c, log, scratch, gemini, ws, scriptPath };
  return current;
}

const brainAudit = (d: Daemon): AuditEntry[] => d.store.audit.list({ limit: 500 }).filter((e) => e.principal.kind === "brain").reverse();
const brainFrames = (log: string): { dir: string; frame: Record<string, unknown> }[] => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
/** The next orchestrator message not yet seen by this test. */
const seen = new Set<string>();
async function nextSay(c: TestClient, timeoutMs = 5000): Promise<Message> {
  const n = await c.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "orchestrator" && !seen.has((p as { message: Message }).message.id)), timeoutMs);
  const m = (n.params as { message: Message }).message;
  seen.add(m.id);
  return m;
}

describe("milestone 3: brain conversation", () => {
  test("the conversation: quote a session, start an agent, park on its ask, answer meanwhile, report and complete; quick and cancel; a restart picks the task up", async () => {
    const { d, c, ws, log, scriptPath } = await start();
    await waitFor(() => d.brain?.state === "up");

    // 1. A user session (spawned here for want of a terminal) and a question about it: the reply quotes it.
    const theirs = await d.sessions.spawn({ harness: "claude", workspace: ws, prompt: "say hi" }, { profiles: d.profiles });
    await waitFor(() => d.sessions.get(theirs.id)?.status === "idle");
    const r1 = await c.request<{ message: string }>("chat.send", { text: `what is ${theirs.id} doing` });
    const userMessage = await waitFor(() => brainFrames(log).find((f) => f.dir === "in" && f.frame["method"] === "user.message"));
    expect((userMessage.frame["params"] as { message: string; text: string }).message).toBe(r1.message);
    const quoted = await nextSay(c);
    expect(quoted.content[0]).toEqual({ type: "text", text: "It said:" });
    expect(quoted.content[1]).toEqual({ type: "quote", text: "Hi there.", source: { kind: "session", session: theirs.id, seq: [3, 3] } });

    // 2. A change: the brain creates a task, spawns an agent over ACP for it and blocks the task on the session.
    await c.request("chat.send", { text: "fix the build in work" });
    const started = await nextSay(c);
    expect(started.content[0]).toEqual({ type: "text", text: "Started an agent." });
    const sessionRef = (started.content[1] as { session: string }).session;
    const taskRef = (started.content[2] as { task: string }).task;
    const agent = d.sessions.get(sessionRef)!;
    expect(agent.native.transport).toBe("acp");
    expect(agent.origin).toBe("orchestrator");
    expect(agent.task).toBe(taskRef);
    expect(agent.workspace).toBe(ws);
    let task = d.tasks.get(taskRef)!;
    expect(task.sessions).toEqual([sessionRef]);
    expect(task.thread).toBe(d.chat.current().id);

    // 3. The agent's permission request is an Ask with a harness source; the brain parks the task on it.
    const askState = await c.next(isMethod("ask.state", (p) => (p as Ask).status === "open" && (p as Ask).source.kind === "harness"));
    const ask = askState.params as Ask;
    expect(ask.source).toEqual({ kind: "harness", session: sessionRef });
    expect(ask.answerableBy).toEqual(["user", "brain"]);
    await waitFor(() => d.tasks.get(taskRef)?.blocker?.kind === "ask");
    task = d.tasks.get(taskRef)!;
    expect(task.status).toBe("blocked");
    expect(task.blocker).toEqual({ kind: "ask", ask: ask.id });
    const parkedSay = await nextSay(c);
    expect(parkedSay.content[0]).toEqual({ type: "text", text: `The agent asks: ${ask.title}` });
    expect(parkedSay.content[1]).toEqual({ type: "ref", ask: ask.id });
    const taskStates = c.notifications.filter((n) => n.method === "task.state").map((n) => n.params as Task);
    expect(taskStates.some((t) => t.id === taskRef && t.status === "blocked" && t.blocker?.kind === "ask")).toBe(true);

    // 4. An unrelated question is answered while the task waits.
    await c.request("chat.send", { text: "what else is going on" });
    const meanwhile = await nextSay(c);
    expect(meanwhile.content).toEqual([{ type: "text", text: "Nothing else is running." }]);
    expect(d.tasks.get(taskRef)!.status).toBe("blocked");

    // 5. The user answers: task.ready; the brain waits on the session again; the session goes idle: task.ready; the brain reports and completes.
    await c.request("ask.answer", { id: ask.id, option: "allow-once" });
    const report = await nextSay(c, 10_000);
    expect(report.content[0]).toEqual({ type: "text", text: "The agent finished:" });
    const quote = report.content[1] as { type: string; text: string; source: { kind: string; session: string } };
    expect(quote.type).toBe("quote");
    expect(quote.source).toMatchObject({ kind: "session", session: sessionRef });
    expect(quote.text).toContain("you chose allow-once");
    expect(report.content[2]).toEqual({ type: "ref", task: taskRef });
    await waitFor(() => d.tasks.get(taskRef)?.status === "done");
    expect(d.tasks.get(taskRef)!.result).toEqual({ summary: "the agent finished" });
    const readies = brainFrames(log).filter((f) => f.dir === "in" && f.frame["method"] === "task.ready");
    expect(readies).toHaveLength(2);
    expect(readies.map((f) => (f.frame["params"] as { id: string; cause: string }).cause)).toEqual(["unblocked", "unblocked"]);

    // 6. A quick message: the brain's llm.complete carries no tools and the mode reached it.
    await c.request("chat.send", { text: "is it done", mode: "quick" });
    const quick = await nextSay(c);
    expect(quick.content).toEqual([{ type: "text", text: "Yes, it is done." }]);
    const quickEvent = brainFrames(log).find((f) => f.dir === "in" && f.frame["method"] === "user.message" && (f.frame["params"] as { mode?: string }).mode === "quick");
    expect(quickEvent).toBeDefined();
    const llm = brainAudit(d).filter((e) => e.action === "llm.complete");
    expect(llm).toHaveLength(1);
    expect(llm[0]!.outcome).toBe("ok");
    expect((llm[0]!.args as { tools?: unknown }).tools).toBeUndefined();

    // 7. A message mid-turn: the brain cancels the request in flight; the cancel and the cancelled call are both in the audit.
    await c.request("chat.send", { text: "think hard about it" });
    await waitFor(() => brainAudit(d).filter((e) => e.action === "llm.complete").length === 2);
    await c.request("chat.send", { text: "never mind" });
    const dropped = await nextSay(c);
    expect(dropped.content).toEqual([{ type: "text", text: "Dropped it." }]);
    await waitFor(() => brainAudit(d).find((e) => e.action === "cancel")?.outcome === "ok");
    await waitFor(() => brainAudit(d).filter((e) => e.action === "llm.complete")[1]?.outcome === "cancelled");

    // 8. Killed mid-task: the task, thread and ask stay; the next brain picks the task up.
    await c.request("chat.send", { text: "fix the build again" });
    const again = await nextSay(c);
    const task2 = (again.content[2] as { task: string }).task;
    const ask2 = (await c.next(isMethod("ask.state", (p) => (p as Ask).status === "open" && (p as Ask).id !== ask.id))).params as Ask;
    await waitFor(() => d.tasks.get(task2)?.blocker?.kind === "ask");
    expect((await nextSay(c)).content[1]).toEqual({ type: "ref", ask: ask2.id });
    const instance = d.brain!.instanceId;
    writeFileSync(scriptPath, JSON.stringify(script(ws, true)));
    d.brain!.kill();
    await waitFor(() => d.brain?.state === "up" && d.brain.instanceId !== instance, 10_000);
    expect(d.tasks.get(task2)!.status).toBe("blocked");
    expect(d.tasks.get(task2)!.blocker).toEqual({ kind: "ask", ask: ask2.id });
    expect(d.asks.get(ask2.id)!.status).toBe("open");
    expect(d.chat.current().id).toBe(task.thread!);
    const back = await nextSay(c, 10_000);
    expect(back.content).toEqual([{ type: "text", text: "Back. Still open:" }, { type: "ref", task: task2 }]);
  }, 60_000);
});
