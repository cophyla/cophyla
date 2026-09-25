// The wake word the controller carries in its own build, under `wake/` beside the page:
// openWakeWord's two feature models, the one keyword head, and the ONNX Runtime wasm that
// runs them. The model pins are the ones `apps/cophylad/scripts/fetch-models.ts` fetches with,
// the wasm's is onnxruntime-web 1.30.0's; the build checks every copy against them and the
// page keys its cache on them. A head the phone does not carry is the node's to detect.

export const WAKE_DIR = "wake/";

export interface BundledFile {
  file: string;
  sha256: string;
}

export const BUNDLED = {
  wasm: { file: "ort-wasm-simd-threaded.wasm", sha256: "3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2" },
  mel: { file: "melspectrogram.onnx", sha256: "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f" },
  embedding: { file: "embedding_model.onnx", sha256: "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f" },
  heads: [{ file: "hey_jarvis_v0.1.onnx", sha256: "94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb" }],
  /** The input scale the bundled heads were trained at; the node's answer names the one to run. */
  scale: "int16",
} as const satisfies { wasm: BundledFile; mel: BundledFile; embedding: BundledFile; heads: readonly BundledFile[]; scale: "int16" | "unit" };

/** The heads `voice.wakeword` offers the node. */
export const BUNDLED_HEADS: string[] = BUNDLED.heads.map((h) => h.file);

/** Every file the build copies and the page fetches. */
export const BUNDLED_FILES: BundledFile[] = [BUNDLED.wasm, BUNDLED.mel, BUNDLED.embedding, ...BUNDLED.heads];
