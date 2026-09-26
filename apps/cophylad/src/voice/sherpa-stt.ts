// Speech to text on the whole utterance through sherpa-onnx's offline recogniser: Moonshine
// (Tiny and Base, English) and Whisper Base (99 languages). Nemotron decodes as the audio
// comes; these read an utterance whole, and they are small enough that a spoken sentence
// takes a few tens of milliseconds (Moonshine) to a few hundred (Whisper Base) on two
// threads, and load in under a second, which is what a speech process started at the wake
// word needs. So that the words still show while the user speaks, the audio heard so far is
// read again every `PARTIAL_MS` while the utterance lasts, one read at a time and off the
// thread the audio arrives on (`decodeAsync`), and a read that finds new text is a partial.

import type { SttEngine, SttStream } from "./engines.ts";
import { IN_RATE, toFloat } from "./engines.ts";
import type { VoiceManifest } from "./manifest.ts";
import { paramPath, readVoiceManifest } from "./manifest.ts";
import { cpuProvider, loadSherpa } from "./runtime.ts";
import type { SherpaOfflineRecognizer } from "./runtime.ts";

/** How often the audio so far is read again for a partial. */
export const PARTIAL_MS = 1000;
/** Whisper hears 30 s at most; an utterance is read to that length, and so is every partial. */
export const MAX_SAMPLES = 30 * IN_RATE;

export interface OfflineSttOptions {
  threads?: number;
  /** Whisper's language; it detects one when absent. Moonshine is English only. */
  language?: string;
  nospin: string;
  /** For the tests: `PARTIAL_MS` unless given, 0 for none. */
  partialMs?: number;
}

/** The model config sherpa takes for the recogniser the manifest names. */
function modelConfig(dir: string, manifest: VoiceManifest, language: string | undefined): Record<string, unknown> {
  const path = (key: string) => {
    const p = paramPath(dir, manifest, key);
    if (!p) throw new Error(`${dir} does not name its ${key}`);
    return p;
  };
  const recognizer = manifest.params["recognizer"];
  if (recognizer === "moonshine") return { moonshine: { encoder: path("encoder"), mergedDecoder: path("mergedDecoder") }, tokens: path("tokens") };
  if (recognizer === "whisper") return { whisper: { encoder: path("encoder"), decoder: path("decoder"), language: language ?? "", task: "transcribe", tailPaddings: -1 }, tokens: path("tokens") };
  throw new Error(`${dir} names no recogniser this engine runs`);
}

class OfflineStream implements SttStream {
  onPartial?: (text: string) => void;
  private rec: SherpaOfflineRecognizer;
  private partialMs: number;
  private chunks: Float32Array[] = [];
  private samples = 0;
  /** Samples the last partial read covered, the text it found, and whether a read is running. */
  private readAt = 0;
  private last = "";
  private reading?: Promise<void>;
  private disposed = false;
  /** Bumped by `reset`, `final` and `dispose`: a partial read that started before is dropped. */
  private epoch = 0;

  constructor(rec: SherpaOfflineRecognizer, partialMs: number) {
    this.rec = rec;
    this.partialMs = partialMs;
  }

  accept(pcm: Int16Array): void {
    if (this.disposed || this.samples >= MAX_SAMPLES) return;
    const take = Math.min(pcm.length, MAX_SAMPLES - this.samples);
    this.chunks.push(toFloat(take === pcm.length ? pcm : pcm.subarray(0, take)));
    this.samples += take;
    if (this.partialMs > 0 && !this.reading && this.samples - this.readAt >= (this.partialMs / 1000) * IN_RATE) this.readPartial();
  }

  private audio(): Float32Array {
    const all = new Float32Array(this.samples);
    let o = 0;
    for (const c of this.chunks) {
      all.set(c, o);
      o += c.length;
    }
    return all;
  }

  private async read(samples: Float32Array): Promise<string> {
    const stream = this.rec.createStream();
    stream.acceptWaveform({ samples, sampleRate: IN_RATE });
    return (await this.rec.decodeAsync(stream)).text.trim();
  }

  private readPartial(): void {
    const epoch = this.epoch;
    this.readAt = this.samples;
    this.reading = this.read(this.audio())
      .then((text) => {
        if (epoch !== this.epoch || this.disposed || !text || text === this.last) return;
        this.last = text;
        this.onPartial?.(text);
      })
      .catch(() => {})
      .finally(() => {
        this.reading = undefined;
      });
  }

  async final(): Promise<string> {
    if (this.disposed) return "";
    this.epoch++;
    await this.reading;
    const text = this.samples > 0 ? await this.read(this.audio()) : "";
    this.reset();
    return text;
  }

  reset(): void {
    this.epoch++;
    this.chunks = [];
    this.samples = 0;
    this.readAt = 0;
    this.last = "";
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
  }
}

export async function loadOfflineStt(dir: string, opts: OfflineSttOptions): Promise<SttEngine> {
  const manifest = readVoiceManifest(dir);
  if (!manifest) throw new Error(`no voice manifest in ${dir}`);
  const model = modelConfig(dir, manifest, opts.language);
  const sherpa = await loadSherpa();
  const rec = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: IN_RATE, featureDim: 80 },
    modelConfig: { ...model, numThreads: opts.threads ?? 2, provider: cpuProvider(opts.nospin), debug: 0 },
    decodingMethod: "greedy_search",
  });
  const partialMs = opts.partialMs ?? PARTIAL_MS;
  return {
    stream: () => new OfflineStream(rec, partialMs),
    close: () => {
      // sherpa frees the recogniser with its handle.
    },
  };
}
