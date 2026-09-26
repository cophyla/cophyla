// Voice activity detection: Silero, one detector per conversation over one loaded model. It
// marks the end of an utterance, which is what turns a stream of partials into one
// `user.message`. It runs on onnxruntime-node, which the platform ships for the wake word
// anyway, so detecting speech needs nothing the user has to install: a hosted recogniser
// works on a node with no local speech engine at all. Silero wants 512-sample windows and the
// controller sends 640-sample frames, so the frames are re-cut here with a carry.
//
// The decision is the one sherpa-onnx made over the same model: a window is speech above the
// threshold; speech starts once it has lasted `MIN_SPEECH_MS`, a blip shorter than that is
// forgotten; once started it ends after `minSilenceMs` below the threshold less a margin (so
// a soft syllable does not end it), or after `MAX_SPEECH_MS` however it goes.

import type { VadEngine } from "./engines.ts";
import { IN_RATE, toFloat } from "./engines.ts";
import { paramPath, readVoiceManifest } from "./manifest.ts";
import { loadOrt } from "./runtime.ts";
import type { Ort } from "./runtime.ts";

export const WINDOW = 512;
/** A window is speech above this. */
export const THRESHOLD = 0.5;
/** Speech under way ends only below the threshold less this. */
const END_MARGIN = 0.15;
/** Speech shorter than this is not an utterance. */
export const MIN_SPEECH_MS = 250;
/** An utterance longer than this is closed anyway. */
export const MAX_SPEECH_MS = 30_000;
/** The model's recurrent state: two layers of 64. */
const STATE = [2, 1, 64];

type Session = import("onnxruntime-node").InferenceSession;
type Tensor = import("onnxruntime-node").Tensor;

class Silero implements VadEngine {
  private ort: Ort;
  private session: Session;
  private minSilence: number;
  private carry = new Float32Array(0);
  private h!: Tensor;
  private c!: Tensor;
  /** Samples seen since the last reset, at the end of the last window. */
  private at = 0;
  private start = -1;
  private silentSince = -1;
  private speaking = false;
  heard = false;

  constructor(ort: Ort, session: Session, minSilenceMs: number) {
    this.ort = ort;
    this.session = session;
    this.minSilence = (minSilenceMs / 1000) * IN_RATE;
    this.reset();
  }

  async feed(pcm: Int16Array): Promise<boolean> {
    const samples = toFloat(pcm);
    const joined = new Float32Array(this.carry.length + samples.length);
    joined.set(this.carry);
    joined.set(samples, this.carry.length);
    let closed = false;
    let off = 0;
    for (; off + WINDOW <= joined.length; off += WINDOW) {
      if (this.step(await this.prob(joined.slice(off, off + WINDOW)))) closed = true;
    }
    this.carry = joined.slice(off);
    return closed;
  }

  private async prob(window: Float32Array): Promise<number> {
    const out = await this.session.run({ x: new this.ort.Tensor("float32", window, [1, WINDOW]), h: this.h, c: this.c });
    this.h = out["new_h"] as Tensor;
    this.c = out["new_c"] as Tensor;
    return (out["prob"]!.data as Float32Array)[0]!;
  }

  /** One window's probability in; true when it closes an utterance. */
  private step(p: number): boolean {
    this.at += WINDOW;
    if (p >= THRESHOLD) {
      this.silentSince = -1;
      if (this.start < 0) this.start = this.at - WINDOW;
      if (!this.speaking && this.at - this.start >= (MIN_SPEECH_MS / 1000) * IN_RATE) {
        this.speaking = true;
        this.heard = true;
      }
    } else if (!this.speaking) {
      this.start = -1;
    } else if (p < THRESHOLD - END_MARGIN) {
      if (this.silentSince < 0) this.silentSince = this.at - WINDOW;
      if (this.at - this.silentSince >= this.minSilence) return this.end();
    }
    if (this.speaking && this.at - this.start >= (MAX_SPEECH_MS / 1000) * IN_RATE) return this.end();
    return false;
  }

  private end(): boolean {
    this.speaking = false;
    this.start = -1;
    this.silentSince = -1;
    return true;
  }

  reset(): void {
    this.carry = new Float32Array(0);
    this.h = new this.ort.Tensor("float32", new Float32Array(2 * 64), STATE);
    this.c = new this.ort.Tensor("float32", new Float32Array(2 * 64), STATE);
    this.at = 0;
    this.start = -1;
    this.silentSince = -1;
    this.speaking = false;
    this.heard = false;
  }

  close(): void {
    // The session is the model's, shared by every detector; it goes with the process.
  }
}

export interface SileroOptions {
  /** Silence that ends an utterance, in milliseconds. */
  minSilenceMs?: number;
}

/** A maker, so every conversation gets a detector of its own over the one loaded model. */
export async function loadSilero(dir: string, opts: SileroOptions = {}): Promise<() => VadEngine> {
  const manifest = readVoiceManifest(dir);
  if (!manifest) throw new Error(`no voice manifest in ${dir}`);
  const model = paramPath(dir, manifest, "model");
  if (!model) throw new Error(`${dir} names no VAD model`);
  const ort = await loadOrt();
  const session = await ort.InferenceSession.create(model, { intraOpNumThreads: 1, interOpNumThreads: 1, executionProviders: ["cpu"] });
  return () => new Silero(ort, session, opts.minSilenceMs ?? 700);
}
