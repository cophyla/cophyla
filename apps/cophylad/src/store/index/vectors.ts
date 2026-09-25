// The vector leg behind a small interface, so the scan can be replaced (sqlite-vec, say)
// without `recall.ts` noticing. The JS index keeps int8 rows in one flat array with a
// per-row scale: unit vectors quantised to a byte each, so 100k chunks of 384 dims cost
// about 39 MB and a full scan tens of milliseconds. Rows live in `chunk_vectors` on disk;
// the newest `maxRows` are loaded at start and older chunks stay findable by full text.

import type { Database } from "bun:sqlite";

export interface VectorHit {
  id: number;
  /** Cosine similarity, in [-1, 1]. */
  score: number;
}

export interface VectorIndex {
  readonly dim: number;
  readonly size: number;
  /** Loads the newest rows of `model` from disk. */
  load(db: Database, model: string): number;
  /** Adds or replaces a row. */
  put(chunk: number, vector: Float32Array): void;
  remove(chunk: number): void;
  has(chunk: number): boolean;
  /** The `k` best by cosine, over `eligible` chunks only when given. */
  search(query: Float32Array, k: number, eligible?: ReadonlySet<number>): VectorHit[];
}

export interface Quantised {
  scale: number;
  q: Int8Array;
}

/** Symmetric int8 quantisation: `v ≈ q * scale`. */
export function quantise(v: Float32Array): Quantised {
  let max = 0;
  for (let i = 0; i < v.length; i++) {
    const a = Math.abs(v[i]!);
    if (a > max) max = a;
  }
  const scale = max === 0 ? 1 : max / 127;
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i]! / scale)));
  return { scale, q };
}

export class JsVectorIndex implements VectorIndex {
  readonly dim: number;
  private maxRows: number;
  private cap: number;
  private data: Int8Array;
  private scales: Float32Array;
  private ids: Int32Array;
  private rowOf = new Map<number, number>();
  private n = 0;

  constructor(dim: number, maxRows: number) {
    this.dim = dim;
    this.maxRows = maxRows;
    this.cap = Math.min(maxRows, 1024);
    this.data = new Int8Array(this.cap * dim);
    this.scales = new Float32Array(this.cap);
    this.ids = new Int32Array(this.cap);
  }

  get size(): number {
    return this.n;
  }

  load(db: Database, model: string): number {
    const rows = db
      .query("SELECT chunk, scale, q FROM chunk_vectors WHERE model = $model AND dim = $dim ORDER BY chunk DESC LIMIT $limit")
      .all({ model, dim: this.dim, limit: this.maxRows }) as { chunk: number; scale: number; q: Uint8Array }[];
    // Oldest first, so the newest are the last in and survive any later eviction longest.
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!;
      if (r.q.byteLength !== this.dim) continue;
      this.putQuantised(r.chunk, r.scale, new Int8Array(r.q.buffer, r.q.byteOffset, this.dim));
    }
    return this.n;
  }

  put(chunk: number, vector: Float32Array): void {
    if (vector.length !== this.dim) throw new Error(`vector of ${vector.length} dims in a ${this.dim}-dim index`);
    const { scale, q } = quantise(vector);
    this.putQuantised(chunk, scale, q);
  }

  private putQuantised(chunk: number, scale: number, q: Int8Array): void {
    let row = this.rowOf.get(chunk);
    if (row === undefined) {
      if (this.n === this.cap) this.grow();
      row = this.n++;
      this.rowOf.set(chunk, row);
      this.ids[row] = chunk;
    }
    this.data.set(q, row * this.dim);
    this.scales[row] = scale;
  }

  /** Doubles the arrays, or, at `maxRows`, drops the oldest tenth by chunk id. */
  private grow(): void {
    if (this.cap < this.maxRows) {
      const cap = Math.min(this.maxRows, this.cap * 2);
      const data = new Int8Array(cap * this.dim);
      data.set(this.data);
      const scales = new Float32Array(cap);
      scales.set(this.scales);
      const ids = new Int32Array(cap);
      ids.set(this.ids);
      this.data = data;
      this.scales = scales;
      this.ids = ids;
      this.cap = cap;
      return;
    }
    const drop = Math.max(1, Math.floor(this.n / 10));
    const oldest = Array.from(this.ids.subarray(0, this.n))
      .sort((a, b) => a - b)
      .slice(0, drop);
    for (const id of oldest) this.remove(id);
  }

  remove(chunk: number): void {
    const row = this.rowOf.get(chunk);
    if (row === undefined) return;
    const last = this.n - 1;
    if (row !== last) {
      this.data.copyWithin(row * this.dim, last * this.dim, (last + 1) * this.dim);
      this.scales[row] = this.scales[last]!;
      const moved = this.ids[last]!;
      this.ids[row] = moved;
      this.rowOf.set(moved, row);
    }
    this.rowOf.delete(chunk);
    this.n = last;
  }

  has(chunk: number): boolean {
    return this.rowOf.has(chunk);
  }

  search(query: Float32Array, k: number, eligible?: ReadonlySet<number>): VectorHit[] {
    if (k <= 0 || this.n === 0) return [];
    let qnorm = 0;
    for (let i = 0; i < query.length; i++) qnorm += query[i]! * query[i]!;
    qnorm = Math.sqrt(qnorm) || 1;
    const dim = this.dim;
    const best: VectorHit[] = [];
    let floor = Number.NEGATIVE_INFINITY;
    for (let row = 0; row < this.n; row++) {
      const id = this.ids[row]!;
      if (eligible && !eligible.has(id)) continue;
      const base = row * dim;
      let dot = 0;
      let rnorm = 0;
      for (let i = 0; i < dim; i++) {
        const v = this.data[base + i]!;
        dot += v * query[i]!;
        rnorm += v * v;
      }
      const score = dot / (qnorm * (Math.sqrt(rnorm) || 1));
      if (best.length >= k && score <= floor) continue;
      // Insert in order; k is small.
      let at = best.length;
      while (at > 0 && best[at - 1]!.score < score) at--;
      best.splice(at, 0, { id, score });
      if (best.length > k) best.pop();
      if (best.length === k) floor = best[k - 1]!.score;
    }
    return best;
  }
}
