// Speech to text: the Nemotron 3.5 streaming transducer through sherpa-onnx, in-process.
// It decodes in 560 ms chunks and the text only grows, so a partial can go to the brain
// while the user is still speaking. Endpointing is Silero's job, not the recogniser's, so
// its own endpoint rules are off; `final` pads the tail with silence, drains what the model
// still holds, and resets the stream for the next utterance.
//
// `decode` is synchronous and costs about 93 ms per chunk on this machine (spike 10). The
// interface is shaped so the recogniser could move into a worker later without the
// conversation noticing.

import type { SttEngine, SttStream } from "./engines.ts";
import { IN_RATE, toFloat } from "./engines.ts";
import { paramNumber, paramPath, readVoiceManifest } from "./manifest.ts";
import { cpuProvider, loadSherpa } from "./runtime.ts";
import type { SherpaRecognizer, SherpaStream } from "./runtime.ts";

/** Silence appended before the last decode, so the model emits the final words. */
export const TAIL_MS = 600;

class NemotronStream implements SttStream {
  onPartial?: (text: string) => void;
  private rec: SherpaRecognizer;
  private stream: SherpaStream;
  private last = "";
  private disposed = false;

  constructor(rec: SherpaRecognizer, language?: string) {
    this.rec = rec;
    this.stream = rec.createStream();
    if (language) this.stream.setOption("language", language);
  }

  accept(pcm: Int16Array): void {
    if (this.disposed) return;
    this.stream.acceptWaveform({ samples: toFloat(pcm), sampleRate: IN_RATE });
    this.pump();
  }

  private pump(): void {
    while (this.rec.isReady(this.stream)) {
      this.rec.decode(this.stream);
      const text = this.rec.getResult(this.stream).text;
      if (text !== this.last) {
        this.last = text;
        if (text.trim()) this.onPartial?.(text.trim());
      }
    }
  }

  async final(): Promise<string> {
    if (this.disposed) return "";
    this.stream.acceptWaveform({ samples: new Float32Array(Math.round((IN_RATE * TAIL_MS) / 1000)), sampleRate: IN_RATE });
    this.pump();
    const text = this.last.trim();
    this.reset();
    return text;
  }

  reset(): void {
    if (this.disposed) return;
    this.rec.reset(this.stream);
    this.last = "";
  }

  dispose(): void {
    this.disposed = true;
  }
}

export interface NemotronOptions {
  threads?: number;
  language?: string;
  nospin: string;
}

export async function loadNemotron(dir: string, opts: NemotronOptions): Promise<SttEngine> {
  const manifest = readVoiceManifest(dir);
  if (!manifest) throw new Error(`no voice manifest in ${dir}`);
  const encoder = paramPath(dir, manifest, "encoder");
  const decoder = paramPath(dir, manifest, "decoder");
  const joiner = paramPath(dir, manifest, "joiner");
  const tokens = paramPath(dir, manifest, "tokens");
  if (!encoder || !decoder || !joiner || !tokens) throw new Error(`${dir} does not name an encoder, decoder, joiner and tokens`);
  const sherpa = await loadSherpa();
  const rec = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: IN_RATE, featureDim: paramNumber(manifest, "featureDim", 128) },
    modelConfig: {
      transducer: { encoder, decoder, joiner },
      tokens,
      numThreads: opts.threads ?? 2,
      provider: cpuProvider(opts.nospin),
      debug: 0,
    },
    decodingMethod: "greedy_search",
    // Silero closes an utterance; the recogniser's own rules would close it twice.
    enableEndpoint: 0,
  });
  return {
    stream: (streamOpts) => new NemotronStream(rec, streamOpts?.language ?? opts.language),
    close: () => {
      // sherpa frees the recogniser with its handle.
    },
  };
}
