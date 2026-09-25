// A deterministic embedder for the index tests: a bag of words hashed into a few dims and
// normalised, so texts that share words are near and the ranking is the same every run.

import type { Embedder } from "../../src/store/index/embed.ts";

export const FAKE_DIM = 16;

function hash(word: string): number {
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

export function fakeVector(text: string, dim = FAKE_DIM): Float32Array {
  const v = new Float32Array(dim);
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const h = hash(m[0]);
    v[h % dim] = v[h % dim]! + ((h >>> 8) % 2 === 0 ? 1 : -1);
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) v[i] = v[i]! / norm;
  return v;
}

export class FakeEmbedder implements Embedder {
  readonly model = "fake-bow@test";
  readonly dim = FAKE_DIM;
  calls = 0;
  texts: string[] = [];
  closed = false;
  /** Milliseconds each call takes, to let a test race a write against the model. */
  delayMs = 0;

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    this.texts.push(...texts);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    return texts.map((t) => fakeVector(t, this.dim));
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
