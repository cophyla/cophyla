// What the chat's own session is told, cut into parts a harness carries whole: text that fits
// is one part, as it is; a longer one is cut between lines into labelled parts that each fit,
// in order, with nothing lost; a line longer than a part is sliced where it must be; past the
// most parts a telling may have, the last says the rest did not fit; and the cut always ends,
// down to a part barely larger than its label.

import { describe, expect, test } from "bun:test";
import { CLAUDE_PART_CHARS, CODEX_PART_CHARS, MAX_PARTS, parts } from "../src/assistant/context.ts";

const LABEL = /^\[cophyla context, part (\d+) of (\d+)\]\n/;

/** A part without the line that names it, and what that line said. */
function unlabel(part: string): { i: number; n: number; body: string } {
  const m = LABEL.exec(part);
  if (!m) throw new Error(`a part with no label: ${part.slice(0, 60)}`);
  return { i: Number(m[1]), n: Number(m[2]), body: part.slice(m[0].length) };
}

/** `count` numbered lines of `width` characters each. */
function lines(count: number, width: number): string[] {
  return Array.from({ length: count }, (_, i) => `${String(i).padStart(5, "0")} ${"x".repeat(width - 6)}`);
}

describe("parts", () => {
  test("text that fits is one part, as it is, with no label; no text is no part", () => {
    expect(parts("", 100)).toEqual([]);
    expect(parts("one line", 100)).toEqual(["one line"]);
    const exact = "a".repeat(50) + "\n" + "b".repeat(49);
    expect(exact.length).toBe(100);
    expect(parts(exact, 100)).toEqual([exact]);
  });

  test("a longer text is cut between lines into labelled parts that each fit, in order, with nothing lost", () => {
    for (const size of [200, CODEX_PART_CHARS, CLAUDE_PART_CHARS]) {
      const all = lines(Math.ceil((size * 2) / 40), 40);
      const text = all.join("\n");
      const out = parts(text, size);
      expect(out.length).toBeGreaterThan(1);
      expect(out.length).toBeLessThanOrEqual(MAX_PARTS);
      const cut = out.map(unlabel);
      // each says which it is, of how many
      expect(cut.map((p) => p.i)).toEqual(out.map((_, i) => i + 1));
      expect(cut.every((p) => p.n === out.length)).toBe(true);
      for (const p of out) expect(p.length).toBeLessThanOrEqual(size);
      // no line is cut in two, and joined again they are the text
      for (const p of cut) for (const line of p.body.split("\n")) expect(all).toContain(line);
      expect(cut.map((p) => p.body).join("\n")).toBe(text);
    }
  });

  test("a line longer than a part is sliced where it must be, what stood before and after it kept in order", () => {
    const size = 200;
    const long = "L".repeat(500);
    const text = ["before", long, "after"].join("\n");
    const out = parts(text, size, 10);
    const cut = out.map(unlabel);
    for (const p of out) expect(p.length).toBeLessThanOrEqual(size);
    expect(cut[0]!.body).toBe("before");
    // the slices of the line, whole when put together again; its tail shares a part with what follows
    expect(cut.map((p) => p.body).join("")).toBe(`before${long}\nafter`);
    expect(cut.at(-1)!.body.endsWith("\nafter")).toBe(true);
  });

  test("past the most parts a telling may have, the last says the rest did not fit", () => {
    const size = 400;
    const all = lines(200, 40);
    const out = parts(all.join("\n"), size);
    expect(out).toHaveLength(MAX_PARTS);
    const cut = out.map(unlabel);
    expect(cut.every((p) => p.n === MAX_PARTS)).toBe(true);
    for (const p of out) expect(p.length).toBeLessThanOrEqual(size);
    expect(cut.at(-1)!.body.endsWith("\n[cut here: the rest did not fit]")).toBe(true);
    // the parts before it are whole, and the text's first lines
    const whole = cut.slice(0, -1).flatMap((p) => p.body.split("\n"));
    expect(whole).toEqual(all.slice(0, whole.length));
    for (const p of cut.slice(0, -1)) expect(p.body).not.toContain("[cut here");
    // a caller may ask for fewer, or more
    expect(parts(all.join("\n"), size, 2)).toHaveLength(2);
    expect(unlabel(parts(all.join("\n"), size, 2)[1]!).body.endsWith("[cut here: the rest did not fit]")).toBe(true);
    const roomy = parts(all.join("\n"), size, 1000);
    expect(roomy.map((p) => unlabel(p).body).join("\n")).toBe(all.join("\n"));
  });

  test("text that fits exactly in the most parts is not marked as cut", () => {
    const size = 240;
    // Four lines of a part's room each: four parts, none over.
    const all = Array.from({ length: MAX_PARTS }, (_, i) => String(i).repeat(size - 40));
    const out = parts(all.join("\n"), size);
    expect(out.map((p) => unlabel(p).body)).toEqual(all);
    for (const p of out) expect(p.length).toBeLessThanOrEqual(size);
  });

  test("the cut ends for a part barely larger than its label, and for one line with no end in it", () => {
    // A size under the least a part holds is taken as that least: 200 characters, 160 of them the part's own.
    const out = parts("y".repeat(500), 41);
    expect(out).toHaveLength(MAX_PARTS);
    expect(unlabel(out[0]!).body).toBe("y".repeat(160));
    expect(out.map((p) => unlabel(p).body).join("")).toBe("y".repeat(500));
    const one = parts("z".repeat(CLAUDE_PART_CHARS * 3), CLAUDE_PART_CHARS);
    expect(one).toHaveLength(MAX_PARTS);
    for (const p of one) expect(p.length).toBeLessThanOrEqual(CLAUDE_PART_CHARS);
    const few = parts("z".repeat(CODEX_PART_CHARS * 2), CODEX_PART_CHARS);
    expect(few.map((p) => unlabel(p).body).join("")).toBe("z".repeat(CODEX_PART_CHARS * 2));
  });

  // A size of 40 or under leaves no room for a part's text beside its label: it is taken as the
  // least a part holds, so the cutting always ends. Every turn of the cutting adds a piece to a
  // list, so a count on the adding would turn a hang into a failure.
  test("a size too small to hold the line that names a part is refused, or served whole, rather than never ending", () => {
    const push = Array.prototype.push;
    let pieces = 0;
    Array.prototype.push = function (this: unknown[], ...items: unknown[]): number {
      if (++pieces > 10_000) throw new Error("still cutting after 10,000 pieces");
      return push.apply(this, items);
    };
    const ended = (size: number): string => {
      pieces = 0;
      try {
        parts("x".repeat(100), size);
      } catch (e) {
        // refusing the size is an end too
        if (e instanceof Error && e.message.startsWith("still cutting")) return e.message;
      }
      return "ended";
    };
    try {
      expect([40, 30, 1, 0].map(ended)).toEqual(["ended", "ended", "ended", "ended"]);
    } finally {
      Array.prototype.push = push;
    }
  });
});
