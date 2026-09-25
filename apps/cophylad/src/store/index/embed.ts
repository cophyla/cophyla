// The embedder: text in, unit vector out. The ONNX one runs the model directory's
// `model.onnx` on the CPU with one thread each way (the daemon shares the machine), pools
// as the manifest says (bge: the [CLS] token) and L2-normalises, as the model was trained.
// `onnxruntime-node` is imported lazily, so a daemon with no model never loads the addon.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../../log.ts";
import { DEFAULT_MAX_TOKENS, loadTokenizer } from "./tokenizer.ts";
import type { TextTokenizer } from "./tokenizer.ts";

export interface Embedder {
  /** Names the vectors on disk, so a model change re-embeds instead of mixing spaces. */
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
  close(): Promise<void>;
}

export interface ModelManifest {
  name: string;
  revision: string;
  pooling: "cls" | "mean";
  dim: number;
  files: Record<string, string>;
}

export function readManifest(dir: string): ModelManifest | undefined {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as ModelManifest;
}

export function normalise(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
  return v;
}

type Ort = typeof import("onnxruntime-node");

export class OnnxEmbedder implements Embedder {
  readonly model: string;
  readonly dim: number;
  private ort: Ort;
  private session: import("onnxruntime-node").InferenceSession;
  private tokenizer: TextTokenizer;
  private pooling: ModelManifest["pooling"];
  private maxTokens: number;

  private constructor(ort: Ort, session: import("onnxruntime-node").InferenceSession, tokenizer: TextTokenizer, manifest: ModelManifest, maxTokens: number) {
    this.ort = ort;
    this.session = session;
    this.tokenizer = tokenizer;
    this.model = `${manifest.name}@${manifest.revision.slice(0, 12)}`;
    this.dim = manifest.dim;
    this.pooling = manifest.pooling;
    this.maxTokens = maxTokens;
  }

  static async load(dir: string, manifest: ModelManifest, opts: { maxTokens?: number } = {}): Promise<OnnxEmbedder> {
    const ort = await import("onnxruntime-node");
    const session = await ort.InferenceSession.create(join(dir, "model.onnx"), { intraOpNumThreads: 1, interOpNumThreads: 1, executionProviders: ["cpu"] });
    return new OnnxEmbedder(ort, session, loadTokenizer(dir), manifest, opts.maxTokens ?? DEFAULT_MAX_TOKENS);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const text of texts) out.push(await this.one(text));
    return out;
  }

  private async one(text: string): Promise<Float32Array> {
    const { ids } = this.tokenizer.encode(text, this.maxTokens);
    const n = ids.length;
    const feeds: Record<string, import("onnxruntime-node").Tensor> = {
      input_ids: new this.ort.Tensor("int64", BigInt64Array.from(ids, (x) => BigInt(x)), [1, n]),
      attention_mask: new this.ort.Tensor("int64", new BigInt64Array(n).fill(1n), [1, n]),
    };
    if (this.session.inputNames.includes("token_type_ids")) feeds["token_type_ids"] = new this.ort.Tensor("int64", new BigInt64Array(n), [1, n]);
    const result = await this.session.run(feeds);
    const hidden = result[this.session.outputNames[0]!]!;
    const data = hidden.data as Float32Array;
    const dim = hidden.dims[2]!;
    if (dim !== this.dim) throw new Error(`model gives ${dim} dims, manifest says ${this.dim}`);
    const v = new Float32Array(dim);
    if (this.pooling === "cls") v.set(data.subarray(0, dim));
    else {
      for (let t = 0; t < n; t++) for (let i = 0; i < dim; i++) v[i] = v[i]! + data[t * dim + i]!;
      for (let i = 0; i < dim; i++) v[i] = v[i]! / n;
    }
    return normalise(v);
  }

  async close(): Promise<void> {
    await this.session.release();
  }
}

/**
 * The embedder for a model directory, or `undefined` (logged once) when the directory has
 * no manifest or the runtime will not load: recall then runs on full text alone.
 */
export async function loadEmbedder(dir: string, log: Logger, opts: { maxTokens?: number } = {}): Promise<Embedder | undefined> {
  const manifest = readManifest(dir);
  if (!manifest) {
    log.info("no embedding model; recall is full-text only", { dir });
    return undefined;
  }
  try {
    const started = performance.now();
    const embedder = await OnnxEmbedder.load(dir, manifest, opts);
    log.info("embedding model loaded", { model: embedder.model, dim: embedder.dim, ms: Math.round(performance.now() - started) });
    return embedder;
  } catch (err) {
    log.warn("embedding model failed to load; recall is full-text only", { dir, error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}
