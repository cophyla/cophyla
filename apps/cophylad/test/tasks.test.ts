// Tasks: status from the input, patches that block and unblock, completion timestamps, and
// the blockers the platform clears itself: an answered ask, a completed task, a session
// that went idle or ended, each raising `task.ready`; a harness ask answered while its agent
// runs on hands the task back to the session, and a block on something already settled
// settles at once.

import { describe, expect, test } from "bun:test";
import { newId } from "@cophyla/protocol";
import type { Session, Task } from "@cophyla/protocol";
import { Bus } from "../src/bus.ts";
import type { TaskReadyEvent } from "../src/bus.ts";
import { Asks } from "../src/gate/asks.ts";
import { Store } from "../src/store/index.ts";
import { Tasks } from "../src/tasks/index.ts";

const BRAIN = { kind: "brain" } as const;
const SESSION = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1";

function setup() {
  const store = new Store(":memory:");
  store.migrate();
  const bus = new Bus();
  const asks = new Asks(store, newId("node"), bus);
  let now = 5000;
  const tasks = new Tasks({ store, bus, tz: "UTC", now: () => now++ });
  const states: Task[] = [];
  const ready: TaskReadyEvent[] = [];
  bus.on("task.state", (t) => states.push(structuredClone(t)));
  bus.on("task.ready", (e) => ready.push(e));
  const session = (status: Session["status"]): Session => ({
    id: SESSION,
    node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    harness: "claude",
    profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8",
    native: { id: "x", transport: "acp" },
    origin: "orchestrator",
    cwd: ".",
    tags: [],
    status,
    startedAt: 1,
    lastActivity: 1,
  });
  return { store, bus, asks, tasks, states, ready, session };
}

describe("tasks", () => {
  test("status comes from the input; patches move it; done sets completedAt", () => {
    const { tasks, states } = setup();
    const a = tasks.create({ title: "a" }, BRAIN);
    expect(a.status).toBe("ready");
    expect(a.priority).toBe("normal");
    const b = tasks.create({ title: "b", blocker: { kind: "user" }, priority: "high" }, BRAIN);
    expect(b.status).toBe("blocked");
    const c = tasks.create({ title: "c", trigger: { kind: "at", at: 99 } }, BRAIN);
    expect(c.status).toBe("pending");
    expect(states.map((t) => t.id)).toEqual([a.id, b.id, c.id]);

    const active = tasks.update(a.id, { status: "active", sessions: [SESSION] }, BRAIN);
    expect(active.status).toBe("active");
    expect(active.sessions).toEqual([SESSION]);
    const blocked = tasks.update(a.id, { blocker: { kind: "session", session: SESSION } }, BRAIN);
    expect(blocked.status).toBe("blocked");
    const unblocked = tasks.update(a.id, { blocker: null }, BRAIN);
    expect(unblocked.status).toBe("ready");
    expect(unblocked.blocker).toBeUndefined();
    const done = tasks.update(a.id, { status: "done", result: { summary: "ok" } }, BRAIN);
    expect(done.completedAt).toBeDefined();
    expect(done.result).toEqual({ summary: "ok" });
    const reopened = tasks.update(a.id, { status: "ready" }, BRAIN);
    expect(reopened.completedAt).toBeUndefined();
    expect(tasks.list({ status: ["ready"] }).map((t) => t.id)).toEqual([a.id]);
    expect(tasks.open().map((t) => t.id).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(() => tasks.update("task_01ARZ3NDEKTSV4RRFFQ69G5FB9", {}, BRAIN)).toThrow(/no task/);
  });

  test("an answered or cancelled ask unblocks the tasks parked on it", () => {
    const { tasks, asks, ready } = setup();
    const ask = asks.open({ type: "permission", source: { kind: "harness", session: SESSION }, title: "x", options: [{ id: "allow", label: "Allow" }], answerableBy: ["user"] });
    const t = tasks.create({ title: "t", blocker: { kind: "ask", ask: ask.id } }, BRAIN);
    const other = tasks.create({ title: "other", blocker: { kind: "user" } }, BRAIN);
    asks.answer(ask.id, { option: "allow" }, { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" });
    expect(tasks.get(t.id)!.status).toBe("ready");
    expect(tasks.get(t.id)!.blocker).toBeUndefined();
    expect(tasks.get(other.id)!.status).toBe("blocked");
    expect(ready).toEqual([{ at: expect.any(Number), id: t.id, cause: "unblocked" }]);
    const ask2 = asks.open({ type: "choice", source: { kind: "brain" }, title: "y", options: [], answerableBy: ["user"] });
    tasks.update(t.id, { blocker: { kind: "ask", ask: ask2.id } }, BRAIN);
    asks.cancel(ask2.id);
    expect(tasks.get(t.id)!.status).toBe("ready");
    expect(ready).toHaveLength(2);
  });

  test("a harness ask answered while its agent still runs puts the task back on the session; a brain ask does not", () => {
    const { tasks, asks, bus, ready, session } = setup();
    bus.emit("session.state", session("busy"));
    const t = tasks.create({ title: "t" }, BRAIN);
    tasks.update(t.id, { status: "active", sessions: [SESSION] }, BRAIN);
    const harnessAsk = asks.open({ type: "permission", source: { kind: "harness", session: SESSION }, title: "run it", options: [{ id: "allow", label: "Allow" }], answerableBy: ["user"] });
    tasks.update(t.id, { blocker: { kind: "ask", ask: harnessAsk.id } }, BRAIN);
    bus.emit("session.state", session("needs_permission"));
    asks.answer(harnessAsk.id, { option: "allow" }, { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" });
    // The agent continues: no task.ready yet, the task waits on the session.
    expect(tasks.get(t.id)!.status).toBe("blocked");
    expect(tasks.get(t.id)!.blocker).toEqual({ kind: "session", session: SESSION });
    expect(ready).toEqual([]);
    bus.emit("session.state", session("busy"));
    bus.emit("session.state", session("idle"));
    expect(tasks.get(t.id)!.status).toBe("ready");
    expect(ready.map((r) => r.id)).toEqual([t.id]);
    // A question the brain asked the user is answered: the loop is wanted now, whatever the agent does.
    bus.emit("session.state", session("busy"));
    const brainAsk = asks.open({ type: "choice", source: { kind: "brain", task: t.id }, title: "which one", options: [{ id: "a", label: "A" }], answerableBy: ["user"] });
    tasks.update(t.id, { blocker: { kind: "ask", ask: brainAsk.id } }, BRAIN);
    asks.answer(brainAsk.id, { option: "a" }, { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" });
    expect(tasks.get(t.id)!.status).toBe("ready");
    expect(tasks.get(t.id)!.blocker).toBeUndefined();
    expect(ready).toHaveLength(2);
  });

  test("a block on an ask already answered settles at once, and an unknown ask is not_found", () => {
    const { tasks, asks, bus, ready, session } = setup();
    bus.emit("session.state", session("busy"));
    const t = tasks.create({ title: "t" }, BRAIN);
    tasks.update(t.id, { sessions: [SESSION], blocker: { kind: "session", session: SESSION } }, BRAIN);
    const ask = asks.open({ type: "permission", source: { kind: "harness", session: SESSION }, title: "edit", options: [{ id: "allow", label: "Allow" }], answerableBy: ["user"] });
    asks.answer(ask.id, { option: "allow" }, { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" });
    // The brain parks on it late: the agent is still busy, so the task stays on the session.
    const late = tasks.update(t.id, { blocker: { kind: "ask", ask: ask.id } }, BRAIN);
    expect(late.status).toBe("blocked");
    expect(late.blocker).toEqual({ kind: "session", session: SESSION });
    expect(ready).toEqual([]);
    // Same, once the agent has gone idle: ready now, and the brain hears it.
    bus.emit("session.state", session("idle"));
    expect(ready).toHaveLength(1);
    const later = tasks.update(t.id, { blocker: { kind: "ask", ask: ask.id } }, BRAIN);
    expect(later.status).toBe("ready");
    expect(later.blocker).toBeUndefined();
    expect(ready).toHaveLength(2);
    expect(() => tasks.update(t.id, { blocker: { kind: "ask", ask: "ask_01ARZ3NDEKTSV4RRFFQ69G5FB9" } }, BRAIN)).toThrow(/no ask/);
  });

  test("a completed task unblocks the tasks waiting on it", () => {
    const { tasks, ready } = setup();
    const first = tasks.create({ title: "first" }, BRAIN);
    const second = tasks.create({ title: "second", blocker: { kind: "task", task: first.id } }, BRAIN);
    tasks.update(first.id, { status: "active" }, BRAIN);
    expect(ready).toEqual([]);
    tasks.update(first.id, { status: "done" }, BRAIN);
    expect(tasks.get(second.id)!.status).toBe("ready");
    expect(ready.map((r) => r.id)).toEqual([second.id]);
  });

  test("a session idle while its own shells run, or with a dialog open, is still at the work: the task waits for plain idle", () => {
    const { tasks, bus, ready, session } = setup();
    const t = tasks.create({ title: "t", blocker: { kind: "session", session: SESSION } }, BRAIN);
    bus.emit("session.state", session("busy"));
    bus.emit("session.state", { ...session("idle"), waiting: { on: "shell" } });
    expect(tasks.get(t.id)!.status).toBe("blocked");
    bus.emit("session.state", { ...session("idle"), waiting: { on: "user", detail: "dialog open" } });
    expect(tasks.get(t.id)!.status).toBe("blocked");
    bus.emit("session.state", session("idle"));
    expect(tasks.get(t.id)!.status).toBe("ready");
    expect(ready.map((r) => r.id)).toEqual([t.id]);
    // Blocking on one waiting on its shell waits too.
    bus.emit("session.state", { ...session("idle"), waiting: { on: "shell" } });
    tasks.update(t.id, { blocker: { kind: "session", session: SESSION } }, BRAIN);
    expect(tasks.get(t.id)!.status).toBe("blocked");
    bus.emit("session.state", session("idle"));
    expect(tasks.get(t.id)!.status).toBe("ready");
  });

  test("the edge of a session to idle or ended unblocks, repeated idle states do not", () => {
    const { tasks, bus, ready, session } = setup();
    const t = tasks.create({ title: "t", blocker: { kind: "session", session: SESSION } }, BRAIN);
    bus.emit("session.state", session("busy"));
    expect(tasks.get(t.id)!.status).toBe("blocked");
    bus.emit("session.state", session("idle"));
    expect(tasks.get(t.id)!.status).toBe("ready");
    expect(ready.map((r) => r.id)).toEqual([t.id]);
    // Blocking on a session already idle is ready at once: the agent finished before the block.
    tasks.update(t.id, { blocker: { kind: "session", session: SESSION } }, BRAIN);
    expect(tasks.get(t.id)!.status).toBe("ready");
    expect(tasks.get(t.id)!.blocker).toBeUndefined();
    expect(ready).toHaveLength(2);
    bus.emit("session.state", session("busy"));
    tasks.update(t.id, { blocker: { kind: "session", session: SESSION } }, BRAIN);
    bus.emit("session.state", session("busy"));
    bus.emit("session.state", session("needs_permission"));
    expect(tasks.get(t.id)!.status).toBe("blocked");
    bus.emit("session.state", session("ended"));
    expect(tasks.get(t.id)!.status).toBe("ready");
    expect(ready).toHaveLength(3);
    // An ended session cannot be waited on either.
    tasks.update(t.id, { blocker: { kind: "session", session: SESSION } }, BRAIN);
    expect(tasks.get(t.id)!.status).toBe("ready");
    expect(ready).toHaveLength(4);
    // Primed sessions start from their current status, so a repeated state does not fire.
    tasks.prime([session("busy")]);
    tasks.update(t.id, { blocker: { kind: "session", session: SESSION } }, BRAIN);
    bus.emit("session.state", session("busy"));
    expect(tasks.get(t.id)!.status).toBe("blocked");
    expect(ready).toHaveLength(4);
    tasks.dispose();
  });
});
