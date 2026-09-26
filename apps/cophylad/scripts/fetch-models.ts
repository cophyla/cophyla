// Fetches the models the platform runs on into `apps/cophylad/models/`, pinned by revision and
// sha256, like the brain seed: a build-time step, never the daemon's.
//
//   bun run apps/cophylad/scripts/fetch-models.ts              the embedding model recall uses
//   bun run apps/cophylad/scripts/fetch-models.ts --voice      the four voice models (~1.1 GB)
//   … --pin                                                 download without checking, print the hashes
//   … --voice --pin --from <dir>                            assemble from local copies and print the hashes
//
// The embedding model is staged into the platform archive. The voice models are not: they are
// `model` releases of their own, fetched by the daemon the first time a stage is turned on,
// and `release-model.ts` packs the directories this writes. Each voice model directory holds
// a `manifest.json` naming its kind, its engine parameters and the sha256 of every file in
// it, which is what the daemon checks after unpacking.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { defaultTar } from "../src/update/platform.ts";

interface ModelSpec {
  name: string;
  repo: string;
  revision: string;
  pooling: "cls" | "mean";
  dim: number;
  /** Remote path → local file name, with the sha256 of the bytes. */
  files: { remote: string; local: string; sha256: string }[];
}

const MODELS: ModelSpec[] = [
  {
    name: "bge-small-en-v1.5",
    repo: "Xenova/bge-small-en-v1.5",
    revision: "ea104dacec62c0de699686887e3f920caeb4f3e3",
    pooling: "cls",
    dim: 384,
    files: [
      { remote: "onnx/model_quantized.onnx", local: "model.onnx", sha256: "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4" },
      { remote: "tokenizer.json", local: "tokenizer.json", sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66" },
      { remote: "tokenizer_config.json", local: "tokenizer_config.json", sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3" },
    ],
  },
];

// --- the voice models ------------------------------------------------------------------------

/** One file fetched as it is, one archive unpacked into the model directory, or one of Cophyla's own from the repository. */
export type VoiceSource =
  | { kind: "file"; url: string; local: string; sha256?: string }
  | { kind: "archive"; url: string; sha256?: string; strip?: number; drop?: string[] }
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
/** The repository's root, for the files Cophyla made itself (`kind: "repo"`). */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const K2 = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

export const VOICE_MODELS: VoiceModelSpec[] = [
  {
    name: "wake-openwakeword",
    kind: "wake",
    version: "1.1.0",
    params: {
      scale: "int16",
      mel: "melspectrogram.onnx",
      embedding: "embedding_model.onnx",
      heads: ["hey_jarvis_v0.1.onnx", "cophyla_v0.1.onnx", "hey_phyla_v0.1.onnx"],
      head_params: {
        "hey_jarvis_v0.1.onnx": { threshold: 0.7, phrase: "Hey Jarvis" },
        "cophyla_v0.1.onnx": { threshold: 0.7, phrase: "Cophyla" },
        "hey_phyla_v0.1.onnx": { threshold: 0.6, phrase: "Hey Phyla" },
      },
    },
    sources: [
      { kind: "file", url: `${OWW}/melspectrogram.onnx`, local: "melspectrogram.onnx", sha256: "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f" },
      { kind: "file", url: `${OWW}/embedding_model.onnx`, local: "embedding_model.onnx", sha256: "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f" },
      { kind: "file", url: `${OWW}/hey_jarvis_v0.1.onnx`, local: "hey_jarvis_v0.1.onnx", sha256: "94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb" },
      // Cophyla's own heads (packages/wake/heads/README.md says how they were made).
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
        strip: 1,
        // The sample clips are a third of the archive and nothing loads them.
        drop: ["test_wavs"],
      },
    ],
  },
  {
    name: "tts-kokoro-en",
    kind: "tts",
    version: "1.0.0",
    params: { model: "model.onnx", voices: "voices.bin", tokens: "tokens.txt", dataDir: "espeak-ng-data", sampleRate: 24000 },
    sources: [{ kind: "archive", url: `${K2}/tts-models/kokoro-en-v0_19.tar.bz2`, sha256: "912804855a04745fa77a30be545b3f9a5d15c4d66db00b88cbcd4921df605ac7", strip: 1 }],
  },
];

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { pin: { type: "boolean" }, voice: { type: "boolean" }, from: { type: "string" }, only: { type: "string" } }, strict: true });

export const MODELS_DIR: string = join(dirname(import.meta.dir), "models");
export const VOICE_DIR: string = join(MODELS_DIR, "voice");

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Archive name → its hash, printed at the end of a `--pin` run so the pins can be pasted in. */
const pinned = new Map<string, string>();
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

async function get(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Every file under `dir`, as forward-slash paths relative to it, sorted. */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, base));
    else if (entry.isFile()) out.push(relative(base, path).replaceAll("\\", "/"));
  }
  return out.sort();
}

async function unpack(archive: string, dest: string, strip: number): Promise<void> {
  const args = ["-xf", archive, "-C", dest, ...(strip ? [`--strip-components=${strip}`] : [])];
  const proc = Bun.spawn([defaultTar(), ...args], { stdout: "ignore", stderr: "pipe", windowsHide: true });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`tar exited ${code}: ${err.trim().slice(0, 400)}`);
}

/** Fills a model directory from its sources, or from a local copy when `--from` names one. */
async function fill(spec: VoiceModelSpec, dir: string, from?: string): Promise<void> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, ".download");
  for (const source of spec.sources) {
    if (source.kind === "repo") {
      const bytes = readFileSync(join(REPO_ROOT, source.path));
      if (!values.pin && sha256(bytes) !== source.sha256) throw new Error(`${source.path}: sha256 ${sha256(bytes)}, expected ${source.sha256}`);
      writeFileSync(join(dir, source.local), bytes);
      console.log(`  ${source.local} (from ${source.path}) ${mb(bytes.byteLength)}`);
      continue;
    }
    if (source.kind === "file") {
      const local = join(dir, source.local);
      if (from) {
        const src = findLocal(from, source.local);
        if (!src) throw new Error(`${spec.name}: no ${source.local} under ${from}`);
        cpSync(src, local);
      } else {
        process.stdout.write(`  ${source.local}… `);
        const bytes = await get(source.url);
        if (!values.pin && source.sha256 && sha256(bytes) !== source.sha256) throw new Error(`${source.local}: sha256 ${sha256(bytes)}, expected ${source.sha256}`);
        writeFileSync(local, bytes);
        console.log(mb(bytes.byteLength));
      }
      continue;
    }
    const name = source.url.split("/").pop()!;
    if (from) {
      // A local copy is the unpacked directory, not the archive.
      const src = findLocalDir(from, spec);
      if (!src) throw new Error(`${spec.name}: no unpacked copy under ${from}`);
      cpSync(src, dir, { recursive: true });
    } else {
      process.stdout.write(`  ${name}… `);
      const bytes = await get(source.url);
      if (values.pin) pinned.set(name, `${sha256(bytes)}  (${bytes.byteLength} bytes)`);
      if (!values.pin && source.sha256 && sha256(bytes) !== source.sha256) throw new Error(`${name}: sha256 ${sha256(bytes)}, expected ${source.sha256}`);
      mkdirSync(tmp, { recursive: true });
      const archive = join(tmp, name);
      writeFileSync(archive, bytes);
      console.log(`${mb(bytes.byteLength)}, unpacking`);
      await unpack(archive, dir, source.strip ?? 0);
      rmSync(tmp, { recursive: true, force: true });
    }
    for (const gone of source.drop ?? []) rmSync(join(dir, gone), { recursive: true, force: true });
  }
}

/** A file of that name anywhere under `root`, for `--from` over the spike directories. */
function findLocal(root: string, name: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const found = findLocal(path, name);
      if (found) return found;
    }
  }
  return undefined;
}

/** The unpacked directory of an archived model under `root`: the one holding its first named file. */
function findLocalDir(root: string, spec: VoiceModelSpec): string | undefined {
  const marker = String(spec.params["model"] ?? spec.params["encoder"] ?? "");
  if (!marker) return undefined;
  const found = findLocal(root, marker);
  return found ? dirname(found) : undefined;
}

async function voice(): Promise<void> {
  const only = values.only?.split(",").map((s) => s.trim());
  for (const spec of VOICE_MODELS) {
    if (only && !only.includes(spec.name)) continue;
    const dir = join(VOICE_DIR, spec.name);
    console.log(`${spec.name} ${spec.version}:`);
    await fill(spec, dir, values.from);
    // The manifest is what the daemon checks an unpacked release against.
    const files: Record<string, string> = {};
    for (const rel of walk(dir)) {
      if (rel === "manifest.json") continue;
      files[rel] = sha256(readFileSync(join(dir, rel)));
    }
    const manifest = { name: spec.name, kind: spec.kind, version: spec.version, params: spec.params, files };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    const total = Object.keys(files).reduce((n, f) => n + statSync(join(dir, f)).size, 0);
    console.log(`  ${Object.keys(files).length} files, ${mb(total)} → ${dir}`);
    if (values.pin) {
      // The archive hashes are what `VOICE_MODELS` pins; the per-file ones live in the manifest.
      for (const source of spec.sources) {
        if (source.kind === "file" || source.kind === "repo") console.log(`    ${source.local}: ${files[source.local]}`);
        else console.log(`    ${source.url.split("/").pop()}: ${pinned.get(source.url.split("/").pop()!) ?? "(from a local copy; not pinned)"}`);
      }
    }
  }
}

if (values.voice) {
  await voice();
} else {
  for (const spec of MODELS) {
    const dir = join(MODELS_DIR, spec.name);
    mkdirSync(dir, { recursive: true });
    const hashes: Record<string, string> = {};
    for (const file of spec.files) {
      const dst = join(dir, file.local);
      if (!values.pin && existsSync(dst) && sha256(readFileSync(dst)) === file.sha256) {
        hashes[file.local] = file.sha256;
        console.log(`${spec.name}/${file.local}: present`);
        continue;
      }
      process.stdout.write(`${spec.name}/${file.local}: fetching… `);
      const bytes = await get(`https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${file.remote}`);
      const hash = sha256(bytes);
      if (!values.pin && hash !== file.sha256) throw new Error(`${spec.name}/${file.local}: sha256 ${hash}, expected ${file.sha256}`);
      writeFileSync(dst, bytes);
      hashes[file.local] = hash;
      console.log(`${mb(bytes.byteLength)}${values.pin ? ` sha256 ${hash}` : ""}`);
    }
    const manifest = { name: spec.name, revision: spec.revision, pooling: spec.pooling, dim: spec.dim, files: hashes };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`${spec.name}: ${dir}`);
  }
}
