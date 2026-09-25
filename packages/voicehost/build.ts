// What a host page needs beside its own bundle for voice, built once for the phone and the
// desktop app: the capture worklet, which must be a module of its own because
// `audioWorklet.addModule` loads it into the audio thread by URL; the wake word's worker,
// which ONNX Runtime's wasm build runs in; and the wake word's files under `wake/` — the
// openWakeWord models from `apps/cophylad/models/voice/wake-openwakeword/` (fetched there
// first when missing) and onnxruntime-web's wasm, each checked against the pin in
// `src/wake/bundled.ts`, with a NOTICE of their licences.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLED, BUNDLED_FILES } from "./src/wake/bundled.ts";

/** What `wake/NOTICE.txt` says about each file; a head not named here is named by the fallback. */
const NOTICES: Record<string, string> = {
  "ort-wasm-simd-threaded.wasm": `ort-wasm-simd-threaded.wasm
  ONNX Runtime Web 1.30.0 (onnxruntime-web), https://github.com/microsoft/onnxruntime
  Copyright (c) Microsoft Corporation. MIT License.
`,
  "melspectrogram.onnx": `melspectrogram.onnx, embedding_model.onnx
  openWakeWord v0.5.1 feature models, https://github.com/dscripka/openWakeWord
  Copyright (c) 2022 David Scripka. Apache License 2.0.
`,
  "hey_jarvis_v0.1.onnx": `hey_jarvis_v0.1.onnx
  openWakeWord v0.5.1 pre-trained "hey jarvis" model, https://github.com/dscripka/openWakeWord
  Copyright (c) 2022 David Scripka. Creative Commons Attribution-NonCommercial-ShareAlike 4.0
  International (CC BY-NC-SA 4.0), https://creativecommons.org/licenses/by-nc-sa/4.0/
`,
};

const OWN_HEAD = (file: string) => `${file}
  Cophyla's own keyword head, trained with livekit-wakeword (Apache License 2.0) on synthetic
  speech against openWakeWord's precomputed ACAV100M negative features, which are licensed
  CC BY-NC-SA 4.0; packages/wake/heads/README.md in the Cophyla repository says how it was made.
`;

export function wakeNotice(): string {
  const parts = ["The wake word files in this directory. The third-party ones are shipped unmodified.\n"];
  for (const f of BUNDLED_FILES) {
    if (f.file === BUNDLED.embedding.file) continue;
    parts.push(NOTICES[f.file] ?? OWN_HEAD(f.file));
  }
  return parts.join("\n");
}

export interface VoiceAssetsOptions {
  /** Where the page is built: `worklet.js`, `wake-worker.js` and `wake/` go beside it. */
  outDir: string;
  minify?: boolean;
}

const ROOT = import.meta.dir;
const REPO = join(ROOT, "..", "..");

async function bundle(entry: string, outDir: string, naming: string, minify: boolean): Promise<void> {
  const result = await Bun.build({ entrypoints: [entry], outdir: outDir, target: "browser", format: "esm", naming, minify, sourcemap: "none" });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`building ${entry} failed`);
  }
}

/** The worklet, the wake worker and the checked wake files, into `outDir`. */
export async function buildVoiceAssets(opts: VoiceAssetsOptions): Promise<void> {
  const minify = opts.minify ?? false;
  await bundle(join(ROOT, "src", "worklet.ts"), opts.outDir, "worklet.js", minify);
  await bundle(join(ROOT, "src", "wake", "worker.ts"), opts.outDir, "wake-worker.js", minify);

  const models = join(REPO, "apps", "cophylad", "models", "voice", "wake-openwakeword");
  const modelFiles = [BUNDLED.mel, BUNDLED.embedding, ...BUNDLED.heads];
  if (!modelFiles.every((f) => existsSync(join(models, f.file)))) {
    // A subprocess, not an import: the script parses its own arguments strictly when it loads.
    console.log("the wake word's models are not in the checkout; fetching them");
    const proc = Bun.spawn(["bun", "run", join(REPO, "apps", "cophylad", "scripts", "fetch-models.ts"), "--voice", "--only", "wake-openwakeword"], { stdout: "inherit", stderr: "inherit" });
    if ((await proc.exited) !== 0) throw new Error("fetching the wake word's models failed");
  }
  const sources = new Map<string, string>([
    [BUNDLED.wasm.file, Bun.resolveSync("onnxruntime-web/ort-wasm-simd-threaded.wasm", ROOT)],
    ...modelFiles.map((f) => [f.file, join(models, f.file)] as [string, string]),
  ]);
  const wakeOut = join(opts.outDir, "wake");
  mkdirSync(wakeOut, { recursive: true });
  for (const f of BUNDLED_FILES) {
    const bytes = readFileSync(sources.get(f.file)!);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== f.sha256) throw new Error(`${sources.get(f.file)} has sha256 ${hash}; packages/voicehost/src/wake/bundled.ts pins ${f.sha256}`);
    writeFileSync(join(wakeOut, f.file), bytes);
  }
  writeFileSync(join(wakeOut, "NOTICE.txt"), wakeNotice());
}
