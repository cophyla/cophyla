// The engines that run on this machine, built from the model directories the feed unpacked or
// the user installed. The wake word and the VAD run in the daemon, on onnxruntime-node: they
// are small, and the wake word listens all the time. The transcription and speech engines run
// in the speech process (`speech-process.ts`), which exists only while a turn needs it, so
// what this factory hands the voice module for them are stand-ins that start it.
//
// One job beyond wiring: before the first engine loads, the daemon pins itself to the
// performance cores on a hybrid CPU, because everything below this line is inference and
// Windows will otherwise put some of it on the efficiency cores, where it runs three times
// slower (spike 10). The pin is applied once and inherited by every process it starts.

import { join } from "node:path";
import type { VoiceConfig } from "../config/schema.ts";
import type { Logger } from "../log.ts";
import type { Sidecars } from "../sidecars/index.ts";
import { applyProcessAffinity } from "./affinity.ts";
import { chatterboxEngine } from "./chatterbox.ts";
import type { EngineFactory, EngineLoadOptions, SttEngine, TtsEngine, VadEngine, WakeHeadInfo, WakeModel } from "./engines.ts";
import { allWakeHeads, OpenWakeWord } from "./openwakeword.ts";
import { speechEngine } from "./catalog.ts";
import type { SpeechInstaller } from "./engines.ts";
import { installEngine, modelInstalled, pendingBytes, runtimeInstalled } from "./install.ts";
import type { InstallOptions } from "./install.ts";
import { readVoiceManifest } from "./manifest.ts";
import { ensureNospinConfig, sherpaAvailable, useSherpaFrom } from "./runtime.ts";
import { SpeechProcess } from "./speech-process.ts";
import type { SpawnWorker, SpeechStage } from "./speech-process.ts";
import type { SherpaTtsEngine } from "./sherpa-tts.ts";
import { loadSilero } from "./silero.ts";

/** The model names the feed ships, one release each. */
export const WAKE_MODEL = "wake-openwakeword";
export const VAD_MODEL = "vad-silero";
/** The model each local transcription engine reads. */
export const STT_MODELS = {
  "moonshine-tiny": "stt-moonshine-tiny-en",
  "moonshine-base": "stt-moonshine-base-en",
  "whisper-base": "stt-whisper-base",
  nemotron: "stt-nemotron-3.5-streaming-int8",
} as const;
export type LocalSttEngine = keyof typeof STT_MODELS;
/** Nemotron's, the recogniser there was first. */
export const STT_MODEL = STT_MODELS.nemotron;
/** The most one utterance may last on Moonshine or Whisper, which read it whole: Whisper hears 30 s (`sherpa-stt.ts`). */
export const OFFLINE_MAX_SECONDS = 30;
/** The model each local speech engine speaks with. */
export const TTS_MODELS: Record<SherpaTtsEngine, string> = {
  piper: "tts-piper-en",
  kokoro: "tts-kokoro-en",
  supertonic: "tts-supertonic-3",
};

/** The speech engines that run in the speech process on a model of their own, as opposed to a sidecar or a route. */
export function sherpaEngine(tts: string): SherpaTtsEngine | undefined {
  return Object.hasOwn(TTS_MODELS, tts) ? (tts as SherpaTtsEngine) : undefined;
}

/** The transcription engines that run in the speech process. */
export function localSttEngine(stt: string): LocalSttEngine | undefined {
  return Object.hasOwn(STT_MODELS, stt) ? (stt as LocalSttEngine) : undefined;
}

export interface LocalEnginesDeps {
  /** `<home>/data`, where the ORT session config is written. */
  dataDir: string;
  log: Logger;
  /** The mask to pin to before the first load, when the config asked for one. */
  affinity?: bigint;
  /** The Chatterbox sidecar's bootstrap, built by the daemon; absent means the stage cannot come up. */
  ttsPy?: { ensure(): Promise<import("../sidecars/index.ts").Sidecar> };
  /**
   * `[voice] models_dir`: a checkout developing against local model folders, whose own
   * node_modules copy of sherpa-onnx stands in for an installed runtime.
   */
  modelsDir?: string;
  /** Where installs download from, for tests. */
  install?: Pick<InstallOptions, "fetch" | "registry" | "tar">;
  /** How the speech process is started, for tests. */
  spawn?: SpawnWorker;
}

/**
 * The local speech engines on this machine: an engine is here when sherpa-onnx is and every
 * model it loads is, installed under `data/voice/` or, while developing, in `models_dir`.
 */
export function localSpeech(deps: Pick<LocalEnginesDeps, "dataDir" | "modelsDir" | "install">): SpeechInstaller {
  const modelHere = (name: string) => modelInstalled(deps.dataDir, name) || (deps.modelsDir !== undefined && readVoiceManifest(join(deps.modelsDir, name)) !== undefined);
  const spec = (engine: string) => {
    const s = speechEngine(engine);
    if (!s) throw new Error(`${engine} is not a speech engine this machine installs`);
    return s;
  };
  return {
    installed: (engine) => {
      const s = speechEngine(engine);
      return !s || (sherpaAvailable() && s.models.every(modelHere));
    },
    pendingBytes: (engine) => {
      const s = speechEngine(engine);
      if (!s) return 0;
      const missing = { ...s, models: s.models.filter((m) => !modelHere(m)) };
      return pendingBytes(deps.dataDir, missing, sherpaAvailable() || runtimeInstalled(deps.dataDir));
    },
    install: (engine, onProgress) => {
      const s = spec(engine);
      const missing = { ...s, models: s.models.filter((m) => !modelHere(m)) };
      return installEngine(deps.dataDir, missing, { ...deps.install, onProgress }, sherpaAvailable());
    },
  };
}

export interface LocalEngines extends EngineFactory {
  /** The speech process, for the tests and the live check. */
  readonly process: SpeechProcess;
}

export function localEngines(deps: LocalEnginesDeps): LocalEngines {
  const dev = deps.modelsDir !== undefined;
  useSherpaFrom({ dataDir: deps.dataDir, dev });
  const speech = localSpeech(deps);
  let pinned = false;
  const pin = () => {
    if (pinned || deps.affinity === undefined) return;
    pinned = true;
    applyProcessAffinity(deps.affinity, deps.log);
  };
  const nospin = () => ensureNospinConfig(deps.dataDir);
  let watcher: ((stage: SpeechStage, engine: string, failure: string | undefined) => void) | undefined;
  const proc = new SpeechProcess({
    dataDir: deps.dataDir,
    dev,
    nospin,
    log: deps.log.child("speech"),
    ...(deps.affinity !== undefined ? { affinity: deps.affinity } : {}),
    ...(deps.spawn ? { spawn: deps.spawn } : {}),
    onStage: (stage, engine, failure) => watcher?.(stage, engine, failure),
  });
  const checked = async (stage: SpeechStage, opts: EngineLoadOptions | undefined) => {
    if (!opts?.check) return;
    const failure = await proc.probe(stage);
    if (failure) throw new Error(failure);
  };

  return {
    speech,
    process: proc,

    models(config: VoiceConfig): string[] {
      const names: string[] = [];
      if (config.wake !== "off") names.push(WAKE_MODEL);
      // The VAD is local on every recogniser; the recogniser's own model only for a local one.
      if (config.stt !== "off") names.push(VAD_MODEL);
      const stt = localSttEngine(config.stt);
      if (stt) names.push(STT_MODELS[stt]);
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
      deps.log.info("wake phrases", { heads: model.heads.map((h) => `${h.phrase}${h.sound ? ` (${h.sound})` : ""} at ${h.threshold}${h.patience > 1 ? ` x${h.patience}` : ""}`) });
      return model;
    },

    wakeHeads(dir: string, config: VoiceConfig): WakeHeadInfo[] {
      const manifest = readVoiceManifest(dir);
      if (!manifest) return [];
      return allWakeHeads(manifest, {
        ...(config.wake_threshold !== undefined ? { threshold: config.wake_threshold } : {}),
        ...(config.wake_scale ? { scale: config.wake_scale } : {}),
      });
    },

    async vad(dir: string, config: VoiceConfig, opts?: { maxSpeechMs?: number }): Promise<() => VadEngine> {
      pin();
      return loadSilero(dir, { minSilenceMs: config.vad_min_silence_ms, ...(opts?.maxSpeechMs !== undefined ? { maxSpeechMs: opts.maxSpeechMs } : {}) });
    },

    async stt(dir: string, config: VoiceConfig, opts?: EngineLoadOptions): Promise<SttEngine> {
      pin();
      const engine = localSttEngine(config.stt);
      if (!engine) throw new Error(`no local transcription engine is called ${config.stt}`);
      proc.set("stt", { engine, dir, threads: config.stt_threads, ...(config.stt_language ? { language: config.stt_language } : {}) });
      await checked("stt", opts);
      // Moonshine and Whisper read an utterance whole and hear 30 s of it; Nemotron decodes as it goes.
      return engine === "nemotron" ? proc.sttEngine() : { ...proc.sttEngine(), maxSeconds: OFFLINE_MAX_SECONDS };
    },

    async tts(dir: string | undefined, config: VoiceConfig, _sidecars: Sidecars, opts?: EngineLoadOptions): Promise<TtsEngine> {
      pin();
      if (config.tts === "chatterbox") {
        proc.set("tts", undefined);
        if (!deps.ttsPy) throw new Error("the speech sidecar is not configured on this node");
        // The bootstrap is minutes on a first run: `voice.setup` reports every step of it.
        const sidecar = await deps.ttsPy.ensure();
        return chatterboxEngine(sidecar);
      }
      const speech = sherpaEngine(config.tts);
      if (!speech) throw new Error(`no local speech engine is called ${config.tts}`);
      if (!dir) throw new Error(`no ${speech} model directory`);
      const spec = { engine: speech, dir, threads: config.tts_threads, ...(config.tts_voice !== undefined ? { voice: config.tts_voice } : {}) };
      proc.set("tts", spec);
      await checked("tts", opts);
      return proc.ttsEngine(spec);
    },

    turn: (busy) => proc.hold(busy),
    unload: (stage) => {
      if (stage === "stt") proc.set("stt", undefined);
      else proc.set("tts", undefined);
    },
    watch: (on) => {
      watcher = on;
    },
    close: () => proc.close(),
  };
}
