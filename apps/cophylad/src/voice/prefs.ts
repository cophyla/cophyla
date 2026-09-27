// The voice settings the app sets over config.toml (`voice.configure`): the engine that
// speaks, a voice for each engine one was picked for, how fast replies are read, and the
// engine that transcribes. They are this node's own, like its
// profiles: kept in the store's kv under `voice`, which replication leaves out, since each
// machine speaks with its own models.

import type { SttEngineId, TtsEngineId } from "@cophyla/protocol";
import { SpeechSpeed, SttEngineId as SttEngineIdSchema, TtsEngineId as TtsEngineIdSchema } from "@cophyla/protocol";
import type { Store } from "../store/index.ts";

export const VOICE_KV_NS = "voice";
const KEY = "prefs";

/** What the app set over config.toml: the engine that speaks, a voice for each engine one was set for, the speed, and the engine that transcribes. */
export interface VoicePrefs {
  tts?: TtsEngineId;
  voices?: Partial<Record<TtsEngineId, number>>;
  /** How fast every engine's replies are read; absent at the engines' own pace. */
  speed?: number;
  stt?: SttEngineId;
}

/** Where the app's picks are kept. */
export interface VoicePrefsStore {
  read(): VoicePrefs;
  write(prefs: VoicePrefs): void;
}

/** The picks in the store; a row that no longer parses (an engine since removed) reads as none. */
export function storePrefs(store: Pick<Store, "kv">): VoicePrefsStore {
  return {
    read(): VoicePrefs {
      const raw = store.kv.get(VOICE_KV_NS, KEY) as { tts?: unknown; voices?: unknown; speed?: unknown } | undefined;
      if (!raw || typeof raw !== "object") return {};
      const out: VoicePrefs = {};
      const tts = TtsEngineIdSchema.safeParse(raw.tts);
      if (tts.success) out.tts = tts.data;
      const stt = SttEngineIdSchema.safeParse((raw as { stt?: unknown }).stt);
      if (stt.success) out.stt = stt.data;
      const speed = SpeechSpeed.safeParse(raw.speed);
      if (speed.success && speed.data !== 1) out.speed = speed.data;
      if (raw.voices && typeof raw.voices === "object") {
        const voices: Partial<Record<TtsEngineId, number>> = {};
        for (const [engine, voice] of Object.entries(raw.voices as Record<string, unknown>)) {
          const id = TtsEngineIdSchema.safeParse(engine);
          if (id.success && typeof voice === "number" && Number.isInteger(voice) && voice >= 0) voices[id.data] = voice;
        }
        if (Object.keys(voices).length > 0) out.voices = voices;
      }
      return out;
    },
    write(prefs: VoicePrefs): void {
      if (prefs.tts === undefined && prefs.voices === undefined && prefs.speed === undefined && prefs.stt === undefined) store.kv.delete(VOICE_KV_NS, KEY);
      else store.kv.put(VOICE_KV_NS, KEY, prefs);
    },
  };
}
