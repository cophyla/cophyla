// The store's search index, owned by `Store`: chunks kept in step with every write, a
// full-text table, and, once `start` has loaded the model, int8 vectors for prose. Startup
// never waits on the model: `recall` answers from full text until the embedder is up, and
// the backfill and the embed queue run in the background. `reindexMemory` is the one entry
// point for memory changes: the daemon calls it on every `memory.write` and `memory.delete`
// today; the milestone-7 watcher will call the same.

import type { Database } from "bun:sqlite";
import type { CapabilityParams, Hit, Memory } from "@cophyla/protocol";
import type { Logger } from "../../log.ts";
import { backfill, reconcileMemory } from "./backfill.ts";
import { Chunks } from "./chunks.ts";
import type { Embedder } from "./embed.ts";
import { EmbedQueue } from "./queue.ts";
import { recall } from "./recall.ts";
import { JsVectorIndex } from "./vectors.ts";
import type { VectorIndex } from "./vectors.ts";

export interface IndexConfig {
  embed_batch: number;
  embed_max_chars: number;
  vector_max_rows: number;
  backfill_batch: number;
}

export const DEFAULT_INDEX_CONFIG: IndexConfig = { embed_batch: 8, embed_max_chars: 1536, vector_max_rows: 150000, backfill_batch: 200 };

export interface IndexStart {
  /** Resolves to the embedder, or to nothing for full-text-only recall. Awaited in the background. */
  embedder?: Promise<Embedder | undefined> | Embedder;
  config?: Partial<IndexConfig>;
  log: Logger;
  /** Every memory file, for the reconcile by mtime. */
  memories?: () => Memory[];
}

export class SearchIndex {
  readonly chunks: Chunks;
  private db: Database;
  private config: IndexConfig = DEFAULT_INDEX_CONFIG;
  private embedder?: Embedder;
  private vectors?: VectorIndex;
  private queue?: EmbedQueue;
  private stopped = false;
  private starting?: Promise<void>;

  constructor(db: Database) {
    this.db = db;
    this.chunks = new Chunks(db, (id) => this.vectors?.remove(id));
  }

  /** The embedder in use, once loaded. */
  get model(): string | undefined {
    return this.embedder?.model;
  }

  /**
   * Reconciles memory files now, then in the background sweeps the store and loads the
   * model. The returned promise settles when the background work has settled; the daemon
   * does not wait for it.
   */
  start(opts: IndexStart): Promise<void> {
    this.config = { ...DEFAULT_INDEX_CONFIG, ...opts.config };
    this.stopped = false;
    if (opts.memories) {
      const r = reconcileMemory(this.chunks, opts.memories());
      if (r.updated + r.removed > 0) opts.log.info("memory reindexed", r);
    }
    this.starting = (async () => {
      const swept = await backfill({ db: this.db, chunks: this.chunks, log: opts.log, batch: this.config.backfill_batch, stopped: () => this.stopped });
      if (!swept) return;
      let embedder: Embedder | undefined;
      try {
        embedder = await opts.embedder;
      } catch (err) {
        opts.log.warn("embedder failed; recall is full-text only", { error: err instanceof Error ? err.message : String(err) });
      }
      if (!embedder || this.stopped) {
        if (embedder && this.stopped) await embedder.close();
        return;
      }
      this.embedder = embedder;
      const vectors = new JsVectorIndex(embedder.dim, this.config.vector_max_rows);
      const loaded = vectors.load(this.db, embedder.model);
      this.vectors = vectors;
      this.queue = new EmbedQueue({ db: this.db, embedder, vectors, log: opts.log, batch: this.config.embed_batch, maxChars: this.config.embed_max_chars });
      const pending = this.queue.pending();
      opts.log.info("vector index ready", { model: embedder.model, loaded, pending });
      if (pending > 0) this.queue.kick();
    })();
    return this.starting;
  }

  /** Resolves when the backfill is done and the embed queue is idle: for tests and the acceptance run. */
  async settled(): Promise<void> {
    await this.starting;
    await this.queue?.idle();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.starting;
    await this.queue?.stop();
    await this.embedder?.close();
    this.embedder = undefined;
    this.vectors = undefined;
    this.queue = undefined;
  }

  /** Nudges the embed queue after a write; a no-op until the embedder is up. */
  kick(): void {
    this.queue?.kick();
  }

  recall(params: CapabilityParams<"recall">): Promise<Hit[]> {
    return recall({ db: this.db, ...(this.embedder ? { embedder: this.embedder } : {}), ...(this.vectors ? { vectors: this.vectors } : {}) }, params);
  }

  /** A memory file changed (`memory` given) or went (absent). */
  reindexMemory(name: string, memory?: Memory): void {
    if (memory) this.chunks.putMemory(memory);
    else this.chunks.deleteMemory(name);
    this.kick();
  }

  reconcileMemory(all: Memory[]): { updated: number; removed: number } {
    const r = reconcileMemory(this.chunks, all);
    if (r.updated > 0) this.kick();
    return r;
  }

  get vectorCount(): number {
    return this.vectors?.size ?? 0;
  }
}
