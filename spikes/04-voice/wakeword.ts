// Streaming port of the openWakeWord feature pipeline (openwakeword/utils.py AudioFeatures):
//   16 kHz int16 -> melspectrogram.onnx (x/10 + 2) -> 76-frame windows, step 8
//   -> embedding_model.onnx (96-dim) -> last 16 embeddings -> keyword classifier -> score 0..1
// One embedding and one classifier pass per 80 ms chunk.
import * as ort from 'onnxruntime-node';

export const SAMPLE_RATE = 16000;
export const CHUNK = 1280; // 80 ms
const CONTEXT = 480; // 30 ms of earlier audio so the mel frames line up across chunks
const MEL_BINS = 32;
const WINDOW = 76;
const EMB_DIM = 96;
const N_EMB = 16;

// openWakeWord classifiers were trained on mel features of audio in int16 range;
// livekit-wakeword classifiers on audio scaled to -1..1. Same feature models, different input scale.
export type Scale = 'int16' | 'unit';

export type Classifier = { name: string; path: string };

const SESSION_OPTS: ort.InferenceSession.SessionOptions = {
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
  executionProviders: ['cpu'],
};

export class WakeWord {
  private raw = new Float32Array(CONTEXT + CHUNK); // last 110 ms, already scaled
  private pending = new Int16Array(0);
  private mel = new Float32Array(WINDOW * MEL_BINS).fill(1); // openWakeWord starts from ones
  private emb = new Float32Array(N_EMB * EMB_DIM);
  chunks = 0;

  // Erasable syntax only (no parameter properties), so Node's type stripping runs this file too.
  private melSession: ort.InferenceSession;
  private embSession: ort.InferenceSession;
  private heads: { name: string; session: ort.InferenceSession }[];
  private scale: Scale;

  private constructor(
    melSession: ort.InferenceSession,
    embSession: ort.InferenceSession,
    heads: { name: string; session: ort.InferenceSession }[],
    scale: Scale,
  ) {
    this.melSession = melSession;
    this.embSession = embSession;
    this.heads = heads;
    this.scale = scale;
  }

  static async create(classifiers: Classifier[], scale: Scale, dir = 'models') {
    const melSession = await ort.InferenceSession.create(`${dir}/melspectrogram.onnx`, SESSION_OPTS);
    const embSession = await ort.InferenceSession.create(`${dir}/embedding_model.onnx`, SESSION_OPTS);
    const heads = [];
    for (const c of classifiers) {
      heads.push({ name: c.name, session: await ort.InferenceSession.create(c.path, SESSION_OPTS) });
    }
    return new WakeWord(melSession, embSession, heads, scale);
  }

  // Feed any amount of audio; returns one score row per completed 80 ms chunk.
  async feed(samples: Int16Array): Promise<Record<string, number>[]> {
    const joined = new Int16Array(this.pending.length + samples.length);
    joined.set(this.pending);
    joined.set(samples, this.pending.length);
    const rows: Record<string, number>[] = [];
    let off = 0;
    for (; off + CHUNK <= joined.length; off += CHUNK) {
      rows.push(await this.step(joined.subarray(off, off + CHUNK)));
    }
    this.pending = joined.slice(off);
    return rows;
  }

  private async step(chunk: Int16Array): Promise<Record<string, number>> {
    const k = this.scale === 'unit' ? 1 / 32768 : 1;
    this.raw.copyWithin(0, CHUNK);
    for (let i = 0; i < CHUNK; i++) this.raw[CONTEXT + i] = chunk[i] * k;

    const melOut = await this.melSession.run({
      [this.melSession.inputNames[0]]: new ort.Tensor('float32', this.raw, [1, this.raw.length]),
    });
    const frames = melOut[this.melSession.outputNames[0]].data as Float32Array; // 8 x 32
    const n = frames.length;
    this.mel.copyWithin(0, n);
    for (let i = 0; i < n; i++) this.mel[this.mel.length - n + i] = frames[i] / 10 + 2;

    const embOut = await this.embSession.run({
      [this.embSession.inputNames[0]]: new ort.Tensor('float32', this.mel, [1, WINDOW, MEL_BINS, 1]),
    });
    this.emb.copyWithin(0, EMB_DIM);
    this.emb.set(embOut[this.embSession.outputNames[0]].data as Float32Array, (N_EMB - 1) * EMB_DIM);

    this.chunks++;
    const row: Record<string, number> = {};
    for (const h of this.heads) {
      const out = await h.session.run({
        [h.session.inputNames[0]]: new ort.Tensor('float32', this.emb, [1, N_EMB, EMB_DIM]),
      });
      // The embedding window is not real audio until 16 chunks have passed.
      row[h.name] = this.chunks < N_EMB ? 0 : (out[h.session.outputNames[0]].data as Float32Array)[0];
    }
    return row;
  }
}

// Minimal PCM16 WAV reader: finds the data chunk, returns mono samples.
export function readWav16(bytes: Uint8Array): { sampleRate: number; samples: Int16Array } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12;
  let sampleRate = 0;
  let channels = 1;
  while (pos + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(pos, pos + 4));
    const size = dv.getUint32(pos + 4, true);
    if (id === 'fmt ') {
      channels = dv.getUint16(pos + 10, true);
      sampleRate = dv.getUint32(pos + 12, true);
      if (dv.getUint16(pos + 22, true) !== 16) throw new Error('not 16-bit PCM');
    } else if (id === 'data') {
      const count = Math.floor(Math.min(size, bytes.length - pos - 8) / 2 / channels);
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i++) samples[i] = dv.getInt16(pos + 8 + i * 2 * channels, true);
      return { sampleRate, samples };
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

export function writeWav16(samples: Int16Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const dv = new DataView(out.buffer);
  const tag = (o: number, s: string) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + samples.length * 2, true); tag(8, 'WAVE');
  tag(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  tag(36, 'data'); dv.setUint32(40, samples.length * 2, true);
  new Int16Array(out.buffer, 44, samples.length).set(samples);
  return out;
}

export function rms(samples: Int16Array): number {
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
  return Math.sqrt(s / Math.max(1, samples.length));
}
