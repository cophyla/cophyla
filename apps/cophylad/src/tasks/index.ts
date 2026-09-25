// The task table and the blockers the platform clears itself: an answered ask, a completed
// task, a session that went idle or ended. Each cleared blocker moves the task to `ready` and
// raises `task.ready` for the brain; a task blocked on a session that has already gone idle
// or ended, or on an ask already closed, settles at once, so a fast agent or a fast answer
// cannot slip between the event and the block. A harness ask answered while the agent that
// raised it still runs puts its task back on that session: the agent continues, and the task
// is ready when it goes idle. A task with a trigger (a time, a cron expression, an event)
// waits `pending` until the scheduler fires it through `fire`, which makes it `ready` with
// `task.ready {cause: trigger}`; a recurring cron or event task marked done goes back to
// `pending` with its result kept, so it fires again. Every change is streamed as `task.state`.

import { newId, RpcError } from "@cophyla/protocol";
import type { Ask, Principal, Session, Task, TaskBlocker, TaskStatus } from "@cophyla/protocol";
import type { z } from "zod";
import type { TaskCreate, TaskPatch } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import type { Store } from "../store/index.ts";
import type { TaskListFilter } from "../store/index.ts";
import { rearms, validateTrigger } from "./triggers.ts";

export type TaskCreateInput = z.infer<typeof TaskCreate>;
export type TaskPatchInput = z.infer<typeof TaskPatch>;

export interface TasksDeps {
  store: Store;
  bus: Bus;
  /** The zone a cron trigger without `tz` runs in. */
  tz: string;
  now?: () => number;
}

/**
 * A session done for now: ended, or idle with nothing it waits on. One idle while its own
 * shells run, or with a dialog open, is still at the work.
 */
function settled(s: Session): boolean {
  return s.status === "ended" || (s.status === "idle" && s.waiting === undefined);
}

export class Tasks {
  private deps: TasksDeps;
  private unsubscribe: (() => void)[] = [];
  /** Whether each session was last seen settled, so only the edge into settled clears a blocker. */
  private sessionSettled = new Map<string, boolean>();

  constructor(deps: TasksDeps) {
    this.deps = deps;
    this.unsubscribe.push(deps.bus.on("ask.state", (ask) => this.onAskState(ask)));
    this.unsubscribe.push(deps.bus.on("session.state", (session) => this.onSessionState(session)));
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  list(filter: TaskListFilter = {}): Task[] {
    return this.deps.store.tasks.list(filter);
  }

  get(id: string): Task | undefined {
    return this.deps.store.tasks.get(id);
  }

  must(id: string): Task {
    const t = this.deps.store.tasks.get(id);
    if (!t) throw new RpcError("not_found", `no task ${id}`);
    return t;
  }

  /** Open tasks: everything not finished. */
  open(): Task[] {
    return this.deps.store.tasks.list({ status: ["pending", "ready", "active", "paused", "blocked"] });
  }

  create(input: TaskCreateInput, by: Principal): Task {
    if (input.trigger) validateTrigger(input.trigger, this.deps.tz);
    const now = this.now();
    const t: Task = {
      id: newId("task", now),
      title: input.title,
      createdBy: by,
      status: input.blocker ? "blocked" : input.trigger ? "pending" : "ready",
      priority: input.priority ?? "normal",
      sessions: [],
      createdAt: now,
      updatedAt: now,
    };
    if (input.detail !== undefined) t.detail = input.detail;
    if (input.workspace !== undefined) t.workspace = input.workspace;
    if (input.thread !== undefined) t.thread = input.thread;
    if (input.parent !== undefined) t.parent = input.parent;
    if (input.trigger !== undefined) t.trigger = input.trigger;
    if (input.recurring) t.recurring = true;
    if (input.blocker !== undefined) t.blocker = input.blocker;
    this.deps.store.tasks.insert(t);
    this.deps.bus.emit("task.state", t);
    return t;
  }

  update(id: string, patch: TaskPatchInput, _by: Principal): Task {
    const t = this.must(id);
    if (patch.trigger) validateTrigger(patch.trigger, this.deps.tz);
    const now = this.now();
    const wasFinished = t.status === "done" || t.status === "cancelled";
    if (patch.title !== undefined) t.title = patch.title;
    if (patch.detail !== undefined) t.detail = patch.detail;
    if (patch.priority !== undefined) t.priority = patch.priority;
    if (patch.trigger !== undefined) {
      if (patch.trigger === null) {
        delete t.trigger;
        // Nothing left to wait for: a pending task with no blocker is ready now.
        if (t.status === "pending" && !t.blocker && patch.status === undefined) t.status = "ready";
      } else t.trigger = patch.trigger;
    }
    if (patch.recurring !== undefined) {
      if (patch.recurring) t.recurring = true;
      else delete t.recurring;
    }
    if (patch.sessions !== undefined) t.sessions = patch.sessions;
    if (patch.result !== undefined) t.result = patch.result;
    let settled = false;
    if (patch.blocker !== undefined) {
      if (patch.blocker === null) {
        delete t.blocker;
        if (t.status === "blocked") t.status = "ready";
      } else if (patch.blocker.kind === "session" && this.isSettled(patch.blocker.session)) {
        // The agent already went idle or ended: there is nothing to wait for, so the task is ready now.
        delete t.blocker;
        t.status = "ready";
        settled = true;
      } else if (patch.blocker.kind === "ask") {
        const ask = this.deps.store.asks.get(patch.blocker.ask);
        if (!ask) throw new RpcError("not_found", `no ask ${patch.blocker.ask}`);
        if (ask.status === "open") {
          t.blocker = patch.blocker;
          t.status = "blocked";
        } else {
          // Answered before the block landed: what follows an answer follows now.
          this.afterAsk(t, ask);
          settled = t.status === "ready";
        }
      } else {
        t.blocker = patch.blocker;
        t.status = "blocked";
      }
    }
    if (patch.status !== undefined) {
      t.status = patch.status;
      if (patch.status !== "blocked" && patch.blocker === undefined && t.blocker && patch.status !== "paused") delete t.blocker;
    }
    const done = t.status === "done";
    if (done && rearms(t)) {
      // One entity that re-arms: this run is over, the next waits on the trigger; the result stays until the next run replaces it.
      t.completedAt = now;
      t.status = "pending";
    } else if (t.status === "done" || t.status === "cancelled") t.completedAt = wasFinished ? (t.completedAt ?? now) : now;
    else delete t.completedAt;
    t.updatedAt = now;
    this.deps.store.tasks.update(t);
    this.deps.bus.emit("task.state", t);
    if (settled && t.status === "ready") this.deps.bus.emit("task.ready", { at: now, id: t.id, cause: "unblocked" });
    if (done) this.unblock("task", t.id);
    return t;
  }

  /**
   * A trigger fired: the task goes `ready` and the brain hears `task.ready {cause: trigger}`,
   * with the event that fired an event trigger. Only a `pending` task fires; false otherwise,
   * so a task paused, already ready or being worked on is left alone.
   */
  fire(id: string, event?: { name: string; payload: unknown }): boolean {
    const t = this.deps.store.tasks.get(id);
    if (!t || t.status !== "pending") return false;
    const now = this.now();
    t.status = "ready";
    t.updatedAt = now;
    this.deps.store.tasks.update(t);
    this.deps.bus.emit("task.state", t);
    this.deps.bus.emit("task.ready", { at: now, id: t.id, cause: "trigger", ...(event ? { event } : {}) });
    return true;
  }

  /** The pending tasks with a trigger: what the scheduler watches. */
  scheduled(): Task[] {
    return this.deps.store.tasks.list({ status: ["pending"] }).filter((t) => t.trigger !== undefined);
  }

  /** Whether the session was last seen as a blocker would already have cleared on. */
  private isSettled(session: string): boolean {
    return this.sessionSettled.get(session) === true;
  }

  /** Every task blocked on `kind: id` goes `ready` and the brain hears `task.ready`. */
  private unblock(kind: "task" | "session", id: string): Task[] {
    const cleared: Task[] = [];
    for (const t of this.deps.store.tasks.blockedOn(kind, id)) {
      const now = this.now();
      delete t.blocker;
      t.status = "ready";
      t.updatedAt = now;
      this.deps.store.tasks.update(t);
      this.deps.bus.emit("task.state", t);
      this.deps.bus.emit("task.ready", { at: now, id: t.id, cause: "unblocked" });
      cleared.push(t);
    }
    return cleared;
  }

  /**
   * What follows a closed ask for a task parked on it. A harness ask from one of the task's own
   * sessions means the agent goes on working, so the task waits on that session unless it has
   * already gone idle or ended; any other ask leaves the task ready.
   */
  private afterAsk(t: Task, ask: Ask): void {
    const session = ask.source.kind === "harness" && t.sessions.includes(ask.source.session) && !this.isSettled(ask.source.session) ? ask.source.session : undefined;
    if (session) {
      t.blocker = { kind: "session", session };
      t.status = "blocked";
    } else {
      delete t.blocker;
      t.status = "ready";
    }
  }

  private onAskState(ask: Ask): void {
    if (ask.status === "open") return;
    for (const t of this.deps.store.tasks.blockedOn("ask", ask.id)) {
      const now = this.now();
      this.afterAsk(t, ask);
      t.updatedAt = now;
      this.deps.store.tasks.update(t);
      this.deps.bus.emit("task.state", t);
      if (t.status === "ready") this.deps.bus.emit("task.ready", { at: now, id: t.id, cause: "unblocked" });
    }
  }

  private onSessionState(session: Session): void {
    const was = this.sessionSettled.get(session.id);
    const now = settled(session);
    this.sessionSettled.set(session.id, now);
    if (now && was !== true) this.unblock("session", session.id);
  }

  /**
   * Tasks blocked on an ask that is not open here go `ready`: what a promoted backup does,
   * since the asks the old primary held went with it. Returns how many were released.
   */
  releaseUnknownAsks(isOpen: (ask: string) => boolean): number {
    let n = 0;
    for (const t of this.deps.store.tasks.list({ status: ["blocked"], blocker: "ask" })) {
      if (t.blocker?.kind !== "ask" || isOpen(t.blocker.ask)) continue;
      const now = this.now();
      delete t.blocker;
      t.status = "ready";
      t.updatedAt = now;
      this.deps.store.tasks.update(t);
      this.deps.bus.emit("task.state", t);
      this.deps.bus.emit("task.ready", { at: now, id: t.id, cause: "unblocked" });
      n++;
    }
    return n;
  }

  /** Marks what the tasks module saw of a session at start, so a session already idle does not fire. */
  prime(sessions: Session[]): void {
    for (const s of sessions) if (s.status !== "ended") this.sessionSettled.set(s.id, settled(s));
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
  }
}

export type { TaskBlocker, TaskStatus };
