// Milestone 7 over the socket, with the fake brain: a tool file written into the home is
// loaded, the brain hears `tools.changed`, runs the tool under the gate's `exec` policy (an
// ask the user answers, or a rule that allows it) and the audit says so; a hook's emit
// becomes `event.custom`, is listed under the hook in `event.list` and in `event.history`,
// and fires a task whose `task.ready` carries the event; a recurring cron task is paused
// and resumed from the client; a pending time trigger in the past fires after a restart,
// and the editable tool is in `tool.list` at the new handshake; the brain's hello carries
// the zone.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditEntry, EventDefinition, Task } from "@cophyla/protocol";
import type { Daemon } from "../src/daemon.ts";
import { isMethod, removeHome, sleep, stopDaemon, tempHome, TestClient, tomlString, waitFor } from "./helpers.ts";

const FAKE_BRAIN = join(import.meta.dir, "fakes", "brain.ts");
const FAKE_AGENT = join(import.meta.dir, "fakes", "acp-agent.ts");
const DEFAULT_RULES: Record<string, string> = {
  "brain:ui.say": "allow",
  "brain:task.create": "allow",
  "brain:task.update": "allow",
  "brain:thread.start": "allow",
};

interface Started {
  d: Daemon & { home: string };
  c: TestClient;
  log: string;
  scratch: string;
  scriptPath: string;
}

let current: Started | undefined;

afterEach(async () => {
  if (!current) return;
  current.c.close();
  await stopDaemon(current.d);
  removeHome(current.scratch);
  current = undefined;
});

function configToml(scratch: string, rules: Record<string, string>): string {
  const configDir = join(scratch, "claude-home");
  mkdirSync(configDir, { recursive: true });
  return (
    `[node]\ntz = "Europe/Istanbul"\n\n[nodes]\ndiscovery = false\n\n[sessions]\ndiscover = false\ninstall_hooks = false\nlaunch = "acp"\n\n[editable]\npoll_ms = 0\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(configDir)}\n\n` +
    `[brain]\ncommand = ${tomlString(FAKE_BRAIN)}\nrestart_backoff_ms = 100\nhello_timeout_ms = 5000\n\n[acp.claude]\ncommand = ${tomlString(FAKE_AGENT)}\n\n` +
    `[gate.rules]\n${Object.entries({ ...DEFAULT_RULES, ...rules }).map(([k, v]) => `"${k}" = "${v}"`).join("\n")}\n`
  );
}

async function boot(scratch: string, scriptPath: string, log: string): Promise<Daemon & { home: string }> {
  const { startDaemon } = await import("../src/daemon.ts");
  const { silentLogger } = await import("../src/log.ts");
  return Object.assign(
    await startDaemon({ home: scratch, port: 0, log: silentLogger, embedder: null, env: { ...process.env, FAKE_BRAIN_SCRIPT: scriptPath, FAKE_BRAIN_LOG: log, FAKE_BRAIN_RANGE: "1-1", GEMINI_API_KEY: undefined } }),
    { home: scratch },
  );
}

/** A daemon on a scratch home with the fake brain running `script`, and a client. */
async function start(script: object, opts: { rules?: Record<string, string> } = {}): Promise<Started> {
  const scratch = tempHome();
  const scriptPath = join(scratch, "brain-script.json");
  writeFileSync(scriptPath, JSON.stringify(script));
  const log = join(scratch, "brain.log");
  writeFileSync(join(scratch, "config.toml"), configToml(scratch, opts.rules ?? {}));
  const d = await boot(scratch, scriptPath, log);
  const c = await TestClient.connect(d.api.url);
  await c.hello(d.token, { name: "test" });
  current = { d, c, log, scratch, scriptPath };
  return current;
}

const brainAudit = (d: Daemon): AuditEntry[] => d.store.audit.list({ limit: 500 }).filter((e) => e.principal.kind === "brain").reverse();
const brainFrames = (log: string): { dir: string; frame: Record<string, unknown> }[] => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const eventsIn = (log: string, name: string) => brainFrames(log).filter((f) => f.dir === "in" && f.frame["method"] === name).map((f) => f.frame["params"] as Record<string, unknown>);

const ECHO_TOOL = 'export const name = "my.echo";\nexport const description = "echoes";\nexport const risk = "read";\nexport const schema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };\nexport function run(args: { text: string }) { return { echoed: args.text }; }\n';

describe("automation: tools", () => {
  test("a tool written into the home reaches the brain as tools.changed; the run is asked under the exec policy, then allowed by a rule", async () => {
    const { d, c, log } = await start({
      on: [{ event: "tools.changed", requests: [{ method: "tool.list", params: {} }, { method: "tool.run", params: { name: "my.echo", args: { text: "hi" } } }, { method: "ui.say", params: { blocks: [{ type: "text", text: "echo: $last.result.echoed" }] } }] }],
    });
    await waitFor(() => d.brain?.state === "up");
    const hello = brainFrames(log).find((f) => f.dir === "in" && f.frame["method"] === "hello")!;
    expect((hello.frame["params"] as { tz: string }).tz).toBe("Europe/Istanbul");
    expect(d.tz).toBe("Europe/Istanbul");
    writeFileSync(join(d.home, "tools", "my.echo.ts"), ECHO_TOOL);
    await d.editable.rescan();
    const changed = await waitFor(() => eventsIn(log, "tools.changed")[0]);
    expect(changed["problems"]).toBeUndefined();
    // The run is held for the user: exec asks by default, and an editable read tool is exec.
    const askState = await c.next(isMethod("ask.state", (p) => (p as { status: string }).status === "open"));
    const ask = askState.params as { id: string; source: { kind: string; action: string } };
    expect(ask.source).toMatchObject({ kind: "gate", action: "tool.run" });
    await c.request("ask.answer", { id: ask.id, option: "allow" });
    const reply = await c.next(isMethod("chat.message", (p) => (p as { message: { role: string } }).message.role === "orchestrator"));
    expect(((reply.params as { message: { content: { text: string }[] } }).message.content[0] as { text: string }).text).toBe("echo: hi");
    const run = brainAudit(d).find((e) => e.action === "tool.run")!;
    expect(run.target).toBe("my.echo");
    expect(run.decision).toBe("ask");
    expect(run.outcome).toBe("ok");
    const listed = brainFrames(log).find((f) => f.dir === "in" && f.frame["id"] === "r1")!.frame["result"] as { tools: { name: string; source: string; risk: string }[] };
    expect(listed.tools.find((t) => t.name === "my.echo")).toMatchObject({ source: "editable", risk: "exec" });

    // A broken rewrite: the brain hears the problem, the old tool still runs.
    await sleep(15);
    writeFileSync(join(d.home, "tools", "my.echo.ts"), "export const name = ;\n");
    await d.editable.rescan();
    const second = await waitFor(() => eventsIn(log, "tools.changed")[1]);
    expect(second["problems"]).toEqual([{ file: "tools/my.echo.ts", message: expect.stringMatching(/^my\.echo\.ts: /) }]);
    expect(d.tools.get("my.echo")).toBeDefined();
  });

  test("a rule on the tool's name allows the run without asking", async () => {
    const { d, c, log } = await start(
      { on: [{ event: "tools.changed", requests: [{ method: "tool.run", params: { name: "my.echo", args: { text: "quiet" } } }, { method: "ui.say", params: { blocks: [{ type: "text", text: "echo: $last.result.echoed" }] } }] }] },
      { rules: { "brain:tool.run@my.echo": "allow" } },
    );
    await waitFor(() => d.brain?.state === "up");
    writeFileSync(join(d.home, "tools", "my.echo.ts"), ECHO_TOOL);
    await d.editable.rescan();
    const reply = await c.next(isMethod("chat.message", (p) => (p as { message: { role: string } }).message.role === "orchestrator"));
    expect(((reply.params as { message: { content: { text: string }[] } }).message.content[0] as { text: string }).text).toBe("echo: quiet");
    const run = brainAudit(d).find((e) => e.action === "tool.run")!;
    expect(run.decision).toBe("allow");
    expect(run.outcome).toBe("ok");
    expect(eventsIn(log, "tools.changed")).toHaveLength(1);
  });
});

describe("automation: hooks and triggers", () => {
  test("a hook's emit fires an event task: task.ready carries the event, event.list has the hook's event, event.history has the record", async () => {
    const { d, c, log } = await start({
      on: [
        { event: "task.ready", requests: [{ method: "task.get", params: { id: "$event.id" } }, { method: "event.history", params: { name: "my.ping" } }, { method: "event.list", params: {} }] },
      ],
    });
    await waitFor(() => d.brain?.state === "up");
    const { id } = await c.request<{ id: string }>("task.create", { title: "on ping", trigger: { kind: "event", name: "my.ping", match: { branch: "main" } }, recurring: true });
    const pending = await c.next(isMethod("task.state", (p) => (p as Task).id === id));
    expect((pending.params as Task).status).toBe("pending");
    writeFileSync(
      join(d.home, "hooks", "pinger.ts"),
      'export const events = [{ name: "my.ping", description: "a ping", payload: { type: "object", properties: { branch: { type: "string" } } } }];\nexport const on = { start(ctx) { ctx.emit("my.ping", { branch: "dev" }); ctx.emit("my.ping", { branch: "main", n: 1 }); } };\n',
    );
    await d.editable.rescan();
    const ready = await c.next(isMethod("task.state", (p) => (p as Task).id === id && (p as Task).status === "ready"));
    expect((ready.params as Task).status).toBe("ready");
    const fired = await waitFor(() => eventsIn(log, "task.ready").find((e) => e["id"] === id));
    expect(fired).toMatchObject({ id, cause: "trigger", event: { name: "my.ping", payload: { branch: "main", n: 1 } } });
    const customs = eventsIn(log, "event.custom");
    expect(customs.map((e) => e["payload"])).toEqual([{ branch: "dev" }, { branch: "main", n: 1 }]);
    const changed = eventsIn(log, "events.changed");
    expect(changed).toHaveLength(1);
    const { events } = await c.request<{ events: EventDefinition[] }>("event.list", {});
    expect(events.find((e) => e.name === "my.ping")).toEqual({ name: "my.ping", description: "a ping", payload: { type: "object", properties: { branch: { type: "string" } } }, source: { hook: "pinger" }, node: d.identity.id });
    const history = await waitFor(() => brainFrames(log).find((f) => f.dir === "in" && f.frame["id"] === "r2" && f.frame["result"] !== undefined));
    expect((history.frame["result"] as { events: { name: string; payload: unknown }[] }).events.map((e) => e.payload)).toEqual([{ branch: "dev" }, { branch: "main", n: 1 }]);
    const list = await waitFor(() => brainFrames(log).find((f) => f.dir === "in" && f.frame["id"] === "r3" && f.frame["result"] !== undefined));
    expect((list.frame["result"] as { events: EventDefinition[] }).events.some((e) => e.name === "my.ping")).toBe(true);
    // Done re-arms it; the hook emits again on reload and the task fires again.
    await c.request("task.update", { id, patch: { status: "done", result: { summary: "handled" } } });
    await c.next(isMethod("task.state", (p) => (p as Task).id === id && (p as Task).status === "pending" && (p as Task).result !== undefined));
    await sleep(15);
    writeFileSync(join(d.home, "hooks", "pinger.ts"), 'export const on = { start(ctx) { ctx.emit("my.ping", { branch: "main", n: 2 }); } };\n');
    await d.editable.rescan();
    await waitFor(() => eventsIn(log, "task.ready").filter((e) => e["id"] === id).length === 2);
    expect(d.tasks.get(id)!.result).toEqual({ summary: "handled" });
  });

  test("a recurring cron task is paused and resumed from the client; a paused one never fires", async () => {
    const { d, c } = await start({ on: [] });
    await waitFor(() => d.brain?.state === "up");
    const { id } = await c.request<{ id: string }>("task.create", { title: "leap day", trigger: { kind: "cron", expr: "0 0 29 2 *" }, recurring: true });
    expect(d.tasks.get(id)!.status).toBe("pending");
    await c.request("task.update", { id, patch: { status: "paused" } });
    expect(d.tasks.get(id)!.status).toBe("paused");
    d.scheduler.tick();
    expect(d.tasks.get(id)!.status).toBe("paused");
    await c.request("task.update", { id, patch: { status: "pending" } });
    expect(d.tasks.get(id)!.status).toBe("pending");
    expect(d.tasks.get(id)!.trigger).toEqual({ kind: "cron", expr: "0 0 29 2 *" });
    expect(d.tasks.get(id)!.recurring).toBe(true);
    const bad = await c.call("task.create", { title: "bad", trigger: { kind: "cron", expr: "nope" } });
    expect("error" in bad && bad.error.data?.code).toBe("invalid");
  });

  test("a time trigger missed while the daemon was down fires after the restart, and the editable tool is listed at the new handshake", async () => {
    const started = await start({
      on: [{ event: "task.ready", requests: [{ method: "tool.list", params: {} }] }],
    });
    const { scratch, scriptPath, log } = started;
    await waitFor(() => started.d.brain?.state === "up");
    writeFileSync(join(scratch, "tools", "my.echo.ts"), ECHO_TOOL);
    await started.d.editable.rescan();
    await waitFor(() => started.d.tools.get("my.echo") !== undefined);
    started.c.close();
    await started.d.stop();
    current = undefined;
    // While down: a task due in the past.
    const { Store } = await import("../src/store/index.ts");
    const store = new Store(join(scratch, "data", "cophyla.sqlite"));
    store.migrate();
    const at = Date.now() - 60_000;
    store.tasks.insert({ id: "task_01ARZ3NDEKTSV4RRFFQ69G5FB2", title: "overdue", createdBy: { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" }, status: "pending", priority: "normal", trigger: { kind: "at", at }, sessions: [], createdAt: at, updatedAt: at });
    store.close();
    const d = await boot(scratch, scriptPath, log);
    const c = await TestClient.connect(d.api.url);
    await c.hello(d.token, { name: "again" });
    current = { d, c, log, scratch, scriptPath };
    await waitFor(() => d.brain?.state === "up");
    expect(d.tasks.get("task_01ARZ3NDEKTSV4RRFFQ69G5FB2")!.status).toBe("ready");
    const fired = await waitFor(() => eventsIn(log, "task.ready").find((e) => e["id"] === "task_01ARZ3NDEKTSV4RRFFQ69G5FB2"));
    expect(fired["cause"]).toBe("trigger");
    // The hello came after the fire (the event waited in the outbox), and the tool is there.
    const hellos = brainFrames(log).filter((f) => f.dir === "in" && f.frame["method"] === "hello");
    expect(hellos).toHaveLength(2);
    const listed = await waitFor(() => brainFrames(log).filter((f) => f.dir === "in" && f.frame["result"] !== undefined && (f.frame["result"] as { tools?: unknown }).tools !== undefined).pop());
    expect((listed.frame["result"] as { tools: { name: string }[] }).tools.some((t) => t.name === "my.echo")).toBe(true);
    expect(d.tools.source("my.echo")).toBe("editable");
  });
});
