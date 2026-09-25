// The wake word on the page's side of the worker. It fetches the four bundled files here on
// the main thread — `connect-src 'self'` allows it, and it keeps the worker clear of however
// a web view serves a worker's own requests — checks and keeps them where the platform can,
// starts `wake-worker.js` as a module worker with the bytes transferred to it, and from then
// on hands it the frames the page is listening to and passes on what it hears.

import type { WakewordMode } from "@cophyla/protocol";
import { BUNDLED, BUNDLED_FILES, BUNDLED_HEADS, WAKE_DIR } from "./bundled.ts";
import type { BundledFile } from "./bundled.ts";
import type { WorkerIn, WorkerOut } from "./worker.ts";

export type DetectorState = "idle" | "loading" | "ready" | "failed";

export type PhoneWake = Extract<WakewordMode, { mode: "phone" }>;

export interface WakeStats {
  msPerChunk: number;
  chunks: number;
  peak: number;
  at: number;
}

/** Where the fetched files are kept between visits, by sha256. */
export interface FileCache {
  get(key: string): Promise<ArrayBuffer | undefined>;
  put(key: string, bytes: ArrayBuffer): Promise<void>;
  /** Drops every entry but these. */
  keep(keys: string[]): Promise<void>;
}

export interface DetectorOptions {
  /** The browser page's cache; the app reads the files from its own assets and keeps none. */
  cache?: FileCache;
  /** Checks each download against its pin: the browser page, whose files come from the node. */
  verify?: boolean;
  onWake: (score: number, seq: number) => void;
  /** The worker failed after it was ready. */
  onError: (reason: string) => void;
  onStats?: (stats: WakeStats) => void;
  /** For the tests. */
  worker?: () => Worker;
  fetch?: (url: string) => Promise<Response>;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class WakeDetector {
  state: DetectorState = "idle";
  readonly heads: string[] = BUNDLED_HEADS;
  /** What the node said to run, once it said it. */
  configured?: PhoneWake;
  stats?: WakeStats;
  /** How long the files and the worker took to come up, and how many files the cache had. */
  loadMs?: number;
  fromCache = 0;
  private opts: DetectorOptions;
  private worker?: Worker;

  constructor(opts: DetectorOptions) {
    this.opts = opts;
  }

  get ready(): boolean {
    return this.state === "ready";
  }

  /** The files, then the worker. Resolves once it can listen; rejects, and stays failed, when it cannot. */
  async load(): Promise<void> {
    if (this.state !== "idle") return;
    this.state = "loading";
    const t0 = performance.now();
    try {
      const [wasm, mel, embedding, ...heads] = await Promise.all(BUNDLED_FILES.map((f) => this.file(f)));
      void this.opts.cache?.keep(BUNDLED_FILES.map((f) => f.sha256)).catch(() => {});
      const worker = (this.opts.worker ?? (() => new Worker("wake-worker.js", { type: "module" })))();
      this.worker = worker;
      await new Promise<void>((resolve, reject) => {
        worker.onmessage = (ev: MessageEvent) => {
          const msg = ev.data as WorkerOut;
          if (msg.type === "ready") resolve();
          else if (msg.type === "error") reject(new Error(msg.reason));
        };
        worker.onerror = (ev: ErrorEvent) => reject(new Error(ev.message || "the wake worker did not start"));
        const init: WorkerIn = { type: "init", wasm: wasm!, mel: mel!, embedding: embedding!, heads: BUNDLED.heads.map((h, i) => ({ name: h.file, bytes: heads[i]! })) };
        worker.postMessage(init, [wasm!, mel!, embedding!, ...heads]);
      });
      worker.onmessage = (ev: MessageEvent) => this.onMessage(ev.data as WorkerOut);
      worker.onerror = (ev: ErrorEvent) => this.fail(ev.message || "the wake worker stopped");
      this.loadMs = Math.round(performance.now() - t0);
      this.state = "ready";
    } catch (e) {
      this.state = "failed";
      this.worker?.terminate();
      this.worker = undefined;
      throw e;
    }
  }

  private async file(f: BundledFile): Promise<ArrayBuffer> {
    const cached = await this.opts.cache?.get(f.sha256).catch(() => undefined);
    if (cached) {
      this.fromCache++;
      return cached;
    }
    const res = await (this.opts.fetch ?? fetch)(WAKE_DIR + f.file);
    if (!res.ok) throw new Error(`${WAKE_DIR}${f.file}: ${res.status}`);
    const bytes = await res.arrayBuffer();
    if (this.opts.verify && (await sha256Hex(bytes)) !== f.sha256) throw new Error(`${WAKE_DIR}${f.file} is not the file this build was made with`);
    await this.opts.cache?.put(f.sha256, bytes).catch(() => {});
    return bytes;
  }

  /** The head, threshold and scale the node said to run. */
  configure(mode: PhoneWake): void {
    if (!this.worker) return;
    this.configured = mode;
    this.post({ type: "configure", head: mode.head, threshold: mode.threshold, scale: mode.scale });
  }

  /** A frame to listen to; the page keeps its own, since this one is handed over. */
  feed(seq: number, pcm: Int16Array): void {
    if (!this.worker || !this.configured) return;
    const copy = pcm.slice();
    this.post({ type: "frame", seq, pcm: copy.buffer }, [copy.buffer]);
  }

  /** Starts over: the audio it would have carried on from is not what comes next. */
  reset(): void {
    if (this.worker) this.post({ type: "reset" });
  }

  close(): void {
    this.worker?.terminate();
    this.worker = undefined;
    if (this.state !== "failed") this.state = "idle";
  }

  private post(msg: WorkerIn, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer);
  }

  private onMessage(msg: WorkerOut): void {
    switch (msg.type) {
      case "wake":
        this.opts.onWake(msg.score, msg.seq);
        return;
      case "stats":
        this.stats = { msPerChunk: Number(msg.msPerChunk.toFixed(2)), chunks: msg.chunks, peak: Number(msg.peak.toFixed(3)), at: Date.now() };
        this.opts.onStats?.(this.stats);
        return;
      case "error":
        this.fail(msg.reason);
        return;
      case "ready":
        return;
    }
  }

  private fail(reason: string): void {
    if (this.state === "failed") return;
    this.state = "failed";
    this.worker?.terminate();
    this.worker = undefined;
    this.opts.onError(reason);
  }
}
