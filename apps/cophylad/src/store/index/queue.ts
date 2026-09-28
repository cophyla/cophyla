// The embed queue: prose chunks with no vector for the current model, newest first, in
// small batches, each written to `chunk_vectors` and put in the in-memory index. The loop
// yields between batches; during a backfill (over a hundred pending) it also sleeps, so a
// daemon indexing a year of sessions stays responsive. `stop` cuts the sleep short and ends
// the loop after the batch in flight, so a stopping daemon never waits on the queue. (The
// timers are not unref'd: under `bun test` an unref'd timer that is the only pending work
// never fires, and a test awaiting the queue would hang.)

import type { Database } from "bun:sqlite";
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

  /** The chunks left out, as SQL over `c` and its session `s`, and its params. */
  private skipped(): { join: string; where: string; params: Record<string, string> } {
    const nodes = this.deps.skipNodes?.() ?? [];
    if (nodes.length === 0) return { join: "", where: "", params: {} };
    return {
      join: " LEFT JOIN harness_sessions s ON c.session = s.id",
      where: ` AND (c.corpus != 'session' OR s.node NOT IN (${nodes.map((_, i) => `$skip${i}`).join(", ")}))`,
      params: Object.fromEntries(nodes.map((n, i) => [`skip${i}`, n])),
    };
  }

  /** Chunks still waiting for a vector. */
  pending(): number {
    const skip = this.skipped();
    const row = this.deps.db
      .query(`SELECT COUNT(*) AS n FROM chunks c LEFT JOIN chunk_vectors v ON v.chunk = c.id AND v.model = $model${skip.join} WHERE c.prose = 1 AND v.chunk IS NULL${skip.where}`)
      .get({ model: this.deps.embedder.model, ...skip.params }) as { n: number };
    return row.n;
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
    while (!this.stopped) {
      this.kicked = false;
      const skip = this.skipped();
      const rows = db
        .query(
          `SELECT c.id AS id, c.text AS text FROM chunks c LEFT JOIN chunk_vectors v ON v.chunk = c.id AND v.model = $model${skip.join}
           WHERE c.prose = 1 AND v.chunk IS NULL${skip.where} ORDER BY c.id DESC LIMIT $limit`,
        )
        .all({ model: embedder.model, limit: batch, ...skip.params }) as { id: number; text: string }[];
      if (rows.length === 0) return;
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
          // The chunk may have gone or changed while the model ran; a changed one gets the next pass.
          const now = db.query("SELECT text FROM chunks WHERE id = $id").get({ id: rows[i]!.id }) as { text: string } | null;
          if (!now || now.text !== rows[i]!.text) continue;
          insert.run({ chunk: rows[i]!.id, model: embedder.model, dim: embedder.dim, scale, q: new Uint8Array(q.buffer, q.byteOffset, q.byteLength) });
          vectors.put(rows[i]!.id, vecs[i]!);
        }
      });
      write();
      const left = this.pending();
      if (left === 0) return;
      await this.sleep(left > BACKFILL_PENDING ? BACKFILL_SLEEP_MS : 0);
    }
  }
}
