// Bundles the controller app into `dist/`, which the node serves on the controller listener,
// or, with `--native`, into `dist-native/`, which the Capacitor shell wraps; `--server` is
// the server the native app signs in to (the production one by default).
//   bun run apps/controller/scripts/build.ts [--native [--server https://orc.example]]
// Three entry points: the page, the capture worklet, which must be a module of its own
// because `audioWorklet.addModule` loads it into the audio thread by URL, and the wake word's
// worker, which ONNX Runtime's wasm build runs in. The native build takes `native.ts` as the
// page: the same app over the shell's plugins, with the relay on.
//
// The wake word's files go under `wake/` in both builds: the three openWakeWord models from
// `apps/cophylad/models/voice/wake-openwakeword/` (fetched there first when missing) and
// onnxruntime-web's wasm, each checked against the pin in `src/wake/bundled.ts`, with a
// NOTICE of their licences.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLED, BUNDLED_FILES } from "../src/wake/bundled.ts";

/** What `wake/NOTICE.txt` says: the four files are third-party work, shipped unmodified. */
const WAKE_NOTICE = `The wake word files in this directory are third-party work, shipped unmodified.

ort-wasm-simd-threaded.wasm
  ONNX Runtime Web 1.30.0 (onnxruntime-web), https://github.com/microsoft/onnxruntime
  Copyright (c) Microsoft Corporation. MIT License.

melspectrogram.onnx, embedding_model.onnx
  openWakeWord v0.5.1 feature models, https://github.com/dscripka/openWakeWord
  Copyright (c) 2022 David Scripka. Apache License 2.0.

hey_jarvis_v0.1.onnx
  openWakeWord v0.5.1 pre-trained "hey jarvis" model, https://github.com/dscripka/openWakeWord
  Copyright (c) 2022 David Scripka. Creative Commons Attribution-NonCommercial-ShareAlike 4.0
  International (CC BY-NC-SA 4.0), https://creativecommons.org/licenses/by-nc-sa/4.0/
`;

const native = process.argv.includes("--native");
const serverAt = process.argv.indexOf("--server");
const server = serverAt > 0 ? process.argv[serverAt + 1] : (process.env["COPHYLA_SERVER_URL"] ?? "https://api.getcophyla.com");
if (!server || !/^https?:\/\/[^/]+$/.test(server.replace(/\/$/, ""))) {
  console.error(`--server must be an origin, like https://orc.example (got ${server ?? "nothing"})`);
  process.exit(1);
}
const root = join(import.meta.dir, "..");
const repo = join(root, "..", "..");
const dist = join(root, native ? "dist-native" : "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const build = async (entry: string, naming: string) => {
  const result = await Bun.build({
    entrypoints: [join(root, "src", entry)],
    outdir: dist,
    target: "browser",
    format: "esm",
    naming,
    minify: process.env["NODE_ENV"] === "production",
    sourcemap: "none",
    define: { COPHYLA_SERVER_URL: JSON.stringify(server.replace(/\/$/, "")) },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
};

await build(native ? "native.ts" : "main.ts", "main.js");
await build("worklet.ts", "worklet.js");
await build("wake/worker.ts", "wake-worker.js");
for (const file of ["index.html", "controller.css"]) copyFileSync(join(root, "src", file), join(dist, file));
// The view picker's and the settings' looks are viewhost's, shared with the desktop app.
copyFileSync(Bun.resolveSync("@cophyla/viewhost/chooser.css", root), join(dist, "chooser.css"));
copyFileSync(Bun.resolveSync("@cophyla/viewhost/settings.css", root), join(dist, "settings.css"));
if (native) {
  // the shell serves the page from its own origin and the link goes wherever the node is: no `'self'` policy holds
  const html = (await Bun.file(join(root, "src", "index.html")).text()).replace(/<meta\s+http-equiv="content-security-policy"[\s\S]*?\/>\s*/i, "");
  await Bun.write(join(dist, "index.html"), html);
}

// --- the wake word's files ---------------------------------------------------------------------

const models = join(repo, "apps", "cophylad", "models", "voice", "wake-openwakeword");
const modelFiles = [BUNDLED.mel, BUNDLED.embedding, ...BUNDLED.heads];
if (!modelFiles.every((f) => existsSync(join(models, f.file)))) {
  // A subprocess, not an import: the script parses its own arguments strictly when it loads.
  console.log("the wake word's models are not in the checkout; fetching them");
  const proc = Bun.spawn(["bun", "run", join(repo, "apps", "cophylad", "scripts", "fetch-models.ts"), "--voice", "--only", "wake-openwakeword"], { stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) {
    console.error("fetching the wake word's models failed");
    process.exit(1);
  }
}
const sources = new Map<string, string>([
  [BUNDLED.wasm.file, Bun.resolveSync("onnxruntime-web/ort-wasm-simd-threaded.wasm", root)],
  ...modelFiles.map((f) => [f.file, join(models, f.file)] as [string, string]),
]);
const wakeOut = join(dist, "wake");
mkdirSync(wakeOut, { recursive: true });
for (const f of BUNDLED_FILES) {
  const bytes = readFileSync(sources.get(f.file)!);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== f.sha256) {
    console.error(`${sources.get(f.file)} has sha256 ${hash}; src/wake/bundled.ts pins ${f.sha256}`);
    process.exit(1);
  }
  writeFileSync(join(wakeOut, f.file), bytes);
}
writeFileSync(join(wakeOut, "NOTICE.txt"), WAKE_NOTICE);

console.log(`controller built into ${dist}${native ? ` (native, signs in to ${server})` : ""}`);
