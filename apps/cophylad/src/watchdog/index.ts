// The event-loop watchdog: how the daemon finds out its own thread stopped answering. The main
// thread moves a beat in shared memory every tenth of a second and labels what it is doing
// (task.ts); a worker of its own (worker.ts) watches the beat and writes "event loop stalled"
// to the log while a stall lasts and when it ends, naming the task, which the main thread
// could not do itself. Beside it, `monitorEventLoopDelay` measures how late the loop ran what
// it was due to: the median, the 99th percentile and the worst since the previous reading go
// into each metrics sample, so a node's history shows how responsive its daemon was.

import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Logger } from "../log.ts";
import { SHARED_BYTES, SLOT_BEAT, shareTasks, unshareTasks } from "./task.ts";
import type { ToWatchdog } from "./worker.ts";

type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;

export interface WatchdogOptions {
  log: Logger;
  /** The daemon's own log file, when it writes one; the worker appends to it. Its stderr otherwise. */
  logFile?: string;
  /** A loop this late is stalled. */
  stallMs?: number;
  beatMs?: number;
  /** Makes the worker (the tests use their own). */
  makeWorker?: () => Worker;
}

export interface LoopLag {
  p50: number;
  p99: number;
  max: number;
}

export class Watchdog {
  private opts: WatchdogOptions;
  private worker?: Worker;
  private timer?: ReturnType<typeof setInterval>;
  private slots?: Int32Array;
  private delay?: IntervalHistogram;

  constructor(opts: WatchdogOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.worker) return;
    const block = new SharedArrayBuffer(SHARED_BYTES);
    this.slots = new Int32Array(block);
    const worker = this.opts.makeWorker?.() ?? new Worker(new URL("./worker.ts", import.meta.url).href, { smol: true } as WorkerOptions);
    (worker as { unref?: () => void }).unref?.();
    worker.onerror = (ev) => this.opts.log.warn("the watchdog's worker failed", { error: ev.message });
    this.worker = worker;
    const beatMs = this.opts.beatMs ?? 100;
    worker.postMessage({
      kind: "init",
      block,
      ...(this.opts.logFile ? { logFile: this.opts.logFile } : {}),
      stallMs: this.opts.stallMs ?? 1000,
      checkMs: beatMs,
      repeatMs: 5000,
      level: "warn",
    } satisfies ToWatchdog);
    shareTasks(block, (id, label) => worker.postMessage({ kind: "label", id, label } satisfies ToWatchdog));
    const slots = this.slots;
    this.timer = setInterval(() => Atomics.add(slots, SLOT_BEAT, 1), beatMs);
    (this.timer as { unref?: () => void }).unref?.();
    Atomics.store(slots, SLOT_BEAT, 1);
    try {
      this.delay = monitorEventLoopDelay({ resolution: 10 });
      this.delay.enable();
    } catch {
      // a runtime without the histogram reports no lag
    }
  }

  /** How late the loop ran since the previous reading, in milliseconds; the histogram starts over. */
  lag(): LoopLag | undefined {
    const h = this.delay;
    if (!h || h.count === 0) return undefined;
    const ms = (ns: number) => Math.round((ns / 1e6) * 10) / 10;
    const out = { p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max) };
    h.reset();
    return out;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.delay?.disable();
    unshareTasks();
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 500);
      worker.onmessage = () => {
        clearTimeout(t);
        resolve();
      };
      worker.postMessage({ kind: "stop" } satisfies ToWatchdog);
    });
    worker.terminate();
  }
}
