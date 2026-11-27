// A child's output as whole lines: a line split across chunks is one line, CRLF and blank
// lines are taken care of, a line that never ends is cut at its cap, and the last line without
// a break comes out at the end. The transcript tail reads a slice at a time and says so.

import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lineSplitter } from "../src/rpc/lines.ts";
import { Tail, tailPace } from "../src/sessions/tail.ts";

describe("the line splitter", () => {
  test("a line across chunks is one line", () => {
    const lines: string[] = [];
    const s = lineSplitter((l) => lines.push(l));
    s.push("WARN direct.net hel");
    s.push("per: a warning\r\nsecond");
    s.push(" line\n\n  \nthird");
    expect(lines).toEqual(["WARN direct.net helper: a warning", "second line"]);
    s.end();
    expect(lines).toEqual(["WARN direct.net helper: a warning", "second line", "third"]);
  });

  test("a line that never ends is cut at its cap", () => {
    const lines: string[] = [];
    const s = lineSplitter((l) => lines.push(l), 8);
    s.push("0123456789abc");
    expect(lines).toEqual(["0123456789abc".slice(0, 8)]);
  });
});

describe("the transcript tail", () => {
  test("a big file is read a slice at a time, each saying more is left", () => {
    const dir = mkdtempSync(join(tmpdir(), "cophyla-test-tail-"));
    const path = join(dir, "t.jsonl");
    try {
      writeFileSync(path, "");
      for (let i = 0; i < 100; i++) appendFileSync(path, JSON.stringify({ i, pad: "x".repeat(100) }) + "\n");
      const tail = new Tail(path, { maxRead: 2048 });
      let n = 0;
      let slices = 0;
      for (;;) {
        tailPace.sliced = false;
        const lines = tail.read();
        n += lines.length;
        slices++;
        if (!tailPace.sliced) break;
      }
      expect(n).toBe(100);
      expect(slices).toBeGreaterThan(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
