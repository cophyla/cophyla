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
import { windowsCommandLine } from "../metrics/windows.ts";
import type { WorkerSample } from "../metrics/worker-engine.ts";
import { backupObjects } from "../cloud/reconcile.ts";
import { readSnapshot } from "../store/index.ts";
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
 * How long one call of a fill reads before it answers how far it got: a few hundred
 * milliseconds, read in statements of a few dozen rows, each its own read transaction, so none
 * lasts long enough to hold the WAL back, and the next call goes on from there.
 */
const FILL_CALL_MS = 250;
const FILL_ROWS = 64;

/**
 * The clears recorded in session_events past `after` and up to `to`, as far as one call reads:
 * each `context_cleared` notification's conversation left, to its session, and the rowid
 * reached. What `session_clears` is filled from once.
 */
function clearsScan(db: Database, args: { after: number; to: number }): { clears: ClearRow[]; reached: number } {
  const until = performance.now() + FILL_CALL_MS;
  // the kinds first, a few rows at a time; a notification's payload after
  const kinds = db.query("SELECT rowid AS id, kind FROM session_events WHERE rowid > $after AND rowid <= $to ORDER BY rowid LIMIT $n");
  const payload = db.query("SELECT session, at, payload FROM session_events WHERE rowid = $id");
  const clears: ClearRow[] = [];
  let reached = args.after;
  while (reached < args.to && performance.now() < until) {
    const rows = kinds.all({ after: reached, to: args.to, n: FILL_ROWS }) as { id: number; kind: string }[];
    if (rows.length === 0) {
      reached = args.to;
      break;
    }
    for (const r of rows) {
      if (r.kind !== "notification") continue;
      const row = payload.get({ id: r.id }) as { session: string; at: number; payload: string } | null;
      if (!row || !row.payload.includes("context_cleared")) continue;
      try {
        const p = JSON.parse(row.payload) as { type?: string; from?: unknown };
        if (p.type === "context_cleared" && typeof p.from === "string") clears.push({ native: p.from, session: row.session, at: row.at });
      } catch {
        // a payload that is not JSON names nothing
      }
    }
    reached = rows[rows.length - 1]!.id;
  }
  return { clears, reached };
}

/** The prose chunks past `after` and up to `to` with no vector for `model`, as far as one call reads, and the id reached: what the embed queue is filled from once. */
function embedMissing(db: Database, args: { model: string; after: number; to: number }): { ids: number[]; reached: number } {
  const until = performance.now() + FILL_CALL_MS;
  const batch = db.query(
    "SELECT c.id AS id, c.prose = 1 AND NOT EXISTS (SELECT 1 FROM chunk_vectors v WHERE v.chunk = c.id AND v.model = $model) AS missing FROM chunks c WHERE c.id > $after AND c.id <= $to ORDER BY c.id LIMIT $n",
  );
  const ids: number[] = [];
  let reached = args.after;
  while (reached < args.to && performance.now() < until) {
    const rows = batch.all({ model: args.model, after: reached, to: args.to, n: FILL_ROWS * 4 }) as { id: number; missing: number }[];
    if (rows.length === 0) {
      reached = args.to;
      break;
    }
    for (const r of rows) if (r.missing) ids.push(r.id);
    reached = rows[rows.length - 1]!.id;
  }
  return { ids, reached };
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

/**
 * A replication snapshot's tables, read in one transaction and answered as JSON text: the
 * daemon sends it on as it is, never parsing it into objects or writing it out again.
 */
function replicaSnapshot(db: Database, args: { excludeKvNs: string[]; privateNodes: string[] }): string {
  return db.transaction(() => JSON.stringify(readSnapshot(db, args.excludeKvNs, args.privateNodes)))();
}

export const JOBS: Record<string, Job> = {
  // a process's command line (Windows): the line, nothing when it cannot be read, null where there is no native way
  "proc.commandLine": ((_db: Database, args: { pid: number }) => {
    const line = windowsCommandLine(args.pid);
    return line === undefined ? false : line;
  }) as Job,
  "backup.objects": backupObjects as Job,
  "replica.snapshot": replicaSnapshot as Job,
  "metrics.compact": metricsCompact as Job,
  "metrics.sample": metricsSample as Job,
  "metrics.dispose": metricsDispose as Job,
  checkpoint: checkpoint as Job,
  "rowid.max": maxRowid as Job,
  "clears.scan": clearsScan as Job,
  "embed.missing": embedMissing as Job,
  "spend.backfill": spendBackfillJob as Job,
};
