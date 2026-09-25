// The wake word: openWakeWord's feature pipeline, streaming. 16 kHz int16 in 80 ms chunks
// through `melspectrogram.onnx`, 76-frame windows of 32 mel bins through
// `embedding_model.onnx`, the last 16 embeddings through the keyword head, one score per
// chunk. A port of `spikes/04-voice/wakeword.ts`, with the sessions shared by every stream
// and the rolling state per stream, so a second listener costs no memory.
//
// The node runs it on onnxruntime-node and the phone on onnxruntime-web, so it imports
// neither: the sessions and the tensor constructor are the few members both runtimes have.
//
// The head is trained at one input scale: openWakeWord's own heads on int16-range audio,
// livekit-wakeword's on -1..1. The model's manifest says which, so both can be shipped.

export const CHUNK = 1280;
/** 30 ms of earlier audio, so the mel frames line up across chunks. */
const CONTEXT = 480;
const MEL_BINS = 32;
const WINDOW = 76;
const EMB_DIM = 96;
const N_EMB = 16;

export type Scale = "int16" | "unit";

/** The part of an ONNX Runtime session the pipeline runs; onnxruntime-node's and onnxruntime-web's both fit. */
export interface WakeSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { readonly data: unknown }>>;
}

/** The runtime's tensor constructor, the one other thing the pipeline needs from it. */
export interface WakeRuntime {
  Tensor: new (type: "float32", data: Float32Array, dims: readonly number[]) => unknown;
}

/** The three loaded models: the two feature models every head shares, and the heads. */
export interface WakeModels {
  readonly ort: WakeRuntime;
  readonly mel: WakeSession;
  readonly emb: WakeSession;
  readonly heads: readonly { name: string; session: WakeSession }[];
  readonly scale: Scale;
}

/** One stream's rolling state over shared models: audio in, the peak score out. */
export class WakePipeline {
  private models: WakeModels;
  private raw = new Float32Array(CONTEXT + CHUNK);
  private pending = new Int16Array(0);
  private mel = new Float32Array(WINDOW * MEL_BINS).fill(1);
  private emb = new Float32Array(N_EMB * EMB_DIM);
  private chunks = 0;

  constructor(models: WakeModels) {
    this.models = models;
  }

  reset(): void {
    this.raw.fill(0);
    this.pending = new Int16Array(0);
    this.mel.fill(1);
    this.emb.fill(0);
    this.chunks = 0;
  }

  /** The peak score over the chunks this audio completed, 0 when it completed none. */
  async feed(pcm: Int16Array): Promise<number> {
    const joined = new Int16Array(this.pending.length + pcm.length);
    joined.set(this.pending);
    joined.set(pcm, this.pending.length);
    let peak = 0;
    let off = 0;
    for (; off + CHUNK <= joined.length; off += CHUNK) {
      peak = Math.max(peak, await this.step(joined.subarray(off, off + CHUNK)));
    }
    this.pending = joined.slice(off);
    return peak;
  }

  private async step(chunk: Int16Array): Promise<number> {
    const { ort, mel: melSession, emb: embSession, heads, scale } = this.models;
    const k = scale === "unit" ? 1 / 32768 : 1;
    this.raw.copyWithin(0, CHUNK);
    for (let i = 0; i < CHUNK; i++) this.raw[CONTEXT + i] = chunk[i]! * k;

    const melOut = await melSession.run({ [melSession.inputNames[0]!]: new ort.Tensor("float32", this.raw, [1, this.raw.length]) });
    const frames = melOut[melSession.outputNames[0]!]!.data as Float32Array;
    const n = frames.length;
    this.mel.copyWithin(0, n);
    for (let i = 0; i < n; i++) this.mel[this.mel.length - n + i] = frames[i]! / 10 + 2;

    const embOut = await embSession.run({ [embSession.inputNames[0]!]: new ort.Tensor("float32", this.mel, [1, WINDOW, MEL_BINS, 1]) });
    this.emb.copyWithin(0, EMB_DIM);
    this.emb.set(embOut[embSession.outputNames[0]!]!.data as Float32Array, (N_EMB - 1) * EMB_DIM);

    this.chunks++;
    // The embedding window is not real audio until 16 chunks have gone through it.
    if (this.chunks < N_EMB) return 0;
    let peak = 0;
    for (const head of heads) {
      const out = await head.session.run({ [head.session.inputNames[0]!]: new ort.Tensor("float32", this.emb, [1, N_EMB, EMB_DIM]) });
      const score = (out[head.session.outputNames[0]!]!.data as Float32Array)[0] ?? 0;
      if (score > peak) peak = score;
    }
    return peak;
  }
}
