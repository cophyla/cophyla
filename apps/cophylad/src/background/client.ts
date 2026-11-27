// The daemon's side of the background worker (worker.ts): calls a job and resolves with its
// answer, hearing its parts on the way. The worker is made once and kept: Bun on Windows never
// frees a worker that was terminated (its thread waits for ever, holding its heap and a
// committed stack), so it is ended only when the daemon stops, or when it broke, and then a
// fresh one is made for the next call, a few times an hour at most. A store with no file (the
// tests' `:memory:`) has no worker: `InlineBackground` runs the same jobs on the store's own
// connection, so every caller is written once against `Background`.

import type { Database } from "bun:sqlite";
import { silentLogger } from "../log.ts";
import type { Logger } from "../log.ts";
import { JOBS } from "./jobs.ts";
import type { CallMessage, FromWorker, JobClass, ToWorker } from "./protocol.ts";

export interface CallOptions {
  class?: JobClass;
  onPart?: (part: unknown) => void;
}

export interface Background {
  /** Runs a job off the daemon's thread when there is a worker; its answer. */
  call<T>(job: string, args?: unknown, opts?: CallOptions): Promise<T>;
  /** Whether the jobs run on a thread of their own (a passive checkpoint is then this one's to run). */
  readonly threaded: boolean;
  stop(): Promise<void>;
}

/** Breaks a few times an hour, and the worker is given up on: the jobs fail until the daemon restarts. */
const RESTARTS_PER_HOUR = 5;

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  onPart?: (part: unknown) => void;
  job: string;
}

export class WorkerBackground implements Background {
  readonly threaded = true;
  private worker?: Worker;
  private ready?: Promise<void>;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private restarts: number[] = [];
  private stopped = false;
  private opts: { path: string; cacheKib: number; log: Logger; makeWorker?: () => Worker };

  constructor(opts: { path: string; cacheKib: number; log: Logger; makeWorker?: () => Worker }) {
    this.opts = opts;
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const worker = this.opts.makeWorker?.() ?? new Worker(new URL("./worker.ts", import.meta.url).href, { smol: true } as WorkerOptions);
    (worker as { unref?: () => void }).unref?.();
    this.worker = worker;
    this.ready = new Promise<void>((resolve) => {
      worker.onmessage = (ev: MessageEvent<FromWorker>) => {
        const m = ev.data;
        if (m.kind === "ready") resolve();
        else this.heard(m);
      };
    });
    worker.onerror = (ev) => this.broke(worker, ev.message || "the background worker failed");
    worker.postMessage({ kind: "init", path: this.opts.path, cacheKib: this.opts.cacheKib } satisfies ToWorker);
    return this.ready;
  }

  private heard(m: FromWorker): void {
    switch (m.kind) {
      case "part":
        this.pending.get(m.id)?.onPart?.(m.part);
        break;
      case "done": {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        p?.resolve(m.result);
        break;
      }
      case "failed": {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        p?.reject(new Error(m.error));
        break;
      }
      case "log":
        (m.scope ? this.opts.log.child(m.scope) : this.opts.log)[m.level](m.msg, m.fields);
        break;
      case "stopped":
      case "ready":
        break;
    }
  }

  private broke(worker: Worker, why: string): void {
    if (this.worker !== worker) return;
    this.opts.log.warn("background worker broke", { error: why, inFlight: [...this.pending.values()].map((p) => p.job) });
    worker.terminate();
    this.worker = undefined;
    this.ready = undefined;
    const failed = [...this.pending.values()];
    this.pending.clear();
    for (const p of failed) p.reject(new Error(why));
    const now = Date.now();
    this.restarts = [...this.restarts.filter((t) => now - t < 3_600_000), now];
  }

  async call<T>(job: string, args?: unknown, opts: CallOptions = {}): Promise<T> {
    if (this.stopped) throw new Error("the background worker stopped");
    if (!this.worker && this.restarts.length >= RESTARTS_PER_HOUR) throw new Error("the background worker keeps breaking; given up until the daemon restarts");
    await this.start();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, job, ...(opts.onPart ? { onPart: opts.onPart } : {}) });
      this.worker!.postMessage({ kind: "call", id, job, args: args ?? null, class: opts.class ?? "bulk" } satisfies CallMessage);
    });
  }

  /** Closes the worker's connection, then ends it; a worker that does not answer within a second is ended anyway. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const worker = this.worker;
    if (!worker) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1000);
      const prev = worker.onmessage;
      worker.onmessage = (ev: MessageEvent<FromWorker>) => {
        if (ev.data.kind === "stopped") {
          clearTimeout(t);
          resolve();
        } else prev?.call(worker, ev);
      };
      worker.postMessage({ kind: "stop" } satisfies ToWorker);
    });
    worker.terminate();
    this.worker = undefined;
    for (const p of this.pending.values()) p.reject(new Error("the background worker stopped"));
    this.pending.clear();
  }
}

/** The jobs on the store's own connection, a turn of the loop later: for a store with no file. */
export class InlineBackground implements Background {
  readonly threaded = false;
  private db: Database;
  private log: Logger;

  constructor(db: Database, log: Logger = silentLogger) {
    this.db = db;
    this.log = log;
  }

  async call<T>(job: string, args?: unknown, opts: CallOptions = {}): Promise<T> {
    await Promise.resolve();
    const fn = JOBS[job];
    if (!fn) throw new Error(`no job ${job}`);
    return (await fn(this.db, (args ?? null) as never, { part: (p) => opts.onPart?.(p), log: this.log })) as T;
  }

  async stop(): Promise<void> {}
}
