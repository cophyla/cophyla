// The daemon's side of the index worker (worker.ts): the embedder, the vector index and recall
// as the rest of the index sees them, each a message to the worker. `WorkerEmbedder` is an
// `Embedder` whose model runs there; `RemoteVectors` is the `VectorIndex` the embed queue puts
// into and stale chunks are removed from, its changes posted in the order they happen, which is
// the order the worker applies them; recall is asked of the worker whole. The worker is made
// once and ended only when the index stops (Bun on Windows never frees a terminated worker).

import type { CapabilityParams, Hit } from "@cophyla/protocol";
import type { Logger } from "../../log.ts";
import type { Embedder } from "./embed.ts";
import type { RecallScope } from "./filters.ts";
import type { VectorHit, VectorIndex } from "./vectors.ts";
import type { FromIndexWorker, ToIndexWorker } from "./worker.ts";

export interface IndexWorkerOptions {
  path: string;
  /** The embedding model's directory; none for an index that is full text only. */
  modelDir?: string;
  maxRows: number;
  cacheKib: number;
  log: Logger;
  makeWorker?: () => Worker;
}

export interface IndexWorkerReady {
  model?: string;
  dim?: number;
  loaded: number;
}

export class IndexWorker {
  private opts: IndexWorkerOptions;
  private worker?: Worker;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private nextId = 1;
  private openedAt?: Promise<void>;
  private readyAt?: Promise<IndexWorkerReady>;
  private broken?: string;
  /** Rows the worker's vector index holds, as its loads and these changes tell. */
  size = 0;

  constructor(opts: IndexWorkerOptions) {
    this.opts = opts;
  }

  /** Starts the worker; resolves once it has loaded its model and vectors (or found none). */
  start(): Promise<IndexWorkerReady> {
    if (this.readyAt) return this.readyAt;
    const worker = this.opts.makeWorker?.() ?? new Worker(new URL("./worker.ts", import.meta.url).href, { smol: true } as WorkerOptions);
    (worker as { unref?: () => void }).unref?.();
    this.worker = worker;
    let opened!: () => void;
    let ready!: (r: IndexWorkerReady) => void;
    let failed!: (e: Error) => void;
    this.openedAt = new Promise<void>((resolve) => (opened = resolve));
    this.readyAt = new Promise<IndexWorkerReady>((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    worker.onmessage = (ev: MessageEvent<FromIndexWorker>) => {
      const m = ev.data;
      switch (m.kind) {
        case "opened":
          opened();
          break;
        case "ready":
          this.size = m.loaded;
          ready({ ...(m.model ? { model: m.model } : {}), ...(m.dim ? { dim: m.dim } : {}), loaded: m.loaded });
          break;
        case "embedded":
          this.settle(m.id, m.vectors);
          break;
        case "recalled":
          this.settle(m.id, m.hits);
          break;
        case "failed": {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          p?.reject(new Error(m.error));
          break;
        }
        case "log":
          this.opts.log[m.level](m.msg, m.fields);
          break;
        case "stopped":
          break;
      }
    };
    worker.onerror = (ev) => {
      const why = ev.message || "the index worker failed";
      this.broken = why;
      this.opts.log.warn("the index worker broke; recall is full text on the daemon's thread until it restarts", { error: why });
      opened();
      failed(new Error(why));
      for (const p of this.pending.values()) p.reject(new Error(why));
      this.pending.clear();
    };
    this.post({ kind: "init", path: this.opts.path, ...(this.opts.modelDir ? { modelDir: this.opts.modelDir } : {}), maxRows: this.opts.maxRows, cacheKib: this.opts.cacheKib });
    return this.readyAt;
  }

  /** Whether the worker answers: it opened its connection and has not broken. */
  get usable(): boolean {
    return this.worker !== undefined && this.broken === undefined;
  }

  /** Resolves once the worker's connection is open: recall may go to it from then on. */
  opened(): Promise<void> {
    return this.openedAt ?? Promise.resolve();
  }

  private settle(id: number, v: unknown): void {
    const p = this.pending.get(id);
    this.pending.delete(id);
    p?.resolve(v);
  }

  private post(m: ToIndexWorker, transfer: ArrayBuffer[] = []): void {
    this.worker?.postMessage(m, transfer);
  }

  private ask<T>(m: (id: number) => ToIndexWorker): Promise<T> {
    if (!this.worker || this.broken) return Promise.reject(new Error(this.broken ?? "the index worker is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.post(m(id));
    });
  }

  embed(texts: string[]): Promise<Float32Array[]> {
    return this.ask<Float32Array[]>((id) => ({ kind: "embed", id, texts }));
  }

  recall(params: CapabilityParams<"recall">, scope: RecallScope): Promise<Hit[]> {
    return this.ask<Hit[]>((id) => ({ kind: "recall", id, params, scope }));
  }

  put(chunk: number, vector: Float32Array): void {
    this.post({ kind: "put", chunk, vector });
  }

  remove(chunk: number): void {
    this.post({ kind: "remove", chunk });
  }

  /**
   * Has the worker release its model and close its connection, and leaves the thread to end
   * with the process. It is never terminated: Bun panics (NAPI FATAL ERROR) tearing down a
   * worker that loaded onnxruntime-node, released or not, and an unref'd one holds no exit up.
   */
  async stop(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.opts.log.warn("the index worker did not say it stopped");
        resolve();
      }, 2000);
      const prev = worker.onmessage;
      worker.onmessage = (ev: MessageEvent<FromIndexWorker>) => {
        if (ev.data.kind === "stopped") {
          clearTimeout(t);
          resolve();
        } else prev?.call(worker, ev);
      };
      worker.postMessage({ kind: "stop" } satisfies ToIndexWorker);
    });
    worker.onmessage = null;
    for (const p of this.pending.values()) p.reject(new Error("the index worker stopped"));
    this.pending.clear();
  }
}

/** The embedder on the index worker. */
export class WorkerEmbedder implements Embedder {
  readonly model: string;
  readonly dim: number;
  private worker: IndexWorker;

  constructor(worker: IndexWorker, model: string, dim: number) {
    this.worker = worker;
    this.model = model;
    this.dim = dim;
  }

  embed(texts: string[]): Promise<Float32Array[]> {
    return this.worker.embed(texts);
  }

  /** The model goes with the worker. */
  async close(): Promise<void> {}
}

/** The index worker's vector index, as the embed queue and the chunks see it: changes go there, searches are the worker's. Its size is the worker's load and the changes since, near enough. */
export class RemoteVectors implements VectorIndex {
  readonly dim: number;
  private worker: IndexWorker;

  constructor(worker: IndexWorker, dim: number) {
    this.worker = worker;
    this.dim = dim;
  }

  get size(): number {
    return this.worker.size;
  }

  /** The worker loads its own. */
  load(): number {
    return this.worker.size;
  }

  put(chunk: number, vector: Float32Array): void {
    this.worker.size++;
    this.worker.put(chunk, vector);
  }

  remove(chunk: number): void {
    this.worker.remove(chunk);
  }

  /** Not known here: the worker holds the rows. */
  has(): boolean {
    return false;
  }

  search(): VectorHit[] {
    throw new Error("the vector leg runs on the index worker");
  }
}
