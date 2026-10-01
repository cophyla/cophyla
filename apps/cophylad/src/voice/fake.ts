// Engines for the tests: the whole pipeline with no model files and no native code, so the
// conversation logic, the fan-out and the plumbing to the brain can be exercised in
// milliseconds. A frame carrying `WAKE_MARKER` fires the wake word; a frame of zeros is
// silence the VAD counts towards the end of an utterance; anything else is speech the
// recogniser turns into the next word of a fixed transcript. Speech out is a ramp, one
// chunk per sentence, and every line spoken is kept for the test to read.

import type { VoiceConfig } from "../config/schema.ts";
import type { Sidecars } from "../sidecars/index.ts";
import type { EngineFactory, EngineLoadOptions, SpeechInstaller, SpeechInstallProgress, SttEngine, SttStream, TtsEngine, VadEngine, WakeEngine, WakeHeadInfo, WakeModel } from "./engines.ts";
import { FRAME, IN_RATE, OUT_RATE } from "./engines.ts";
import { phraseOf } from "./openwakeword.ts";

/** A sample value no real microphone produces, so a test can fire the wake word by hand. */
export const WAKE_MARKER = 31337;

export function wakeChunk(): Int16Array {
  const pcm = new Int16Array(FRAME);
  pcm[0] = WAKE_MARKER;
  return pcm;
}

export function speechChunk(level = 1000): Int16Array {
  const pcm = new Int16Array(FRAME);
  for (let i = 0; i < pcm.length; i++) pcm[i] = level;
  return pcm;
}

export function silenceChunk(): Int16Array {
  return new Int16Array(FRAME);
}

/** A frame as it rides the wire: base64 of the little-endian int16 samples. */
export function b64(pcm: Int16Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
}

export interface FakeOptions {
  /** What every utterance transcribes to. */
  transcript?: string;
  /** Speech frames per word of the transcript. */
  wordsPerChunk?: number;
  /** Silence that closes an utterance. */
  minSilenceMs?: number;
  /** How long one spoken sentence lasts, for the playback estimate. */
  msPerSentence?: number;
  /** How long a sentence takes to synthesise, as a real engine does; 0 is instant. */
  synthDelayMs?: number;
  /** The most seconds the recogniser hears of an utterance; no limit when absent. */
  maxSeconds?: number;
}

const isWake = (pcm: Int16Array) => pcm.some((v) => v === WAKE_MARKER);
const isSpeech = (pcm: Int16Array) => pcm.some((v) => v !== 0 && v !== WAKE_MARKER);

export class FakeEngines implements EngineFactory {
  readonly opts: Required<Omit<FakeOptions, "maxSeconds">> & Pick<FakeOptions, "maxSeconds">;
  /** Every line handed to the speech engine, in order. */
  readonly spoken: string[] = [];
  /** How many syntheses were cut short. */
  aborted = 0;
  /** Set per test to make a stage fail to load. */
  failStage?: "wake" | "stt" | "tts";
  /** Set per test to hold a stage in `loading` until the promise settles. */
  hold: Partial<Record<"wake" | "stt" | "tts", Promise<unknown>>> = {};
  /** The heads the fake wake model has, for the app to pick from; the configured ones when unset. */
  wakeCatalog?: string[];
  /** The heads each wake load listened with, in order, and how many models were closed. */
  readonly wakeLoads: string[][] = [];
  wakeClosed = 0;
  /** The speech engines loaded, by the name the configuration gave, with the voice each started in; and how many were closed. */
  readonly ttsLoads: { engine: string; voice?: number }[] = [];
  ttsClosed = 0;
  /** The local engines this fake machine has not installed; every one is, unless a test says otherwise. */
  readonly notInstalled = new Set<string>();
  /** The installs asked for, in order; hold one open with `holdInstall`, fail one with `failInstall`. */
  readonly installs: string[] = [];
  holdInstall?: Promise<unknown>;
  failInstall?: string;
  /** The installer the voice module sees: instant, with a runtime step and a model step. */
  readonly speech: SpeechInstaller = {
    installed: (engine) => !this.notInstalled.has(engine),
    pendingBytes: (engine) => (this.notInstalled.has(engine) ? 1000 : 0),
    install: async (engine: string, onProgress: (p: SpeechInstallProgress) => void) => {
      this.installs.push(engine);
      onProgress({ step: "runtime", what: "sherpa-onnx", done: 0, total: 1000 });
      await this.holdInstall;
      if (this.failInstall) throw new Error(this.failInstall);
      onProgress({ step: "model", what: engine, done: 1000, total: 1000 });
      this.notInstalled.delete(engine);
    },
  };
  /** How many utterances the recogniser was asked to drain. */
  finals = 0;
  /** Every `turn` the voice module told, in order: what would hold the speech process and let it go. */
  readonly turns: boolean[] = [];
  /** The stages unloaded, and the loads asked to check their engine. */
  readonly unloads: ("stt" | "tts")[] = [];
  readonly checks: ("stt" | "tts")[] = [];

  turn(busy: boolean): void {
    if (this.turns[this.turns.length - 1] !== busy) this.turns.push(busy);
  }

  unload(stage: "stt" | "tts"): void {
    this.unloads.push(stage);
  }

  constructor(opts: FakeOptions = {}) {
    this.opts = {
      transcript: opts.transcript ?? "what time is the meeting tomorrow afternoon",
      wordsPerChunk: opts.wordsPerChunk ?? 1,
      minSilenceMs: opts.minSilenceMs ?? 400,
      msPerSentence: opts.msPerSentence ?? 40,
      synthDelayMs: opts.synthDelayMs ?? 0,
      ...(opts.maxSeconds !== undefined ? { maxSeconds: opts.maxSeconds } : {}),
    };
  }

  models(): string[] {
    return [];
  }

  async wake(_dir: string, config: VoiceConfig): Promise<WakeModel> {
    await this.hold.wake;
    if (this.failStage === "wake") throw new Error("fake wake failure");
    const heads = this.headInfo(config.wake_model, config);
    this.wakeLoads.push(heads.map((h) => h.name));
    const first = heads[0]!.name;
    return {
      heads,
      stream: (): WakeEngine => ({
        feed: async (pcm) => (isWake(pcm) ? { fired: true, score: 1, head: first } : { fired: false, score: 0 }),
        reset: () => {},
      }),
      close: () => {
        this.wakeClosed++;
      },
    };
  }

  wakeHeads(_dir: string, config: VoiceConfig): WakeHeadInfo[] {
    return this.headInfo(this.wakeCatalog ?? config.wake_model, config);
  }

  private headInfo(names: readonly string[], config: VoiceConfig): WakeHeadInfo[] {
    const threshold = (name: string) => (typeof config.wake_threshold === "number" ? config.wake_threshold : (config.wake_threshold?.[name] ?? 0.7));
    return names.map((name) => ({ name, threshold: threshold(name), patience: 1, scale: config.wake_scale ?? ("int16" as const), phrase: phraseOf(name) }));
  }

  async vad(): Promise<() => VadEngine> {
    const frameMs = (FRAME / IN_RATE) * 1000;
    return () => {
      let silent = 0;
      let heard = false;
      // Since the last reset, as `VadEngine.heard` is; `heard` above is since the last close.
      let latched = false;
      return {
        get heard() {
          return latched;
        },
        feed: (pcm) => {
          if (isSpeech(pcm)) {
            heard = true;
            latched = true;
            silent = 0;
            return false;
          }
          if (!heard) return false;
          silent += frameMs;
          if (silent >= this.opts.minSilenceMs) {
            silent = 0;
            heard = false;
            return true;
          }
          return false;
        },
        reset: () => {
          silent = 0;
          heard = false;
          latched = false;
        },
        close: () => {},
      };
    };
  }

  async stt(_dir?: string, _config?: VoiceConfig, opts?: EngineLoadOptions): Promise<SttEngine> {
    if (opts?.check) this.checks.push("stt");
    await this.hold.stt;
    if (this.failStage === "stt") throw new Error("fake stt failure");
    const words = this.opts.transcript.split(/\s+/).filter(Boolean);
    const perWord = Math.max(1, this.opts.wordsPerChunk);
    return {
      ...(this.opts.maxSeconds !== undefined ? { maxSeconds: this.opts.maxSeconds } : {}),
      stream: (): SttStream => {
        let chunks = 0;
        let shown = 0;
        const self: SttStream = {
          accept: (pcm) => {
            if (!isSpeech(pcm)) return;
            chunks++;
            const next = Math.min(words.length, Math.ceil(chunks / perWord));
            if (next > shown) {
              shown = next;
              self.onPartial?.(words.slice(0, shown).join(" "));
            }
          },
          final: async () => {
            this.finals++;
            const text = chunks > 0 ? this.opts.transcript : "";
            chunks = 0;
            shown = 0;
            return text;
          },
          reset: () => {
            chunks = 0;
            shown = 0;
          },
          dispose: () => {},
        };
        return self;
      },
      close: () => {},
    };
  }

  async tts(_dir: string | undefined, config: VoiceConfig, _sidecars: Sidecars, opts?: EngineLoadOptions): Promise<TtsEngine> {
    if (opts?.check) this.checks.push("tts");
    const hold = this.hold.tts;
    await hold;
    if (this.failStage === "tts") throw new Error("fake tts failure");
    this.ttsLoads.push({ engine: config.tts, ...(config.tts_voice !== undefined ? { voice: config.tts_voice } : {}) });
    const engine = this;
    // Named after the engine it stands in for, with four voices and the first by default.
    return {
      name: config.tts,
      sampleRate: OUT_RATE,
      voices: 4,
      voice: config.tts_voice ?? 0,
      useVoice(voice) {
        (this as { voice?: number }).voice = voice ?? 0;
      },
      synth(text, opts = {}) {
        engine.spoken.push(text);
        const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
        const samples = Math.max(1, Math.round((OUT_RATE * engine.opts.msPerSentence) / 1000));
        return {
          async *[Symbol.asyncIterator]() {
            for (const _ of sentences.length > 0 ? sentences : [text]) {
              // A real engine takes time per sentence, which is what makes a barge-in cut one short.
              if (engine.opts.synthDelayMs > 0) await Bun.sleep(engine.opts.synthDelayMs);
              if (opts.signal?.aborted) {
                engine.aborted++;
                return;
              }
              // A ramp, so a test can tell one chunk from the next.
              const chunk = new Int16Array(samples);
              for (let i = 0; i < samples; i++) chunk[i] = ((i * 7) % 2000) - 1000;
              yield chunk;
              await Promise.resolve();
            }
          },
        };
      },
      close: () => {
        engine.ttsClosed++;
      },
    };
  }
}
