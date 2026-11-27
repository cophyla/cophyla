// The index worker's thread: the recall index's heavy half, off the daemon's thread. ONNX
// Runtime runs a model synchronously on the thread that calls it (a chunk is 130 to 180 ms of
// CPU), the vector index is tens of megabytes loaded by walking `chunk_vectors`, and a recall
// that narrows the vector leg reads every prose chunk the filter admits: all of it here, on a
// connection of the worker's own (read-only by `query_only`; the daemon's connection writes).
//
// It answers three things, at the thread's own priority. `embed`: vectors for texts, one text at a time,
// a recall waiting being answered between two texts. `put` and `remove`: the vector index kept
// in step with what the daemon wrote, in the order it wrote it. `recall`: both legs and the
// hydration, on full text alone until the vectors are loaded. Messages
// that arrive while the connection opens wait for it.

import { Database } from "bun:sqlite";
import { isMainThread } from "node:worker_threads";
import type { CapabilityParams, Hit } from "@cophyla/protocol";
import type { Logger } from "../../log.ts";
import { loadEmbedder } from "./embed.ts";
import type { Embedder } from "./embed.ts";
import type { RecallScope } from "./filters.ts";
import { recall } from "./recall.ts";
import { JsVectorIndex } from "./vectors.ts";

declare const self: Worker;

export type ToIndexWorker =
  | { kind: "init"; path: string; modelDir?: string; maxRows: number; cacheKib: number }
  | { kind: "embed"; id: number; texts: string[] }
  | { kind: "put"; chunk: number; vector: Float32Array }
  | { kind: "remove"; chunk: number }
  | { kind: "recall"; id: number; params: CapabilityParams<"recall">; scope: RecallScope }
  | { kind: "stop" };

export type FromIndexWorker =
  | { kind: "opened" }
  | { kind: "ready"; model?: string; dim?: number; loaded: number }
  | { kind: "embedded"; id: number; vectors: Float32Array[] }
  | { kind: "recalled"; id: number; hits: Hit[] }
  | { kind: "failed"; id: number; error: string }
  | { kind: "log"; level: "debug" | "info" | "warn" | "error"; msg: string; fields?: Record<string, unknown> }
  | { kind: "stopped" };

const post = (m: FromIndexWorker, transfer: ArrayBuffer[] = []): void => self.postMessage(m, transfer);

const log: Logger = {
  debug: (msg, fields) => post({ kind: "log", level: "debug", msg, ...(fields ? { fields } : {}) }),
  info: (msg, fields) => post({ kind: "log", level: "info", msg, ...(fields ? { fields } : {}) }),
  warn: (msg, fields) => post({ kind: "log", level: "warn", msg, ...(fields ? { fields } : {}) }),
  error: (msg, fields) => post({ kind: "log", level: "error", msg, ...(fields ? { fields } : {}) }),
  child: () => log,
};

let db: Database | undefined;
let embedder: Embedder | undefined;
let vectors: JsVectorIndex | undefined;
/** Messages that came before the connection was open, and the work queued after. */
let early: ToIndexWorker[] | undefined = [];
const recalls: Extract<ToIndexWorker, { kind: "recall" }>[] = [];
const embeds: { id: number; texts: string[]; done: Float32Array[] }[] = [];
let draining = false;
let stopping = false;
/** The index's changes while it loads, applied in order once it has: a removal is never lost to the load. */
let held: Extract<ToIndexWorker, { kind: "put" | "remove" }>[] | undefined = [];

async function init(m: Extract<ToIndexWorker, { kind: "init" }>): Promise<void> {
  try {
    db = new Database(m.path, { readwrite: true, create: false, strict: true });
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`PRAGMA cache_size = -${m.cacheKib}`);
    db.exec("PRAGMA query_only = 1");
  } catch (e) {
    log.warn("the index worker could not open the store; recall is the daemon's", { error: e instanceof Error ? e.message : String(e) });
  }
  post({ kind: "opened" });
  const waiting = early ?? [];
  early = undefined;
  for (const w of waiting) heard(w);
  let loaded = 0;
  // At the thread's own priority, as the background worker's: a lowered one was starved on a
  // loaded machine while the daemon's thread waited on something it held.
  if (m.modelDir && db) {
    embedder = await loadEmbedder(m.modelDir, log);
    if (embedder) {
      const index = new JsVectorIndex(embedder.dim, m.maxRows);
      loaded = index.load(db, embedder.model);
      vectors = index;
    }
  }
  for (const op of held ?? []) apply(op);
  held = undefined;
  post({ kind: "ready", ...(embedder ? { model: embedder.model, dim: embedder.dim } : {}), loaded });
}

function heard(m: ToIndexWorker): void {
  if (early && m.kind !== "init" && m.kind !== "stop") {
    early.push(m);
    return;
  }
  switch (m.kind) {
    case "init":
      void init(m);
      return;
    case "put":
    case "remove":
      if (held) held.push(m);
      else apply(m);
      return;
    case "recall":
      recalls.push(m);
      break;
    case "embed":
      embeds.push({ id: m.id, texts: m.texts, done: [] });
      break;
    case "stop":
      stopping = true;
      if (!draining) finish();
      return;
  }
  void drain();
}

function apply(op: Extract<ToIndexWorker, { kind: "put" | "remove" }>): void {
  if (op.kind === "put") vectors?.put(op.chunk, op.vector);
  else vectors?.remove(op.chunk);
}

/** Recalls first; an embed request a text at a time, so a recall waits for one text at most. */
async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      if (stopping) break;
      const r = recalls.shift();
      if (r) {
        try {
          const hits = db ? await recall({ db, scope: r.scope, ...(embedder && vectors ? { embedder, vectors } : {}) }, r.params) : [];
          post({ kind: "recalled", id: r.id, hits });
        } catch (e) {
          post({ kind: "failed", id: r.id, error: e instanceof Error ? e.message : String(e) });
        }
        continue;
      }
      const e = embeds[0];
      if (!e) break;
      if (!embedder) {
        embeds.shift();
        post({ kind: "failed", id: e.id, error: "no embedding model on the index worker" });
        continue;
      }
      try {
        const [v] = await embedder.embed([e.texts[e.done.length]!]);
        e.done.push(v!);
      } catch (err) {
        embeds.shift();
        post({ kind: "failed", id: e.id, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (e.done.length === e.texts.length) {
        embeds.shift();
        post({ kind: "embedded", id: e.id, vectors: e.done }, e.done.map((v) => v.buffer as ArrayBuffer));
      }
      // a turn of the loop: a recall that came meanwhile is heard before the next text
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    draining = false;
    if (stopping) finish();
  }
}

let finished = false;

/** The connection closed first (the daemon's closes after it), then the model released. */
function finish(): void {
  if (finished) return;
  finished = true;
  for (const r of recalls.splice(0)) post({ kind: "failed", id: r.id, error: "the index worker stopped" });
  for (const e of embeds.splice(0)) post({ kind: "failed", id: e.id, error: "the index worker stopped" });
  try {
    db?.close(true);
  } catch (e) {
    log.warn("the index worker's connection did not close", { error: e instanceof Error ? e.message : String(e) });
  }
  db = undefined;
  vectors = undefined;
  void (async () => {
    try {
      await embedder?.close();
    } catch {
      // the session goes with the thread
    }
    embedder = undefined;
    post({ kind: "stopped" });
  })();
}

if (!isMainThread) self.onmessage = (ev: MessageEvent<ToIndexWorker>) => heard(ev.data);
