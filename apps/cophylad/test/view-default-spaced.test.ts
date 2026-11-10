// Paths with a space in a name, DOM-free. Found whole between quotes and backticks and as all of a
// code span's words; elsewhere found as far as the space, with the words after it when they could
// go on with it (a separator, or an extension after a last name with none). Then spelled out
// against a computer's names a folder at a time: the longest name the words begin with, ending
// where a name may end, through each folder; a sentence that runs on stays out; a folder that
// cannot be read takes the rest as written, one that can and holds nothing more ends the path.

import { describe, expect, test } from "bun:test";
import { linksIn, pathsIn } from "../views/default/model.ts";
import { nameEnds, spelledPath } from "../views/default/spaced.ts";
import type { Names } from "../views/default/spaced.ts";

const found = (text: string, whole = false) => pathsIn(text, { whole }).map((p) => ({ words: text.slice(p.start, p.end), path: p.path, ...(p.more !== undefined ? { more: p.more } : {}), ...(p.line !== undefined ? { line: p.line } : {}), ...(p.folder ? { folder: true } : {}), ...(p.plain ? { plain: true } : {}) }));

describe("a path with a space in a name, in words", () => {
  test("between quotes or backticks it is whole, spaces and all, its line its line still", () => {
    expect(found('ran "C:\\Program Files\\nodejs\\node.exe" just now')).toEqual([{ words: "C:\\Program Files\\nodejs\\node.exe", path: "C:\\Program Files\\nodejs\\node.exe" }]);
    expect(found("see `~/Google Drive/My Notes/todo.md:12` for it")).toEqual([{ words: "~/Google Drive/My Notes/todo.md:12", path: "~/Google Drive/My Notes/todo.md", line: 12 }]);
    expect(found("\u201C/Users/me/Library/Application Support/Code/\u201D")).toEqual([{ words: "/Users/me/Library/Application Support/Code/", path: "/Users/me/Library/Application Support/Code/", folder: true }]);
    expect(found("'C:\\Users\\me\\My Documents' holds it")[0]).toMatchObject({ path: "C:\\Users\\me\\My Documents", plain: true });
    // a quote with no close on the line is no quote around it
    expect(found('"C:\\My Docs\\a.md\nnext')[0]).toMatchObject({ path: "C:\\My", more: " Docs\\a.md" });
  });

  test("all of a code span's words are the path, when it begins them", () => {
    expect(found("C:\\Users\\me\\Desktop\\Screenshot 2026-11-10 103215.png", true)).toEqual([{ words: "C:\\Users\\me\\Desktop\\Screenshot 2026-11-10 103215.png", path: "C:\\Users\\me\\Desktop\\Screenshot 2026-11-10 103215.png" }]);
    // not all of them: words after the command are checked as anywhere else
    expect(found("cd C:\\Program Files\\x", true)[0]).toMatchObject({ path: "C:\\Program", more: " Files\\x" });
    // not a code span's: the same words are checked too
    expect(found("C:\\Users\\me\\Desktop\\Screenshot 2026-11-10 103215.png")[0]).toMatchObject({ path: "C:\\Users\\me\\Desktop\\Screenshot", more: " 2026-11-10 103215.png" });
  });

  test("elsewhere, as far as the space, with the words that may go on with it, up to what no name holds", () => {
    expect(found("ran C:\\Program Files\\nodejs\\node.exe and saw it")[0]).toEqual({ words: "C:\\Program", path: "C:\\Program", more: " Files\\nodejs\\node.exe and saw it", plain: true });
    expect(found("at /Users/me/Desktop/Screen Shot 2026-11-10 at 10.32.15 AM.png. Then")[0]).toMatchObject({ path: "/Users/me/Desktop/Screen", more: " Shot 2026-11-10 at 10.32.15 AM.png. Then" });
    expect(found("in ~/Google Drive/notes.md | done")[0]).toMatchObject({ path: "~/Google", more: " Drive/notes.md " });
    expect(found("/c/Program Files/Git/bin/bash.exe\tnext")[0]).toMatchObject({ path: "/c/Program", more: " Files/Git/bin/bash.exe" });
  });

  test("words that could not go on with it are no more of it: a name that has its extension, a sentence with neither, a relative path, a line", () => {
    expect(found("edited C:\\repo\\a.ts and b.ts")[0]).toEqual({ words: "C:\\repo\\a.ts", path: "C:\\repo\\a.ts" });
    expect(found("it lives in C:\\D\\Faircase and its tests too")[0]).toEqual({ words: "C:\\D\\Faircase", path: "C:\\D\\Faircase", plain: true });
    expect(found("see src/My Folder/x.ts")[0]).not.toHaveProperty("more");
    expect(found("C:\\x\\y.ts:12 and z/w.ts")[0]).not.toHaveProperty("more");
    // one that has its extension still goes on through a separator
    expect(found("C:\\v1.2 notes\\a.md")[0]).toMatchObject({ path: "C:\\v1.2", more: " notes\\a.md" });
  });

  test("a message's links take the same: a web address and a quoted path apart", () => {
    const text = 'see https://example.com/a b and "C:\\My Docs\\x.md"';
    expect(linksIn(text).map((l) => (l.kind === "web" ? l.url : l.path.path))).toEqual(["https://example.com/a", "C:\\My Docs\\x.md"]);
  });
});

/** A computer's names by folder, as the words spell it: `/` or `\` after each. */
function computer(tree: Record<string, Names>, failing: string[] = []): { list: (dir: string) => Promise<Names | undefined>; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    list: async (dir) => {
      asked.push(dir);
      return failing.includes(dir) ? undefined : tree[dir];
    },
  };
}

const spell = async (text: string, tree: Record<string, Names>, opts: { fold?: boolean; failing?: string[] } = {}) => {
  const p = pathsIn(text)[0]!;
  const c = computer(tree, opts.failing);
  const s = await spelledPath(p.path, p.more ?? "", c.list, opts.fold ?? true);
  return { words: s ? text.slice(p.start, p.start + s.length) : undefined, folder: s?.folder, asked: c.asked };
};

describe("a path with spaces, spelled against its computer's names", () => {
  test("a folder at a time, through each folder, to the file", async () => {
    const r = await spell("ran C:\\Program Files\\nodejs\\node.exe and saw it", {
      "C:\\": { folders: ["Program Files", "Program Files (x86)", "Users"], files: [] },
      "C:\\Program Files\\": { folders: ["nodejs", "Git"], files: [] },
      "C:\\Program Files\\nodejs\\": { folders: [], files: ["node.exe", "npm.cmd"] },
    });
    expect(r).toEqual({ words: "C:\\Program Files\\nodejs\\node.exe", folder: false, asked: ["C:\\", "C:\\Program Files\\", "C:\\Program Files\\nodejs\\"] });
  });

  test("a screenshot's name, with the stop that ends the sentence left out; the longest name the words begin with", async () => {
    const r = await spell("at /Users/me/Desktop/Screen Shot 2026-11-10 at 10.32.15 AM.png. Then", {
      "/Users/me/Desktop/": { folders: ["Screen"], files: ["Screen Shot 2026-11-10 at 10.32.15 AM.png", "Screen Shot 2026-11-10 at 10.32.15 AM.png.bak"] },
    }, { fold: false });
    expect(r.words).toBe("/Users/me/Desktop/Screen Shot 2026-11-10 at 10.32.15 AM.png");
  });

  test("a sentence that runs on stays out: only names that are there count", async () => {
    const r = await spell("it lives in C:\\D\\Faircase and its tests in tests.py", { "C:\\D\\": { folders: ["Faircase", "orchestrator"], files: [] } });
    expect(r.words).toBeUndefined();
    // a name must hold the words the path had before the space
    const longer = await spell("in C:\\D\\Faircase-old and new\\x.md", { "C:\\D\\": { folders: ["Faircase", "Faircase-old and new"], files: [] }, "C:\\D\\Faircase-old and new\\": { folders: [], files: ["x.md"] } });
    expect(longer.words).toBe("C:\\D\\Faircase-old and new\\x.md");
    const shorter = await spell("in C:\\D\\Faircase-old and new.md", { "C:\\D\\": { folders: ["Faircase"], files: [] } });
    expect(shorter.words).toBeUndefined();
  });

  test("names compared as the computer does: without case on Windows and a Mac, with it elsewhere", async () => {
    const tree = { "C:\\Users\\me\\": { folders: ["My Documents"], files: [] }, "C:\\Users\\me\\my documents\\": { folders: [], files: ["Report.PDF"] } };
    expect((await spell("C:\\Users\\me\\my documents\\report.pdf", tree)).words).toBe("C:\\Users\\me\\my documents\\report.pdf");
    expect((await spell("/home/me/my documents/x", { "/home/me/": { folders: ["My Documents"], files: [] } }, { fold: false })).words).toBeUndefined();
  });

  test("a folder the words end at is the folder; one that holds nothing more ends the path there", async () => {
    const tree = { "C:\\Users\\me\\": { folders: ["My Documents"], files: [] }, "C:\\Users\\me\\My Documents\\": { folders: [], files: ["a.txt"] } };
    expect(await spell("open C:\\Users\\me\\My Documents\\ now", tree)).toMatchObject({ words: "C:\\Users\\me\\My Documents\\", folder: true });
    expect(await spell("open C:\\Users\\me\\My Documents\\notes about it", tree)).toMatchObject({ words: "C:\\Users\\me\\My Documents\\", folder: true });
  });

  test("past a folder that cannot be read, what follows with no space is taken as written; none read at all, nothing", async () => {
    const tree = { "C:\\Users\\me\\": { folders: ["My Documents"], files: [] } };
    expect(await spell("open C:\\Users\\me\\My Documents\\report.pdf, then", tree, { failing: ["C:\\Users\\me\\My Documents\\"] })).toMatchObject({ words: "C:\\Users\\me\\My Documents\\report.pdf", folder: false });
    expect((await spell("open C:\\Users\\me\\My Documents\\report.pdf", tree, { failing: ["C:\\Users\\me\\"] })).words).toBeUndefined();
  });

  test("where a name may end", () => {
    expect([nameEnds("a b", 1), nameEnds("ab", 2), nameEnds("a/b", 1), nameEnds("a, b", 1), nameEnds("a. B", 1), nameEnds("a.png", 1), nameEnds("ab", 1), nameEnds("a)", 1)]).toEqual([true, true, true, true, true, false, false, true]);
  });
});
