// Text to speech on the CPU: Kokoro through sherpa-onnx, in-process. This is the default
// engine — it needs no sidecar, no GPU and no reference clip, so a node speaks as soon as
// the model is unpacked. sherpa calls back per sentence while it generates, which is what
// lets the first sentence leave before the rest exists; the callback is bridged to an async
// iterator here, and returning 0 from it is how a barge-in stops the generation.

import type { TtsEngine } from "./engines.ts";
import { toInt16 } from "./engines.ts";
import { paramNumber, paramPath, readVoiceManifest } from "./manifest.ts";
import { cpuProvider, loadSherpa } from "./runtime.ts";
import type { SherpaModule, SherpaTts } from "./runtime.ts";

export interface KokoroOptions {
  threads?: number;
  /** Which of the model's voices to speak in. */
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

class Kokoro implements TtsEngine {
  readonly name = "kokoro";
  readonly sampleRate: number;
  private tts: SherpaTts;
  private sherpa: SherpaModule;
  private voice: number;

  constructor(sherpa: SherpaModule, tts: SherpaTts, voice: number) {
    this.sherpa = sherpa;
    this.tts = tts;
    this.voice = voice;
    this.sampleRate = tts.sampleRate;
  }

  synth(text: string, opts: { signal?: AbortSignal } = {}): AsyncIterable<Int16Array> {
    const chunks = new Chunks();
    const generationConfig = new this.sherpa.GenerationConfig({ sid: this.voice, speed: 1.0 });
    void this.tts
      .generateAsync({
        text,
        generationConfig,
        onProgress: (info) => {
          if (opts.signal?.aborted) return 0;
          if (info.samples.length > 0) chunks.push(toInt16(info.samples));
          return 1;
        },
      })
      .then(() => chunks.end())
      .catch((e: unknown) => chunks.end(e));
    return { [Symbol.asyncIterator]: () => ({ next: () => chunks.next() }) };
  }

  close(): void {
    // sherpa frees the engine with its handle.
  }
}

export async function loadKokoro(dir: string, opts: KokoroOptions): Promise<TtsEngine> {
  const manifest = readVoiceManifest(dir);
  if (!manifest) throw new Error(`no voice manifest in ${dir}`);
  const model = paramPath(dir, manifest, "model");
  const voices = paramPath(dir, manifest, "voices");
  const tokens = paramPath(dir, manifest, "tokens");
  const dataDir = paramPath(dir, manifest, "dataDir");
  if (!model || !voices || !tokens || !dataDir) throw new Error(`${dir} does not name a model, voices, tokens and dataDir`);
  const sherpa = await loadSherpa();
  const tts = new sherpa.OfflineTts({
    model: {
      kokoro: { model, voices, tokens, dataDir },
      numThreads: opts.threads ?? 2,
      provider: cpuProvider(opts.nospin),
      debug: 0,
    },
    // One sentence per callback: the first words leave while the rest is still being made.
    maxNumSentences: 1,
  });
  const voice = Math.max(0, Math.min(tts.numSpeakers - 1, opts.voice ?? paramNumber(manifest, "voice", 0)));
  return new Kokoro(sherpa, tts, voice);
}
