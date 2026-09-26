// Installing a local engine's pieces on this machine: a model's archive and file fetched, held
// to the hash the catalog pins before anything is unpacked, unpacked with its manifest written,
// and moved into place whole; a wrong hash or a failed fetch leaves nothing behind. The
// runtime's packages are held to npm's integrity the same way. Everything is served from a
// local server: nothing here reaches the network.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultTar } from "../src/update/platform.ts";
import type { VoiceModelSpec } from "../src/voice/catalog.ts";
import { installModel, installRuntime, modelDir, modelInstalled, runtimeDir, runtimeInstalled } from "../src/voice/install.ts";
import { readVoiceManifest, verifyVoiceDir } from "../src/voice/manifest.ts";
import { removeHome, tempHome } from "./helpers.ts";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) removeHome(h);
});
const home = () => {
  const h = tempHome();
  homes.push(h);
  return h;
};

let archive: Uint8Array;
let licence: Uint8Array;
let server: ReturnType<typeof Bun.serve>;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

beforeAll(async () => {
  // An archive shaped like the k2-fsa ones: one top directory, a model, and a folder to drop.
  const src = home();
  mkdirSync(join(src, "voice-x", "test_wavs"), { recursive: true });
  writeFileSync(join(src, "voice-x", "model.onnx"), "not really a model");
  writeFileSync(join(src, "voice-x", "tokens.txt"), "a 1\nb 2\n");
  writeFileSync(join(src, "voice-x", "test_wavs", "big.wav"), "RIFF");
  const out = join(src, "voice-x.tar.gz");
  const tar = Bun.spawn([defaultTar(), "-czf", out, "-C", src, "voice-x"], { stdout: "ignore", stderr: "pipe" });
  expect(await tar.exited).toBe(0);
  archive = new Uint8Array(readFileSync(out));
  licence = new TextEncoder().encode("A licence.\n");
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/voice-x.tar.gz") return new Response(archive);
      if (path === "/LICENSE") return new Response(licence);
      return new Response("no", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));

const spec = (over: Partial<VoiceModelSpec> = {}): VoiceModelSpec => ({
  name: "tts-test-voice",
  kind: "tts",
  version: "1.0.0",
  params: { model: "model.onnx", tokens: "tokens.txt" },
  sources: [
    { kind: "archive", url: `${server.url}voice-x.tar.gz`, sha256: sha256(archive), bytes: archive.byteLength, strip: 1, drop: ["test_wavs"] },
    { kind: "file", url: `${server.url}LICENSE`, local: "MODEL_LICENSE", sha256: sha256(licence), bytes: licence.byteLength },
  ],
  ...over,
});

describe("installing a model", () => {
  test("fetched, checked, unpacked with its manifest, and placed whole, with progress told as it comes", async () => {
    const data = home();
    const seen: number[] = [];
    await installModel(data, spec(), { onProgress: (p) => seen.push(p.done) });
    const dir = modelDir(data, "tts-test-voice");
    expect(readFileSync(join(dir, "model.onnx"), "utf8")).toBe("not really a model");
    expect(existsSync(join(dir, "MODEL_LICENSE"))).toBe(true);
    expect(existsSync(join(dir, "test_wavs"))).toBe(false);
    expect(existsSync(`${dir}.partial`)).toBe(false);
    const manifest = readVoiceManifest(dir)!;
    expect(manifest).toMatchObject({ name: "tts-test-voice", kind: "tts", version: "1.0.0", params: { model: "model.onnx" } });
    expect(Object.keys(manifest.files).sort()).toEqual(["MODEL_LICENSE", "model.onnx", "tokens.txt"]);
    expect(verifyVoiceDir(dir)).toMatchObject({ ok: true });
    expect(seen.at(-1)).toBe(archive.byteLength + licence.byteLength);
  });

  test("a body that does not hash to the pin is refused before it is unpacked, and nothing is left", async () => {
    const data = home();
    const bad = spec({ sources: [{ kind: "archive", url: `${server.url}voice-x.tar.gz`, sha256: "0".repeat(64), strip: 1 }] });
    await expect(installModel(data, bad)).rejects.toThrow(/sha256 [0-9a-f]{64}, expected 0{64}/);
    expect(existsSync(join(modelDir(data, "tts-test-voice"), "model.onnx"))).toBe(false);
    expect(readVoiceManifest(modelDir(data, "tts-test-voice"))).toBeUndefined();
  });

  test("a source that is not there fails the install", async () => {
    const data = home();
    await expect(installModel(data, spec({ sources: [{ kind: "file", url: `${server.url}gone`, local: "x" }] }))).rejects.toThrow(/answered 404/);
  });

  test("a model is installed only at the catalog's version", () => {
    const data = home();
    const dir = modelDir(data, "tts-piper-en");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "tts-piper-en", kind: "tts", version: "0.9.0", params: {}, files: {} }));
    expect(modelInstalled(data, "tts-piper-en")).toBe(false);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "tts-piper-en", kind: "tts", version: "1.0.0", params: {}, files: {} }));
    expect(modelInstalled(data, "tts-piper-en")).toBe(true);
  });
});

describe("installing the runtime", () => {
  test("a package that does not match npm's integrity is refused, and the runtime is not installed", async () => {
    const data = home();
    // The local server has none of the registry's packages: the first answers 404.
    await expect(installRuntime(data, { registry: server.url.origin })).rejects.toThrow(/answered 404/);
    expect(runtimeInstalled(data)).toBe(false);
    const fake = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("not the package") });
    try {
      await expect(installRuntime(data, { registry: fake.url.origin })).rejects.toThrow(/sha512 .*, expected /);
      expect(runtimeInstalled(data)).toBe(false);
      expect(existsSync(join(runtimeDir(data), "node_modules"))).toBe(false);
    } finally {
      fake.stop(true);
    }
  });
});
