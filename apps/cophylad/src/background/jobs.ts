// The background worker's jobs: reads of the store too long for the daemon's thread, and the
// passive checkpoint. Each is a plain function of a connection and its arguments, so the
// worker runs it on its own connection and a store with no file (the tests' `:memory:` ones)
// runs the same function inline. A read is bounded: a range of rowids or ids, never a walk of
// a whole table in one go, so no read transaction lasts long enough to pin the WAL; the caller
// pages through with what each call answers. What a job returns is plain data: it crosses
// the thread boundary by structured clone.

import type { Database } from "bun:sqlite";
import type { Logger } from "../log.ts";
import { hostEngine } from "../metrics/engine.ts";
import type { MetricsEngine } from "../metrics/engine.ts";
import { foldForRollup } from "../metrics/owners.ts";
import type { WorkerSample } from "../metrics/worker-engine.ts";
import { spendBackfillJob } from "../usage/backfill-worker.ts";

export interface JobContext {
  /** Sends a part of the answer ahead of the end (a long read's batches). */
  part(p: unknown): void;
  /** The daemon's log, from wherever the job runs. */
  log: Logger;
}

export type Job = (db: Database, args: never, ctx: JobContext) => unknown;

/** `wal_checkpoint(PASSIVE)`: copies what it can of the WAL into the store, never waiting on a writer. */
function checkpoint(db: Database): { busy: number; log: number; checkpointed: number } {
  return db.query("PRAGMA wal_checkpoint(PASSIVE)").get() as { busy: number; log: number; checkpointed: number };
}

/** The highest rowid of a table: one step down its b-tree. */
function maxRowid(db: Database, args: { table: string }): number {
  if (!/^[a-z_]+$/.test(args.table)) throw new Error(`no table ${args.table}`);
  return ((db.query(`SELECT max(rowid) AS m FROM ${args.table}`).get() as { m: number | null }).m ?? 0);
}

export interface ClearRow {
  native: string;
  session: string;
  at: number;
}

/**
 * The clears recorded in one rowid range of session_events: each `context_cleared`
 * notification's conversation left, to its session. What `session_clears` is filled from once.
 */
function clearsScan(db: Database, args: { after: number; to: number }): ClearRow[] {
  const rows = db
    .query("SELECT session, at, payload FROM session_events WHERE rowid > $after AND rowid <= $to AND kind = 'notification' ORDER BY rowid")
    .all({ after: args.after, to: args.to }) as { session: string; at: number; payload: string }[];
  const out: ClearRow[] = [];
  for (const r of rows) {
    if (!r.payload.includes("context_cleared")) continue;
    try {
      const p = JSON.parse(r.payload) as { type?: string; from?: unknown };
      if (p.type === "context_cleared" && typeof p.from === "string") out.push({ native: p.from, session: r.session, at: r.at });
    } catch {
      // a payload that is not JSON names nothing
    }
  }
  return out;
}

/** The prose chunks in an id range with no vector for `model`: what the embed queue is filled from once. */
function embedMissing(db: Database, args: { model: string; after: number; to: number }): number[] {
  const rows = db
    .query("SELECT c.id AS id FROM chunks c WHERE c.id > $after AND c.id <= $to AND c.prose = 1 AND NOT EXISTS (SELECT 1 FROM chunk_vectors v WHERE v.chunk = c.id AND v.model = $model) ORDER BY c.id")
    .all({ model: args.model, after: args.after, to: args.to }) as { id: number }[];
  return rows.map((r) => r.id);
}

export interface CompactedMinute {
  minute: number;
  /** The rollup with its processes folded as a stored minute keeps them; absent when it was already. */
  sample?: string;
  /** The minute's per-profile spend, for `metrics_spend`. */
  profiles?: string;
}

/**
 * One node's stored minutes before `before`, newest first, `limit` of them: each folded as a
 * stored minute keeps its processes now (owners.ts) and its spend read out. What the one-time
 * compaction of the minutes stored before the fold, and the fill of `metrics_spend`, write.
 */
function metricsCompact(db: Database, args: { node: string; before: number; limit: number }): CompactedMinute[] {
  const rows = db
    .query("SELECT minute, sample FROM metrics WHERE node = $node AND minute < $before ORDER BY minute DESC LIMIT $limit")
    .all({ node: args.node, before: args.before, limit: args.limit }) as { minute: number; sample: string }[];
  return rows.map((r) => {
    const out: CompactedMinute = { minute: r.minute };
    try {
      const s = JSON.parse(r.sample) as { processes?: Parameters<typeof foldForRollup>[0]; profiles?: unknown };
      if (s.profiles && typeof s.profiles === "object" && Object.keys(s.profiles).length > 0) out.profiles = JSON.stringify(s.profiles);
      if (Array.isArray(s.processes)) {
        const folded = foldForRollup(s.processes);
        if (folded.length < s.processes.length) out.sample = JSON.stringify({ ...s, processes: folded });
      }
    } catch {
      // a row that is not JSON is left as it is
    }
    return out;
  });
}

/** The OS engines this thread made, one with the GPU readers and one without, kept for every sample. */
const engines = new Map<boolean, MetricsEngine>();

/** One raw sample of the machine (metrics/worker-engine.ts): the engine made at the first. */
function metricsSample(_db: Database, args: { gpu: boolean }, ctx: JobContext): Promise<WorkerSample> | WorkerSample {
  let engine = engines.get(args.gpu);
  if (!engine) engines.set(args.gpu, (engine = hostEngine({ gpu: args.gpu, log: ctx.log.child(args.gpu ? "metrics" : "processes") })));
  const raw = engine.sample();
  const name = engine.name;
  return raw instanceof Promise ? raw.then((sample) => ({ engine: name, sample })) : { engine: name, sample: raw };
}

function metricsDispose(_db: Database, args: { gpu: boolean }): null {
  engines.get(args.gpu)?.dispose?.();
  engines.delete(args.gpu);
  return null;
}

export const JOBS: Record<string, Job> = {
  "metrics.compact": metricsCompact as Job,
  "metrics.sample": metricsSample as Job,
  "metrics.dispose": metricsDispose as Job,
  checkpoint: checkpoint as Job,
  "rowid.max": maxRowid as Job,
  "clears.scan": clearsScan as Job,
  "embed.missing": embedMissing as Job,
  "spend.backfill": spendBackfillJob as Job,
};
