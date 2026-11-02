// The transcript tail: a file bigger than one read is read in pieces over several calls, every
// line handed out once, whole, at its offset, a line cut by a piece's end waiting for the next.

import { describe, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Tail } from "../src/sessions/tail.ts";
import { tempHome } from "./helpers.ts";

describe("tail", () => {
  test("reads a big file in bounded pieces, each line once and whole", () => {
    const path = join(tempHome(), "t.jsonl");
    const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ n: i, pad: "x".repeat(i % 7) }));
    writeFileSync(path, lines.map((l) => l + "\n").join(""));
    const tail = new Tail(path, { maxRead: 64 });
    const got: { text: string; offset: number }[] = [];
    let calls = 0;
    for (let batch = tail.read(); calls < 1000; batch = tail.read()) {
      calls++;
      got.push(...batch);
      if (tail.consumed === Tail.sizeOf(path)) break;
    }
    expect(calls).toBeGreaterThan(1);
    expect(got.map((l) => l.text)).toEqual(lines);
    let at = 0;
    for (const [i, l] of got.entries()) {
      expect(l.offset).toBe(at);
      at += lines[i]!.length + 1;
    }
    // What is appended later follows as before.
    appendFileSync(path, '{"n":"more"}\n');
    expect(tail.read().map((l) => l.text)).toEqual(['{"n":"more"}']);
  });
});
