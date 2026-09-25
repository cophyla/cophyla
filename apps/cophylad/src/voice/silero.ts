// Voice activity detection: Silero through sherpa-onnx, one detector per conversation. It
// marks the end of an utterance, which is what turns a stream of partials into one
// `user.message`. Silero wants 512-sample windows and the controller sends 640-sample
// frames, so the frames are re-cut here with a carry.

import type { VadEngine } from "./engines.ts";
import { IN_RATE, toFloat } from "./engines.ts";
import { paramPath, readVoiceManifest } from "./manifest.ts";
import { cpuProvider, loadSherpa } from "./runtime.ts";
import type { SherpaVad } from "./runtime.ts";

export const WINDOW = 512;

class Silero implements VadEngine {
  private vad: SherpaVad;
  private carry = new Float32Array(0);
  heard = false;

  constructor(vad: SherpaVad) {
    this.vad = vad;
  }

  feed(pcm: Int16Array): boolean {
    const samples = toFloat(pcm);
    const joined = new Float32Array(this.carry.length + samples.length);
    joined.set(this.carry);
    joined.set(samples, this.carry.length);
    let off = 0;
    for (; off + WINDOW <= joined.length; off += WINDOW) this.vad.acceptWaveform(joined.subarray(off, off + WINDOW));
    this.carry = joined.slice(off);
    this.heard ||= this.vad.isDetected() || !this.vad.isEmpty();
    if (this.vad.isEmpty()) return false;
    // A segment is complete: the audio itself is not wanted, only that the utterance closed.
    while (!this.vad.isEmpty()) this.vad.pop();
    return true;
  }

  reset(): void {
    this.carry = new Float32Array(0);
    this.heard = false;
    this.vad.reset();
  }

  close(): void {
    // sherpa frees the detector with its handle; nothing to release by hand.
  }
}

export interface SileroOptions {
  /** Silence that ends an utterance, in milliseconds. */
  minSilenceMs?: number;
  nospin: string;
}

/** A maker, so every conversation gets a detector of its own over the one loaded model. */
export async function loadSilero(dir: string, opts: SileroOptions): Promise<() => VadEngine> {
  const manifest = readVoiceManifest(dir);
  if (!manifest) throw new Error(`no voice manifest in ${dir}`);
  const model = paramPath(dir, manifest, "model");
  if (!model) throw new Error(`${dir} names no VAD model`);
  const sherpa = await loadSherpa();
  const config = {
    sileroVad: {
      model,
      threshold: 0.5,
      minSpeechDuration: 0.25,
      minSilenceDuration: (opts.minSilenceMs ?? 700) / 1000,
      windowSize: WINDOW,
      maxSpeechDuration: 30,
    },
    sampleRate: IN_RATE,
    numThreads: 1,
    provider: cpuProvider(opts.nospin),
    debug: 0,
  };
  return () => new Silero(new sherpa.Vad(config, 60));
}
