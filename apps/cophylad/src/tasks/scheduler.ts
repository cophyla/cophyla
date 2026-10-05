// The clock behind task triggers. One timer, armed to the nearest due `at` or cron task
// among the ones it watches and capped at a minute so a machine back from sleep catches up
// within one; `tick` fires every task due by now, so a firing missed while the daemon was
// down fires at the first tick after start. It watches the pending tasks, and the recurring
// cron tasks still `ready`: one whose last run nobody marked done fires again at its next
// time, once however many times went by. Event triggers listen on the event stream and
// fire on a matching name and payload. The timer is re-armed on every task change, so a
// task created, paused or resumed moves the clock at once.

import type { Task } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import { eventKey } from "../events/stream.ts";
import type { EventStream } from "../events/stream.ts";
import type { Logger } from "../log.ts";
import type { Tasks } from "./index.ts";
import { dueAt, matchesEvent } from "./triggers.ts";

export interface TaskSchedulerDeps {
  tasks: Tasks;
  bus: Bus;
  stream: EventStream;
  tz: string;
  log: Logger;
  now?: () => number;
}

/** The longest the timer sleeps: a clock that jumped (sleep, a manual change) is noticed within this. */
export const MAX_DELAY_MS = 60_000;

export class TaskScheduler {
  private deps: TaskSchedulerDeps;
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe: (() => void)[] = [];
  private stopped = false;
  /** Cron tasks already warned about, so a stuck expression is logged once. */
  private warned = new Set<string>();

  constructor(deps: TaskSchedulerDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Fires what came due while the daemon was down, then keeps time and listens for events. */
  start(): void {
    this.stopped = false;
    this.tick();
    this.unsubscribe.push(
      this.deps.stream.on((e) => this.onEvent(eventKey(e))),
      this.deps.bus.on("task.state", () => this.arm()),
    );
  }

  /** Fires every watched time or cron task due by now, then arms the timer for the next. */
  tick(): void {
    const now = this.now();
    for (const t of this.deps.tasks.scheduled()) {
      const due = this.dueOf(t);
      if (due !== undefined && due <= now) this.deps.tasks.fire(t.id);
    }
    this.arm();
  }

  /** Sets the timer to the nearest due time or cron task, capped; clears it when there is none. */
  arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped) return;
    let nearest: number | undefined;
    for (const t of this.deps.tasks.scheduled()) {
      const due = this.dueOf(t);
      if (due !== undefined && (nearest === undefined || due < nearest)) nearest = due;
    }
    if (nearest === undefined) return;
    const delay = Math.min(Math.max(nearest - this.now(), 0), MAX_DELAY_MS);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tick();
    }, delay);
  }

  /** When a task is next due; undefined for an event trigger, and for a cron trigger that stopped computing. */
  private dueOf(t: Task): number | undefined {
    const due = dueAt(t, this.deps.tz);
    if (due === undefined && t.trigger?.kind === "cron" && !this.warned.has(t.id)) {
      this.warned.add(t.id);
      this.deps.log.warn("cron trigger has no next run", { task: t.id, expr: t.trigger.expr });
    }
    return due;
  }

  private onEvent(event: { name: string; payload: unknown }): void {
    for (const t of this.deps.tasks.scheduled()) {
      if (matchesEvent(t.trigger, event)) this.deps.tasks.fire(t.id, event);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
  }
}
