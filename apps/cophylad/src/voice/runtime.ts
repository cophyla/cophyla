// Loading the two native runtimes, in the one order that works. sherpa-onnx-node ships its
// own `onnxruntime.dll` (1.28.2) and `onnxruntime-node` ships another (1.30.0); on Windows
// a module name resolves to whichever was loaded first, and onnxruntime-node needs an API
// version the older library does not have. Loading onnxruntime-node first therefore serves
// both, and loading sherpa first breaks the embedder. Every caller goes through here, so
// the order is not something a new call site can get wrong.
//
// The ORT session config beside each model is the other half of spike 10: with the thread
// pool's busy-wait left on, two threads cost 156 % of a core while the stream idles between
// chunks; with `allow_spinning` off, the same two threads cost 35 %.

import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Ort = typeof import("onnxruntime-node");

let ortPromise: Promise<Ort> | undefined;
let sherpaPromise: Promise<SherpaModule> | undefined;

/** The ONNX Runtime binding, loaded once. */
export function loadOrt(): Promise<Ort> {
  if (!ortPromise) ortPromise = import("onnxruntime-node");
  return ortPromise;
}

/** The pieces of `sherpa-onnx-node` the voice module uses. */
export interface SherpaModule {
  OnlineRecognizer: new (config: unknown) => SherpaRecognizer;
  OfflineTts: new (config: unknown) => SherpaTts;
  GenerationConfig: new (opts: { sid?: number; speed?: number }) => unknown;
  Vad: new (config: unknown, bufferSizeInSeconds: number) => SherpaVad;
}

export interface SherpaStream {
  acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void;
  inputFinished(): void;
  setOption(key: string, value: string): void;
}

export interface SherpaRecognizer {
  createStream(): SherpaStream;
  isReady(stream: SherpaStream): boolean;
  decode(stream: SherpaStream): void;
  reset(stream: SherpaStream): void;
  getResult(stream: SherpaStream): { text: string };
}

export interface SherpaTts {
  readonly sampleRate: number;
  readonly numSpeakers: number;
  generateAsync(obj: { text: string; generationConfig?: unknown; onProgress?: (info: { samples: Float32Array; progress: number }) => number | boolean | void }): Promise<{ samples: Float32Array; sampleRate: number }>;
}

export interface SherpaVad {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  /** Speech is under way: a segment has started and not yet closed. */
  isDetected(): boolean;
  pop(): void;
  reset(): void;
}

/**
 * sherpa-onnx-node, loaded after onnxruntime-node so the newer runtime wins the module
 * name. The require is CommonJS: the package is a `.node` addon behind a JS wrapper.
 */
export async function loadSherpa(): Promise<SherpaModule> {
  if (!sherpaPromise) {
    sherpaPromise = (async () => {
      // Load-bearing: onnxruntime-node first, always. See the note at the top of this file.
      await loadOrt();
      const require = createRequire(import.meta.url);
      return require("sherpa-onnx-node") as SherpaModule;
    })();
  }
  return sherpaPromise;
}

export const NOSPIN_FILE = "ort-nospin.cfg";
const NOSPIN_BODY = "SessionConfig.session.intra_op.allow_spinning=0\nSessionConfig.session.inter_op.allow_spinning=0\n";

/**
 * The ORT session config sherpa reads as `provider: "cpu:<path>"`, written under
 * `data/voice/` so it is there whatever a model directory holds.
 */
export function ensureNospinConfig(dataDir: string): string {
  const dir = join(dataDir, "voice");
  const path = join(dir, NOSPIN_FILE);
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, NOSPIN_BODY, "utf8");
  }
  return path;
}

/** The `provider` string for a sherpa model config: the CPU with the busy-wait off. */
export function cpuProvider(nospinPath: string): string {
  return `cpu:${nospinPath}`;
}
