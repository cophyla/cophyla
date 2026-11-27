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
  test("says when a read left more than it takes, whether the file grew by its size alone, and reads again from a line it rewinds to", () => {
    const path = join(tempHome(), "r.jsonl");
    writeFileSync(path, ['{"n":1}', '{"n":2}', '{"n":3}'].map((l) => l + "\r\n").join(""));
    const tail = new Tail(path, { maxRead: 12 });
    expect(tail.read().map((l) => l.text)).toEqual(['{"n":1}']);
    expect(tail.behind).toBe(true);
    expect(tail.unchanged()).toBe(false);
    const rest = [...tail.read(), ...tail.read()];
    expect(rest.map((l) => l.text)).toEqual(['{"n":2}', '{"n":3}']);
    expect(tail.behind).toBe(false);
    expect(tail.unchanged()).toBe(true);
    // the line at 9 handed out and not taken: read again from it
    expect(rest[0]!.offset).toBe(9);
    tail.rewind(rest[0]!.offset);
    expect([...tail.read(), ...tail.read()].map((l) => l.text)).toEqual(['{"n":2}', '{"n":3}']);
    appendFileSync(path, '{"n":4}\n');
    expect(tail.unchanged()).toBe(false);
    expect(tail.read().map((l) => l.text)).toEqual(['{"n":4}']);
  });
});
