// The wake word's own thread: ONNX Runtime's wasm build running openWakeWord through the
// same `WakePipeline` the node runs, over the frames the page hands it while it listens.
// One thread and no proxy (the page is not cross-origin isolated), and the wasm's bytes come
// from the page, which fetched and checked them, so the runtime never looks for a URL of
// its own. When the score reaches the threshold it says so with the frame's number and
// starts over; every ten seconds it says how long a chunk takes.
//
// in:  init {wasm, mel, embedding, heads: [{name, bytes}]}   → ready | error {reason}
//      configure {head, threshold, scale}
//      frame {seq, pcm}                                      → wake {score, seq}
//      reset
// out: stats {msPerChunk, chunks, peak}, every 10 s

import * as ort from "onnxruntime-web/wasm";
import { CHUNK, WakePipeline } from "@cophyla/wake";
import type { Scale, WakeSession } from "@cophyla/wake";

/** The worker scope, as far as this file uses it: the DOM library has no dedicated-worker global. */
interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}
const scope = globalThis as unknown as WorkerScope;

export type WorkerIn =
  | { type: "init"; wasm: ArrayBuffer; mel: ArrayBuffer; embedding: ArrayBuffer; heads: { name: string; bytes: ArrayBuffer }[] }
  | { type: "configure"; head: string; threshold: number; scale: Scale }
  | { type: "frame"; seq: number; pcm: ArrayBuffer }
  | { type: "reset" };

export type WorkerOut =
  | { type: "ready" }
  | { type: "error"; reason: string }
  | { type: "wake"; score: number; seq: number }
  | { type: "stats"; msPerChunk: number; chunks: number; peak: number };

/** Two seconds of frames: a phone that falls further behind starts over rather than catching up. */
const MAX_BACKLOG = 50;
const STATS_MS = 10_000;

let sessions: { mel: WakeSession; emb: WakeSession; heads: Map<string, WakeSession> } | undefined;
let pipeline: WakePipeline | undefined;
let threshold = 1;
let queue: { seq: number; pcm: Int16Array }[] = [];
let pumping = false;
/** A reset asked for while a chunk was being scored, applied before the next. */
let resetWanted = false;
let busyMs = 0;
let samples = 0;
let peak = 0;

const post = (message: WorkerOut): void => scope.postMessage(message);
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function init(msg: Extract<WorkerIn, { type: "init" }>): Promise<void> {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmBinary = msg.wasm;
  const create = (bytes: ArrayBuffer) => ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ["wasm"] }) as Promise<WakeSession>;
  const [mel, emb, ...heads] = await Promise.all([create(msg.mel), create(msg.embedding), ...msg.heads.map((h) => create(h.bytes))]);
  sessions = { mel: mel!, emb: emb!, heads: new Map(msg.heads.map((h, i) => [h.name, heads[i]!])) };
  post({ type: "ready" });
}

/** Starts over with nothing queued; between two chunks, never in the middle of one. */
function reset(): void {
  queue = [];
  if (pumping) resetWanted = true;
  else pipeline?.reset();
}

function configure(msg: Extract<WorkerIn, { type: "configure" }>): void {
  if (!sessions) throw new Error("configure before init");
  const head = sessions.heads.get(msg.head);
  if (!head) throw new Error(`no wake head ${msg.head} in this build`);
  pipeline = new WakePipeline({ ort, mel: sessions.mel, emb: sessions.emb, heads: [{ name: msg.head, session: head }], scale: msg.scale });
  threshold = msg.threshold;
  queue = [];
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const frame = queue.shift();
      if (!frame || !pipeline) break;
      if (resetWanted) {
        resetWanted = false;
        pipeline.reset();
      }
      const t0 = performance.now();
      const score = await pipeline.feed(frame.pcm);
      busyMs += performance.now() - t0;
      samples += frame.pcm.length;
      if (score > peak) peak = score;
      if (score >= threshold) {
        post({ type: "wake", score, seq: frame.seq });
        // Heard: start over, and what was queued behind the word is the utterance's, not ours.
        pipeline.reset();
        queue = [];
      }
    }
  } catch (e) {
    post({ type: "error", reason: reason(e) });
  } finally {
    pumping = false;
  }
}

scope.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as WorkerIn;
  try {
    switch (msg.type) {
      case "init":
        init(msg).catch((e: unknown) => post({ type: "error", reason: reason(e) }));
        return;
      case "configure":
        configure(msg);
        return;
      case "frame":
        if (!pipeline) return;
        queue.push({ seq: msg.seq, pcm: new Int16Array(msg.pcm) });
        if (queue.length > MAX_BACKLOG) reset();
        void pump();
        return;
      case "reset":
        reset();
        return;
    }
  } catch (e) {
    post({ type: "error", reason: reason(e) });
  }
};

setInterval(() => {
  const chunks = samples / CHUNK;
  post({ type: "stats", msPerChunk: chunks > 0 ? busyMs / chunks : 0, chunks: Math.floor(chunks), peak });
  busyMs = 0;
  samples = 0;
  peak = 0;
}, STATS_MS);
