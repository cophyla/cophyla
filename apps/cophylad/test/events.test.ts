// The event stream, catalogue and recorder: bus events mapped to capability events as the
// brain's feed used to map them (discovered once, updated every time, a bare annotate once,
// ended once), the live sessions known at `start` and `prime`, the editable notices passed
// through, a custom event as plain JSON with its origin and depth, an oversize or cyclic
// payload dropped, `eventKey` for triggers and hooks; the catalogue's built-ins, hook
// events, refused names, `ensure`, one `events.changed` per batch; custom events recorded
// with `history` filters and pruned.

import { describe, expect, test } from "bun:test";
import { newId } from "@cophyla/protocol";
import type { Ask, Session, SessionEvent, Terminal } from "@cophyla/protocol";
import { Bus } from "../src/bus.ts";
import type { ChangedEvent } from "../src/bus.ts";
import { builtinEvents, EventCatalogue } from "../src/events/catalogue.ts";
import { recordCustomEvents } from "../src/events/recorder.ts";
import { CUSTOM_PAYLOAD_CAP, eventKey, EventStream } from "../src/events/stream.ts";
import type { StreamEvent } from "../src/events/stream.ts";
import { createLogger } from "../src/log.ts";
import { Store } from "../src/store/index.ts";

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";

function session(id: string, status: Session["status"] = "idle", extra: Partial<Session> = {}): Session {
  return {
    id,
    node: NODE,
    harness: "claude",
    profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8",
    native: { id: "n-" + id, transport: "pipe" },
    origin: "user",
    cwd: ".",
    tags: [],
    status,
    startedAt: 1,
    lastActivity: 2,
    ...extra,
  };
}

function setup(live: Session[] = []) {
  const bus = new Bus();
  const sessions = new Map<string, Session>(live.map((s) => [s.id, s]));
  const lines: string[] = [];
  const log = createLogger("debug", (l) => lines.push(l));
  let now = 1000;
  const stream = new EventStream({ bus, sessions: { get: (id) => sessions.get(id), list: () => [...sessions.values()] }, log, now: () => now++ });
  const events: StreamEvent[] = [];
  stream.on((e) => events.push(e));
  stream.start(live);
  const names = () => events.map((e) => e.name);
  return { bus, sessions, stream, events, names, lines };
}

const sessionEvent = (id: string, seq: number): SessionEvent => ({ session: id, seq, at: 5, kind: "status", payload: { status: "busy" } });

describe("event stream: the mapping", () => {
  test("a session is discovered once then updated every time; ended once; a session live at start is never discovered", () => {
    const a = session("sess_01ARZ3NDEKTSV4RRFFQ69G5FB1");
    const b = session("sess_01ARZ3NDEKTSV4RRFFQ69G5FB2");
    const { bus, sessions, names, events } = setup([a]);
    bus.emit("session.event", sessionEvent(a.id, 1));
    expect(names()).toEqual(["session.updated"]);
    sessions.set(b.id, b);
    bus.emit("session.event", sessionEvent(b.id, 1));
    bus.emit("session.event", sessionEvent(b.id, 2));
    expect(names()).toEqual(["session.updated", "session.discovered", "session.updated", "session.updated"]);
    expect((events[1]!.params as { session: Session }).session.id).toBe(b.id);
    const ended = session(b.id, "ended", { endedAt: 99 });
    sessions.set(b.id, ended);
    bus.emit("session.state", ended);
    bus.emit("session.state", ended);
    expect(names().filter((n) => n === "session.ended")).toHaveLength(1);
    expect((events[events.length - 1]!.params as { at: number }).at).toBe(99);
    // An event for a session the module cannot see is dropped.
    bus.emit("session.event", sessionEvent("sess_01ARZ3NDEKTSV4RRFFQ69G5FB9", 1));
    expect(names()).toHaveLength(5);
  });

  test("a session.state that changes only the annotation is one session.updated without an event; the same again is nothing", () => {
    const a = session("sess_01ARZ3NDEKTSV4RRFFQ69G5FB1");
    const { bus, sessions, events } = setup([a]);
    bus.emit("session.state", a);
    expect(events).toHaveLength(0);
    const annotated = session(a.id, "idle", { summary: "said hi", tags: ["x"] });
    sessions.set(a.id, annotated);
    bus.emit("session.state", annotated);
    bus.emit("session.state", annotated);
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe("session.updated");
    expect((events[0]!.params as { event?: unknown }).event).toBeUndefined();
    // A session unknown to the stream is not announced by a state alone.
    bus.emit("session.state", session("sess_01ARZ3NDEKTSV4RRFFQ69G5FB3", "idle", { summary: "new" }));
    expect(events).toHaveLength(1);
  });

  test("a new mode or task on a session's row is a session.updated without an event", () => {
    const a = session("sess_01ARZ3NDEKTSV4RRFFQ69G5FB1");
    const { bus, sessions, events } = setup([a]);
    const planning = session(a.id, "idle", { mode: "plan" });
    sessions.set(a.id, planning);
    bus.emit("session.state", planning);
    bus.emit("session.state", planning);
    expect(events).toHaveLength(1);
    expect((events[0]!.params as { session: Session }).session.mode).toBe("plan");
    const handed = session(a.id, "idle", { mode: "plan", task: "task_01ARZ3NDEKTSV4RRFFQ69G5FB2" });
    sessions.set(a.id, handed);
    bus.emit("session.state", handed);
    expect(events).toHaveLength(2);
    expect((events[1]!.params as { session: Session; event?: unknown }).session.task).toBe("task_01ARZ3NDEKTSV4RRFFQ69G5FB2");
    expect((events[1]!.params as { event?: unknown }).event).toBeUndefined();
  });

  test("an open harness ask is session.ask; a gate ask or a closed one is not", () => {
    const { bus, names } = setup();
    const ask = (source: Ask["source"], status: Ask["status"]): Ask => ({ id: newId("ask"), node: NODE, type: "permission", title: "t", options: [], status, source, createdAt: 1, answerableBy: ["user"] });
    bus.emit("ask.state", ask({ kind: "harness", session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1" }, "open"));
    bus.emit("ask.state", ask({ kind: "harness", session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1" }, "answered"));
    bus.emit("ask.state", ask({ kind: "gate", action: "x", principal: { kind: "brain" } }, "open"));
    expect(names()).toEqual(["session.ask"]);
  });

  test("tasks, threads, workspaces, the user and the editable notices pass through with their fields", () => {
    const { bus, events } = setup();
    const now = 50;
    bus.emit("task.state", { id: "task_01ARZ3NDEKTSV4RRFFQ69G5FB2", title: "t", createdBy: { kind: "brain" }, status: "ready", priority: "normal", sessions: [], createdAt: now, updatedAt: 77 });
    bus.emit("task.ready", { at: 78, id: "task_01ARZ3NDEKTSV4RRFFQ69G5FB2", cause: "trigger", event: { name: "my.ping", payload: { a: 1 } } });
    bus.emit("task.ready", { at: 79, id: "task_01ARZ3NDEKTSV4RRFFQ69G5FB2", cause: "unblocked", cleared: { kind: "task", task: "task_01ARZ3NDEKTSV4RRFFQ69G5FB3" } });
    bus.emit("thread.state", { id: "thr_01ARZ3NDEKTSV4RRFFQ69G5FB3", startedAt: 1, tags: [], sessions: [] });
    bus.emit("workspace.state", { id: "ws_01ARZ3NDEKTSV4RRFFQ69G5FB0", node: NODE, path: "/x", name: "x", origin: "user", tags: [], lastActivity: 12 });
    bus.emit("user.message", { at: 3, text: "hi", source: "ui", mode: "quick", message: "msg_01ARZ3NDEKTSV4RRFFQ69G5FB4", thread: "thr_01ARZ3NDEKTSV4RRFFQ69G5FB3" });
    bus.emit("user.activity", { at: 4, state: "typing", source: "ui" });
    bus.emit("voice.transcript", { at: 9, text: "what is running" });
    const problems = [{ file: "tools/bad.ts", message: "bad.ts: nope" }];
    bus.emit("tools.changed", { at: 5, problems });
    bus.emit("prompts.changed", { at: 6 });
    bus.emit("memory.changed", { at: 7 });
    bus.emit("events.changed", { at: 8 });
    expect(events.map((e) => e.name)).toEqual(["task.updated", "task.ready", "task.ready", "thread.updated", "workspace.updated", "user.message", "user.activity", "voice.transcript", "tools.changed", "prompts.changed", "memory.changed", "events.changed"]);
    expect(events[0]!.params).toEqual({ at: 77, id: "task_01ARZ3NDEKTSV4RRFFQ69G5FB2" });
    expect(events[1]!.params).toEqual({ at: 78, id: "task_01ARZ3NDEKTSV4RRFFQ69G5FB2", cause: "trigger", event: { name: "my.ping", payload: { a: 1 } } });
    expect(events[2]!.params).toEqual({ at: 79, id: "task_01ARZ3NDEKTSV4RRFFQ69G5FB2", cause: "unblocked", cleared: { kind: "task", task: "task_01ARZ3NDEKTSV4RRFFQ69G5FB3" } });
    expect(events[4]!.params).toEqual({ at: 12, id: "ws_01ARZ3NDEKTSV4RRFFQ69G5FB0" });
    expect(events[5]!.params).toEqual({ at: 3, text: "hi", source: "ui", mode: "quick", message: "msg_01ARZ3NDEKTSV4RRFFQ69G5FB4", thread: "thr_01ARZ3NDEKTSV4RRFFQ69G5FB3" });
    // The words the user has said so far: text and time, nothing about the client that heard them.
    expect(events[7]!.params).toEqual({ at: 9, text: "what is running" });
    expect(events[8]!.params).toEqual({ at: 5, problems });
    expect(events[11]!.params).toEqual({ at: 8 });
  });

  test("prime marks the live sessions known: one seen before is not discovered again, one that ended before is forgotten", () => {
    const a = session("sess_01ARZ3NDEKTSV4RRFFQ69G5FB1");
    const { bus, sessions, stream, names } = setup();
    sessions.set(a.id, a);
    bus.emit("session.event", sessionEvent(a.id, 1));
    expect(names()).toEqual(["session.discovered", "session.updated"]);
    stream.prime([a]);
    bus.emit("session.event", sessionEvent(a.id, 2));
    expect(names()).toEqual(["session.discovered", "session.updated", "session.updated"]);
    stream.prime([]);
    bus.emit("session.state", session(a.id, "ended"));
    expect(names().filter((n) => n === "session.ended")).toHaveLength(0);
  });

  test("a terminal's row is terminal.waiting only when it begins or stops holding a CLI no session stands for", () => {
    const { bus, events } = setup();
    const row = (extra: Partial<Terminal>): Terminal => ({ id: "7d1e0a93c2b4", node: NODE, host: "a1b2c3d4e5f60718", argv0: "pwsh.exe", cwd: "C:\\D\\x", cols: 120, rows: 32, status: "running", windows: 0, startedAt: 1, ...extra });
    bus.emit("terminal.state", row({ title: "pwsh" }));
    expect(events).toHaveLength(0);
    bus.emit("terminal.state", row({ title: "x", harness: "codex" }));
    // A retitle while it waits is nothing.
    bus.emit("terminal.state", row({ title: "x · busy", harness: "codex" }));
    // A session holds it: the CLI no longer waits.
    bus.emit("terminal.state", row({ title: "x", session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1" }));
    bus.emit("terminal.state", row({ title: "x", harness: "codex" }));
    bus.emit("terminal.state", row({ harness: "codex", status: "exited" }));
    bus.emit("terminal.state", row({ status: "exited" }));
    expect(events.map((e) => e.name)).toEqual(["terminal.waiting", "terminal.waiting", "terminal.waiting", "terminal.waiting"]);
    expect(events.map((e) => (e.params as { terminal: Terminal }).terminal.harness ?? "-")).toEqual(["codex", "-", "codex", "codex"]);
    expect((events[3]!.params as { terminal: Terminal }).terminal.status).toBe("exited");
  });

  test("a listener that throws does not stop the next; dispose ends everything", () => {
    const { bus, stream, events, lines } = setup();
    stream.on(() => {
      throw new Error("boom");
    });
    const later: string[] = [];
    stream.on((e) => later.push(e.name));
    bus.emit("prompts.changed", { at: 1 });
    expect(events).toHaveLength(1);
    expect(later).toEqual(["prompts.changed"]);
    expect(lines.some((l) => l.includes("event listener failed") && l.includes("boom"))).toBe(true);
    stream.dispose();
    bus.emit("prompts.changed", { at: 2 });
    expect(events).toHaveLength(1);
  });
});

describe("event stream: custom events", () => {
  test("custom emits event.custom with the payload as plain JSON, the origin and the depth", () => {
    const { stream, events } = setup();
    const sent = stream.custom("my.ping", { branch: "main", when: undefined, fn: () => 1 }, { origin: "watch", depth: 2 });
    expect(sent).toEqual({ name: "event.custom", params: { at: 1000, name: "my.ping", payload: { branch: "main" } }, origin: "watch", depth: 2 });
    expect(events).toEqual([sent!]);
    expect(stream.custom("my.bare", undefined)!.params).toEqual({ at: 1001, name: "my.bare", payload: null });
    expect(stream.custom("my.at", 1, { at: 5 })!.params).toEqual({ at: 5, name: "my.at", payload: 1 });
    expect(eventKey(sent!)).toEqual({ name: "my.ping", payload: { branch: "main" } });
    expect(eventKey({ name: "prompts.changed", params: { at: 9 } })).toEqual({ name: "prompts.changed", payload: { at: 9 } });
  });

  test("a cyclic or oversize payload is dropped with a warning", () => {
    const { stream, events, lines } = setup();
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(stream.custom("my.cycle", cyclic)).toBeUndefined();
    expect(stream.custom("my.big", { text: "x".repeat(CUSTOM_PAYLOAD_CAP) })).toBeUndefined();
    expect(events).toHaveLength(0);
    expect(lines.filter((l) => l.includes("custom event dropped"))).toHaveLength(2);
  });
});

describe("event catalogue", () => {
  function setup() {
    const bus = new Bus();
    const changed: ChangedEvent[] = [];
    bus.on("events.changed", (c) => changed.push(c));
    const catalogue = new EventCatalogue({ node: NODE, bus, now: () => 42 });
    return { bus, changed, catalogue };
  }

  test("lists the built-ins, then hook events by name, each under its hook", () => {
    const { catalogue, changed } = setup();
    const builtin = builtinEvents(NODE).map((e) => e.name);
    expect(catalogue.list().map((e) => e.name)).toEqual(builtin);
    for (const name of ["session.ask", "event.custom", "tools.changed", "events.changed", "memory.changed", "prompts.changed", "task.ready", "user.activity", "voice.transcript"]) expect(builtin).toContain(name);
    // A hook cannot take a voice name either: the built-ins own the whole list.
    expect(catalogue.has("voice.transcript")).toBe(true);
    expect(catalogue.setHook("ci", [{ name: "ci.failed", description: "CI failed", payload: { type: "object" } }, { name: "ci.passed", description: "CI passed" }])).toEqual({ refused: [] });
    expect(catalogue.setHook("inbox", [{ name: "inbox.file", description: "a file" }])).toEqual({ refused: [] });
    const custom = catalogue.list().slice(builtin.length);
    expect(custom).toEqual([
      { name: "ci.failed", description: "CI failed", payload: { type: "object" }, source: { hook: "ci" }, node: NODE },
      { name: "ci.passed", description: "CI passed", source: { hook: "ci" }, node: NODE },
      { name: "inbox.file", description: "a file", source: { hook: "inbox" }, node: NODE },
    ]);
    expect(catalogue.has("ci.failed")).toBe(true);
    expect(catalogue.has("session.ask")).toBe(true);
    expect(catalogue.has("nope.x")).toBe(false);
    expect(catalogue.ownerOf("inbox.file")).toBe("inbox");
    expect(changed).toHaveLength(2);
    expect(changed[0]).toEqual({ at: 42 });
  });

  test("a built-in name or another hook's is refused; the same declaration again changes nothing", () => {
    const { catalogue, changed } = setup();
    catalogue.setHook("ci", [{ name: "ci.failed", description: "x" }]);
    expect(catalogue.setHook("other", [{ name: "ci.failed", description: "y" }, { name: "session.ask", description: "z" }, { name: "other.ok", description: "ok" }])).toEqual({ refused: ["ci.failed", "session.ask"] });
    expect(catalogue.ownerOf("ci.failed")).toBe("ci");
    expect(catalogue.ownerOf("other.ok")).toBe("other");
    expect(changed).toHaveLength(2);
    catalogue.setHook("ci", [{ name: "ci.failed", description: "x" }]);
    expect(changed).toHaveLength(2);
    expect(catalogue.removeHook("ci")).toBe(true);
    expect(catalogue.removeHook("ci")).toBe(false);
    expect(catalogue.has("ci.failed")).toBe(false);
    expect(changed).toHaveLength(3);
  });

  test("ensure adds an undeclared event under its hook once; a batch sends one events.changed with the problems", async () => {
    const { catalogue, changed } = setup();
    expect(catalogue.ensure("watch.tick", "watch")).toBe(true);
    expect(catalogue.ensure("watch.tick", "watch")).toBe(false);
    expect(catalogue.ensure("session.ask", "watch")).toBe(false);
    expect(catalogue.list().find((e) => e.name === "watch.tick")).toEqual({ name: "watch.tick", description: "raised by the watch hook", source: { hook: "watch" }, node: NODE });
    expect(changed).toHaveLength(1);
    const problems = [{ file: "hooks/bad.ts", message: "bad.ts: on must be an object" }];
    await catalogue.batch(
      async () => {
        catalogue.setHook("a", [{ name: "a.one", description: "1" }]);
        catalogue.setHook("b", [{ name: "b.one", description: "1" }]);
        catalogue.removeHook("watch");
      },
      { problems: () => problems },
    );
    expect(changed).toHaveLength(2);
    expect(changed[1]).toEqual({ at: 42, problems });
    await catalogue.batch(() => {});
    expect(changed).toHaveLength(2);
    await catalogue.batch(() => {}, { force: true });
    expect(changed).toHaveLength(3);
    expect(changed[2]).toEqual({ at: 42 });
    await catalogue.batch(() => void catalogue.setHook("c", [{ name: "c.one", description: "1" }]), { silent: true });
    expect(changed).toHaveLength(3);
    expect(catalogue.has("c.one")).toBe(true);
  });
});

describe("event recorder", () => {
  test("custom events land in the store; history filters by name, node and range; prune keeps the newest", () => {
    const store = new Store(":memory:");
    store.migrate();
    const { stream, bus } = setup();
    const stop = recordCustomEvents(stream, store, NODE, { keep: 3 });
    bus.emit("prompts.changed", { at: 1 });
    stream.custom("my.ping", { n: 1 }, { at: 10 });
    stream.custom("my.pong", { n: 2 }, { at: 20 });
    stream.custom("my.ping", { n: 3 }, { at: 30 });
    expect(store.events.history()).toEqual([
      { name: "my.ping", node: NODE, at: 10, payload: { n: 1 } },
      { name: "my.pong", node: NODE, at: 20, payload: { n: 2 } },
      { name: "my.ping", node: NODE, at: 30, payload: { n: 3 } },
    ]);
    expect(store.events.history({ name: "my.ping" }).map((e) => e.at)).toEqual([10, 30]);
    expect(store.events.history({ node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAW" })).toEqual([]);
    expect(store.events.history({ from: 15, to: 25 }).map((e) => e.at)).toEqual([20]);
    expect(store.events.history({ limit: 1 }).map((e) => e.at)).toEqual([30]);
    // The table is pruned every hundred inserts: the 97 below make the hundredth.
    for (let i = 0; i < 97; i++) stream.custom("my.tick", i, { at: 100 + i });
    expect(store.events.count()).toBe(3);
    expect(store.events.history().map((e) => e.at)).toEqual([194, 195, 196]);
    stop();
    stream.custom("my.after", null);
    expect(store.events.count()).toBe(3);
    store.close();
  });
});
