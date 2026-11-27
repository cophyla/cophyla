// The background worker's thread: its own connection to the store, read-only by `query_only`
// (writes stay on the daemon's connection, the single writer), a modest page cache, and the
// jobs of jobs.ts run one at a time, `read` calls ahead of `bulk` ones. The thread lowers its
// own priority for each job by its class: background mode for bulk work, below normal for a
// read someone waits on. The connection is closed before the thread ends, when the daemon says
// stop, so the daemon's own connection is the last to close.

import { Database } from "bun:sqlite";
import { isMainThread } from "node:worker_threads";
import type { Logger } from "../log.ts";
import { setThreadLevel } from "../os/priority.ts";
import { JOBS } from "./jobs.ts";
import type { CallMessage, FromWorker, ToWorker } from "./protocol.ts";

declare const self: Worker;

let db: Database | undefined;
const queue: CallMessage[] = [];
let running = false;
let stopping = false;

const post = (m: FromWorker): void => self.postMessage(m);

/** The jobs' log: each line goes to the daemon, which writes it as its own, under the job's scope. */
const posting = (scope: string | undefined): Logger => {
  const line = (level: "debug" | "info" | "warn" | "error") => (msg: string, fields?: Record<string, unknown>) =>
    post({ kind: "log", level, msg, ...(scope ? { scope } : {}), ...(fields ? { fields } : {}) });
  return { debug: line("debug"), info: line("info"), warn: line("warn"), error: line("error"), child: (s) => posting(scope ? `${scope}.${s}` : s) };
};
const jobLog = posting(undefined);

function open(path: string, cacheKib: number): Database {
  const d = new Database(path, { readwrite: true, create: false, strict: true });
  d.exec("PRAGMA busy_timeout = 5000");
  d.exec(`PRAGMA cache_size = -${cacheKib}`);
  d.exec("PRAGMA query_only = 1");
  return d;
}

/** The next call: the oldest read, else the oldest bulk. */
function take(): CallMessage | undefined {
  const i = queue.findIndex((c) => c.class === "read");
  return queue.splice(i >= 0 ? i : 0, 1)[0];
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const call = take();
      if (!call) break;
      if (!db) {
        post({ kind: "failed", id: call.id, error: "the background worker has no store" });
        continue;
      }
      const job = JOBS[call.job];
      if (!job) {
        post({ kind: "failed", id: call.id, error: `no job ${call.job}` });
        continue;
      }
      setThreadLevel(call.class === "read" ? "below" : "background");
      const t0 = performance.now();
      try {
        const result = await job(db, call.args as never, { part: (part) => post({ kind: "part", id: call.id, part }), log: jobLog });
        post({ kind: "done", id: call.id, result, ms: performance.now() - t0 });
      } catch (e) {
        post({ kind: "failed", id: call.id, error: e instanceof Error ? e.message : String(e) });
      }
      // A turn of the loop between jobs: the next message (a read jumping the queue) is heard.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    running = false;
    if (stopping) finish();
  }
}

function finish(): void {
  try {
    db?.close();
  } catch {
    // closing is best effort; the thread ends either way
  }
  db = undefined;
  post({ kind: "stopped" });
}

if (!isMainThread) {
  self.onmessage = (ev: MessageEvent<ToWorker>) => {
    const m = ev.data;
    if (m.kind === "init") {
      try {
        db = open(m.path, m.cacheKib);
        post({ kind: "ready" });
      } catch (e) {
        post({ kind: "log", level: "warn", msg: "the background worker could not open the store", fields: { error: e instanceof Error ? e.message : String(e) } });
        post({ kind: "ready" });
      }
    } else if (m.kind === "call") {
      queue.push(m);
      void drain();
    } else if (m.kind === "stop") {
      stopping = true;
      for (const c of queue.splice(0)) post({ kind: "failed", id: c.id, error: "the background worker stopped" });
      if (!running) finish();
    }
  };
}
