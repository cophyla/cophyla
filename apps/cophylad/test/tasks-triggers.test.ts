// Task triggers, driven by hand with an injected clock and `tick()`, so no timer runs: a
// bad trigger is refused; `dueAt` for a time and for a cron in UTC and in Istanbul; a time
// trigger fires at its time and not before, a paused or active task never fires, one
// `task.ready` per fire and a second tick is a no-op; a recurring cron task marked done goes
// back to pending with its result kept and the next due after now, a recurring `at` stays
// done, a recurring event task fires again; event matching by name, by nested payload and
// by capability name; `event` carried on `task.ready`; a time missed while down fires at
// `start()`; dropping the trigger makes a pending task ready.

import { describe, expect, test } from "bun:test";
import { newId } from "@cophyla/protocol";
import type { Task } from "@cophyla/protocol";
import { Bus } from "../src/bus.ts";
import type { TaskReadyEvent } from "../src/bus.ts";
import { EventStream } from "../src/events/stream.ts";
import { silentLogger } from "../src/log.ts";
import { Store } from "../src/store/index.ts";
import { Tasks } from "../src/tasks/index.ts";
import { MAX_DELAY_MS, TaskScheduler } from "../src/tasks/scheduler.ts";
import { dueAt, matchesEvent, nodeTz, rearms, validateTrigger, validTz } from "../src/tasks/triggers.ts";

const BRAIN = { kind: "brain" } as const;
const T0 = Date.parse("2026-03-10T08:00:00Z");

function setup(opts: { tz?: string; start?: boolean } = {}) {
  const store = new Store(":memory:");
  store.migrate();
  const bus = new Bus();
  const clock = { now: T0 };
  const now = () => clock.now;
  const tz = opts.tz ?? "UTC";
  const tasks = new Tasks({ store, bus, tz, now });
  const stream = new EventStream({ bus, sessions: { get: () => undefined, list: () => [] }, now });
  stream.start([]);
  const scheduler = new TaskScheduler({ tasks, bus, stream, tz, log: silentLogger, now });
  const ready: TaskReadyEvent[] = [];
  const states: Task[] = [];
  bus.on("task.ready", (e) => ready.push(e));
  bus.on("task.state", (t) => states.push(structuredClone(t)));
  if (opts.start !== false) scheduler.start();
  return { store, bus, clock, tasks, stream, scheduler, ready, states, tz };
}

describe("triggers: the pure part", () => {
  test("validation: a bad cron expression, a bad zone, a never-matching expression and an empty event name are invalid", () => {
    expect(() => validateTrigger({ kind: "cron", expr: "0 9 * * *" }, "UTC")).not.toThrow();
    expect(() => validateTrigger({ kind: "cron", expr: "0 9 * * *", tz: "Europe/Istanbul" }, "UTC")).not.toThrow();
    expect(() => validateTrigger({ kind: "cron", expr: "not a cron" }, "UTC")).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(() => validateTrigger({ kind: "cron", expr: "0 9 * * *", tz: "Mars/Olympus" }, "UTC")).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(() => validateTrigger({ kind: "cron", expr: "0 0 30 2 *" }, "UTC")).toThrow(/never matches/);
    expect(() => validateTrigger({ kind: "event", name: "  " }, "UTC")).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(() => validateTrigger({ kind: "event", name: "my.ping" }, "UTC")).not.toThrow();
    expect(() => validateTrigger({ kind: "at", at: 5 }, "UTC")).not.toThrow();
    expect(validTz("Europe/Istanbul")).toBe(true);
    expect(validTz("Nowhere/Land")).toBe(false);
    expect(typeof nodeTz()).toBe("string");
    expect(validTz(nodeTz())).toBe(true);
  });

  test("dueAt: a time is itself; a cron is the next run after updatedAt in its zone or the platform's", () => {
    const base: Task = { id: newId("task"), title: "t", createdBy: BRAIN, status: "pending", priority: "normal", sessions: [], createdAt: T0, updatedAt: T0 };
    expect(dueAt({ ...base, trigger: { kind: "at", at: 123 } }, "UTC")).toBe(123);
    expect(dueAt({ ...base, trigger: { kind: "cron", expr: "0 9 * * *" } }, "UTC")).toBe(Date.parse("2026-03-10T09:00:00Z"));
    expect(dueAt({ ...base, updatedAt: Date.parse("2026-03-10T09:00:00Z"), trigger: { kind: "cron", expr: "0 9 * * *" } }, "UTC")).toBe(Date.parse("2026-03-11T09:00:00Z"));
    // 09:00 in Istanbul (UTC+3) is 06:00 UTC: at 08:00 UTC that is tomorrow.
    expect(dueAt({ ...base, trigger: { kind: "cron", expr: "0 9 * * *" } }, "Europe/Istanbul")).toBe(Date.parse("2026-03-11T06:00:00Z"));
    expect(dueAt({ ...base, trigger: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Istanbul" } }, "UTC")).toBe(Date.parse("2026-03-11T06:00:00Z"));
    expect(dueAt({ ...base, trigger: { kind: "event", name: "x.y" } }, "UTC")).toBeUndefined();
    expect(dueAt(base, "UTC")).toBeUndefined();
    expect(dueAt({ ...base, trigger: { kind: "cron", expr: "0 0 30 2 *" } }, "UTC")).toBeUndefined();
  });

  test("matchesEvent: by name, key by key, nested values by equality, a missing key as null", () => {
    const t = { kind: "event", name: "my.ci", match: { branch: "main", run: { ok: true } } } as const;
    expect(matchesEvent(t, { name: "my.ci", payload: { branch: "main", run: { ok: true }, extra: 1 } })).toBe(true);
    expect(matchesEvent(t, { name: "my.ci", payload: { branch: "dev", run: { ok: true } } })).toBe(false);
    expect(matchesEvent(t, { name: "my.ci", payload: { branch: "main", run: { ok: false } } })).toBe(false);
    expect(matchesEvent(t, { name: "other", payload: { branch: "main", run: { ok: true } } })).toBe(false);
    expect(matchesEvent({ kind: "event", name: "my.ci" }, { name: "my.ci", payload: "anything" })).toBe(true);
    expect(matchesEvent({ kind: "event", name: "my.ci", match: { branch: null } }, { name: "my.ci", payload: {} })).toBe(true);
    expect(matchesEvent({ kind: "event", name: "my.ci", match: { branch: "main" } }, { name: "my.ci", payload: null })).toBe(false);
    expect(matchesEvent({ kind: "at", at: 1 }, { name: "my.ci", payload: {} })).toBe(false);
    expect(matchesEvent(undefined, { name: "my.ci", payload: {} })).toBe(false);
  });

  test("rearms: recurring cron or event only", () => {
    const base: Task = { id: newId("task"), title: "t", createdBy: BRAIN, status: "done", priority: "normal", sessions: [], createdAt: 1, updatedAt: 1 };
    expect(rearms({ ...base, recurring: true, trigger: { kind: "cron", expr: "* * * * *" } })).toBe(true);
    expect(rearms({ ...base, recurring: true, trigger: { kind: "event", name: "x.y" } })).toBe(true);
    expect(rearms({ ...base, recurring: true, trigger: { kind: "at", at: 1 } })).toBe(false);
    expect(rearms({ ...base, trigger: { kind: "cron", expr: "* * * * *" } })).toBe(false);
    expect(rearms({ ...base, recurring: true })).toBe(false);
  });
});

describe("triggers: the scheduler", () => {
  test("a time trigger fires at its time and not before; once fired a second tick is a no-op; a paused or active task never fires", () => {
    const { clock, tasks, scheduler, ready, states } = setup();
    const at = T0 + 60_000;
    const t = tasks.create({ title: "later", trigger: { kind: "at", at } }, BRAIN);
    expect(t.status).toBe("pending");
    scheduler.tick();
    clock.now = at - 1;
    scheduler.tick();
    expect(ready).toEqual([]);
    clock.now = at;
    scheduler.tick();
    expect(ready).toEqual([{ at, id: t.id, cause: "trigger" }]);
    expect(tasks.get(t.id)!.status).toBe("ready");
    scheduler.tick();
    expect(ready).toHaveLength(1);
    expect(states.filter((s) => s.id === t.id).map((s) => s.status)).toEqual(["pending", "ready"]);

    const paused = tasks.create({ title: "paused", trigger: { kind: "at", at: T0 } }, BRAIN);
    tasks.update(paused.id, { status: "paused" }, BRAIN);
    const active = tasks.create({ title: "active", trigger: { kind: "at", at: T0 } }, BRAIN);
    tasks.update(active.id, { status: "active" }, BRAIN);
    scheduler.tick();
    expect(ready).toHaveLength(1);
    // Resumed: pending again, fires at the next tick since its time is past.
    tasks.update(paused.id, { status: "pending" }, BRAIN);
    scheduler.tick();
    expect(ready.map((r) => r.id)).toEqual([t.id, paused.id]);
    expect(tasks.fire(active.id)).toBe(false);
    expect(tasks.fire("task_01ARZ3NDEKTSV4RRFFQ69G5FB9")).toBe(false);
    scheduler.stop();
  });

  test("a recurring cron task marked done goes back to pending, keeps its result, and is due after now; a recurring at task stays done", () => {
    const { clock, tasks, scheduler, ready, tz } = setup();
    const t = tasks.create({ title: "morning", detail: "say what is open", trigger: { kind: "cron", expr: "0 9 * * *" }, recurring: true }, BRAIN);
    expect(dueAt(t, tz)).toBe(Date.parse("2026-03-10T09:00:00Z"));
    clock.now = Date.parse("2026-03-10T09:00:30Z");
    scheduler.tick();
    expect(ready).toHaveLength(1);
    expect(tasks.get(t.id)!.status).toBe("ready");
    clock.now = Date.parse("2026-03-10T09:05:00Z");
    const done = tasks.update(t.id, { status: "done", result: { summary: "3 open" } }, BRAIN);
    expect(done.status).toBe("pending");
    expect(done.completedAt).toBe(clock.now);
    expect(done.result).toEqual({ summary: "3 open" });
    expect(done.recurring).toBe(true);
    expect(dueAt(done, tz)).toBe(Date.parse("2026-03-11T09:00:00Z"));
    scheduler.tick();
    expect(ready).toHaveLength(1);
    clock.now = Date.parse("2026-03-11T09:00:00Z");
    scheduler.tick();
    expect(ready).toHaveLength(2);
    expect(tasks.get(t.id)!.result).toEqual({ summary: "3 open" });
    // Cancelled stays cancelled.
    const cancelled = tasks.update(t.id, { status: "cancelled" }, BRAIN);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.completedAt).toBe(clock.now);

    const once = tasks.create({ title: "once", trigger: { kind: "at", at: T0 }, recurring: true }, BRAIN);
    scheduler.tick();
    expect(tasks.update(once.id, { status: "done" }, BRAIN).status).toBe("done");
    scheduler.stop();
  });

  test("an event trigger fires on a matching custom event with the event on task.ready, re-arms when recurring, and a built-in event matches by capability name", () => {
    const { tasks, stream, scheduler, ready, bus } = setup();
    const t = tasks.create({ title: "on ping", trigger: { kind: "event", name: "my.ping", match: { branch: "main" } }, recurring: true }, BRAIN);
    stream.custom("my.ping", { branch: "dev" });
    expect(ready).toEqual([]);
    stream.custom("my.ping", { branch: "main", n: 1 });
    expect(ready).toEqual([{ at: T0, id: t.id, cause: "trigger", event: { name: "my.ping", payload: { branch: "main", n: 1 } } }]);
    // Ready now: another match does nothing until the task is done and re-armed.
    stream.custom("my.ping", { branch: "main", n: 2 });
    expect(ready).toHaveLength(1);
    expect(tasks.update(t.id, { status: "done", result: { summary: "handled 1" } }, BRAIN).status).toBe("pending");
    stream.custom("my.ping", { branch: "main", n: 3 });
    expect(ready).toHaveLength(2);
    expect(ready[1]!.event).toEqual({ name: "my.ping", payload: { branch: "main", n: 3 } });
    // Not recurring: done is done.
    tasks.update(t.id, { recurring: false }, BRAIN);
    expect(tasks.update(t.id, { status: "done" }, BRAIN).status).toBe("done");

    const builtin = tasks.create({ title: "on prompts", trigger: { kind: "event", name: "prompts.changed" } }, BRAIN);
    bus.emit("prompts.changed", { at: 5 });
    expect(ready[2]).toEqual({ at: T0, id: builtin.id, cause: "trigger", event: { name: "prompts.changed", payload: { at: 5 } } });
    scheduler.stop();
  });

  test("a time missed while the daemon was down fires at start; the timer is armed to the nearest due, capped", () => {
    const { store, bus, clock, tz } = setup({ start: false });
    const tasks = new Tasks({ store, bus, tz, now: () => clock.now });
    const past = tasks.create({ title: "missed", trigger: { kind: "at", at: T0 - 5000 } }, BRAIN);
    const far = tasks.create({ title: "far", trigger: { kind: "at", at: T0 + 3_600_000 } }, BRAIN);
    const ready: TaskReadyEvent[] = [];
    bus.on("task.ready", (e) => ready.push(e));
    const stream = new EventStream({ bus, sessions: { get: () => undefined, list: () => [] }, now: () => clock.now });
    stream.start([]);
    const scheduler = new TaskScheduler({ tasks, bus, stream, tz, log: silentLogger, now: () => clock.now });
    scheduler.start();
    expect(ready.map((r) => r.id)).toEqual([past.id]);
    expect(tasks.get(far.id)!.status).toBe("pending");
    expect(MAX_DELAY_MS).toBe(60_000);
    scheduler.stop();
    store.close();
  });

  test("dropping the trigger of a pending task makes it ready; a trigger patch is validated; create refuses a bad one", () => {
    const { tasks, scheduler, ready } = setup();
    const t = tasks.create({ title: "waiting", trigger: { kind: "cron", expr: "0 9 * * *" } }, BRAIN);
    expect(() => tasks.update(t.id, { trigger: { kind: "cron", expr: "bad" } }, BRAIN)).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(() => tasks.create({ title: "bad", trigger: { kind: "event", name: "" } }, BRAIN)).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(tasks.update(t.id, { trigger: null }, BRAIN).status).toBe("ready");
    expect(ready).toEqual([]);
    expect(tasks.scheduled()).toEqual([]);
    scheduler.stop();
  });
});
