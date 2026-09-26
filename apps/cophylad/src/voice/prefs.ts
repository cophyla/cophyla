// The voice settings the app sets over config.toml (`voice.configure`): the engine that
// speaks, and a voice for each engine one was picked for. They are this node's own, like its
// profiles: kept in the store's kv under `voice`, which replication leaves out, since each
// machine speaks with its own models.

import type { TtsEngineId } from "@cophyla/protocol";
import { TtsEngineId as TtsEngineIdSchema } from "@cophyla/protocol";
import type { Store } from "../store/index.ts";

export const VOICE_KV_NS = "voice";
const KEY = "prefs";

/** What the app set over config.toml: the engine, and a voice for each engine it was set for. */
export interface VoicePrefs {
  tts?: TtsEngineId;
  voices?: Partial<Record<TtsEngineId, number>>;
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
      const raw = store.kv.get(VOICE_KV_NS, KEY) as { tts?: unknown; voices?: unknown } | undefined;
      if (!raw || typeof raw !== "object") return {};
      const out: VoicePrefs = {};
      const tts = TtsEngineIdSchema.safeParse(raw.tts);
      if (tts.success) out.tts = tts.data;
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
      if (prefs.tts === undefined && prefs.voices === undefined) store.kv.delete(VOICE_KV_NS, KEY);
      else store.kv.put(VOICE_KV_NS, KEY, prefs);
    },
  };
}
