// The phone's runtime against the node's, through the one pipeline both run: onnxruntime-web's
// wasm entry, loaded as the phone's worker loads it (the wasm's bytes handed over, one
// thread, no proxy), and onnxruntime-node, over the same two recorded clips. Every chunk's
// score must agree, the same chunk must be the first over the threshold, the phrase must
// fire and the question must not. Skipped unless the wake model is there, since a checkout
// does not carry it:
//
//   bun run apps/cophylad/scripts/fetch-models.ts --voice --only wake-openwakeword
//   bun test packages/wake/test/parity.live.test.ts
//   COPHYLA_VOICE_MODELS=C:/D/scratch-m8/models bun test …   (models somewhere else)

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { CHUNK, WakePipeline } from "../src/index.ts";
import type { WakeModels, WakeSession } from "../src/index.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const MODELS = process.env["COPHYLA_VOICE_MODELS"] ?? join(REPO, "apps", "cophylad", "models", "voice");
const DIR = join(MODELS, "wake-openwakeword");
const CLIPS = join(REPO, "apps", "cophylad", "test", "fixtures", "audio");
const present = existsSync(join(DIR, "manifest.json"));
const THRESHOLD = 0.7;
const TOLERANCE = 1e-3;

/** A 16-bit PCM wav's samples. */
function readWav(path: string): Int16Array {
  const bytes = new Uint8Array(readFileSync(path));
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(pos, pos + 4));
    const size = dv.getUint32(pos + 4, true);
    if (id === "data") {
      const count = Math.floor(Math.min(size, bytes.length - pos - 8) / 2);
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i++) samples[i] = dv.getInt16(pos + 8 + i * 2, true);
      return samples;
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error(`no data chunk in ${path}`);
}

/** Half a second of silence either side of a clip, cut into the pipeline's chunks. */
function chunks(clip: Int16Array): Int16Array[] {
  const pad = new Int16Array(8000);
  const all = new Int16Array(pad.length * 2 + clip.length);
  all.set(clip, pad.length);
  const out: Int16Array[] = [];
  for (let i = 0; i + CHUNK <= all.length; i += CHUNK) out.push(all.subarray(i, i + CHUNK));
  return out;
}

interface Manifest {
  params: { mel: string; embedding: string; heads: string[]; scale: "int16" | "unit" };
}

type Create = (bytes: Uint8Array) => Promise<WakeSession>;

async function models(ort: WakeModels["ort"], create: Create): Promise<WakeModels> {
  const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as Manifest;
  const read = (file: string) => new Uint8Array(readFileSync(join(DIR, file)));
  const head = manifest.params.heads[0]!;
  const [mel, emb, session] = await Promise.all([create(read(manifest.params.mel)), create(read(manifest.params.embedding)), create(read(head))]);
  return { ort, mel, emb, heads: [{ name: head, session }], scale: manifest.params.scale };
}

async function scores(m: WakeModels, input: Int16Array[]): Promise<{ scores: number[]; ms: number }> {
  const pipeline = new WakePipeline(m);
  const out: number[] = [];
  const t0 = performance.now();
  for (const chunk of input) out.push(await pipeline.feed(chunk));
  return { scores: out, ms: (performance.now() - t0) / input.length };
}

describe.skipIf(!present)("the phone's runtime scores as the node's does", () => {
  test("per chunk, on the phrase and on the question", async () => {
    // onnxruntime-node first, as the daemon loads it; then the wasm entry the worker imports.
    const node = await import("onnxruntime-node");
    const web = await import("onnxruntime-web/wasm");
    const require = createRequire(import.meta.url);
    web.env.wasm.numThreads = 1;
    web.env.wasm.proxy = false;
    web.env.wasm.wasmBinary = new Uint8Array(readFileSync(require.resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm")));

    const nodeOpts = { intraOpNumThreads: 1, interOpNumThreads: 1, executionProviders: ["cpu"] };
    const onNode = await models(node, (bytes) => node.InferenceSession.create(bytes, nodeOpts as never) as Promise<WakeSession>);
    const onWeb = await models(web, (bytes) => web.InferenceSession.create(bytes, { executionProviders: ["wasm"] }) as Promise<WakeSession>);

    const first = (s: number[]) => s.findIndex((v) => v >= THRESHOLD);
    for (const [clip, fires] of [["hey_jarvis.wav", true], ["question.wav", false]] as const) {
      const input = chunks(readWav(join(CLIPS, clip)));
      const a = await scores(onNode, input);
      const b = await scores(onWeb, input);
      expect(b.scores).toHaveLength(a.scores.length);
      const worst = Math.max(...a.scores.map((v, i) => Math.abs(v - b.scores[i]!)));
      console.info(`${clip}: peak node ${Math.max(...a.scores).toFixed(4)}, wasm ${Math.max(...b.scores).toFixed(4)}; worst difference ${worst.toExponential(2)}; ${a.ms.toFixed(2)} vs ${b.ms.toFixed(2)} ms a chunk`);
      expect(worst).toBeLessThan(TOLERANCE);
      expect(first(b.scores)).toBe(first(a.scores));
      expect(first(a.scores) >= 0).toBe(fires);
    }
  }, 120_000);
});
