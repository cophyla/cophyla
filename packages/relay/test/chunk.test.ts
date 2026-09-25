// A record cut into data-channel messages comes back whole, however it was cut; the vectors
// are the ones the helper's tests read too, so both sides agree on the message size.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chunk, CHUNK_MAX, ChunkError, Reassembler } from "../src/chunk.ts";
import { derive, ephemeral, pskFromSecret } from "../src/tunnel.ts";

const vectors = JSON.parse(readFileSync(join(import.meta.dir, "chunk-vectors.json"), "utf8")) as {
  chunkMax: number;
  vectors: { why: string; max: number; record: string; messages: string[] }[];
};

describe("chunk", () => {
  test("the vectors' message size is the one this side uses", () => {
    expect(vectors.chunkMax).toBe(CHUNK_MAX);
  });

  for (const v of vectors.vectors) {
    test(v.why, () => {
      expect(chunk(v.record, v.max)).toEqual(v.messages);
      const r = new Reassembler();
      const out = v.messages.map((m) => r.push(m));
      expect(out.slice(0, -1).every((x) => x === undefined)).toBe(true);
      expect(out.at(-1)).toBe(v.record);
      expect(r.pending).toBe(0);
    });
  }

  test("every message of a large record fits, and the record comes back", () => {
    const record = "x".repeat(3 * CHUNK_MAX + 17);
    const messages = chunk(record);
    expect(messages.length).toBe(4);
    for (const m of messages) expect(m.length).toBeLessThanOrEqual(CHUNK_MAX);
    const r = new Reassembler();
    let whole: string | undefined;
    for (const m of messages) whole = r.push(m) ?? whole;
    expect(whole).toBe(record);
  });

  test("records follow each other on one reassembler", () => {
    const r = new Reassembler();
    const got: string[] = [];
    for (const rec of ["one", "t".repeat(40), "three"]) for (const m of chunk(rec, 8)) {
      const w = r.push(m);
      if (w !== undefined) got.push(w);
    }
    expect(got).toEqual(["one", "t".repeat(40), "three"]);
  });

  test("a message without a marker, and a record past the cap, are errors", () => {
    expect(() => new Reassembler().push("abc")).toThrow(ChunkError);
    const r = new Reassembler(10);
    r.push("+12345");
    expect(() => r.push("+678901")).toThrow(ChunkError);
    // the reassembler starts over after the refusal
    expect(r.pending).toBe(0);
  });

  test("a sealed record survives the cut; a piece lost makes it fail to open", async () => {
    const ea = await ephemeral();
    const eb = await ephemeral();
    const psk = await pskFromSecret("a grant key");
    const a = await derive("initiator", ea, eb.publicKey, psk, { kind: "direct", peer: "node_x" });
    const b = await derive("responder", eb, ea.publicKey, psk, { kind: "direct", peer: "node_x" });
    const frame = JSON.stringify({ jsonrpc: "2.0", method: "terminal.output", params: { data: "é".repeat(20_000) } });
    const pieces = chunk(await a.seal(frame));
    expect(pieces.length).toBeGreaterThan(1);
    const r = new Reassembler();
    let rec: string | undefined;
    for (const p of pieces) rec = r.push(p) ?? rec;
    expect(await b.open(rec!)).toBe(frame);
    // the next record with its middle piece gone never opens
    const next = chunk(await a.seal(frame));
    const r2 = new Reassembler();
    let broken: string | undefined;
    for (const p of next.filter((_, i) => i !== 1)) broken = r2.push(p) ?? broken;
    await expect(b.open(broken!)).rejects.toMatchObject({ code: "bad_record" });
  });

  test("a direct tunnel's keys are not the relay tunnel's, from the same secret and keys", async () => {
    const ea = await ephemeral();
    const eb = await ephemeral();
    const psk = await pskFromSecret("a grant key");
    const relay = await derive("initiator", ea, eb.publicKey, psk, { kind: "node", peer: "node_x" });
    const direct = await derive("responder", eb, ea.publicKey, psk, { kind: "direct", peer: "node_x" });
    await expect(direct.open(await relay.seal("hello"))).rejects.toMatchObject({ code: "bad_record" });
  });
});
