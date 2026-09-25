// Prompts and memory as markdown files with frontmatter: parse and serialise round-trips,
// list, ranked substring search, read, write, delete, and the name rule.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryFiles } from "../src/editable/memory.ts";
import { parseMarkdown, serialiseMarkdown } from "../src/editable/markdown.ts";
import { placeholders, Prompts } from "../src/editable/prompts.ts";
import { tempHome } from "./helpers.ts";

describe("markdown frontmatter", () => {
  test("parses scalars, inline lists and block lists; a file without a fence is all body", () => {
    const p = parseMarkdown('---\ndescription: "Who: the user"\nkind: user\ntags: [a, "b c"]\nvariables:\n  - x\n  - y\n# comment\n---\n\nBody line\n\nmore\n');
    expect(p.frontmatter).toEqual({ description: "Who: the user", kind: "user", tags: ["a", "b c"], variables: ["x", "y"] });
    expect(p.body).toBe("Body line\n\nmore\n");
    expect(parseMarkdown("just text")).toEqual({ frontmatter: {}, body: "just text" });
    expect(parseMarkdown("---\nunterminated")).toEqual({ frontmatter: {}, body: "---\nunterminated" });
  });

  test("serialise then parse is the identity, with quoting where needed", () => {
    const fm = { description: "a: tricky value", kind: "decision", tags: ["x", "true", "two words"], empty: [] };
    const text = serialiseMarkdown(fm, "body\n\n");
    expect(text).toBe('---\ndescription: "a: tricky value"\nkind: decision\ntags: [x, "true", two words]\nempty: []\n---\nbody\n');
    expect(parseMarkdown(text).frontmatter).toEqual(fm);
  });
});

describe("prompts and memory", () => {
  test("prompts: write, list, search, read, delete; variables from the body when not declared", () => {
    const home = tempHome();
    const prompts = new Prompts(join(home, "prompts"));
    expect(prompts.list()).toEqual([]);
    const p = prompts.write({ name: "review", description: "Review a diff", tags: ["code"], body: "Review {{diff}} for {{focus}} and {{diff}} again." });
    expect(p.variables).toEqual(["diff", "focus"]);
    expect(p.tags).toEqual(["code"]);
    expect(placeholders("{{ a }} {{b}}")).toEqual(["a", "b"]);
    prompts.write({ name: "plan", body: "Plan it", variables: ["explicit"] });
    expect(prompts.list().map((m) => m.name)).toEqual(["plan", "review"]);
    expect(Object.keys(prompts.list()[1]!)).not.toContain("body");
    expect(prompts.search("review").map((m) => m.name)).toEqual(["review"]);
    expect(prompts.search("plan diff").map((m) => m.name)).toEqual(["plan", "review"]);
    expect(prompts.search("").map((m) => m.name)).toEqual(["plan", "review"]);
    expect(prompts.read("plan").variables).toEqual(["explicit"]);
    expect(readFileSync(join(home, "prompts", "review.md"), "utf8")).toContain("variables: [diff, focus]");
    expect(prompts.delete("plan")).toBe(true);
    expect(prompts.delete("plan")).toBe(false);
    expect(() => prompts.read("plan")).toThrow(/no plan/);
    expect(() => prompts.write({ name: "Bad Name", body: "" })).toThrow(/bad name/);
    expect(() => prompts.read("../etc")).toThrow(/bad name/);
    // A hand-written file with no frontmatter is listed with what it has.
    writeFileSync(join(home, "prompts", "raw.md"), "Just a body\n");
    expect(prompts.read("raw")).toMatchObject({ name: "raw", tags: [], body: "Just a body\n" });
    rmSync(home, { recursive: true, force: true });
  });

  test("memory: kinds, ranked search over name, description and body", () => {
    const home = tempHome();
    const memory = new MemoryFiles(join(home, "memory"));
    memory.write({ name: "user", kind: "user", description: "who the user is", body: "A solo developer." });
    memory.write({ name: "prefers-short", kind: "preference", body: "Short answers. Brevity is liked.", tags: ["style"] });
    memory.write({ name: "odd", kind: "bogus" as "user", body: "user mentioned here" });
    expect(memory.list().map((m) => [m.name, m.kind])).toEqual([
      ["odd", undefined],
      ["prefers-short", "preference"],
      ["user", "user"],
    ]);
    expect(memory.search("user").map((m) => m.name)).toEqual(["user", "odd"]);
    expect(memory.read("prefers-short")).toMatchObject({ kind: "preference", tags: ["style"], body: "Short answers. Brevity is liked.\n" });
    expect(memory.delete("odd")).toBe(true);
    expect(existsSync(join(home, "memory", "odd.md"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});
