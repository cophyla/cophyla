// The store's upkeep, as background jobs on the scheduler, and what makes the daemon busy for
// them. Each job is small on the daemon's thread: the reads go to the background worker, the
// writes come back in batches, and everything waits while someone is talking to the daemon or
// the CPU is critically loaded.
//
// - checkpoint: a passive checkpoint on the worker every few seconds, so no commit on the
//   daemon's thread ever copies the WAL into the store (the connection's own checkpointing is
//   off while the worker does it, and back on if the worker is given up).
// - optimize: the planner's statistics, a few minutes after the start and hourly, bounded by
//   `analysis_limit` (the first ever, with no statistics yet, reads every index: most of a
//   second on a store of a year; they are kept in the store, so the ones after are quick).
// - clears: the clears recorded before `session_clears`, read in once (clears.ts).
// - audit: the audit kept to its retention, a thousand of the oldest rows a slice.
// - metrics: the minutes stored before the rollup folded its processes, folded and their spend
//   kept apart, newest first, once.

import type { Bus } from "../bus.ts";
import type { Logger } from "../log.ts";
import { fillClears } from "../store/clears.ts";
import type { Store } from "../store/index.ts";
import type { Background } from "./client.ts";
import type { CompactedMinute } from "./jobs.ts";
import { Scheduler } from "./scheduler.ts";
import type { JobContext } from "./scheduler.ts";

export interface MaintenanceDeps {
  store: Store;
  background: Background;
  bus: Bus;
  nodeId: string;
  log: Logger;
  auditRetentionDays: number;
  /** When the clears are all read in: the spend backfill's first run waits for it. */
  onClearsFilled?: () => void;
  /** Keeps the planner's statistics (not for a test's store). */
  optimize?: boolean;
  now?: () => number;
}

const CHECKPOINT_EVERY_MS = 5_000;
/** Checkpoints that fail in a row before the connection checkpoints for itself again. */
const CHECKPOINT_FAILURES = 3;
const OPTIMIZE_EVERY_MS = 3_600_000;
const OPTIMIZE_FIRST_MS = 300_000;
const AUDIT_EVERY_MS = 3_600_000;
const AUDIT_BATCH = 1000;
const COMPACT_BATCH = 100;
const COMPACT_DONE = "metrics.compact.v1";
const COMPACT_AT = "metrics.compact.v1.at";

/** Tracks what makes the daemon busy for background work: a conversation listening or transcribing, the CPU critical. */
export function busySignal(bus: Bus, nodeId: string): { busy: () => string | undefined; dispose: () => void } {
  const voice = new Map<string, string>();
  let cpuCritical = false;
  const offs = [
    bus.on("voice.state", (s) => {
      const key = s.client ?? "";
      if (s.state === "listening" || s.state === "transcribing") voice.set(key, s.state);
      else voice.delete(key);
    }),
    bus.on("node.pressure", (p) => {
      if (p.node === nodeId && p.resource === "cpu") cpuCritical = p.level === "critical";
    }),
  ];
  return {
    busy: () => (voice.size > 0 ? "voice" : cpuCritical ? "cpu" : undefined),
    dispose: () => {
      for (const off of offs) off();
    },
  };
}

export class Maintenance {
  readonly scheduler: Scheduler;
  private deps: MaintenanceDeps;
  private signal: { busy: () => string | undefined; dispose: () => void };
  private checkpointFailures = 0;

  constructor(deps: MaintenanceDeps) {
    this.deps = deps;
    this.signal = busySignal(deps.bus, deps.nodeId);
    this.scheduler = new Scheduler({ log: deps.log, background: deps.background, busy: this.signal.busy, ...(deps.now ? { now: deps.now } : {}) });
    const { store, background } = deps;
    if (background.threaded) {
      store.checkpointBy("worker");
      this.scheduler.add({ name: "store.checkpoint", class: "checkpoint", delayMs: CHECKPOINT_EVERY_MS, everyMs: CHECKPOINT_EVERY_MS, maxDeferMs: 0, run: (ctx) => this.checkpoint(ctx) });
    }
    if (deps.optimize !== false) this.scheduler.add({ name: "store.optimize", delayMs: OPTIMIZE_FIRST_MS, everyMs: OPTIMIZE_EVERY_MS, run: async () => store.optimize() });
    this.scheduler.add({
      name: "store.clears",
      delayMs: 10_000,
      run: async (ctx) => {
        if (await fillClears(store, ctx)) deps.onClearsFilled?.();
      },
    });
    this.scheduler.add({ name: "audit.retention", delayMs: 120_000, everyMs: AUDIT_EVERY_MS, run: (ctx) => this.auditRetention(ctx) });
    this.scheduler.add({ name: "metrics.compact", delayMs: 60_000, run: (ctx) => this.compactMetrics(ctx) });
  }

  get background(): Background {
    return this.deps.background;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  start(): void {
    this.scheduler.start();
  }

  async stop(): Promise<void> {
    this.signal.dispose();
    await this.scheduler.stop();
  }

  private async checkpoint(ctx: JobContext): Promise<void> {
    try {
      await ctx.read("checkpoint");
      this.checkpointFailures = 0;
    } catch (e) {
      if (++this.checkpointFailures === CHECKPOINT_FAILURES) {
        this.deps.log.warn("checkpoints keep failing on the background worker; the store checkpoints for itself", { error: e instanceof Error ? e.message : String(e) });
        this.deps.store.checkpointBy("self");
      }
    }
  }

  /**
   * Drops the audit rows past the retention, the oldest first, a batch a slice: a thousand rows,
   * halved while a batch takes longer than a slice should (an audit row carries its result, and
   * its pages are freed with it), down to a hundred.
   */
  private async auditRetention(ctx: JobContext): Promise<void> {
    const before = this.now() - this.deps.auditRetentionDays * 86_400_000;
    let gone = 0;
    let batch = AUDIT_BATCH;
    for (;;) {
      if (ctx.stopping) break;
      const t0 = performance.now();
      const n = this.deps.store.audit.prune(before, batch);
      if (performance.now() - t0 > 20 && batch > 100) batch = Math.max(100, batch >> 1);
      gone += n;
      if (n < batch) break;
      await ctx.yield();
    }
    if (gone > 0) this.deps.log.info("audit pruned", { rows: gone, days: this.deps.auditRetentionDays });
  }

  /** Folds the stored minutes, newest first, and keeps their spend apart; marked done once it reaches the oldest. */
  private async compactMetrics(ctx: JobContext): Promise<void> {
    const { store } = this.deps;
    if (store.meta.get(COMPACT_DONE) === "done") return;
    let before = Number(store.meta.get(COMPACT_AT) ?? Number.MAX_SAFE_INTEGER) || Number.MAX_SAFE_INTEGER;
    let folded = 0;
    for (;;) {
      if (ctx.stopping) return;
      const rows = await ctx.read<CompactedMinute[]>("metrics.compact", { node: this.deps.nodeId, before, limit: COMPACT_BATCH });
      if (rows.length === 0) break;
      store.db.transaction(() => {
        for (const r of rows) {
          if (r.sample !== undefined) {
            store.metrics.replace(this.deps.nodeId, r.minute, r.sample);
            folded++;
          }
          if (r.profiles !== undefined) store.metrics.putSpend(this.deps.nodeId, r.minute, JSON.parse(r.profiles) as never);
        }
        before = rows[rows.length - 1]!.minute;
        store.meta.set(COMPACT_AT, String(before));
      })();
      await ctx.yield();
    }
    store.meta.set(COMPACT_DONE, "done");
    if (folded > 0) this.deps.log.info("stored metrics folded", { minutes: folded });
  }
}
