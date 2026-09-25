// Engines for the tests: the whole pipeline with no model files and no native code, so the
// conversation logic, the fan-out and the plumbing to the brain can be exercised in
// milliseconds. A frame carrying `WAKE_MARKER` fires the wake word; a frame of zeros is
// silence the VAD counts towards the end of an utterance; anything else is speech the
// recogniser turns into the next word of a fixed transcript. Speech out is a ramp, one
// chunk per sentence, and every line spoken is kept for the test to read.

import type { VoiceConfig } from "../config/schema.ts";
import type { Sidecars } from "../sidecars/index.ts";
import type { EngineFactory, SttEngine, SttStream, TtsEngine, VadEngine, WakeEngine, WakeModel } from "./engines.ts";
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
}

const isWake = (pcm: Int16Array) => pcm.some((v) => v === WAKE_MARKER);
const isSpeech = (pcm: Int16Array) => pcm.some((v) => v !== 0 && v !== WAKE_MARKER);

export class FakeEngines implements EngineFactory {
  readonly opts: Required<FakeOptions>;
  /** Every line handed to the speech engine, in order. */
  readonly spoken: string[] = [];
  /** How many syntheses were cut short. */
  aborted = 0;
  /** Set per test to make a stage fail to load. */
  failStage?: "wake" | "stt" | "tts";
  /** Set per test to hold a stage in `loading` until the promise settles. */
  hold: Partial<Record<"wake" | "stt", Promise<unknown>>> = {};
  /** How many utterances the recogniser was asked to drain. */
  finals = 0;

  constructor(opts: FakeOptions = {}) {
    this.opts = {
      transcript: opts.transcript ?? "what time is the meeting tomorrow afternoon",
      wordsPerChunk: opts.wordsPerChunk ?? 1,
      minSilenceMs: opts.minSilenceMs ?? 400,
      msPerSentence: opts.msPerSentence ?? 40,
      synthDelayMs: opts.synthDelayMs ?? 0,
    };
  }

  models(): string[] {
    return [];
  }

  async wake(_dir: string, config: VoiceConfig): Promise<WakeModel> {
    await this.hold.wake;
    if (this.failStage === "wake") throw new Error("fake wake failure");
    const threshold = (name: string) => (typeof config.wake_threshold === "number" ? config.wake_threshold : (config.wake_threshold?.[name] ?? 0.7));
    const heads = config.wake_model.map((name) => ({ name, threshold: threshold(name), scale: config.wake_scale ?? ("int16" as const), phrase: phraseOf(name) }));
    const first = heads[0]!.name;
    return {
      heads,
      stream: (): WakeEngine => ({
        feed: async (pcm) => (isWake(pcm) ? { fired: true, score: 1, head: first } : { fired: false, score: 0 }),
        reset: () => {},
      }),
      close: () => {},
    };
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

  async stt(): Promise<SttEngine> {
    await this.hold.stt;
    if (this.failStage === "stt") throw new Error("fake stt failure");
    const words = this.opts.transcript.split(/\s+/).filter(Boolean);
    const perWord = Math.max(1, this.opts.wordsPerChunk);
    return {
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

  async tts(_dir: string | undefined, _config: VoiceConfig, _sidecars: Sidecars): Promise<TtsEngine> {
    if (this.failStage === "tts") throw new Error("fake tts failure");
    const engine = this;
    return {
      name: "fake",
      sampleRate: OUT_RATE,
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
      close: () => {},
    };
  }
}
