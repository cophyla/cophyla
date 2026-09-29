// The brain's listeners over a real store, bus and event stream: each kind of event and each
// filter; `times` counting down to a last fire that removes the listener; `cooldownS`; a
// listener `until` a task that settles or a session that ends; what `listener.add` refuses;
// the fire raised after the event that caused it; the listeners and their counts kept across
// a restart of the module. A metric condition over a manually ticked sampler: held for its
// window it fires once, not held it does not, back across the line it re-arms, a line at the
// scale's end fires again after another window; the sampler runs faster only while a metric
// listener exists. Another node's metric is watched over the link under `listener:<id>`, its
// samples routed back to the module, watched again when the node links again. Last, across a
// real primary and secondary, the link's watch and the secondary's sampler.

import { afterEach, describe, expect, test } from "bun:test";
import type { Listener, ListenerSpec, MetricsSample, Node, Session, SessionEvent, Task } from "@cophyla/protocol";
import { Bus } from "../src/bus.ts";
import type { BusEvents } from "../src/bus.ts";
import { parseConfig } from "../src/config/load.ts";
import { EventStream } from "../src/events/stream.ts";
import type { StreamEvent } from "../src/events/stream.ts";
import { Listeners, LISTENERS_NS, MAX_LISTENERS } from "../src/listeners/index.ts";
import { intervalFor } from "../src/listeners/metric.ts";
import { silentLogger } from "../src/log.ts";
import type { RawSample } from "../src/metrics/engine.ts";
import { FakeEngine } from "../src/metrics/fake.ts";
import { Metrics } from "../src/metrics/index.ts";
import { Store } from "../src/store/index.ts";
import { waitFor } from "./helpers.ts";
import { linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const WS = "ws_01ARZ3NDEKTSV4RRFFQ69G5FB0";
const WS2 = "ws_01ARZ3NDEKTSV4RRFFQ69G5FB9";
const S1 = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1";
const S2 = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB2";
const T1 = "task_01ARZ3NDEKTSV4RRFFQ69G5FB3";
const T2 = "task_01ARZ3NDEKTSV4RRFFQ69G5FB4";
const PROFILE = "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8";
const T0 = Math.floor(1_700_000_000_000 / 60000) * 60000 + 10_000;

function session(id: string, over: Partial<Session> = {}): Session {
  return { id, node: NODE, harness: "claude", profile: PROFILE, native: { id: "n", transport: "pipe" }, origin: "orchestrator", workspace: WS, cwd: "/w", tags: [], status: "busy", startedAt: T0, lastActivity: T0, ...over };
}

function task(id: string, over: Partial<Task> = {}): Task {
  return { id, title: "t", createdBy: { kind: "brain" }, status: "blocked", priority: "normal", sessions: [], createdAt: T0, updatedAt: T0, ...over };
}

let seq = 0;
function ev(s: string, kind: SessionEvent["kind"], payload: unknown): SessionEvent {
  return { session: s, seq: ++seq, at: T0 + seq, kind, payload };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

interface Rig {
  listeners: Listeners;
  store: Store;
  bus: Bus;
  stream: EventStream;
  metrics: Metrics;
  sessions: Map<string, Session>;
  tasks: Map<string, Task>;
  clock: { now: number };
  fired: BusEvents["listener.fired"][];
  removed: BusEvents["listener.removed"][];
  /** Every stream event in order, the fires and removals among them. */
  order: string[];
  remote: { watched: Map<string, { node: string; intervalMs: number }>; fail: boolean };
  /** A session event: the row is stored, then the event goes on the bus as sessions raise it. */
  said(s: Session, kind: SessionEvent["kind"], payload: unknown): void;
  add(spec: Partial<ListenerSpec> & Pick<ListenerSpec, "on">): Listener;
  /** Advances the clock and ticks the sampler once at the machine's `busyPct`. */
  step(ms: number, busyPct: number): Promise<void>;
  restart(): void;
}

function rig(opts: { metricsToml?: string } = {}): Rig {
  const store = new Store(":memory:");
  store.migrate();
  const bus = new Bus();
  const sessions = new Map<string, Session>();
  const tasks = new Map<string, Task>();
  const clock = { now: T0 };
  const stream = new EventStream({ bus, sessions: { get: (id) => sessions.get(id), list: () => [...sessions.values()] }, now: () => clock.now });
  stream.start([]);
  const fired: Rig["fired"] = [];
  const removed: Rig["removed"] = [];
  const order: string[] = [];
  bus.on("listener.fired", (e) => fired.push(e));
  bus.on("listener.removed", (e) => removed.push(e));
  stream.on((e: StreamEvent) => order.push(e.name));
  let monoS = 0;
  let last: RawSample = FakeEngine.tree({}, { monoS: 0 });
  last.at = clock.now;
  last.cpu = { busyNs: 0, totalNs: 0 };
  const engine = new FakeEngine(() => last);
  const metrics = new Metrics({
    config: parseConfig(opts.metricsToml ?? "[metrics]\nidle_interval_ms = 15000\nmin_interval_ms = 1000\n").metrics,
    nodeId: NODE,
    store,
    bus,
    log: silentLogger,
    engine,
    sessions: { pids: () => new Map(), list: () => [] },
    brainPid: () => undefined,
    sidecarPids: () => new Map(),
    deliver: () => true,
    now: () => clock.now,
    manual: true,
  });
  const remote: Rig["remote"] = { watched: new Map(), fail: false };
  const make = () =>
    new Listeners({
      store,
      bus,
      stream,
      nodeId: NODE,
      knownEvent: (name) => name === "ci.failed",
      knownNode: (id) => id === OTHER,
      session: (id) => sessions.get(id),
      task: (id) => tasks.get(id),
      metrics,
      remote: {
        watch: async (client, node, intervalMs) => {
          if (remote.fail) throw new Error("not linked");
          remote.watched.set(client, { node, intervalMs });
        },
        unwatch: async (client) => {
          remote.watched.delete(client);
        },
      },
      log: silentLogger,
      now: () => clock.now,
    });
  const r: Rig = {
    listeners: make(),
    store,
    bus,
    stream,
    metrics,
    sessions,
    tasks,
    clock,
    fired,
    removed,
    order,
    remote,
    said: (s, kind, payload) => {
      sessions.set(s.id, s);
      bus.emit("session.event", ev(s.id, kind, payload));
    },
    add: (spec) => r.listeners.add({ deliver: "wake", why: "a test", ...spec } as ListenerSpec),
    step: async (ms, busyPct) => {
      clock.now += ms;
      monoS += ms / 1000;
      const prev = last;
      const raw = FakeEngine.tree({}, { monoS });
      raw.at = clock.now;
      const dTotal = Number(raw.monoNs - prev.monoNs) * raw.cores;
      raw.cpu = { busyNs: prev.cpu.busyNs + (dTotal * busyPct) / 100, totalNs: prev.cpu.totalNs + dTotal };
      last = raw;
      await metrics.tick();
      await flush();
    },
    restart: () => {
      r.listeners.stop();
      r.listeners = make();
      r.listeners.start();
    },
  };
  r.listeners.start();
  return r;
}

describe("listeners", () => {
  test("each session kind is read off the session's events, and the session filters take only their own", async () => {
    const r = rig();
    const l = r.add({ on: ["session.started", "session.idle", "session.waiting", "session.said", "session.tool", "session.ask", "session.ended"], session: S1 });
    const s1 = session(S1);
    r.said(s1, "status", { status: "busy" });
    r.said(s1, "assistant_text", { text: "working" });
    r.said(s1, "tool_call", { id: "t", tool: "Bash", input: {} });
    r.said(s1, "status", { status: "idle", waiting: { on: "shell" } });
    r.said(s1, "status", { status: "idle" });
    r.bus.emit("ask.state", { id: "ask_01ARZ3NDEKTSV4RRFFQ69G5FB5", node: NODE, type: "permission", source: { kind: "harness", session: S1 }, title: "run?", options: [], answerableBy: ["user"], status: "open", createdAt: T0 });
    // Another session's say nothing to a listener on this one.
    r.said(session(S2), "status", { status: "idle" });
    r.bus.emit("session.state", { ...s1, status: "ended", endedAt: T0 + 100 });
    await flush();
    const kinds = r.fired.map((f) => (f.event.name === "session.updated" ? `${f.event.name}:${(f.event.params["event"] as SessionEvent).kind}` : f.event.name));
    expect(kinds).toEqual(["session.discovered", "session.updated:assistant_text", "session.updated:tool_call", "session.updated:status", "session.updated:status", "session.ask", "session.ended"]);
    // The event is the capability event as the brain hears it: the ask names its session by id.
    expect(r.fired[5]!.event.params["session"]).toBe(S1);
    expect(typeof r.fired[0]!.event.params["at"]).toBe("number");
    expect(r.fired.map((f) => f.listener.fired)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(r.fired.every((f) => f.listener.id === l.id && !f.last)).toBe(true);

    // The row's filters: workspace, harness, origin, node, the task the session serves, and a tool by name.
    const byRow = r.add({ on: ["session.idle"], workspace: WS2, harness: "codex", origin: "user", node: OTHER, task: T1 });
    const tool = r.add({ on: ["session.tool"], tool: "Edit" });
    const before = r.fired.length;
    r.said(session(S2, { workspace: WS2, harness: "codex", origin: "user", node: OTHER }), "status", { status: "idle" });
    r.said(session(S2, { workspace: WS2, harness: "codex", origin: "user", node: OTHER, task: T1 }), "status", { status: "idle" });
    r.said(session(S2), "tool_call", { id: "t", tool: "Bash", input: {} });
    r.said(session(S2), "tool_call", { id: "t", tool: "Edit", input: {} });
    await flush();
    const later = r.fired.slice(before);
    expect(later.map((f) => f.listener.id)).toEqual([byRow.id, tool.id]);
  });

  test("task.ready by task, workspace and session; pressure by node and level; joins and leaves; a custom event by name and payload", async () => {
    const r = rig();
    r.tasks.set(T1, task(T1, { workspace: WS, sessions: [S1] }));
    r.tasks.set(T2, task(T2, { workspace: WS2 }));
    const byTask = r.add({ on: ["task.ready"], task: T1 });
    const byWs = r.add({ on: ["task.ready"], workspace: WS2 });
    const bySession = r.add({ on: ["task.ready"], session: S1 });
    const pressure = r.add({ on: ["node.pressure"], node: NODE, level: "critical" });
    const joins = r.add({ on: ["node.joined", "node.left"], node: OTHER });
    const ci = r.add({ on: ["custom"], name: "ci.failed", match: { branch: "main" } });
    r.bus.emit("task.ready", { at: T0, id: T1, cause: "unblocked" });
    r.bus.emit("task.ready", { at: T0, id: T2, cause: "trigger" });
    r.bus.emit("node.pressure", { at: T0, node: NODE, resource: "cpu", level: "warn" });
    r.bus.emit("node.pressure", { at: T0, node: OTHER, resource: "cpu", level: "critical" });
    r.bus.emit("node.pressure", { at: T0, node: NODE, resource: "memory", level: "critical" });
    r.bus.emit("node.joined", { id: OTHER, name: "other" } as Node);
    r.bus.emit("node.left", { node: OTHER, at: T0 });
    r.bus.emit("node.left", { node: NODE, at: T0 });
    r.stream.custom("ci.failed", { branch: "dev" });
    r.stream.custom("ci.failed", { branch: "main", run: 4 });
    r.stream.custom("other.thing", { branch: "main" });
    await flush();
    expect(r.fired.map((f) => [f.listener.id, f.event.name])).toEqual([
      [byTask.id, "task.ready"],
      [bySession.id, "task.ready"],
      [byWs.id, "task.ready"],
      [pressure.id, "node.pressure"],
      [joins.id, "node.joined"],
      [joins.id, "node.left"],
      [ci.id, "event.custom"],
    ]);
    expect(r.fired.at(-1)!.event.params).toMatchObject({ name: "ci.failed", payload: { branch: "main", run: 4 } });
  });

  test("times counts down to a last fire that removes it; the cooldown holds fires back; the fire follows the event on the stream", async () => {
    const r = rig();
    const twice = r.add({ on: ["node.pressure"], times: 2 });
    const slow = r.add({ on: ["node.pressure"], cooldownS: 60 });
    const pressure = () => r.bus.emit("node.pressure", { at: r.clock.now, node: NODE, resource: "cpu", level: "warn" });
    pressure();
    // Nothing is raised in the same turn as the event: every listener of the stream hears the event first.
    expect(r.fired).toHaveLength(0);
    await flush();
    expect(r.order).toEqual(["node.pressure", "listener.fired", "listener.fired"]);
    r.clock.now += 10_000;
    pressure();
    await flush();
    r.clock.now += 60_000;
    pressure();
    await flush();
    expect(r.fired.map((f) => [f.listener.id, f.listener.times, f.last])).toEqual([
      [twice.id, 1, false],
      [slow.id, undefined, false],
      [twice.id, 0, true],
      [slow.id, undefined, false],
    ]);
    expect(r.removed).toEqual([{ at: T0 + 10_000, id: twice.id, why: "spent" }]);
    // Removed after its last fire is raised.
    expect(r.order.slice(3, 6)).toEqual(["node.pressure", "listener.fired", "listener.removed"]);
    expect(r.listeners.list().map((l) => l.id)).toEqual([slow.id]);
    expect(r.store.kv.list(LISTENERS_NS)).toEqual([slow.id]);
    expect(r.listeners.get(slow.id)).toMatchObject({ fired: 2, lastFiredAt: T0 + 70_000 });
  });

  test("until a task: gone when the task is done or cancelled, not when a recurring one re-arms; until a session: gone when it ends, after its last fire", async () => {
    const r = rig();
    r.tasks.set(T1, task(T1));
    r.tasks.set(T2, task(T2));
    const s1 = session(S1);
    r.said(s1, "status", { status: "busy" });
    const a = r.add({ on: ["session.idle"], task: T1, until: T1 });
    const b = r.add({ on: ["session.idle"], until: T2 });
    const c = r.add({ on: ["session.ended"], session: S1, until: S1 });
    r.bus.emit("task.state", task(T1, { status: "pending", recurring: true }));
    expect(r.listeners.list()).toHaveLength(3);
    r.bus.emit("task.state", task(T1, { status: "done" }));
    r.bus.emit("task.state", task(T2, { status: "cancelled" }));
    r.bus.emit("session.state", { ...s1, status: "ended", endedAt: T0 });
    await flush();
    expect(r.removed.map((x) => [x.id, x.why])).toEqual([
      [a.id, "until"],
      [b.id, "until"],
      [c.id, "until"],
    ]);
    // The session's end fired the listener on it before its end removed it.
    expect(r.fired.map((f) => f.listener.id)).toEqual([c.id]);
    expect(r.listeners.list()).toEqual([]);
  });

  test("what add refuses, with words the model can act on; the cap; a metric fills in this node; remove by the user or the brain", async () => {
    const r = rig();
    r.tasks.set(T1, task(T1, { status: "done" }));
    r.sessions.set(S2, session(S2, { status: "ended" }));
    const refused = (spec: Partial<ListenerSpec> & Pick<ListenerSpec, "on">): string => {
      try {
        r.add(spec);
      } catch (e) {
        return `${(e as { code?: string }).code}: ${(e as Error).message}`;
      }
      return "added";
    };
    expect(refused({ on: ["metric"] })).toBe("invalid: a listener on metric needs metric: {resource, above or below, forS}");
    expect(refused({ on: ["metric"], metric: { resource: "cpu", forS: 5 } })).toBe("invalid: metric needs exactly one of above and below");
    expect(refused({ on: ["metric"], metric: { resource: "cpu", above: 90, below: 10, forS: 5 } })).toBe("invalid: metric needs exactly one of above and below");
    expect(refused({ on: ["session.idle"], metric: { resource: "cpu", above: 90, forS: 5 } })).toStartWith("invalid: metric applies to none of session.idle");
    expect(refused({ on: ["node.pressure"], tool: "Bash", harness: "claude" })).toStartWith("invalid: harness, tool apply to none of node.pressure");
    expect(refused({ on: ["custom"], name: "nope" })).toBe("invalid: no event named nope: event.list names the ones the hooks raise");
    expect(refused({ on: ["node.left"], node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAX" })).toBe("not_found: no node node_01ARZ3NDEKTSV4RRFFQ69G5FAX in this cluster");
    expect(refused({ on: ["session.idle"], until: T1 })).toBe("invalid: task task_01ARZ3NDEKTSV4RRFFQ69G5FB3 is done already");
    expect(refused({ on: ["session.idle"], until: T2 })).toBe("not_found: no task task_01ARZ3NDEKTSV4RRFFQ69G5FB4");
    expect(refused({ on: ["session.idle"], until: S2 })).toBe("invalid: session sess_01ARZ3NDEKTSV4RRFFQ69G5FB2 has ended already");
    expect(r.listeners.list()).toEqual([]);
    const m = r.add({ on: ["metric"], metric: { resource: "cpu", above: 90, forS: 10 } });
    expect(m.node).toBe(NODE);
    expect(m).toMatchObject({ fired: 0, createdAt: T0, deliver: "wake", why: "a test" });
    expect(m.id).toMatch(/^lst_/);
    for (let i = 1; i < MAX_LISTENERS; i++) r.add({ on: ["node.joined"] });
    expect(refused({ on: ["node.joined"] })).toBe(`conflict: already ${MAX_LISTENERS} listeners: remove one first (listener.list shows them)`);
    expect(r.listeners.remove(m.id, "user")).toBe(true);
    expect(r.listeners.remove(m.id, "brain")).toBe(false);
    const other = r.listeners.list()[0]!;
    expect(r.listeners.remove(other.id, "brain")).toBe(true);
    await flush();
    expect(r.removed.map((x) => x.why)).toEqual(["user", "brain"]);
  });

  test("a wake or notify fire carries the speech verdict, taken at the fire from the listener after it; a note carries none; every add, fire and removal is told", async () => {
    const r = rig();
    const asked: { id: string; fired: number; event: string }[] = [];
    let changes = 0;
    r.listeners.speech = {
      fired: (l, event) => {
        asked.push({ id: l.id, fired: l.fired, event: event.name });
        return l.deliver === "wake";
      },
      changed: () => changes++,
    };
    const wake = r.add({ on: ["node.pressure"], deliver: "wake", asked: "msg_01ARZ3NDEKTSV4RRFFQ69G5FC0" });
    const notify = r.add({ on: ["node.pressure"], deliver: "notify", times: 1 });
    r.add({ on: ["node.pressure"], deliver: "note" });
    expect(changes).toBe(3);
    expect(wake.asked).toBe("msg_01ARZ3NDEKTSV4RRFFQ69G5FC0");
    r.bus.emit("node.pressure", { at: T0, node: NODE, resource: "cpu", level: "warn" });
    await flush();
    expect(asked).toEqual([
      { id: wake.id, fired: 1, event: "node.pressure" },
      { id: notify.id, fired: 1, event: "node.pressure" },
    ]);
    expect(r.fired.map((f) => [f.listener.deliver, f.speak])).toEqual([
      ["wake", true],
      ["notify", false],
      ["note", undefined],
    ]);
    // The wake and the note fired and stayed; the notify was spent and went.
    expect(changes).toBe(3 + 3);
  });

  test("the listeners and their counts are kept across a restart, and one spent before it is gone after it", async () => {
    const r = rig();
    const kept = r.add({ on: ["node.pressure"], times: 3, cooldownS: 5 });
    const spent = r.add({ on: ["node.pressure"], times: 1 });
    r.bus.emit("node.pressure", { at: T0, node: NODE, resource: "cpu", level: "warn" });
    await flush();
    r.restart();
    expect(r.listeners.list()).toEqual([{ ...kept, times: 2, fired: 1, lastFiredAt: T0 }]);
    // The cooldown survives too: a fire within it is held back.
    r.clock.now += 1000;
    r.bus.emit("node.pressure", { at: r.clock.now, node: NODE, resource: "cpu", level: "warn" });
    await flush();
    expect(r.fired.map((f) => f.listener.id)).toEqual([kept.id, spent.id]);
    // Stopped, it hears nothing, and still lists what is stored.
    r.listeners.stop();
    r.clock.now += 10_000;
    r.bus.emit("node.pressure", { at: r.clock.now, node: NODE, resource: "cpu", level: "warn" });
    await flush();
    expect(r.fired).toHaveLength(2);
    expect(r.listeners.list().map((l) => l.id)).toEqual([kept.id]);
  });

  test("a metric held for its window fires once and re-arms only back across the line; not held, it does not fire; the sampler speeds up only while it exists", async () => {
    const r = rig();
    await r.step(1000, 10);
    expect(r.metrics.intervalMs()).toBe(15000);
    const hot = r.add({ on: ["metric"], metric: { resource: "cpu", above: 80, forS: 5 }, why: "CPU above 80% for 5 s" });
    expect(r.metrics.intervalMs()).toBe(intervalFor(5));
    expect(intervalFor(5)).toBe(1000);
    expect(intervalFor(10)).toBe(2000);
    expect(intervalFor(600)).toBe(5000);
    // Above for four seconds, then a dip: not held long enough.
    for (let i = 0; i < 5; i++) await r.step(1000, 95);
    await r.step(1000, 50);
    expect(r.fired).toHaveLength(0);
    // Six samples above spanning five seconds: it fires, with the reading.
    for (let i = 0; i < 6; i++) await r.step(1000, 95);
    expect(r.fired).toHaveLength(1);
    expect(r.fired[0]!.event).toEqual({ name: "metric", params: { node: NODE, resource: "cpu", value: 95, forS: 5, above: 80 } });
    expect(r.fired[0]!.listener.id).toBe(hot.id);
    // Still above: disarmed, nothing more.
    for (let i = 0; i < 10; i++) await r.step(1000, 95);
    expect(r.fired).toHaveLength(1);
    // Under the line but within the hysteresis: still disarmed; one sample well under is not enough either.
    for (let i = 0; i < 3; i++) await r.step(1000, 78);
    await r.step(1000, 50);
    for (let i = 0; i < 6; i++) await r.step(1000, 95);
    expect(r.fired).toHaveLength(1);
    // Two samples back across by five points re-arm it; held again, it fires again.
    await r.step(1000, 50);
    await r.step(1000, 50);
    for (let i = 0; i < 6; i++) await r.step(1000, 95);
    expect(r.fired).toHaveLength(2);
    // Gone, the sampler goes back to its own pace.
    r.listeners.remove(hot.id, "brain");
    expect(r.metrics.intervalMs()).toBe(15000);
    expect(r.metrics.snapshot().internal).toEqual([]);
  });

  test("a line at the scale's end cannot be crossed back: held, it fires again after another window, until its times run out", async () => {
    const r = rig();
    await r.step(1000, 10);
    const always = r.add({ on: ["metric"], metric: { resource: "cpu", below: 100, forS: 5 }, times: 2 });
    for (let i = 0; i < 6; i++) await r.step(1000, 30);
    expect(r.fired.map((f) => f.last)).toEqual([false]);
    for (let i = 0; i < 5; i++) await r.step(1000, 30);
    expect(r.fired).toHaveLength(1);
    await r.step(1000, 30);
    expect(r.fired.map((f) => f.last)).toEqual([false, true]);
    expect(r.fired[1]!.event.params).toMatchObject({ resource: "cpu", below: 100, value: 30 });
    expect(r.removed.map((x) => [x.id, x.why])).toEqual([[always.id, "spent"]]);
    expect(r.metrics.intervalMs()).toBe(15000);
  });

  test("another node's metric is watched over the link as listener:<id>, its samples routed back; unwatched when it goes, watched again when the node links again", async () => {
    const r = rig();
    r.remote.fail = true;
    const far = r.add({ on: ["metric"], node: OTHER, metric: { resource: "memory", above: 50, forS: 10 } });
    const client = `listener:${far.id}`;
    // Not linked now: nothing watched until the node joins.
    await flush();
    expect(r.remote.watched.size).toBe(0);
    r.remote.fail = false;
    r.bus.emit("node.joined", { id: OTHER, name: "other" } as Node);
    await flush();
    expect(r.remote.watched.get(client)).toEqual({ node: OTHER, intervalMs: 2000 });
    const sample = (at: number, memPct: number): MetricsSample => ({ node: OTHER, at, cpu: 5, memory: { used: memPct, total: 100 }, processes: [], llm: {} });
    for (let i = 0; i <= 5; i++) expect(r.listeners.sample(client, sample(T0 + i * 2000, 70))).toBe(true);
    await flush();
    expect(r.fired.map((f) => f.event.params)).toEqual([{ node: OTHER, resource: "memory", value: 70, forS: 10, above: 50 }]);
    // A client id that is not a listener's, or one of a listener gone, is refused so the link drops it.
    expect(r.listeners.sample("cli_x", sample(T0, 70))).toBe(false);
    r.listeners.remove(far.id, "user");
    expect(r.remote.watched.size).toBe(0);
    expect(r.listeners.sample(client, sample(T0 + 20_000, 70))).toBe(false);
  });
});

describe("listeners across the link", () => {
  let primary: Primary | undefined;
  let secondary: Started | undefined;

  afterEach(async () => {
    await stopAll(secondary, primary?.d);
    primary = undefined;
    secondary = undefined;
  });

  /** A scripted engine a test advances by hand, one second a step. */
  function scripted(t0: number) {
    let last: RawSample = FakeEngine.tree({}, { monoS: 0 });
    last.at = t0;
    last.cpu = { busyNs: 0, totalNs: 0 };
    let monoS = 0;
    const engine = new FakeEngine(() => last);
    const step = (busyPct: number) => {
      monoS += 1;
      const raw = FakeEngine.tree({}, { monoS });
      raw.at = last.at + 1000;
      const dTotal = Number(raw.monoNs - last.monoNs) * raw.cores;
      raw.cpu = { busyNs: last.cpu.busyNs + (dTotal * busyPct) / 100, totalNs: last.cpu.totalNs + dTotal };
      last = raw;
    };
    return { engine, step, now: () => last.at };
  }

  test("a metric listener on the secondary subscribes the link at its rate, fires on the primary from the secondary's samples, and unsubscribes the link when removed", async () => {
    const T = Math.floor(1_700_000_000_000 / 60000) * 60000;
    const p = scripted(T);
    const s = scripted(T);
    primary = await startPrimary({ heartbeatMs: 1000, daemon: { metrics: { engine: p.engine, manual: true, now: p.now } } });
    secondary = await startSecondary(primary, { heartbeatMs: 1000, daemon: { metrics: { engine: s.engine, manual: true, now: s.now } } });
    await linked(secondary);
    s.step(5);
    await secondary.metrics.tick();
    const fired: BusEvents["listener.fired"][] = [];
    primary.d.bus.on("listener.fired", (e) => fired.push(e));
    const sid = secondary.identity.id;
    const l = primary.d.listeners.add({ on: ["metric"], node: sid, metric: { resource: "cpu", above: 80, forS: 5 }, deliver: "notify", why: "the secondary is busy" });
    await waitFor(() => secondary!.metrics.snapshot().subscribers.length === 1);
    expect(secondary.metrics.snapshot().subscribers[0]).toMatchObject({ intervalMs: 1000, processes: "owners" });
    expect(secondary.metrics.snapshot().subscribers[0]!.client.startsWith("link:")).toBe(true);
    for (let i = 0; i < 7; i++) {
      s.step(95);
      await secondary.metrics.tick();
      await Bun.sleep(20);
    }
    await waitFor(() => fired.length === 1);
    expect(fired[0]!.listener.id).toBe(l.id);
    expect(fired[0]!.event).toMatchObject({ name: "metric", params: { node: sid, resource: "cpu", above: 80, forS: 5 } });
    expect(primary.d.listeners.remove(l.id, "user")).toBe(true);
    await waitFor(() => secondary!.metrics.snapshot().subscribers.length === 0);
  }, 30_000);
});
