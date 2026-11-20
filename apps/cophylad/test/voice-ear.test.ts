// A message written for the eye, said for the ear: markdown's marks dropped, a code block named
// and not read, a table a row at a time, a link by its words or its site, a path by its file's
// name, each line a sentence, and a long one cut at a sentence with the listener told.

import { describe, expect, test } from "bun:test";
import { CODE_WORDS, CUT_WORDS, EAR_MAX, forTheEar } from "../src/voice/ear.ts";

describe("a message said for the ear", () => {
  test("headings, emphasis, bullets and quotes lose their marks; each line is a sentence", () => {
    const md = "## Migration done\n\nI moved **3 tables** and kept *orders* on the old schema.\n\n- `users` moved\n- __sessions__ moved\n1. first\n2) second\n> a quote\n- [x] checked\n\n---\n~~gone~~ word";
    expect(forTheEar(md)).toBe("Migration done. I moved 3 tables and kept orders on the old schema. users moved. sessions moved. first. second. a quote. checked. gone word.");
  });

  test("a code block is named once and not read; one left open runs to the end", () => {
    expect(forTheEar("Run this:\n```bash\nrm -rf build\nbun run build\n```\nThen it works.")).toBe(`Run this: ${CODE_WORDS} Then it works.`);
    expect(forTheEar("Two:\n~~~\na\n~~~\nand\n````ts\n```\nnot closed by a shorter fence\n````\ndone")).toBe(`Two: ${CODE_WORDS} and. ${CODE_WORDS} done.`);
    expect(forTheEar("Open:\n```\nnever closed")).toBe(`Open: ${CODE_WORDS}`);
  });

  test("a table is read a row at a time, its rule left out", () => {
    expect(forTheEar("| Table | Rows |\n|---|---:|\n| users | 120 |\n| `orders` | 9 |")).toBe("Table, Rows. users, 120. orders, 9.");
  });

  test("a link by its words, a bare one by its site, a tag dropped", () => {
    expect(forTheEar("See [the PR](https://github.com/cophyla/cophyla/pull/12) and https://www.example.com/a/b?c=d <br> now")).toBe("See the PR and example.com now.");
  });

  test("a path by its file's name: a drive's, the root's, a share's, or a relative one with a file", () => {
    expect(forTheEar("Edited C:\\work\\api\\migrations\\0042.sql and /home/me/app/src/main.ts, see `apps/cophylad/src/voice/ear.ts`.")).toBe("Edited 0042.sql and main.ts, see ear.ts.");
    expect(forTheEar("On \\\\server\\share\\notes.md, at src/ and 1/2 of it, e.g. v1.2.")).toBe("On notes.md, at src/ and 1/2 of it, e.g. v1.2.");
  });

  test("a long message stops at a sentence, and says the rest is on screen", () => {
    const long = Array.from({ length: 3000 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const said = forTheEar(long);
    expect(said.length).toBeLessThanOrEqual(EAR_MAX + CUT_WORDS.length + 1);
    expect(said.endsWith(`is here. ${CUT_WORDS}`)).toBe(true);
    expect(forTheEar("")).toBe("");
    expect(forTheEar("```\nonly code\n```")).toBe(CODE_WORDS);
  });
});
