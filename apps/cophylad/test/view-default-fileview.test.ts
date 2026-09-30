// The default view's file viewer, its parts that need no page (model.ts): which grammar colours a
// file, by its whole name or its extension, and a fence's info string; a file's lines as the
// gutter numbers them; what its head and its note say; why it could not be shown; and what a
// copy of lines selected takes. Every grammar it can name is one the view vendors, pinned.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FileText } from "@cophyla/protocol";
import { VENDOR_DIR } from "../scripts/vendor-view.ts";
import { bytesOf, FIND_MAX, fileErrorWords, fileLanguage, fileLines, findInLines, findWords, GRAMMARS, grammarName, imageKind, isHtml, isPdf, linesBetween, listedKind, pathsIn, readsWhole, relativeFile, relUnder, resolveRel, underListedFolder, VIEWER_WIDTH, viewerMeta, viewerNote, viewerTab, viewerWidth } from "../views/default/model.ts";

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
    expect(viewerMeta(file({ path: "blob.bin", binary: true, text: undefined }), undefined)).toBe("Binary · 1.2 KB");
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
    expect(fileErrorWords("denied", "out/x: outside the folder")).toBe("out/x: outside the folder");
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
    expect(found("http://localhost:4931/x/y and git@github.com:cophyla/cophyla")).toEqual([]);
    expect(found("/etc/nginx/nginx.conf")).toEqual([["/etc/nginx/nginx.conf", "/etc/nginx/nginx.conf", undefined]]);
  });

  test("a path with no extension counts once a separator is in it: a folder where one ends it, plain otherwise", () => {
    const found = (text: string) => pathsIn(text).map((p) => [text.slice(p.start, p.end), p.folder ?? false, p.plain ?? false]);
    expect(found("Ctrl+click apps/cophylad/src/ or C:\\D\\orchestrator\\apps")).toEqual([
      ["apps/cophylad/src/", true, false],
      ["C:\\D\\orchestrator\\apps", false, true],
    ]);
    expect(found("cd /home/me/Code; ls ./scripts and src\\lib\\ then a/b")).toEqual([
      ["/home/me/Code", false, true],
      ["./scripts", false, true],
      ["src\\lib\\", true, false],
      ["a/b", false, true],
    ]);
    // A file's own path is neither, and a folder's name ends where a sentence does.
    expect(found("wrote src/app.py, see apps/web.")).toEqual([
      ["src/app.py", false, false],
      ["apps/web", false, true],
    ]);
    // Words with a slash are found too; the view keeps only the ones its Files knows (`underListedFolder`).
    expect(found("and/or 1/2 TCP/IP")).toEqual([
      ["and/or", false, true],
      ["1/2", false, true],
      ["TCP/IP", false, true],
    ]);
    // A root alone names nothing; a name without a separator or an extension is a word.
    expect(found("at / and C:\\ and ./ or Dockerfile")).toEqual([]);
    expect(found("/usr/lib/os-release")).toEqual([["/usr/lib/os-release", false, true]]);
  });

  test("which relative paths name a folder the explorer listed at its top, and what a listing says a path is", () => {
    const ex = {
      root: "C:\\D\\site",
      dirs: new Map([
        ["", { dir: "", entries: [{ name: "src", kind: "dir" as const }, { name: "README.md", kind: "file" as const }] }],
        ["src", { dir: "src", entries: [{ name: "lib", kind: "dir" as const }, { name: "Makefile", kind: "file" as const }] }],
      ]),
      loading: new Set<string>(),
    };
    expect(underListedFolder(ex, "src/lib")).toBe(true);
    expect(underListedFolder(ex, "./src/lib/")).toBe(true);
    expect(underListedFolder(ex, "src\\lib")).toBe(true);
    expect(underListedFolder(ex, "and/or")).toBe(false);
    expect(underListedFolder(ex, "README.md/x")).toBe(false);
    expect(underListedFolder(ex, "C:\\D\\site\\src")).toBe(false);
    expect(underListedFolder(undefined, "src/lib")).toBe(false);
    expect(listedKind(ex, "src")).toBe("dir");
    expect(listedKind(ex, "src/lib")).toBe("dir");
    expect(listedKind(ex, "src/Makefile")).toBe("file");
    expect(listedKind(ex, "src/lib/x")).toBeUndefined();
    expect(listedKind(ex, "nope")).toBeUndefined();
    expect(listedKind(ex, "")).toBe("dir");
    expect(listedKind(undefined, "src")).toBeUndefined();
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

  test("a viewer's tab, and its width beside the pane held to its bounds", () => {
    expect(viewerTab("sess_1", undefined)).toBe("sess_1");
    expect(viewerTab(undefined, "0c9e41b27a53")).toBe("terminal:0c9e41b27a53");
    expect(viewerTab(undefined, undefined)).toBeUndefined();
    expect(viewerWidth(undefined)).toBe(VIEWER_WIDTH.usual);
    expect(viewerWidth("60")).toBe(VIEWER_WIDTH.usual);
    expect(viewerWidth(5)).toBe(VIEWER_WIDTH.min);
    expect(viewerWidth(99)).toBe(VIEWER_WIDTH.max);
    expect(viewerWidth(55.55)).toBe(55.6);
  });

  test("a path under a folder, whatever its case or slashes where the folder's disk folds case; none outside it", () => {
    expect(relUnder("C:\\Users\\me", "c:/users/ME/notes/todo.md", "windows")).toBe("notes/todo.md");
    expect(relUnder("C:\\Users\\me", "C:\\Users\\me", "windows")).toBe("");
    expect(relUnder("C:\\Users\\me", "C:\\Users\\meg\\x.md", "windows")).toBeUndefined();
    expect(relUnder("/home/me", "/home/Me/x.md", "linux")).toBeUndefined();
    expect(relUnder("/home/me", "/home/me/src/x.md", "linux")).toBe("src/x.md");
  });

  test("an image by its extension, SVG among them; its size in pixels in the head once drawn; why one does not show", () => {
    expect(imageKind("Assets/icon.PNG")).toBe("PNG");
    expect(imageKind("shot.jpg")).toBe("JPEG");
    expect(imageKind("logo.svg")).toBe("SVG");
    expect(imageKind("png")).toBeUndefined();
    expect(imageKind("notes.md")).toBeUndefined();
    const png = file({ path: "icon.png", size: 2048, binary: true, text: undefined, mime: "image/png", base64: "iVBORw0KGgo=" });
    expect(viewerMeta(png, undefined, { width: 64, height: 32 })).toBe("PNG · 64 × 32 · 2 KB");
    expect(viewerNote(png)).toBe("");
    expect(viewerNote(file({ path: "huge.png", size: 70 * 1024 * 1024, binary: true, text: undefined }))).toBe("This image is too big to show here: 70 MB, past 64 MB.");
    // Sent as nothing though small enough: a node from before images came in pieces.
    expect(viewerNote(file({ path: "big.png", size: 12 * 1024 * 1024, binary: true, text: undefined }))).toBe("That computer's Cophyla is too old to show this image: update it there.");
    expect(viewerNote(file({ path: "scan.tif", size: 2048, binary: true, text: undefined }))).toBe("That computer's Cophyla is too old to show this image: update it there.");
    expect(viewerMeta(file({ path: "logo.svg", size: 300, text: "<svg/>" }), 1, { width: 24, height: 24 })).toBe("SVG · 24 × 24 · 1 line · 300 B");
  });

  test("a whole image: TIFF, HEIC and the rest by extension, drawn as the PNG its node made; why one does not show", () => {
    expect([imageKind("scan.TIFF"), imageKind("a/b.tif"), imageKind("photo.heic"), imageKind("x.HEIF"), imageKind("a.apng"), imageKind("old.jfif")]).toEqual(["TIFF", "TIFF", "HEIC", "HEIF", "APNG", "JPEG"]);
    expect([readsWhole("a.png"), readsWhole("scan.tif"), readsWhole("logo.svg"), readsWhole("notes.md")]).toEqual([true, true, false, false]);
    const tif = file({ path: "scan.tif", size: 44 * 1024 * 1024, text: undefined, mime: "image/png", base64: "iVBORw0KGgo=", at: 0, total: 8 });
    expect(viewerMeta(tif, undefined, { width: 4096, height: 2363 })).toBe("TIFF · shown at 4096 × 2363 · 44 MB");
    expect(viewerNote(tif)).toBe("");
    expect(viewerMeta(file({ path: "big.png", size: 20 * 1024 * 1024, text: undefined, mime: "image/png", base64: "iVBORw0KGgo=" }), undefined, { width: 3000, height: 2250 })).toBe("PNG · 3000 × 2250 · 20 MB");
    const heic = file({ path: "photo.heic", size: 500 * 1024, binary: true, text: undefined, note: "This computer has no decoder for HEIC images." });
    expect(viewerNote(heic)).toBe("This computer has no decoder for HEIC images.");
    expect(viewerMeta(heic, undefined)).toBe("HEIC · 500 KB");
  });

  test("a PDF read whole and drawn: its pages in the head; why one does not show", () => {
    expect([isPdf("docs/Guide.PDF"), isPdf("pdf"), isPdf("a.pdf.txt")]).toEqual([true, false, false]);
    expect(readsWhole("docs/guide.pdf")).toBe(true);
    const pdf = file({ path: "docs/guide.pdf", size: 1.2 * 1024 * 1024, text: undefined, mime: "application/pdf", base64: "JVBERi0=", at: 0, total: 5 });
    expect(viewerMeta(pdf, undefined, undefined, 12)).toBe("PDF · 12 pages · 1.2 MB");
    expect(viewerMeta(pdf, undefined, undefined, 1)).toBe("PDF · 1 page · 1.2 MB");
    expect(viewerMeta(pdf, undefined)).toBe("PDF · 1.2 MB");
    expect(viewerNote(pdf)).toBe("");
    expect(viewerNote(file({ path: "big.pdf", size: 100 * 1024 * 1024, binary: true, text: undefined }))).toBe("This PDF is too big to show here: 100 MB, past 64 MB.");
    // An older node reads a PDF as text, or as not text: either way it is too old to draw it.
    expect(viewerNote(file({ path: "a.pdf", size: 2048, binary: true, text: undefined }))).toBe("That computer's Cophyla is too old to show this PDF: update it there.");
    expect(viewerNote(file({ path: "a.pdf", size: 2048, text: "%PDF-1.7", truncated: true }))).toBe("That computer's Cophyla is too old to show this PDF: update it there.");
  });

  test("an HTML page is drawn by its extension; base64 comes back as its bytes, a slice at a time", () => {
    expect([isHtml("site/index.html"), isHtml("a.HTM"), isHtml("x.xhtml"), isHtml("App.vue"), isHtml("html")]).toEqual([true, true, true, false, false]);
    expect(fileLanguage("page.xhtml")).toBe("html");
    const bytes = Uint8Array.from({ length: 1000 }, (_, i) => (i * 37) % 256);
    expect(bytesOf(Buffer.from(bytes).toString("base64"))).toEqual(bytes);
    expect(bytesOf("")).toEqual(new Uint8Array(0));
    expect(Array.from(bytesOf("YQ=="))).toEqual([97]);
  });

  test("a link or an image in a file, resolved under the folder the viewer reads it from; nothing for the web or a climb out", () => {
    expect(resolveRel("docs/doc.md", "img/small.png")).toBe("docs/img/small.png");
    expect(resolveRel("docs/doc.md", "./img/a%20b.png?raw=1#top")).toBe("docs/img/a b.png");
    expect(resolveRel("docs/doc.md", "../README.md")).toBe("README.md");
    expect(resolveRel("docs/doc.md", "/assets/logo.png")).toBe("assets/logo.png");
    expect(resolveRel("README.md", "docs\\shot.png")).toBe("docs/shot.png");
    expect(resolveRel("README.md", "../outside.png")).toBeUndefined();
    expect(resolveRel("docs/doc.md", "https://example.com/x.png")).toBeUndefined();
    expect(resolveRel("docs/doc.md", "//cdn.example.com/x.png")).toBeUndefined();
    expect(resolveRel("docs/doc.md", "data:image/png;base64,AAAA")).toBeUndefined();
    expect(resolveRel("docs/doc.md", "C:/Windows/x.png")).toBeUndefined();
    expect(resolveRel("docs/doc.md", "#top")).toBeUndefined();
  });

  test("a search's matches by line, any case unless asked, the words taken as written; its count", () => {
    const lines = ["def ship(job):", "    Ship it (job.retries)", "", "ship ship"];
    expect(findInLines(lines, "ship", false)).toEqual([
      { line: 0, start: 4, end: 8 },
      { line: 1, start: 4, end: 8 },
      { line: 3, start: 0, end: 4 },
      { line: 3, start: 5, end: 9 },
    ]);
    expect(findInLines(lines, "Ship", true)).toEqual([{ line: 1, start: 4, end: 8 }]);
    expect(findInLines(lines, "job.retries)", false)).toEqual([{ line: 1, start: 13, end: 25 }]);
    expect(findInLines(lines, "", false)).toEqual([]);
    expect(findInLines(Array.from({ length: FIND_MAX + 10 }, () => "x"), "x", false).length).toBe(FIND_MAX);
    expect(findWords("ship", 4, 1)).toBe("2 of 4");
    expect(findWords("ship", 0, 0)).toBe("No results");
    expect(findWords("", 0, 0)).toBe("");
    expect(findWords("x", FIND_MAX, 0)).toBe(`1 of ${FIND_MAX}+`);
  });

  test("a copy takes the file's own text between two points, blank lines and tabs kept", () => {
    const lines = ["def f():", "\treturn 1", "", "x = f()"];
    expect(linesBetween(lines, [0, 4], [0, 5])).toBe("f");
    expect(linesBetween(lines, [0, 4], [3, 1])).toBe("f():\n\treturn 1\n\nx");
    expect(linesBetween(lines, [1, 0], [2, 0])).toBe("\treturn 1\n");
    expect(linesBetween(lines, [3, 1], [0, 0])).toBe("");
  });
});
