// Path comparison per platform: case folds on Windows and macOS only, separators never
// matter, and "within" stops at a separator boundary.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { foldsCase, isWithin, pathKey, samePath } from "../src/sessions/paths.ts";

describe("paths", () => {
  test("folds case on win32 and darwin only", () => {
    expect(foldsCase("win32")).toBe(true);
    expect(foldsCase("darwin")).toBe(true);
    expect(foldsCase("linux")).toBe(false);
    expect(foldsCase("freebsd")).toBe(false);
    const dir = resolve("Some", "Dir");
    expect(pathKey(dir, "win32")).toBe(dir.toLowerCase());
    expect(pathKey(dir, "darwin")).toBe(dir.toLowerCase());
    expect(pathKey(dir, "linux")).toBe(dir);
  });

  test("macOS takes a name spelled in either Unicode form as the same; NTFS and ext4 do not", () => {
    const nfc = resolve("Belgeler", "Caf\u00e9");
    const nfd = resolve("Belgeler", "Cafe\u0301");
    expect(samePath(nfc, nfd, "darwin")).toBe(true);
    expect(isWithin(resolve(nfd, "notes.md"), nfc, "darwin")).toBe(true);
    expect(samePath(nfc, nfd, "linux")).toBe(false);
    expect(samePath(nfc, nfd, "win32")).toBe(false);
  });

  test("pathKey resolves and keeps the host's separators", () => {
    expect(pathKey("a/../b", "linux")).toBe(resolve("b"));
    expect(pathKey(resolve("x"), "linux")).toBe(resolve("x"));
  });

  test("samePath ignores separators and a trailing one, and folds case only where the platform does", () => {
    const base = resolve("Home", "Me");
    // Separators mixed: relative spellings, since an absolute POSIX path has no backslash form.
    expect(samePath("Home\\Me", "Home/Me", "linux")).toBe(true);
    expect(samePath("Home\\Me", base, "linux")).toBe(true);
    expect(samePath(base, base + "/", "linux")).toBe(true);
    expect(samePath(base, base.toLowerCase(), "win32")).toBe(true);
    expect(samePath(base, base.toLowerCase(), "darwin")).toBe(true);
    expect(samePath(base, base.toLowerCase(), "linux")).toBe(base === base.toLowerCase());
    expect(samePath(undefined, base)).toBe(false);
    expect(samePath(base, undefined)).toBe(false);
  });

  test("isWithin needs a separator boundary and takes the directory itself", () => {
    const dir = resolve("Home", "Me", ".claude");
    expect(isWithin(dir, dir, "linux")).toBe(true);
    expect(isWithin(dir + "/", dir, "linux")).toBe(true);
    expect(isWithin(resolve(dir, "projects", "t.jsonl"), dir, "linux")).toBe(true);
    expect(isWithin(dir + "-other/t.jsonl", dir, "linux")).toBe(false);
    expect(isWithin(resolve("Home", "Me"), dir, "linux")).toBe(false);
    expect(isWithin(resolve(dir.toUpperCase(), "t.jsonl"), dir, "win32")).toBe(true);
    expect(isWithin(resolve(dir.toUpperCase(), "t.jsonl"), dir, "linux")).toBe(dir === dir.toUpperCase());
    // separators mixed between the two sides
    expect(isWithin("Home\\Me\\.claude\\a\\b", "Home/Me/.claude", "linux")).toBe(true);
    expect(isWithin("Home/Me/.claude/a/b", "Home\\Me\\.claude", "linux")).toBe(true);
    expect(isWithin("Home\\Me\\.claude-x\\a", "Home/Me/.claude", "linux")).toBe(false);
  });
});
