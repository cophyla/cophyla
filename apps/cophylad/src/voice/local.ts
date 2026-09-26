// The engines that run on this machine, built from the model directories the feed unpacked.
// One job beyond wiring: before the first engine loads, the daemon pins itself to the
// performance cores on a hybrid CPU, because everything below this line is inference and
// Windows will otherwise put some of it on the efficiency cores, where it runs three times
// slower (spike 10). The pin is applied once and inherited by every sidecar.

import type { VoiceConfig } from "../config/schema.ts";
import type { Logger } from "../log.ts";
import type { Sidecars } from "../sidecars/index.ts";
import { applyProcessAffinity } from "./affinity.ts";
import { chatterboxEngine } from "./chatterbox.ts";
import type { EngineFactory, SttEngine, TtsEngine, VadEngine, WakeModel } from "./engines.ts";
import { loadNemotron } from "./nemotron.ts";
import { OpenWakeWord } from "./openwakeword.ts";
import { ensureNospinConfig } from "./runtime.ts";
import { loadSherpaTts } from "./sherpa-tts.ts";
import type { SherpaTtsEngine } from "./sherpa-tts.ts";
import { loadSilero } from "./silero.ts";

/** The model names the feed ships, one release each. */
export const WAKE_MODEL = "wake-openwakeword";
export const VAD_MODEL = "vad-silero";
export const STT_MODEL = "stt-nemotron-3.5-streaming-int8";
/** The model each in-process speech engine speaks with. */
export const TTS_MODELS: Record<SherpaTtsEngine, string> = {
  piper: "tts-piper-en",
  kokoro: "tts-kokoro-en",
  supertonic: "tts-supertonic-3",
};

/** The engines that run in-process on a model of the feed's, as opposed to a sidecar or the server. */
export function sherpaEngine(tts: string): SherpaTtsEngine | undefined {
  return Object.hasOwn(TTS_MODELS, tts) ? (tts as SherpaTtsEngine) : undefined;
}

export interface LocalEnginesDeps {
  /** `<home>/data`, where the ORT session config is written. */
  dataDir: string;
  log: Logger;
  /** The mask to pin to before the first load, when the config asked for one. */
  affinity?: bigint;
  /** The Chatterbox sidecar's bootstrap, built by the daemon; absent means the stage cannot come up. */
  ttsPy?: { ensure(): Promise<import("../sidecars/index.ts").Sidecar> };
}

export function localEngines(deps: LocalEnginesDeps): EngineFactory {
  let pinned = false;
  const pin = () => {
    if (pinned || deps.affinity === undefined) return;
    pinned = true;
    applyProcessAffinity(deps.affinity, deps.log);
  };
  const nospin = () => ensureNospinConfig(deps.dataDir);

  return {
    models(config: VoiceConfig): string[] {
      const names: string[] = [];
      if (config.wake !== "off") names.push(WAKE_MODEL);
      // The VAD is local on every recogniser; the recogniser's own model only for the local one.
      if (config.stt !== "off") names.push(VAD_MODEL);
      if (config.stt === "nemotron") names.push(STT_MODEL);
      const speech = sherpaEngine(config.tts);
      if (speech) names.push(TTS_MODELS[speech]);
      return names;
    },

    async wake(dir: string, config: VoiceConfig): Promise<WakeModel> {
      pin();
      const model = await OpenWakeWord.load(dir, {
        heads: config.wake_model,
        ...(config.wake_threshold !== undefined ? { threshold: config.wake_threshold } : {}),
        ...(config.wake_scale ? { scale: config.wake_scale } : {}),
      });
      if (model.missing.length > 0) deps.log.warn("wake heads the model does not have are skipped", { missing: model.missing, dir });
      deps.log.info("wake phrases", { heads: model.heads.map((h) => `${h.phrase} (${h.threshold})`) });
      return model;
    },

    async vad(dir: string, config: VoiceConfig): Promise<() => VadEngine> {
      pin();
      return loadSilero(dir, { minSilenceMs: config.vad_min_silence_ms, nospin: nospin() });
    },

    async stt(dir: string, config: VoiceConfig): Promise<SttEngine> {
      pin();
      return loadNemotron(dir, { threads: config.stt_threads, ...(config.stt_language ? { language: config.stt_language } : {}), nospin: nospin() });
    },

    async tts(dir: string | undefined, config: VoiceConfig, _sidecars: Sidecars): Promise<TtsEngine> {
      pin();
      if (config.tts === "chatterbox") {
        if (!deps.ttsPy) throw new Error("the speech sidecar is not configured on this node");
        // The bootstrap is minutes on a first run: `voice.setup` reports every step of it.
        const sidecar = await deps.ttsPy.ensure();
        return chatterboxEngine(sidecar);
      }
      const speech = sherpaEngine(config.tts);
      if (!speech) throw new Error(`no in-process speech engine is called ${config.tts}`);
      if (!dir) throw new Error(`no ${speech} model directory`);
      return loadSherpaTts(speech, dir, { threads: config.tts_threads, ...(config.tts_voice !== undefined ? { voice: config.tts_voice } : {}), nospin: nospin() });
    },
  };
}
