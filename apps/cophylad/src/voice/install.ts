// Installing a speech engine on this machine, when its user asks for it (`voice.install`): the
// sherpa-onnx runtime from the npm registry and the engine's models from where their makers
// publish them, each checked against the hash the catalog pins before anything is unpacked,
// unpacked beside where it belongs and moved into place whole, so a half-finished install is
// never what loads. Nothing here runs on its own: a node whose user never installs an engine
// never fetches one, and is bound by none of their licences.
//
// Everything lands under `<data>/voice/`: `runtime/<sherpa-onnx-version>/node_modules/` with
// the JS package and this target's native one side by side, as sherpa's loader expects, and
// `models/<name>/` with the `manifest.json` the engines read, written here from the catalog.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { defaultTar } from "../update/platform.ts";
import type { SpeechEngineSpec, VoiceModelSpec } from "./catalog.ts";
import { modelBytes, runtimePackages, SHERPA_RUNTIME, voiceModel } from "./catalog.ts";
import { readVoiceManifest } from "./manifest.ts";

/** Where an install is: the runtime or a model, and how many of its bytes have come. */
export interface InstallProgress {
  step: "runtime" | "model";
  /** The runtime's name or the model's. */
  what: string;
  done: number;
  total: number;
}

export interface InstallOptions {
  fetch?: typeof fetch;
  /** The `tar` that unpacks; the platform's own when absent. */
  tar?: string;
  onProgress?: (p: InstallProgress) => void;
  /** Where the runtime's packages come from, for tests: the npm registry when absent. */
  registry?: string;
}

const RUNTIME_MARKER = "installed.json";

export function runtimeDir(dataDir: string): string {
  return join(dataDir, "voice", "runtime", SHERPA_RUNTIME.name);
}

export function modelDir(dataDir: string, name: string): string {
  return join(dataDir, "voice", "models", name);
}

/** The runtime is here whole: its marker is written last. */
export function runtimeInstalled(dataDir: string): boolean {
  return existsSync(join(runtimeDir(dataDir), RUNTIME_MARKER));
}

/** A model is here whole, at the catalog's version: its manifest is written last. */
export function modelInstalled(dataDir: string, name: string): boolean {
  const spec = voiceModel(name);
  const manifest = readVoiceManifest(modelDir(dataDir, name));
  return spec !== undefined && manifest?.name === name && manifest.version === spec.version;
}

/** What installing `engine` would still fetch, in bytes: the runtime when it is missing, and each missing model. */
export function pendingBytes(dataDir: string, engine: SpeechEngineSpec, runtimeHere = runtimeInstalled(dataDir)): number {
  let n = runtimeHere ? 0 : (runtimePackages() ?? []).reduce((sum, p) => sum + p.bytes, 0);
  for (const name of engine.models) {
    const spec = voiceModel(name);
    if (spec && !modelInstalled(dataDir, name)) n += modelBytes(spec);
  }
  return n;
}

/** The runtime and every model `engine` needs that is not here yet. */
export async function installEngine(dataDir: string, engine: SpeechEngineSpec, opts: InstallOptions = {}, runtimeHere = runtimeInstalled(dataDir)): Promise<void> {
  if (!runtimeHere) await installRuntime(dataDir, opts);
  for (const name of engine.models) {
    const spec = voiceModel(name);
    if (!spec) throw new Error(`the catalog has no model ${name}`);
    if (!modelInstalled(dataDir, name)) await installModel(dataDir, spec, opts);
  }
}

/** sherpa-onnx: the JS package and this target's native one, from the npm registry. */
export async function installRuntime(dataDir: string, opts: InstallOptions = {}): Promise<void> {
  const packages = runtimePackages();
  if (!packages) throw new Error(`sherpa-onnx has no build for ${process.platform}/${process.arch}`);
  const dest = runtimeDir(dataDir);
  const partial = `${dest}.partial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(join(partial, "node_modules"), { recursive: true });
  const total = packages.reduce((n, p) => n + p.bytes, 0);
  let done = 0;
  for (const p of packages) {
    const url = opts.registry ? p.url.replace("https://registry.npmjs.org", opts.registry) : p.url;
    const bytes = await download(url, { integrity: p.integrity }, opts, (n) => opts.onProgress?.({ step: "runtime", what: SHERPA_RUNTIME.name, done: done + n, total }));
    done += bytes.byteLength;
    const into = join(partial, "node_modules", p.name);
    mkdirSync(into, { recursive: true });
    await unpackBytes(bytes, `${p.name}.tgz`, into, 1, opts);
  }
  writeFileSync(join(partial, RUNTIME_MARKER), JSON.stringify({ name: SHERPA_RUNTIME.name, packages: packages.map((p) => ({ name: p.name, integrity: p.integrity })), at: Date.now() }, null, 2) + "\n");
  replaceDir(partial, dest);
}

/** One model from its sources, with the manifest the engines read. */
export async function installModel(dataDir: string, spec: VoiceModelSpec, opts: InstallOptions = {}): Promise<void> {
  const dest = modelDir(dataDir, spec.name);
  const partial = `${dest}.partial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  const total = modelBytes(spec);
  let done = 0;
  for (const source of spec.sources) {
    if (source.kind === "repo") throw new Error(`${spec.name} is Cophyla's own and comes from the feed, not from here`);
    const progress = (n: number) => opts.onProgress?.({ step: "model", what: spec.name, done: done + n, total });
    const bytes = await download(source.url, source.sha256 ? { sha256: source.sha256 } : {}, opts, progress);
    done += bytes.byteLength;
    if (source.kind === "file") writeFileSync(join(partial, source.local), bytes);
    else await unpackBytes(bytes, source.url.split("/").pop()!, partial, source.strip ?? 0, opts, source.drop);
  }
  writeManifest(partial, spec);
  replaceDir(partial, dest);
}

/** The manifest the engines read and check: the catalog's params, and the sha256 of every file that came. */
export function writeManifest(dir: string, spec: VoiceModelSpec): void {
  const files: Record<string, string> = {};
  for (const rel of walk(dir)) {
    if (rel === "manifest.json") continue;
    files[rel] = createHash("sha256").update(readFileSync(join(dir, rel))).digest("hex");
  }
  const manifest = { name: spec.name, kind: spec.kind, version: spec.version, params: spec.params, files };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

/** The body of `url`, whole, checked against a sha256 (hex) or an npm integrity (`sha512-` base64). */
async function download(url: string, check: { sha256?: string; integrity?: string }, opts: InstallOptions, progress: (n: number) => void): Promise<Uint8Array> {
  const res = await (opts.fetch ?? fetch)(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`${url} answered ${res.status}`);
  const chunks: Uint8Array[] = [];
  let n = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.byteLength;
    progress(n);
  }
  const bytes = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  if (check.sha256) {
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== check.sha256) throw new Error(`${url}: sha256 ${got}, expected ${check.sha256}`);
  }
  if (check.integrity) {
    const [algo, want] = check.integrity.split("-", 2) as [string, string];
    const got = createHash(algo).update(bytes).digest("base64");
    if (got !== want) throw new Error(`${url}: ${algo} ${got}, expected ${want}`);
  }
  return bytes;
}

async function unpackBytes(bytes: Uint8Array, name: string, dest: string, strip: number, opts: InstallOptions, drop: string[] = []): Promise<void> {
  const tmp = join(dest, `.download-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  const archive = join(tmp, name);
  writeFileSync(archive, bytes);
  try {
    const args = ["-xf", archive, "-C", dest, ...(strip ? [`--strip-components=${strip}`] : [])];
    const proc = Bun.spawn([opts.tar ?? defaultTar(), ...args], { stdout: "ignore", stderr: "pipe", windowsHide: true });
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(`tar exited ${code}: ${err.trim().slice(0, 400)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  for (const gone of drop) rmSync(join(dest, gone), { recursive: true, force: true });
}

/** `from` takes the place of `to`, which goes first. */
function replaceDir(from: string, to: string): void {
  rmSync(to, { recursive: true, force: true });
  renameSync(from, to);
}

/** Every file under `dir`, as forward-slash paths relative to it, sorted. */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, base));
    else if (entry.isFile() && statSync(path).isFile()) out.push(relative(base, path).replaceAll("\\", "/"));
  }
  return out.sort();
}
