// What the voice stages can run on, and where each piece comes from. The wake word and the VAD
// are the platform's own: their models are releases in Cophyla's feed and they run on
// onnxruntime-node, which the platform ships. The speech engines are not. Transcription and
// speech on the node need sherpa-onnx, whose native library carries espeak-ng (GPL-3.0), and
// models under their own licences (OpenMDW, OpenRAIL-M, CC BY, espeak-ng's data), so Cophyla
// ships none of them: each engine is installed on this machine when its user asks, from where
// its makers publish it — the npm registry for the runtime, the k2-fsa releases and Hugging
// Face for the models — pinned by hash here, with the licences the app shows before it
// installs. A user who never installs one is bound by none of them.

/** One file fetched as it is, one archive unpacked into the model directory, or one of Cophyla's own from the repository. */
export type VoiceSource =
  | { kind: "file"; url: string; local: string; sha256?: string; bytes?: number }
  | { kind: "archive"; url: string; sha256?: string; strip?: number; drop?: string[]; bytes?: number }
  | { kind: "repo"; path: string; local: string; sha256: string };

export interface VoiceModelSpec {
  name: string;
  kind: "wake" | "vad" | "stt" | "tts";
  version: string;
  /** What the engine needs to know: which file is what, and the numbers beside them. */
  params: Record<string, unknown>;
  sources: VoiceSource[];
}

const OWW = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1";
const K2 = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

export const VOICE_MODELS: VoiceModelSpec[] = [
  {
    name: "wake-openwakeword",
    kind: "wake",
    version: "1.3.0",
    params: {
      scale: "int16",
      mel: "melspectrogram.onnx",
      embedding: "embedding_model.onnx",
      // The v0.2 heads hear the name as it is said now, ko-FILL-uh; the v0.1 ones its first
      // sound, ko-FY-la, for whoever still says it so. The app's Settings picks among them.
      heads: ["cophyla_v0.2.onnx", "hey_phyla_v0.2.onnx", "cophyla_v0.1.onnx", "hey_phyla_v0.1.onnx"],
      head_params: {
        "cophyla_v0.2.onnx": { threshold: 0.7, patience: 3, phrase: "Cophyla", sound: "ko-FILL-uh" },
        "hey_phyla_v0.2.onnx": { threshold: 0.8, patience: 3, phrase: "Hey Phyla", sound: "hey FILL-uh" },
        "cophyla_v0.1.onnx": { threshold: 0.7, phrase: "Cophyla", sound: "ko-FY-la" },
        "hey_phyla_v0.1.onnx": { threshold: 0.6, phrase: "Hey Phyla", sound: "hey FY-la" },
      },
    },
    sources: [
      { kind: "file", url: `${OWW}/melspectrogram.onnx`, local: "melspectrogram.onnx", sha256: "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f" },
      { kind: "file", url: `${OWW}/embedding_model.onnx`, local: "embedding_model.onnx", sha256: "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f" },
      // Cophyla's own heads (packages/wake/heads/README.md says how they were made).
      { kind: "repo", path: "packages/wake/heads/cophyla_v0.2.onnx", local: "cophyla_v0.2.onnx", sha256: "7575b45b89cf1b0f943921ccf349442dd61258d2cee064b863e42bd8de543fb7" },
      { kind: "repo", path: "packages/wake/heads/hey_phyla_v0.2.onnx", local: "hey_phyla_v0.2.onnx", sha256: "46fd0d8916cd8ed36d8d2f3e9ab11095c4f5ebcb33f3b396d565dfede7672490" },
      { kind: "repo", path: "packages/wake/heads/cophyla_v0.1.onnx", local: "cophyla_v0.1.onnx", sha256: "b08ab17c1ff81a3293c7e8d3c4623d9c9a3b0bacbb291311e7d7d2b9e8b984e9" },
      { kind: "repo", path: "packages/wake/heads/hey_phyla_v0.1.onnx", local: "hey_phyla_v0.1.onnx", sha256: "4ec1d76da29e8581bb8d1d48a453336a35752159403a144df16657e1975f8a36" },
    ],
  },
  {
    name: "vad-silero",
    kind: "vad",
    version: "1.0.0",
    params: { model: "silero_vad.onnx", windowSize: 512 },
    sources: [{ kind: "file", url: `${K2}/asr-models/silero_vad.onnx`, local: "silero_vad.onnx", sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6" }],
  },
  {
    name: "stt-nemotron-3.5-streaming-int8",
    kind: "stt",
    version: "1.0.0",
    params: { encoder: "encoder.int8.onnx", decoder: "decoder.int8.onnx", joiner: "joiner.int8.onnx", tokens: "tokens.txt", featureDim: 128, chunkMs: 560 },
    sources: [
      {
        kind: "archive",
        url: `${K2}/asr-models/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11.tar.bz2`,
        sha256: "c6bf5e0df765f9d5b43bc9e0536d4b4b3e7d40bdf5ecf13e45f134c51c05ae3a",
        bytes: 475271763,
        strip: 1,
        // The sample clips are a third of the archive and nothing loads them.
        drop: ["test_wavs"],
      },
    ],
  },
  {
    // Moonshine's second generation, English: the whole utterance at once, in a few tens of ms.
    name: "stt-moonshine-tiny-en",
    kind: "stt",
    version: "1.0.0",
    params: { recognizer: "moonshine", encoder: "encoder_model.ort", mergedDecoder: "decoder_model_merged.ort", tokens: "tokens.txt" },
    sources: [{ kind: "archive", url: `${K2}/asr-models/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2`, sha256: "9ec31b342d8fa3240c3b81b8f82e1cf7e3ac467c93ca5a999b741d5887164f8d", bytes: 29858559, strip: 1, drop: ["test_wavs"] }],
  },
  {
    name: "stt-moonshine-base-en",
    kind: "stt",
    version: "1.0.0",
    params: { recognizer: "moonshine", encoder: "encoder_model.ort", mergedDecoder: "decoder_model_merged.ort", tokens: "tokens.txt" },
    sources: [{ kind: "archive", url: `${K2}/asr-models/sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2`, sha256: "43232c1d13013d37317163baec3135bd771a186a4356f28c889bab453bb0e891", bytes: 111266225, strip: 1, drop: ["test_wavs"] }],
  },
  {
    // The int8 pair only: the archive's fp32 pair is twice the size and nothing loads it.
    name: "stt-whisper-base",
    kind: "stt",
    version: "1.0.0",
    params: { recognizer: "whisper", encoder: "base-encoder.int8.onnx", decoder: "base-decoder.int8.onnx", tokens: "base-tokens.txt" },
    sources: [
      {
        kind: "archive",
        url: `${K2}/asr-models/sherpa-onnx-whisper-base.tar.bz2`,
        sha256: "911b2083efd7c0dca2ac3b358b75222660dc09fb716d64fbfc417ba6c99ff3de",
        bytes: 207557382,
        strip: 1,
        drop: ["test_wavs", "base-encoder.onnx", "base-decoder.onnx"],
      },
    ],
  },
  {
    name: "tts-kokoro-en",
    kind: "tts",
    version: "1.0.0",
    params: { model: "model.onnx", voices: "voices.bin", tokens: "tokens.txt", dataDir: "espeak-ng-data", sampleRate: 24000 },
    sources: [{ kind: "archive", url: `${K2}/tts-models/kokoro-en-v0_19.tar.bz2`, sha256: "912804855a04745fa77a30be545b3f9a5d15c4d66db00b88cbcd4921df605ac7", bytes: 319625534, strip: 1 }],
  },
  {
    // The default voice: Piper's LibriTTS-R voice (MIT; the recordings CC BY 4.0, named in its MODEL_CARD), 904 speakers.
    name: "tts-piper-en",
    kind: "tts",
    version: "1.0.0",
    params: { model: "en_US-libritts_r-medium.onnx", tokens: "tokens.txt", dataDir: "espeak-ng-data", sampleRate: 22050, voice: 0 },
    sources: [{ kind: "archive", url: `${K2}/tts-models/vits-piper-en_US-libritts_r-medium.tar.bz2`, sha256: "10dc268f3e371696d721486123e2705a9fc1faa113491979fde4d88dba1f1b1c", bytes: 82038311, strip: 1 }],
  },
  {
    // 31 languages, 10 voices. Two flow steps rather than the model's five: twice as fast, and still clear.
    // The weights are OpenRAIL-M, whose use restrictions travel with them: MODEL_LICENSE is that licence.
    name: "tts-supertonic-3",
    kind: "tts",
    version: "1.0.0",
    params: {
      durationPredictor: "duration_predictor.int8.onnx",
      textEncoder: "text_encoder.int8.onnx",
      vectorEstimator: "vector_estimator.int8.onnx",
      vocoder: "vocoder.int8.onnx",
      ttsJson: "tts.json",
      unicodeIndexer: "unicode_indexer.bin",
      voiceStyle: "voice.bin",
      sampleRate: 44100,
      numSteps: 2,
      voice: 0,
    },
    sources: [
      { kind: "archive", url: `${K2}/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2`, sha256: "82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427", bytes: 128774318, strip: 1 },
      {
        kind: "file",
        url: "https://huggingface.co/Supertone/supertonic-3/resolve/3cadd1ee6394adea1bd021217a0e650ede09a323/LICENSE",
        local: "MODEL_LICENSE",
        sha256: "0d944a9110fed9a9602d60e0423a272903e7bd21ab060490774efc77c2275e9f",
        bytes: 15007,
      },
    ],
  },
];

export function voiceModel(name: string): VoiceModelSpec | undefined {
  return VOICE_MODELS.find((m) => m.name === name);
}

/** A licence an engine comes under: what it covers, its name, where to read it. */
export interface Licence {
  covers: string;
  name: string;
  url: string;
}

/** One npm package of the runtime: its tarball and the integrity npm publishes for it. */
export interface RuntimePackage {
  name: string;
  url: string;
  integrity: string;
  bytes: number;
}

const NPM = "https://registry.npmjs.org";
const SHERPA_VERSION = "1.13.8";
const pkg = (name: string, integrity: string, bytes: number): RuntimePackage => ({ name, url: `${NPM}/${name}/-/${name}-${SHERPA_VERSION}.tgz`, integrity, bytes });

/** The native package each target loads, beside the JS one. */
const SHERPA_NATIVE: Record<string, RuntimePackage> = {
  "win32-x64": pkg("sherpa-onnx-win-x64", "sha512-oZF1c9VPOKtMwn83Bboc5XSWL+76BRoyB3eUuVnCknBKxwSULZU2Foia9VHWzU+n4I12rPsP6z6H9Rp1hD9o8g==", 8894875),
  "linux-x64": pkg("sherpa-onnx-linux-x64", "sha512-6plnhjagsSeTntCgnlag86hWbs/uZE9Crms1LgOb68/1nKsIQjMd+WG519m+aPwT6TrsBOiEMzrx41t8sL5L5g==", 11089653),
  "linux-arm64": pkg("sherpa-onnx-linux-arm64", "sha512-Tlg7a70b/Wge3OF8IgTHF9jhSVCsLyKQKhwc4BsJ5A+dL/SrFtGBjzuHp4XeLhiiOT7afCxX5PdSn/D4c8Lnuw==", 13910679),
  "darwin-arm64": pkg("sherpa-onnx-darwin-arm64", "sha512-FPNgJMgnWVl/KhRTIhG3KL3A4Om63Rn4YKXc9/uHY7SzLcvqLJLc/h7UBWJwduXvv7K18t5NpxHR6XgXn4sjWw==", 10047754),
  "darwin-x64": pkg("sherpa-onnx-darwin-x64", "sha512-7BLRpjM6w4f9W46/nmkmq8lEKUayhebvcpslCVQ+6QN2uReYlZEMDZlSpXMjme+hUFrPfRz8P3UNq8ep/4d19g==", 11191481),
};

/** sherpa-onnx, the runtime every local speech engine runs on. */
export const SHERPA_RUNTIME = {
  name: `sherpa-onnx-${SHERPA_VERSION}`,
  js: pkg("sherpa-onnx-node", "sha512-MsDMBdhLFTZ1GwvcGSSQhnS7g/EA8OMH6IYysCVUOM7j8Icty9KRc0E6YT1A5fWBsZwRfKOeh88QC95aRvS8ag==", 11954),
  licences: [
    { covers: "sherpa-onnx, the runtime", name: "Apache-2.0", url: "https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE" },
    { covers: "espeak-ng, built into the runtime", name: "GPL-3.0", url: "https://github.com/espeak-ng/espeak-ng/blob/master/COPYING" },
  ] satisfies Licence[],
};

/** The runtime's packages for a target, the JS one first; none for a target sherpa does not build. */
export function runtimePackages(platform: string = process.platform, arch: string = process.arch): RuntimePackage[] | undefined {
  const native = SHERPA_NATIVE[`${platform}-${arch}`];
  return native ? [SHERPA_RUNTIME.js, native] : undefined;
}

/** A local speech engine: the stage it serves, the models it loads, and what it comes under. */
export interface SpeechEngineSpec {
  id: "moonshine-tiny" | "moonshine-base" | "whisper-base" | "nemotron" | "piper" | "kokoro" | "supertonic";
  stage: "stt" | "tts";
  models: string[];
  licences: Licence[];
}

const ESPEAK_DATA: Licence = { covers: "espeak-ng's data, which the model reads", name: "GPL-3.0", url: "https://github.com/espeak-ng/espeak-ng/blob/master/COPYING" };
const MOONSHINE: Licence = { covers: "Moonshine's English models, from Moonshine AI", name: "MIT", url: "https://github.com/moonshine-ai/moonshine/blob/main/LICENSE" };

export const SPEECH_ENGINES: SpeechEngineSpec[] = [
  { id: "moonshine-tiny", stage: "stt", models: ["stt-moonshine-tiny-en"], licences: [MOONSHINE] },
  { id: "moonshine-base", stage: "stt", models: ["stt-moonshine-base-en"], licences: [MOONSHINE] },
  {
    id: "whisper-base",
    stage: "stt",
    models: ["stt-whisper-base"],
    licences: [{ covers: "Whisper Base, OpenAI's model", name: "MIT", url: "https://github.com/openai/whisper/blob/main/LICENSE" }],
  },
  {
    id: "nemotron",
    stage: "stt",
    models: ["stt-nemotron-3.5-streaming-int8"],
    licences: [{ covers: "Nemotron 3.5 ASR Streaming, NVIDIA's model", name: "OpenMDW-1.1", url: "https://openmdw.ai/license/1-1/" }],
  },
  {
    id: "piper",
    stage: "tts",
    models: ["tts-piper-en"],
    licences: [
      { covers: "Piper's LibriTTS-R voice", name: "MIT", url: "https://huggingface.co/rhasspy/piper-voices" },
      { covers: "the LibriTTS-R recordings it was trained on", name: "CC BY 4.0", url: "https://www.openslr.org/141/" },
      ESPEAK_DATA,
    ],
  },
  {
    id: "kokoro",
    stage: "tts",
    models: ["tts-kokoro-en"],
    licences: [{ covers: "Kokoro 82M", name: "Apache-2.0", url: "https://huggingface.co/hexgrad/Kokoro-82M" }, ESPEAK_DATA],
  },
  {
    id: "supertonic",
    stage: "tts",
    models: ["tts-supertonic-3"],
    licences: [{ covers: "Supertonic 3, with use restrictions that bind whoever uses it", name: "OpenRAIL-M", url: "https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE" }],
  },
];

export function speechEngine(id: string): SpeechEngineSpec | undefined {
  return SPEECH_ENGINES.find((e) => e.id === id);
}

/** Bytes a model's download takes, from its sources. */
export function modelBytes(spec: VoiceModelSpec): number {
  return spec.sources.reduce((n, s) => n + ("bytes" in s && typeof s.bytes === "number" ? s.bytes : 0), 0);
}
