// The daemon's background work, paced so it never holds the thread that answers the user. A
// job runs in slices: it does a little, calls `ctx.yield()`, and the slice ends once it has
// used its budget (8 ms), with a turn of the event loop before the next, so a client's frame,
// a voice packet or a hook is never queued behind more than a slice. Jobs of one class run one
// at a time. Background work waits while the user is talking to the daemon (any conversation
// listening or transcribing) and while the machine's CPU is critically loaded, for a bounded
// time each, then goes on: work deferred for ever is a leak of its own. Heavy reads go to the
// background worker through `ctx.read`, during which the slice is over. A slice that overran
// its budget well is logged, with its job, so a job that stopped yielding is found.
//
// Periodic jobs start a little after the daemon and then repeat, both jittered so jobs that
// share a period do not land together; a job can also be triggered (new work arrived) and
// asks to run again soon by answering "again". While a slice runs it is the watchdog's task.

import type { Logger } from "../log.ts";
import { enter, leave, taskId } from "../watchdog/task.ts";
import type { Background, CallOptions } from "./client.ts";

export interface JobContext {
  /** Ends the slice when its budget is spent, and waits while the daemon is busy. Cheap to call often. */
  yield(): Promise<void>;
  /** A read on the background worker; the slice is over while it runs. */
  read<T>(job: string, args?: unknown, opts?: CallOptions): Promise<T>;
  /** Waits this long, the slice over meanwhile; cut short when the scheduler stops. */
  sleep(ms: number): Promise<void>;
  /** Runs `between` with the slice over meanwhile: a wait on another thread is no slice's. */
  pauseFor<T>(between: () => Promise<T>): Promise<T>;
  /** The scheduler is stopping: the job returns at its next step. */
  readonly stopping: boolean;
  readonly log: Logger;
}

export interface JobSpec {
  name: string;
  /** Jobs of one class run one at a time; "maintenance" otherwise. */
  class?: string;
  /** The first run, this long after `start` (jittered); absent with no `everyMs`: only when triggered. */
  delayMs?: number;
  /** The runs after it, this often (jittered by a tenth). */
  everyMs?: number;
  /** How long it waits for a quiet daemon before it runs anyway; ten minutes otherwise. */
  maxDeferMs?: number;
  /** "again": there is more, run again soon. */
  run(ctx: JobContext): Promise<void | "again">;
}

export interface SchedulerDeps {
  log: Logger;
  background: Background;
  /** Why background work should wait now (`voice`, `cpu`), or nothing. */
  busy: () => string | undefined;
  /** A slice's budget on the daemon's thread. */
  budgetMs?: number;
  /** For tests: what counts as now, and how a wait is waited. */
  now?: () => number;
  random?: () => number;
}

export const SLICE_BUDGET_MS = 8;
/** A slice this long is logged as overrunning its job's budget. */
const OVERRUN_MS = 50;
const OVERRUN_LOG_EVERY_MS = 600_000;
const DEFER_POLL_MS = 250;
const MAX_DEFER_MS = 600_000;
/** How soon a job that answered "again", or was triggered, runs. */
const AGAIN_MS = 50;

interface JobState {
  spec: JobSpec;
  timer?: ReturnType<typeof setTimeout>;
  due: boolean;
  running: boolean;
  lastOverrun: number;
  label: number;
}

export class Scheduler {
  private deps: SchedulerDeps;
  private jobs = new Map<string, JobState>();
  private classes = new Map<string, { busy: boolean; queue: JobState[] }>();
  private started = false;
  private stopped = false;
  private sleeps = new Set<() => void>();
  private runs = new Set<Promise<void>>();

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private jitter(ms: number, spread: number): number {
    return Math.max(0, Math.round(ms * (1 - spread + 2 * spread * (this.deps.random ?? Math.random)())));
  }

  add(spec: JobSpec): void {
    if (this.jobs.has(spec.name)) throw new Error(`job ${spec.name} is there already`);
    const state: JobState = { spec, due: false, running: false, lastOverrun: 0, label: taskId(`job: ${spec.name}`) };
    this.jobs.set(spec.name, state);
    if (this.started) this.arm(state, spec.delayMs ?? spec.everyMs);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const state of this.jobs.values()) this.arm(state, state.spec.delayMs ?? state.spec.everyMs);
  }

  /** Runs a job soon: new work for it arrived. */
  trigger(name: string): void {
    const state = this.jobs.get(name);
    if (!state || this.stopped) return;
    if (state.running) {
      state.due = true;
      return;
    }
    this.arm(state, AGAIN_MS, 0);
  }

  /** Stops every timer, cuts the waits short and resolves once the running slices have returned. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const state of this.jobs.values()) if (state.timer) clearTimeout(state.timer);
    for (const wake of [...this.sleeps]) wake();
    await Promise.allSettled([...this.runs]);
  }

  private arm(state: JobState, ms: number | undefined, spread = 0.1): void {
    if (this.stopped || ms === undefined) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      this.due(state);
    }, this.jitter(ms, spread));
    (state.timer as { unref?: () => void }).unref?.();
  }

  private due(state: JobState): void {
    if (this.stopped) return;
    const cls = state.spec.class ?? "maintenance";
    let c = this.classes.get(cls);
    if (!c) this.classes.set(cls, (c = { busy: false, queue: [] }));
    if (!c.queue.includes(state)) c.queue.push(state);
    if (!c.busy) this.pump(c);
  }

  private pump(c: { busy: boolean; queue: JobState[] }): void {
    const state = c.queue.shift();
    if (!state || this.stopped) return;
    c.busy = true;
    const run = this.runJob(state).finally(() => {
      this.runs.delete(run);
      c.busy = false;
      this.pump(c);
    });
    this.runs.add(run);
  }

  private async runJob(state: JobState): Promise<void> {
    const spec = state.spec;
    state.running = true;
    state.due = false;
    let again = false;
    const ctx = this.context(state);
    try {
      await this.quiet(spec);
      if (this.stopped) return;
      const prev = enter(state.label);
      ctx.sliceAt = performance.now();
      try {
        again = (await spec.run(ctx)) === "again";
      } finally {
        this.sliceEnded(state, ctx);
        leave(prev);
      }
    } catch (e) {
      this.deps.log.warn("background job failed", { job: spec.name, error: e instanceof Error ? e.message : String(e) });
    } finally {
      state.running = false;
    }
    if (this.stopped) return;
    if (again || state.due) this.arm(state, AGAIN_MS, 0);
    else if (spec.everyMs !== undefined) this.arm(state, spec.everyMs);
  }

  /** Waits while the daemon is busy, for the job's bound at most. */
  private async quiet(spec: JobSpec): Promise<void> {
    const until = this.now() + (spec.maxDeferMs ?? MAX_DEFER_MS);
    while (!this.stopped && this.deps.busy() !== undefined && this.now() < until) await this.wait(DEFER_POLL_MS);
  }

  private wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(t);
        this.sleeps.delete(wake);
        resolve();
      };
      const t = setTimeout(wake, ms);
      this.sleeps.add(wake);
    });
  }

  private sliceEnded(state: JobState, ctx: { sliceAt: number }): void {
    const ms = performance.now() - ctx.sliceAt;
    if (ms < OVERRUN_MS) return;
    const now = this.now();
    if (now - state.lastOverrun < OVERRUN_LOG_EVERY_MS) return;
    state.lastOverrun = now;
    this.deps.log.warn("background slice over budget", { job: state.spec.name, ms: Math.round(ms), budgetMs: this.deps.budgetMs ?? SLICE_BUDGET_MS });
  }

  private context(state: JobState): JobContext & { sliceAt: number } {
    const budget = this.deps.budgetMs ?? SLICE_BUDGET_MS;
    const self = this;
    const ctx = {
      sliceAt: 0,
      get stopping() {
        return self.stopped;
      },
      log: this.deps.log,
      /** Ends the slice, runs `between` with no label, and starts the next once the daemon is quiet. */
      async pauseFor<T>(between: () => Promise<T>): Promise<T> {
        self.sliceEnded(state, ctx);
        // A job runs from a timer, under no task of its own: between slices there is none.
        leave(0);
        try {
          return await between();
        } finally {
          await self.quiet(state.spec);
          enter(state.label);
          ctx.sliceAt = performance.now();
        }
      },
      async yield(): Promise<void> {
        if (performance.now() - ctx.sliceAt < budget) return;
        await ctx.pauseFor(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
      },
      read<T>(job: string, args?: unknown, opts?: CallOptions): Promise<T> {
        return ctx.pauseFor(() => self.deps.background.call<T>(job, args, opts));
      },
      sleep(ms: number): Promise<void> {
        return ctx.pauseFor(() => self.wait(ms));
      },
    };
    return ctx;
  }
}
