// The default view's file viewer, its parts that need no page (model.ts): which grammar colours a
// file, by its whole name or its extension, and a fence's info string; a file's lines as the
// gutter numbers them; what its head and its note say; why it could not be shown; and what a
// copy of lines selected takes. Every grammar it can name is one the view vendors, pinned.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FileText } from "@cophyla/protocol";
import { VENDOR_DIR } from "../scripts/vendor-view.ts";
import { fileErrorWords, fileLanguage, fileLines, GRAMMARS, grammarName, linesBetween, pathsIn, relativeFile, viewerMeta, viewerNote } from "../views/default/model.ts";

const file = (over: Partial<FileText>): FileText => ({ path: "src/main.py", size: 1200, modified: 1, text: "x", ...over });

describe("view default file viewer", () => {
  test("a file's grammar by its extension or its whole name, any case; none for what has none", () => {
    expect(fileLanguage("src/main.py")).toBe("py");
    expect(fileLanguage("README.md")).toBe("md");
    expect(fileLanguage("apps/ui/host/main.TS")).toBe("ts");
    expect(fileLanguage("view.tsx")).toBe("ts");
    expect(fileLanguage("lib/parser.rs")).toBe("rs");
    expect(fileLanguage("Dockerfile")).toBe("docker");
    expect(fileLanguage("deploy/Makefile")).toBe("make");
    expect(fileLanguage(".gitignore")).toBe("ini");
    expect(fileLanguage("notes.txt")).toBe("todo");
    expect(fileLanguage("config.yml")).toBe("yaml");
    expect(fileLanguage("icon.png")).toBeUndefined();
    expect(fileLanguage("LICENSE")).toBeUndefined();
    // a name that is a language only as a whole: `make.py` is Python
    expect(fileLanguage("tools/make.py")).toBe("py");
  });

  test("a fence's language by any name it goes by; nothing outside the grammars ever named", () => {
    expect(grammarName("Python")).toBe("py");
    expect(grammarName("typescript")).toBe("ts");
    expect(grammarName("sh")).toBe("bash");
    expect(grammarName("jsonc")).toBe("json");
    expect(grammarName("../../view")).toBeUndefined();
    expect(grammarName("constructor")).toBeUndefined();
    expect(grammarName("__proto__")).toBeUndefined();
    for (const name of Object.keys(GRAMMARS)) expect(existsSync(join(VENDOR_DIR, "shj", `${name}.js`))).toBe(true);
  });

  test("lines by any ending, and no empty one after the last line's own ending", () => {
    expect(fileLines("a\nb\n")).toEqual(["a", "b"]);
    expect(fileLines("a\r\nb\rc")).toEqual(["a", "b", "c"]);
    expect(fileLines("a\n\n")).toEqual(["a", ""]);
    expect(fileLines("")).toEqual([""]);
    expect(fileLines("\n")).toEqual([""]);
  });

  test("the head says the language, the lines and the size; the note says what does not show", () => {
    expect(viewerMeta(file({}), 42)).toBe("Python · 42 lines · 1.2 KB");
    expect(viewerMeta(file({ path: "notes.txt", size: 10 }), 1)).toBe("Text · 1 line · 10 B");
    expect(viewerMeta(file({ path: "icon.png", binary: true, text: undefined }), undefined)).toBe("Binary · 1.2 KB");
    expect(viewerMeta(file({ size: 5 * 1024 * 1024, truncated: true }), 20000)).toBe(`Python · ${(20000).toLocaleString()} lines shown · 5 MB`);
    expect(viewerNote(file({}))).toBe("");
    expect(viewerNote(file({ binary: true, text: undefined }))).toBe("This file is not text, so there is nothing to show.");
    expect(viewerNote(file({ size: 5 * 1024 * 1024, truncated: true, text: "x".repeat(1024 * 1024) }))).toBe("Only the first 1 MB of 5 MB shows.");
    expect(viewerNote(file({ size: 1.3 * 1024 * 1024, truncated: true, text: "x".repeat(1024 * 1024) }))).toBe("Only the first 1 MB of 1.3 MB shows.");
    expect(viewerMeta(file({ size: 40 * 1024 * 1024 }), 1)).toBe("Python · 1 line · 40 MB");
  });

  test("why a file did not show: an app or a node too old, gone, a folder, or the node's words", () => {
    expect(fileErrorWords("unsupported", "unknown method session.file")).toBe("This app cannot show files yet: update it.");
    expect(fileErrorWords("unsupported", "session.file is not served over the node link")).toBe("That computer cannot show its files yet: update Cophyla there.");
    expect(fileErrorWords("not_found", "a.md: no such file")).toBe("There is no such file, or it has gone.");
    expect(fileErrorWords("invalid", "src: a folder")).toBe("That is a folder, not a file.");
    expect(fileErrorWords("denied", "out/x: outside the session's folder")).toBe("out/x: outside the session's folder");
  });

  test("the paths a terminal's row names, with their line; not a URL's, a version's or a word's", () => {
    const found = (text: string) => pathsIn(text).map((p) => [text.slice(p.start, p.end), p.path, p.line]);
    expect(found("● Read(apps/cophylad/src/main.ts)")).toEqual([["apps/cophylad/src/main.ts", "apps/cophylad/src/main.ts", undefined]]);
    expect(found("  ⎿  Updated src\\app.py with 2 additions")).toEqual([["src\\app.py", "src\\app.py", undefined]]);
    expect(found("error in C:\\repo\\lib\\x.ts:12:5 and ./notes.md:3.")).toEqual([
      ["C:\\repo\\lib\\x.ts:12:5", "C:\\repo\\lib\\x.ts", 12],
      ["./notes.md:3", "./notes.md", 3],
    ]);
    expect(found("see README.md, main.py and Dockerfile.")).toEqual([
      ["README.md", "README.md", undefined],
      ["main.py", "main.py", undefined],
    ]);
    expect(found("e.g. v1.2.3 is out; example.com is up")).toEqual([]);
    expect(found("https://github.com/cophyla/cophyla/blob/master/README.md")).toEqual([]);
    expect(found("/usr/lib/os-release")).toEqual([]);
    expect(found("/etc/nginx/nginx.conf")).toEqual([["/etc/nginx/nginx.conf", "/etc/nginx/nginx.conf", undefined]]);
  });

  test("a relative path as the explorer keys it; none for one that climbs out or is absolute", () => {
    expect(relativeFile("src/main.py")).toBe("src/main.py");
    expect(relativeFile("./src\\deep\\x.ts")).toBe("src/deep/x.ts");
    expect(relativeFile("../other/x.ts")).toBeUndefined();
    expect(relativeFile("src/../../x.ts")).toBeUndefined();
    expect(relativeFile("C:\\repo\\x.ts")).toBeUndefined();
    expect(relativeFile("/etc/hosts")).toBeUndefined();
    expect(relativeFile("src//x.ts")).toBeUndefined();
  });

  test("a copy takes the file's own text between two points, blank lines and tabs kept", () => {
    const lines = ["def f():", "\treturn 1", "", "x = f()"];
    expect(linesBetween(lines, [0, 4], [0, 5])).toBe("f");
    expect(linesBetween(lines, [0, 4], [3, 1])).toBe("f():\n\treturn 1\n\nx");
    expect(linesBetween(lines, [1, 0], [2, 0])).toBe("\treturn 1\n");
    expect(linesBetween(lines, [3, 1], [0, 0])).toBe("");
  });
});
