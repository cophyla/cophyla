// The pipeline over fake sessions: several heads at once, each at its own threshold, the
// features computed once per scale the heads use, and nothing scored before the embedding
// window holds real audio. The real models are the live parity test's.

import { describe, expect, test } from "bun:test";
import { CHUNK, WakePipeline } from "../src/index.ts";
import type { Scale, WakeModels, WakeSession } from "../src/index.ts";

class Tensor {
  readonly data: Float32Array;
  constructor(_type: "float32", data: Float32Array, _dims: readonly number[]) {
    this.data = data;
  }
}

/** A session that answers with `out(input)` and counts its runs and the first input value it saw. */
function session(out: (input: Float32Array) => Float32Array): WakeSession & { runs: number; firsts: number[] } {
  const s = {
    inputNames: ["in"],
    outputNames: ["out"],
    runs: 0,
    firsts: [] as number[],
    async run(feeds: Record<string, unknown>) {
      s.runs++;
      const input = (feeds["in"] as Tensor).data;
      s.firsts.push(input[input.length - 1] ?? 0);
      return { out: { data: out(input) } };
    },
  };
  return s;
}

/** Heads that score what they are told to, per chunk after the window fills. */
function models(heads: { name: string; threshold: number; scale: Scale; scores: number[]; patience?: number }[]) {
  const mel = session(() => new Float32Array(5 * 32));
  const emb = session(() => new Float32Array(96));
  const sessions = heads.map((h) => {
    let i = 0;
    return { ...h, session: session(() => new Float32Array([h.scores[i++] ?? 0])) };
  });
  const m: WakeModels = { ort: { Tensor }, mel, emb, heads: sessions.map((h) => ({ name: h.name, threshold: h.threshold, scale: h.scale, session: h.session, ...(h.patience !== undefined ? { patience: h.patience } : {}) })) };
  return { m, mel, emb, sessions };
}

const chunk = (value = 100) => new Int16Array(CHUNK).fill(value);

describe("the wake pipeline", () => {
  test("nothing is scored until sixteen chunks have filled the window", async () => {
    const { m, sessions } = models([{ name: "a", threshold: 0.5, scale: "int16", scores: [0.875] }]);
    const p = new WakePipeline(m);
    for (let i = 0; i < 15; i++) expect(await p.feed(chunk())).toEqual({ fired: false, score: 0 });
    expect(sessions[0]!.session.runs).toBe(0);
    expect(await p.feed(chunk())).toEqual({ fired: true, score: 0.875, head: "a" });
  });

  test("each head fires at its own threshold, and the best score is kept when none does", async () => {
    const { m } = models([
      { name: "hey_phyla", threshold: 0.7, scale: "int16", scores: [0.625, 0.625, 0.125] },
      { name: "cophyla", threshold: 0.5, scale: "int16", scores: [0.25, 0.5625, 0.125] },
    ]);
    const p = new WakePipeline(m);
    for (let i = 0; i < 15; i++) await p.feed(chunk());
    // 0.625 is under hey_phyla's 0.7 and 0.25 under cophyla's 0.5: the best of them, unfired.
    expect(await p.feed(chunk())).toEqual({ fired: false, score: 0.625, head: "hey_phyla" });
    // 0.5625 is over cophyla's 0.5, though under hey_phyla's score: cophyla fired.
    expect(await p.feed(chunk())).toEqual({ fired: true, score: 0.5625, head: "cophyla" });
  });

  test("a feed that completes several chunks reports the first head that fired", async () => {
    const { m } = models([{ name: "a", threshold: 0.5, scale: "int16", scores: [0.25, 0.75, 0.9375] }]);
    const p = new WakePipeline(m);
    for (let i = 0; i < 15; i++) await p.feed(chunk());
    const three = new Int16Array(CHUNK * 3).fill(100);
    expect(await p.feed(three)).toEqual({ fired: true, score: 0.75, head: "a" });
  });

  test("heads of one scale share the features; a second scale gets its own pass at its own scale", async () => {
    const { m, mel } = models([
      { name: "a", threshold: 0.5, scale: "int16", scores: [] },
      { name: "b", threshold: 0.5, scale: "int16", scores: [] },
    ]);
    const p = new WakePipeline(m);
    await p.feed(chunk(16384));
    expect(mel.runs).toBe(1);
    expect(mel.firsts).toEqual([16384]);

    const mixed = models([
      { name: "a", threshold: 0.5, scale: "int16", scores: [] },
      { name: "b", threshold: 0.5, scale: "unit", scores: [] },
    ]);
    await new WakePipeline(mixed.m).feed(chunk(16384));
    expect(mixed.mel.runs).toBe(2);
    expect(mixed.mel.firsts).toEqual([16384, 0.5]);
  });

  test("a reset starts the window over", async () => {
    const { m } = models([{ name: "a", threshold: 0.5, scale: "int16", scores: [0.125, 0.875] }]);
    const p = new WakePipeline(m);
    for (let i = 0; i < 16; i++) await p.feed(chunk());
    p.reset();
    for (let i = 0; i < 15; i++) expect((await p.feed(chunk())).fired).toBe(false);
    expect(await p.feed(chunk())).toEqual({ fired: true, score: 0.875, head: "a" });
  });

  test("a patient head fires only once it has scored over its threshold that many chunks in a row", async () => {
    const { m } = models([{ name: "a", threshold: 0.5, scale: "int16", patience: 3, scores: [0.75, 0.75, 0.25, 0.75, 0.75, 0.875, 0.75] }]);
    const p = new WakePipeline(m);
    for (let i = 0; i < 15; i++) await p.feed(chunk());
    // Two over, then one under: the run starts again.
    expect(await p.feed(chunk())).toEqual({ fired: false, score: 0.75, head: "a" });
    expect((await p.feed(chunk())).fired).toBe(false);
    expect((await p.feed(chunk())).fired).toBe(false);
    expect((await p.feed(chunk())).fired).toBe(false);
    expect((await p.feed(chunk())).fired).toBe(false);
    // The third in a row fires, and the run starts over after it.
    expect(await p.feed(chunk())).toEqual({ fired: true, score: 0.875, head: "a" });
    expect((await p.feed(chunk())).fired).toBe(false);
  });

  test("a reset forgets a run under way", async () => {
    const { m } = models([{ name: "a", threshold: 0.5, scale: "int16", patience: 2, scores: [0.75, 0.75, 0.75] }]);
    const p = new WakePipeline(m);
    for (let i = 0; i < 16; i++) await p.feed(chunk());
    p.reset();
    for (let i = 0; i < 16; i++) expect((await p.feed(chunk())).fired).toBe(false);
    expect(await p.feed(chunk())).toEqual({ fired: true, score: 0.75, head: "a" });
  });
});
