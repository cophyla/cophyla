// The embed queue: the prose chunks in `embed_queue`, newest first, in small batches, each
// batch's vectors written to `chunk_vectors`, put in the vector index and taken off the queue.
// The table is kept as chunks are written (chunks.ts), so the next batch is a few steps down
// its key and what is left is counted no further than the loop needs to know, never by walking
// every chunk. The loop yields between batches; during a backfill (over a hundred pending) it
// also sleeps, so a daemon indexing a year of sessions stays responsive. `stop` cuts the sleep
// short and ends the loop after the batch in flight, so a stopping daemon never waits on the
// queue. (The timers are not unref'd: under `bun test` an unref'd timer that is the only
// pending work never fires, and a test awaiting the queue would hang.)
//
// A chunk the embedder may not see (a workspace node's, when the embedder is the account's) is
// taken off the queue unembedded; a change of embedder refills the queue (`fillQueue`).

import type { Database } from "bun:sqlite";
import type { Background } from "../../background/client.ts";
import type { Logger } from "../../log.ts";
import type { Embedder } from "./embed.ts";
import { quantise } from "./vectors.ts";
import type { VectorIndex } from "./vectors.ts";

export interface EmbedQueueDeps {
  db: Database;
  embedder: Embedder;
  vectors: VectorIndex;
  log: Logger;
  /** Chunks per model call. */
  batch: number;
  /** Characters of a chunk the model reads. */
  maxChars: number;
  /** The nodes whose sessions' chunks are never embedded: a workspace node's, when the embedder is the account's. */
  skipNodes?: () => readonly string[];
}

export const BACKFILL_PENDING = 100;
export const BACKFILL_SLEEP_MS = 50;

/** What the queue was last filled for: the embedder's model, and whether it was the account's. */
export const QUEUE_FILLED_KEY = "index.embed_queue.v1";
const QUEUE_FILL_AT_KEY = "index.embed_queue.v1.at";
/** Chunk ids a fill call reads in one go. */
const FILL_SPAN = 50_000;

/** The key a queue is filled for. */
export const queueKey = (embedder: Embedder): string => `${embedder.model}${embedder.hosted ? "@hosted" : ""}`;

/**
 * Fills the queue with every prose chunk that has no vector for the embedder's model, once per
 * embedder: the chunks written before the queue existed, or under another model. The reads go to
 * the background worker a range of ids at a time; this thread inserts what each finds. Resumes
 * where a stopped fill left off. Returns how many it queued.
 */
export async function fillQueue(db: Database, background: Background, embedder: Embedder, opts: { stopped: () => boolean; log: Logger; onQueued?: () => void }): Promise<number> {
  const key = queueKey(embedder);
  const meta = (k: string) => (db.query("SELECT value FROM meta WHERE key = $key").get({ key: k }) as { value: string } | null)?.value;
  const setMeta = (k: string, v: string) => db.query("INSERT INTO meta (key, value) VALUES ($key, $value) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run({ key: k, value: v });
  const filled = meta(QUEUE_FILLED_KEY);
  if (filled === key) return 0;
  let after = 0;
  // another embedder's queue (or the half of a fill for one) is dropped: it is this one's now
  if (filled !== `${key}:filling`) {
    db.exec("DELETE FROM embed_queue /* scan-ok: a change of embedder empties the queue whole */");
    setMeta(QUEUE_FILLED_KEY, `${key}:filling`);
    setMeta(QUEUE_FILL_AT_KEY, "0");
  } else after = Number(meta(QUEUE_FILL_AT_KEY) ?? "0") || 0;
  const max = await background.call<number>("rowid.max", { table: "chunks" });
  const insert = db.query("INSERT OR IGNORE INTO embed_queue (chunk) SELECT id FROM chunks WHERE id = $id");
  const started = performance.now();
  let queued = 0;
  while (after < max) {
    if (opts.stopped()) return queued;
    const to = Math.min(max, after + FILL_SPAN);
    const ids = await background.call<number[]>("embed.missing", { model: embedder.model, after, to });
    if (opts.stopped()) return queued;
    db.transaction(() => {
      for (const id of ids) queued += insert.run({ id }).changes;
      setMeta(QUEUE_FILL_AT_KEY, String(to));
    })();
    if (ids.length > 0) opts.onQueued?.();
    after = to;
  }
  setMeta(QUEUE_FILLED_KEY, key);
  if (queued > 0) opts.log.info("embed queue filled", { model: embedder.model, chunks: queued, ms: Math.round(performance.now() - started) });
  return queued;
}

export class EmbedQueue {
  private deps: EmbedQueueDeps;
  private running?: Promise<void>;
  private stopped = false;
  private kicked = false;
  private idleWaiters: (() => void)[] = [];
  private napping?: { timer: ReturnType<typeof setTimeout>; wake: () => void };

  constructor(deps: EmbedQueueDeps) {
    this.deps = deps;
  }

  /** A pause `stop` can cut short. */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = () => {
        this.napping = undefined;
        resolve();
      };
      this.napping = { timer: setTimeout(wake, ms), wake };
    });
  }

  /** Chunks still waiting for a vector, counted up to `cap`. */
  pending(cap = 10_000): number {
    return (this.deps.db.query("SELECT COUNT(*) AS n FROM (SELECT 1 FROM embed_queue LIMIT $cap)").get({ cap }) as { n: number }).n;
  }

  /** Starts a drain if none runs; cheap to call after every write. */
  kick(): void {
    if (this.stopped) return;
    this.kicked = true;
    if (this.running) return;
    this.running = this.drain().finally(() => {
      this.running = undefined;
      if (this.kicked && !this.stopped) this.kick();
      else for (const w of this.idleWaiters.splice(0)) w();
    });
  }

  /** Resolves once nothing is running and nothing is pending. */
  idle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.napping) {
      clearTimeout(this.napping.timer);
      this.napping.wake();
    }
    await this.running;
  }

  private async drain(): Promise<void> {
    await this.sleep(0);
    const { db, embedder, vectors, batch, maxChars, log } = this.deps;
    const insert = db.query("INSERT OR REPLACE INTO chunk_vectors (chunk, model, dim, scale, q) VALUES ($chunk, $model, $dim, $scale, $q)");
    const dequeue = db.query("DELETE FROM embed_queue WHERE chunk = $chunk");
    const next = db.query(
      `SELECT q.chunk AS id, c.text AS text, c.corpus AS corpus, s.node AS node FROM embed_queue q JOIN chunks c ON c.id = q.chunk
       LEFT JOIN harness_sessions s ON c.session = s.id ORDER BY q.chunk DESC LIMIT $limit`,
    );
    while (!this.stopped) {
      this.kicked = false;
      const skip = this.deps.skipNodes?.() ?? [];
      const found = next.all({ limit: batch }) as { id: number; text: string; corpus: string; node: string | null }[];
      if (found.length === 0) return;
      const rows = found.filter((r) => !(r.corpus === "session" && r.node !== null && skip.includes(r.node)));
      if (rows.length < found.length) {
        db.transaction(() => {
          for (const r of found) if (!rows.includes(r)) dequeue.run({ chunk: r.id });
        })();
        if (rows.length === 0) continue;
      }
      let vecs: Float32Array[];
      try {
        vecs = await embedder.embed(rows.map((r) => r.text.slice(0, maxChars)));
      } catch (err) {
        log.warn("embedding failed; the queue stops until the next write", { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (this.stopped) return;
      const write = db.transaction(() => {
        for (let i = 0; i < rows.length; i++) {
          const { scale, q } = quantise(vecs[i]!);
          // The chunk may have gone or changed while the model ran; a changed one stays queued for the next pass.
          const now = db.query("SELECT text FROM chunks WHERE id = $id").get({ id: rows[i]!.id }) as { text: string } | null;
          if (!now || now.text !== rows[i]!.text) continue;
          insert.run({ chunk: rows[i]!.id, model: embedder.model, dim: embedder.dim, scale, q: new Uint8Array(q.buffer, q.byteOffset, q.byteLength) });
          dequeue.run({ chunk: rows[i]!.id });
          vectors.put(rows[i]!.id, vecs[i]!);
        }
      });
      write();
      const left = this.pending(BACKFILL_PENDING + 1);
      if (left === 0) return;
      await this.sleep(left > BACKFILL_PENDING ? BACKFILL_SLEEP_MS : 0);
    }
  }
}
