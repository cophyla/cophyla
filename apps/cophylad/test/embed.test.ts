// The embedder and its tokenizer against the real model, when `fetch-models.ts` has run:
// token ids pinned by the fixture, unit vectors, a semantic nearest neighbour, and the
// timings the store's design leans on. Without the model directory the suite is skipped
// and `loadEmbedder` reports the full-text-only fallback.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MODEL_DIR } from "../src/daemon.ts";
import { createLogger, silentLogger } from "../src/log.ts";
import { Store } from "../src/store/index.ts";
import { loadEmbedder, normalise, readManifest } from "../src/store/index/embed.ts";
import { loadTokenizer } from "../src/store/index/tokenizer.ts";

const MODEL = existsSync(join(DEFAULT_MODEL_DIR, "manifest.json"));
const THREAD = "thr_01ARZ3NDEKTSV4RRFFQ69G5FB3";

const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, v, i) => s + v * b[i]!, 0);

describe("embed", () => {
  test("no model directory: no embedder, logged once", async () => {
    const lines: string[] = [];
    const log = createLogger("info", (l) => lines.push(l));
    expect(await loadEmbedder(join(DEFAULT_MODEL_DIR, "..", "nope"), log)).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("full-text only");
    expect(readManifest("C:\\nowhere")).toBeUndefined();
  });

  test("normalise gives a unit vector and leaves zero alone", () => {
    const v = normalise(new Float32Array([3, 4]));
    expect(Array.from(v)).toEqual([0.6000000238418579, 0.800000011920929]);
    expect(Array.from(normalise(new Float32Array([0, 0])))).toEqual([0, 0]);
  });

  test.skipIf(!MODEL)("the tokenizer's ids match the reference fixture, truncation keeps [SEP]", () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "wordpiece.json"), "utf8")) as { cases: { text: string; maxTokens: number; ids: number[] }[] };
    const tok = loadTokenizer(DEFAULT_MODEL_DIR);
    for (const c of fixture.cases) expect(tok.encode(c.text, c.maxTokens).ids).toEqual(c.ids);
    const cut = tok.encode("word ".repeat(400), 8).ids;
    expect(cut).toHaveLength(8);
    expect(cut[0]).toBe(101);
    expect(cut[7]).toBe(102);
  });

  test.skipIf(!MODEL)("the model gives unit vectors, ranks the paraphrase nearest, and runs in a few milliseconds", async () => {
    const embedder = (await loadEmbedder(DEFAULT_MODEL_DIR, silentLogger))!;
    expect(embedder).toBeDefined();
    expect(embedder.dim).toBe(384);
    expect(embedder.model.startsWith("bge-small-en-v1.5@")).toBe(true);
    const [a, b, c] = await embedder.embed(["the deploy step runs after the gate tests pass", "deployment happens once the tests are green", "my cat likes to sleep on the windowsill"]);
    for (const v of [a!, b!, c!]) expect(Math.abs(dot(v, v) - 1)).toBeLessThan(1e-4);
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
    expect(dot(a!, b!)).toBeGreaterThan(0.6);
    const n = 20;
    const texts = Array.from({ length: n }, (_, i) => `message number ${i} about the gate tests and the deploy step, with a little more text to make it realistic`);
    const t0 = performance.now();
    await embedder.embed(texts);
    const perChunk = (performance.now() - t0) / n;
    console.log(`embed: ${perChunk.toFixed(1)} ms per chunk`);
    expect(perChunk).toBeLessThan(200);
    await embedder.close();
  });

  test.skipIf(!MODEL)("through the store: a message is vector-searchable within a second, and recall answers fast", async () => {
    const s = new Store(":memory:");
    s.migrate();
    s.threads.insert({ id: THREAD, startedAt: 1, tags: [], sessions: [] });
    const say = (id: string, text: string, at: number) => s.messages.insert({ id, thread: THREAD, at, role: "user", source: "ui", content: [{ type: "text", text }] });
    say("msg_01ARZ3NDEKTSV4RRFFQ69G5F01", "we agreed to ship the release only after the gate tests pass", 1);
    say("msg_01ARZ3NDEKTSV4RRFFQ69G5F02", "the cat sat on the windowsill all afternoon", 2);
    say("msg_01ARZ3NDEKTSV4RRFFQ69G5F03", "remember to water the plants on friday", 3);
    await s.index.start({ embedder: loadEmbedder(DEFAULT_MODEL_DIR, silentLogger), log: silentLogger });
    await s.index.settled();
    expect(s.index.vectorCount).toBe(3);
    const t0 = performance.now();
    say("msg_01ARZ3NDEKTSV4RRFFQ69G5F04", "deployment is blocked until the test suite is green", 4);
    await s.index.settled();
    expect(performance.now() - t0).toBeLessThan(1000);
    // No word in common with the query except "deploy": the vector leg carries it.
    const t1 = performance.now();
    const hits = await s.index.recall({ query: "when do we deploy?" });
    const ms = performance.now() - t1;
    console.log(`recall: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(500);
    const ids = hits.map((h) => (h.source as { message: string }).message);
    expect(ids.slice(0, 2).sort()).toEqual(["msg_01ARZ3NDEKTSV4RRFFQ69G5F01", "msg_01ARZ3NDEKTSV4RRFFQ69G5F04"]);
    await s.index.stop();
    s.close();
  });
});
