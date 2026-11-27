// The messages between the daemon and its background worker. A call names a job and a class:
// `read` for what something waits on (a sample, a command line, a snapshot, a checkpoint), on a
// worker of its own; `bulk` for work nobody waits on (fills, backfills, compaction), on another.
// Both run at their thread's own priority. The worker answers each call once,
// after any parts, and says so when its own code logs.

export type JobClass = "read" | "bulk";

export interface InitMessage {
  kind: "init";
  /** The store's file; the worker opens its own connection to it, read-only by `query_only`. */
  path: string;
  cacheKib: number;
}

export interface CallMessage {
  kind: "call";
  id: number;
  job: string;
  args: unknown;
  class: JobClass;
}

export interface StopMessage {
  kind: "stop";
}

export type ToWorker = InitMessage | CallMessage | StopMessage;

export type FromWorker =
  | { kind: "ready" }
  | { kind: "part"; id: number; part: unknown }
  | { kind: "done"; id: number; result: unknown; ms: number }
  | { kind: "failed"; id: number; error: string }
  | { kind: "log"; level: "debug" | "info" | "warn" | "error"; msg: string; scope?: string; fields?: Record<string, unknown> }
  | { kind: "stopped" };
