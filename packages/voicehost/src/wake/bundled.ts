// The wake word a client carries in its own build, under `wake/` beside the page — the
// phone's page and app, and the desktop app's host page: openWakeWord's two feature models,
// one keyword head per phrase, and the ONNX Runtime wasm that runs them. The model pins are
// the ones `apps/cophylad/scripts/fetch-models.ts` fetches with, the wasm's is
// onnxruntime-web 1.30.0's; the build checks every copy against them and the phone's browser
// page keys its cache on them. A head the client does not carry is the node's to detect.

export const WAKE_DIR = "wake/";

export interface BundledFile {
  file: string;
  sha256: string;
}

export const BUNDLED = {
  wasm: { file: "ort-wasm-simd-threaded.wasm", sha256: "3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2" },
  mel: { file: "melspectrogram.onnx", sha256: "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f" },
  embedding: { file: "embedding_model.onnx", sha256: "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f" },
  /** One per phrase; the node's answer names the threshold and the input scale each runs at. */
  heads: [
    { file: "hey_jarvis_v0.1.onnx", sha256: "94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb" },
    { file: "cophyla_v0.1.onnx", sha256: "b08ab17c1ff81a3293c7e8d3c4623d9c9a3b0bacbb291311e7d7d2b9e8b984e9" },
    { file: "hey_phyla_v0.1.onnx", sha256: "4ec1d76da29e8581bb8d1d48a453336a35752159403a144df16657e1975f8a36" },
  ],
} as const satisfies { wasm: BundledFile; mel: BundledFile; embedding: BundledFile; heads: readonly BundledFile[] };

/** The heads `voice.wakeword` offers the node. */
export const BUNDLED_HEADS: string[] = BUNDLED.heads.map((h) => h.file);

/** Every file the build copies and the page fetches. */
export const BUNDLED_FILES: BundledFile[] = [BUNDLED.wasm, BUNDLED.mel, BUNDLED.embedding, ...BUNDLED.heads];
