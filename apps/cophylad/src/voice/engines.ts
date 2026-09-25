// The engine interfaces the voice pipeline runs on, and nothing else: every stage sits
// behind one of these, so the conversation logic is the same whether the engine is a real
// model in-process, a sidecar over HTTP, or a fake in a test. Audio is int16 mono
// throughout, 16 kHz up from the controller and 24 kHz down to it.

import type { Sidecars } from "../sidecars/index.ts";
import type { VoiceConfig } from "../config/schema.ts";

/** What a controller sends: 16 kHz mono, 40 ms to a frame. */
export const IN_RATE = 16000;
/** What speech comes back at. */
export const OUT_RATE = 24000;
/** Samples in one `voice.audio` frame from the controller. */
export const FRAME = 640;

/** A loaded wake model; a stream per conversation, the sessions shared. */
export interface WakeModel {
  stream(): WakeEngine;
  close(): void | Promise<void>;
}

export interface WakeEngine {
  /** The peak score over the chunks this audio completed, 0 when it completed none. */
  feed(pcm: Int16Array): Promise<number>;
  reset(): void;
}

export interface VadEngine {
  /** True once, on the frame that closes an utterance. */
  feed(pcm: Int16Array): boolean;
  /** Speech was detected at some point since the last `reset()`. */
  readonly heard: boolean;
  reset(): void;
  close(): void | Promise<void>;
}

export interface SttStream {
  accept(pcm: Int16Array): void;
  /** Called as the text grows, never with the same text twice. */
  onPartial?: (text: string) => void;
  /** Drains what is left and returns the whole utterance, empty when there was no speech. */
  final(): Promise<string>;
  reset(): void;
  dispose(): void;
}

export interface SttEngine {
  stream(opts?: { language?: string }): SttStream;
  close(): void | Promise<void>;
}

export interface TtsEngine {
  readonly name: string;
  readonly sampleRate: number;
  /** One chunk per sentence, so the first words leave before the rest is synthesised. */
  synth(text: string, opts?: { signal?: AbortSignal }): AsyncIterable<Int16Array>;
  close(): void | Promise<void>;
}

export type StageStatus = "off" | "unavailable" | "loading" | "ready" | "failed";

export interface StageState {
  status: StageStatus;
  /** Why it is unavailable or failed, for the log and the view. */
  reason?: string;
  /** The engine that serves the stage, when one does. */
  engine?: string;
}

/** Where an engine's model directory comes from: the feed, or a directory the config names. */
export interface ModelResolver {
  resolve(name: string): Promise<string | undefined>;
}

/** How the voice module builds its engines; `fake.ts` is the other implementation. */
export interface EngineFactory {
  /** The model names this configuration needs, so they are fetched before a stage loads. */
  models(config: VoiceConfig): string[];
  wake(dir: string, config: VoiceConfig): Promise<WakeModel>;
  vad(dir: string, config: VoiceConfig): Promise<() => VadEngine>;
  stt(dir: string, config: VoiceConfig): Promise<SttEngine>;
  tts(dir: string | undefined, config: VoiceConfig, sidecars: Sidecars): Promise<TtsEngine>;
}

/** int16 as the floats sherpa and ONNX want. */
export function toFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 32768;
  return out;
}

/** Floats back to int16, clamped. */
export function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = v < 0 ? v * 32768 : v * 32767;
  }
  return out;
}
