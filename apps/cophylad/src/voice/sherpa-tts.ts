// Text to speech on the CPU through sherpa-onnx, in-process: no sidecar, no GPU and no
// reference clip, so a node speaks as soon as the model is unpacked. Three engines, one
// runtime. Piper, a VITS voice, is the default: about fifteen times faster than real time on
// two threads, so the first words leave a tenth of a second after the reply. Kokoro sounds
// better and runs at about half real time. Supertonic speaks thirty-one languages at about a
// tenth.
//
// Each engine makes a piece of text whole before any of it can be played, so the text is cut
// here (`pieces.ts`): a short first piece, then pieces that grow while the ones before them
// play. sherpa calls back as it generates, and the calls are bridged to an async iterator;
// returning 0 from one is how a barge-in stops the generation. Every engine's audio leaves at
// the pipeline's 24 kHz, resampled when the model speaks at another rate, so Opus carries it.

import type { TtsEngine } from "./engines.ts";
import { OUT_RATE, toInt16 } from "./engines.ts";
import type { VoiceManifest } from "./manifest.ts";
import { paramNumber, paramPath, readVoiceManifest } from "./manifest.ts";
import { speechPieces } from "./pieces.ts";
import { cpuProvider, loadSherpa } from "./runtime.ts";
import type { SherpaModule, SherpaTts } from "./runtime.ts";

/** The engines sherpa runs, as `[voice] tts` names them. */
export type SherpaTtsEngine = "piper" | "kokoro" | "supertonic";

export interface SherpaTtsOptions {
  threads?: number;
  /** Which of the model's voices speaks; the model's own default when absent. */
  voice?: number;
  nospin: string;
}

/** A queue one side pushes and the other awaits, with an end and an error. */
class Chunks {
  private queue: Int16Array[] = [];
  private waiters: ((v: IteratorResult<Int16Array>) => void)[] = [];
  private done = false;
  private failure?: unknown;

  push(chunk: Int16Array): void {
    if (chunk.length === 0) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: chunk, done: false });
    else this.queue.push(chunk);
  }

  end(error?: unknown): void {
    this.done = true;
    this.failure = error;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  next(): Promise<IteratorResult<Int16Array>> {
    const chunk = this.queue.shift();
    if (chunk) return Promise.resolve({ value: chunk, done: false });
    if (this.done) {
      if (this.failure) return Promise.reject(this.failure);
      return Promise.resolve({ value: undefined as never, done: true });
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

class SherpaSpeech implements TtsEngine {
  readonly name: SherpaTtsEngine;
  readonly sampleRate = OUT_RATE;
  readonly voices: number;
  voice: number;
  private sherpa: SherpaModule;
  private tts: SherpaTts;
  private numSteps?: number;
  private defaultVoice: number;
  private generation: unknown;

  constructor(sherpa: SherpaModule, tts: SherpaTts, name: SherpaTtsEngine, defaultVoice: number, voice: number | undefined, numSteps?: number) {
    this.sherpa = sherpa;
    this.tts = tts;
    this.name = name;
    this.voices = Math.max(1, tts.numSpeakers);
    this.defaultVoice = this.clamp(defaultVoice);
    if (numSteps !== undefined) this.numSteps = numSteps;
    this.voice = this.defaultVoice;
    this.useVoice(voice);
  }

  private clamp(voice: number): number {
    return Math.max(0, Math.min(this.voices - 1, voice));
  }

  useVoice(voice: number | undefined): void {
    this.voice = voice === undefined ? this.defaultVoice : this.clamp(voice);
    this.generation = new this.sherpa.GenerationConfig({ sid: this.voice, speed: 1.0, ...(this.numSteps ? { numSteps: this.numSteps } : {}) });
  }

  synth(text: string, opts: { signal?: AbortSignal } = {}): AsyncIterable<Int16Array> {
    const chunks = new Chunks();
    this.run(speechPieces(text), chunks, opts.signal).then(
      () => chunks.end(),
      (e: unknown) => chunks.end(e),
    );
    return { [Symbol.asyncIterator]: () => ({ next: () => chunks.next() }) };
  }

  /** The pieces one after another, each resampled as it comes, the resampler's tail after the last. */
  private async run(pieces: string[], chunks: Chunks, signal: AbortSignal | undefined): Promise<void> {
    const resampler = this.tts.sampleRate === OUT_RATE ? undefined : new this.sherpa.LinearResampler(this.tts.sampleRate, OUT_RATE);
    for (const text of pieces) {
      if (signal?.aborted) return;
      await this.tts.generateAsync({
        text,
        generationConfig: this.generation,
        onProgress: (info) => {
          if (signal?.aborted) return 0;
          if (info.samples.length > 0) chunks.push(toInt16(resampler ? resampler.resample(info.samples) : info.samples));
          return 1;
        },
      });
    }
    if (resampler && !signal?.aborted) chunks.push(toInt16(resampler.flush(new Float32Array(0))));
  }

  close(): void {
    // sherpa frees the engine with its handle.
  }
}

/** The files each engine loads, named by its manifest, as sherpa's model config takes them. */
function modelConfig(engine: SherpaTtsEngine, dir: string, manifest: VoiceManifest): Record<string, unknown> {
  const paths = (...keys: string[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const key of keys) {
      const path = paramPath(dir, manifest, key);
      if (!path) throw new Error(`${dir} does not name its ${key}`);
      out[key] = path;
    }
    return out;
  };
  switch (engine) {
    case "piper":
      return { vits: paths("model", "tokens", "dataDir") };
    case "kokoro":
      return { kokoro: paths("model", "voices", "tokens", "dataDir") };
    case "supertonic":
      return { supertonic: paths("durationPredictor", "textEncoder", "vectorEstimator", "vocoder", "ttsJson", "unicodeIndexer", "voiceStyle") };
  }
}

/** Loads `engine` from its model directory. */
export async function loadSherpaTts(engine: SherpaTtsEngine, dir: string, opts: SherpaTtsOptions): Promise<TtsEngine> {
  const manifest = readVoiceManifest(dir);
  if (!manifest) throw new Error(`no voice manifest in ${dir}`);
  const model = modelConfig(engine, dir, manifest);
  const sherpa = await loadSherpa();
  const tts = new sherpa.OfflineTts({
    model: { ...model, numThreads: opts.threads ?? 2, provider: cpuProvider(opts.nospin), debug: 0 },
    // One sentence per callback where the engine splits at all: the first words leave while the rest is still being made.
    maxNumSentences: 1,
  });
  const steps = paramNumber(manifest, "numSteps", 0);
  return new SherpaSpeech(sherpa, tts, engine, paramNumber(manifest, "voice", 0), opts.voice, steps > 0 ? steps : undefined);
}
