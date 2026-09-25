// The wake word: openWakeWord's feature pipeline, streaming. 16 kHz int16 in 80 ms chunks
// through `melspectrogram.onnx`, 76-frame windows of 32 mel bins through
// `embedding_model.onnx`, the last 16 embeddings through each keyword head, one score per
// head per chunk. A port of `spikes/04-voice/wakeword.ts`, with the sessions shared by every
// stream and the rolling state per stream, so a second listener costs no memory.
//
// The node runs it on onnxruntime-node and the phone on onnxruntime-web, so it imports
// neither: the sessions and the tensor constructor are the few members both runtimes have.
//
// Several heads listen at once, one per phrase, each at its own threshold. A head is trained
// at one input scale: openWakeWord's own heads on int16-range audio, livekit-wakeword's on
// -1..1. The features are computed once per scale the heads use, so heads of one scale share
// them and a second scale costs a second pass through the two feature models.

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

/** One keyword head: its file name, its session, the score it fires at and the scale it was trained at. */
export interface WakeHead {
  readonly name: string;
  readonly session: WakeSession;
  readonly threshold: number;
  readonly scale: Scale;
}

/** The loaded models: the two feature models every head shares, and the heads. */
export interface WakeModels {
  readonly ort: WakeRuntime;
  readonly mel: WakeSession;
  readonly emb: WakeSession;
  readonly heads: readonly WakeHead[];
}

/**
 * What some audio scored. `fired` names the first head that reached its threshold, with its
 * score; otherwise `score` is the highest any head reached and `head` the one that reached it,
 * both absent while no chunk has been scored.
 */
export interface WakeScore {
  fired: boolean;
  score: number;
  head?: string;
}

/** One scale's rolling features: the raw audio's tail, the mel window and the embedding window. */
class Features {
  private raw = new Float32Array(CONTEXT + CHUNK);
  private mel = new Float32Array(WINDOW * MEL_BINS).fill(1);
  readonly emb = new Float32Array(N_EMB * EMB_DIM);
  private chunks = 0;
  private k: number;

  constructor(scale: Scale) {
    this.k = scale === "unit" ? 1 / 32768 : 1;
  }

  reset(): void {
    this.raw.fill(0);
    this.mel.fill(1);
    this.emb.fill(0);
    this.chunks = 0;
  }

  /** One chunk in; true once the embedding window holds real audio (16 chunks). */
  async step(models: WakeModels, chunk: Int16Array): Promise<boolean> {
    const { ort, mel: melSession, emb: embSession } = models;
    this.raw.copyWithin(0, CHUNK);
    for (let i = 0; i < CHUNK; i++) this.raw[CONTEXT + i] = chunk[i]! * this.k;

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
    return this.chunks >= N_EMB;
  }
}

/** One stream's rolling state over shared models: audio in, what the heads made of it out. */
export class WakePipeline {
  private models: WakeModels;
  private pending = new Int16Array(0);
  private features = new Map<Scale, Features>();

  constructor(models: WakeModels) {
    this.models = models;
    for (const head of models.heads) if (!this.features.has(head.scale)) this.features.set(head.scale, new Features(head.scale));
  }

  reset(): void {
    this.pending = new Int16Array(0);
    for (const f of this.features.values()) f.reset();
  }

  /** The chunks this audio completed, scored: the first head to fire, or the best score when none did. */
  async feed(pcm: Int16Array): Promise<WakeScore> {
    const joined = new Int16Array(this.pending.length + pcm.length);
    joined.set(this.pending);
    joined.set(pcm, this.pending.length);
    let best: WakeScore = { fired: false, score: 0 };
    let off = 0;
    for (; off + CHUNK <= joined.length; off += CHUNK) {
      const scored = await this.step(joined.subarray(off, off + CHUNK));
      if (!best.fired && (scored.fired || scored.score > best.score)) best = scored;
    }
    this.pending = joined.slice(off);
    return best;
  }

  private async step(chunk: Int16Array): Promise<WakeScore> {
    const filled = new Map<Scale, boolean>();
    for (const [scale, f] of this.features) filled.set(scale, await f.step(this.models, chunk));
    const { ort, heads } = this.models;
    let best: WakeScore = { fired: false, score: 0 };
    for (const head of heads) {
      if (!filled.get(head.scale)) continue;
      const emb = this.features.get(head.scale)!.emb;
      const out = await head.session.run({ [head.session.inputNames[0]!]: new ort.Tensor("float32", emb, [1, N_EMB, EMB_DIM]) });
      const score = (out[head.session.outputNames[0]!]!.data as Float32Array)[0] ?? 0;
      if (score >= head.threshold) return { fired: true, score, head: head.name };
      if (score > best.score) best = { fired: false, score, head: head.name };
    }
    return best;
  }
}
