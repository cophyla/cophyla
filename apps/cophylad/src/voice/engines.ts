// The engine interfaces the voice pipeline runs on, and nothing else: every stage sits
// behind one of these, so the conversation logic is the same whether the engine is a real
// model in-process, a sidecar over HTTP, or a fake in a test. Audio is int16 mono
// throughout, 16 kHz up from the controller and 24 kHz down to it.

import type { RpcError, VoiceStopped } from "@cophyla/protocol";
import type { Scale, WakeScore } from "@cophyla/wake";
import type { Sidecars } from "../sidecars/index.ts";
import type { VoiceConfig } from "../config/schema.ts";

export type { Scale, WakeScore } from "@cophyla/wake";

/** What a controller sends: 16 kHz mono, 40 ms to a frame. */
export const IN_RATE = 16000;
/** What speech comes back at. */
export const OUT_RATE = 24000;
/** Samples in one `voice.audio` frame from the controller. */
export const FRAME = 640;

/**
 * One phrase the wake word listens for: its head's file, the score it fires at, the chunks in a
 * row it must score so before it fires, the scale it was trained at, what is said, and how it
 * is said when the model has heads for more than one way of saying it.
 */
export interface WakeHeadInfo {
  name: string;
  threshold: number;
  patience: number;
  scale: Scale;
  phrase: string;
  sound?: string;
}

/** A loaded wake model; a stream per conversation, the sessions shared. */
export interface WakeModel {
  /** The heads that listen, in the configured order; a configured head the model lacks is not among them. */
  readonly heads: readonly WakeHeadInfo[];
  stream(): WakeEngine;
  close(): void | Promise<void>;
}

export interface WakeEngine {
  /** The chunks this audio completed, scored: the head that fired, or the best score when none did. */
  feed(pcm: Int16Array): Promise<WakeScore>;
  reset(): void;
}

export interface VadEngine {
  /** True once, on the frame that closes an utterance. */
  feed(pcm: Int16Array): boolean | Promise<boolean>;
  /** Speech was detected at some point since the last `reset()`. */
  readonly heard: boolean;
  reset(): void;
  close(): void | Promise<void>;
}

export interface SttStream {
  accept(pcm: Int16Array): void;
  /** Called as the text grows, never with the same text twice. */
  onPartial?: (text: string) => void;
  /** The recogniser stopped hearing while the utterance went on: its route's limit, or the account's allowance. */
  onStop?: (why: VoiceStopped) => void;
  /**
   * The VAD heard speech in the utterance, or there is no VAD to hear it: a recogniser that
   * costs money while it is open opens now rather than at the utterance's first frame. Called
   * at most once.
   */
  heard?(): void;
  /** How the utterance was transcribed, for the turn's log line, once `final` settled. */
  readonly how?: { route?: string; live?: boolean };
  /** Drains what is left and returns the whole utterance, empty when there was no speech. */
  final(): Promise<string>;
  reset(): void;
  dispose(): void;
}

export interface SttEngine {
  /** The most seconds one utterance may last; no limit when absent. */
  readonly maxSeconds?: number;
  stream(opts?: { language?: string }): SttStream;
  close(): void | Promise<void>;
}

/** What a live transcription says it heard in the end, or why it stopped hearing early. */
export interface LiveResult {
  text: string;
  stopped?: VoiceStopped;
}

/**
 * One utterance transcribed as it is spoken, on one route: the account's server, or the
 * vendor with the user's own key. It is opened when the utterance has speech in it; `ready`
 * settles once the route hears, with the most seconds it will, and rejects with the route's
 * refusal. Audio then goes as it comes; the words come back through `onText`, a `final` one
 * being a finished stretch that is kept and the others the stretch in progress.
 */
export interface LiveSession {
  readonly ready: Promise<{ maxSeconds: number }>;
  /** False when the audio could not be sent: the session is failing. */
  send(pcm: Int16Array): boolean;
  /** The utterance is over: the whole transcript once the last words are in. */
  end(): Promise<LiveResult>;
  onText?: (text: string, final: boolean) => void;
  /** The route ended the session before `end`: a stop at its limit with the text so far, or a failure. */
  onEnded?: (outcome: LiveResult | { error: RpcError }) => void;
  /** Bytes queued toward the route and not yet gone. */
  buffered?(): number;
  /** Dropped: nothing more is sent, and nothing is waited for. */
  abort(): void;
}

/** Opens a live session on one route. */
export type LiveOpener = (opts: { language?: string; vocabulary?: string[] }) => LiveSession;

export interface TtsEngine {
  readonly name: string;
  readonly sampleRate: number;
  /** How many voices the model has, for an engine that has a choice of them. */
  readonly voices?: number;
  /** The voice that speaks now, among `voices`. */
  readonly voice?: number;
  /** Another of the model's voices, from the next line on; the model's own default for `undefined`. */
  useVoice?(voice: number | undefined): void;
  /** One chunk per sentence, so the first words leave before the rest is synthesised. */
  synth(text: string, opts?: { signal?: AbortSignal }): AsyncIterable<Int16Array>;
  close(): void | Promise<void>;
}

export type StageStatus = "off" | "uninstalled" | "unavailable" | "loading" | "ready" | "failed";

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

/** Where an install of a local speech engine is: its runtime or a model, and the bytes come of all it fetches. */
export interface SpeechInstallProgress {
  step: "runtime" | "model";
  what: string;
  done: number;
  total: number;
}

/**
 * The local speech engines this machine installs when its user asks: whether one is here,
 * what installing it would still fetch, and the install itself. The daemon never calls
 * `install` on its own.
 */
export interface SpeechInstaller {
  installed(engine: string): boolean;
  pendingBytes(engine: string): number;
  install(engine: string, onProgress: (p: SpeechInstallProgress) => void): Promise<void>;
}

/** How a stage's engine is made: `check` loads it once to see that it does, rather than trusting what is installed. */
export interface EngineLoadOptions {
  check?: boolean;
}

/** How the voice module builds its engines; `fake.ts` is the other implementation. */
export interface EngineFactory {
  /** Installs the local speech engines; none on a factory whose engines need no install. */
  readonly speech?: SpeechInstaller;
  /** The model names this configuration needs, so they are fetched before a stage loads. */
  models(config: VoiceConfig): string[];
  /** Loads the heads `config.wake_model` names; never called with none. */
  wake(dir: string, config: VoiceConfig): Promise<WakeModel>;
  /** Every head the wake model has, at the numbers `config` would run it at, for the app to pick from; read, not loaded. */
  wakeHeads?(dir: string, config: VoiceConfig): WakeHeadInfo[];
  /** `maxSpeechMs` closes an utterance the wake word began that goes on that long: the recogniser's own limit. */
  vad(dir: string, config: VoiceConfig, opts?: { maxSpeechMs?: number }): Promise<() => VadEngine>;
  stt(dir: string, config: VoiceConfig, opts?: EngineLoadOptions): Promise<SttEngine>;
  tts(dir: string | undefined, config: VoiceConfig, sidecars: Sidecars, opts?: EngineLoadOptions): Promise<TtsEngine>;
  /**
   * A turn began (`true`) or every turn is over (`false`). A factory whose engines run in a
   * process of their own starts it for the turn and ends it after.
   */
  turn?(busy: boolean): void;
  /** The stage no longer uses one of this factory's engines. */
  unload?(stage: "stt" | "tts"): void;
  /** Told when an engine fails to load where no call was waiting on it, and when it loads again. */
  watch?(on: (stage: "stt" | "tts", engine: string, failure: string | undefined) => void): void;
  close?(): void | Promise<void>;
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
