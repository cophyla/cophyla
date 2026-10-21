// What a transfer pulls, as the sending machine lists and opens it: a file is one entry; a
// folder its folders and files in order, each folder before what is in it, empty ones kept,
// a link or a junction left out and counted, never followed; a long listing comes a page at a
// time from the same walk; a drive's root and a folder past the cap are refused. A file of a
// folder is resolved again when its pipe opens: `..`, a link, and a link swapped in since the
// walk that leads out are refused, and so is a path a confined node does not share. Where it
// lands is the first free name, a file's number before its extension.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import { RpcError } from "@cophyla/protocol";
import { freeName, PART, sizeText } from "../src/transfers/index.ts";
import { resolveSource } from "../src/transfers/source.ts";
import { page, TreeCache, walk } from "../src/transfers/tree.ts";
import { removeHome, tempHome } from "./helpers.ts";

/** A junction on Windows (no privilege needed), a symbolic link elsewhere. */
function link(target: string, at: string): void {
  symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
}

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof RpcError ? e.code : `not an RpcError: ${String(e)}`;
  }
}

describe("the walk", () => {
  let scratch: string;
  let root: string;
  let outside: string;

  beforeAll(() => {
    scratch = tempHome();
    root = join(scratch, "project");
    outside = join(scratch, "elsewhere");
    mkdirSync(join(root, "b", "deep"), { recursive: true });
    mkdirSync(join(root, "a-empty"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, "z.txt"), "zz");
    writeFileSync(join(root, "b", "one.bin"), new Uint8Array(1000));
    writeFileSync(join(root, "b", "deep", "two.txt"), "two");
    writeFileSync(join(outside, "secret.txt"), "secret");
    link(outside, join(root, "b", "leads-out"));
  });

  afterAll(() => removeHome(scratch));

  test("a folder: its folders before what they hold, by name, empty ones kept, a link left out and counted", async () => {
    const t = await walk(root);
    expect(t.kind).toBe("folder");
    expect(t.name).toBe("project");
    expect(t.entries.map((e) => e.rel)).toEqual(["a-empty", "b", "b/deep", "b/deep/two.txt", "b/one.bin", "z.txt"]);
    expect(t.entries[0]).toEqual({ rel: "a-empty", dir: true });
    expect(t.entries.find((e) => e.rel === "b/one.bin")).toMatchObject({ size: 1000 });
    expect(t.total).toBe(1005);
    expect(t.files).toBe(3);
    expect(t.skipped).toBe(1);
    expect(t.entries.some((e) => e.rel.includes("secret"))).toBe(false);
  });

  test("a file is one entry under its own name", async () => {
    const t = await walk(join(root, "z.txt"));
    expect(t).toMatchObject({ kind: "file", name: "z.txt", total: 2, files: 1, skipped: 0 });
    expect(t.entries).toEqual([{ rel: "", size: 2, mtimeMs: t.entries[0]!.mtimeMs }]);
  });

  test("a relative path, a drive's root, a missing path and a folder past the cap are refused", async () => {
    expect(await code(walk("project"))).toBe("invalid");
    expect(await code(walk(parse(scratch).root))).toBe("invalid");
    expect(await code(walk(join(root, "nope")))).toBe("not_found");
    expect(await code(walk(root, { max: 3 }))).toBe("invalid");
  });

  test("a confined node's walk is refused outside what it shares", async () => {
    const require = (p: string) => {
      if (!p.startsWith(join(root, "b"))) throw new RpcError("denied", "outside");
    };
    expect(await code(walk(root, { require }))).toBe("denied");
    expect((await walk(join(root, "b"), { require })).files).toBe(2);
  });

  test("a long listing comes a page at a time, from the same walk", async () => {
    const t = await walk(root);
    const first = page(t, 0, 4);
    expect(first.entries.length).toBe(4);
    expect(first.next).toBe(4);
    expect(first.count).toBe(6);
    const last = page(t, 4, 4);
    expect(last.entries.map((e) => e.rel)).toEqual(["b/one.bin", "z.txt"]);
    expect(last.next).toBeUndefined();
    const cache = new TreeCache();
    const p1 = await cache.page(root, undefined);
    writeFileSync(join(root, "added-later.txt"), "x");
    // a later page is of the walk the first came from; a first page walks again
    expect((await cache.page(root, 1)).count).toBe(p1.count);
    expect((await cache.page(root, undefined)).count).toBe(p1.count + 1);
  });
});

describe("a pipe's file", () => {
  let scratch: string;
  let root: string;
  let outside: string;

  beforeAll(() => {
    scratch = tempHome();
    root = join(scratch, "send");
    outside = join(scratch, "elsewhere");
    mkdirSync(join(root, "sub"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, "sub", "f.txt"), "f");
    writeFileSync(join(outside, "secret.txt"), "secret");
  });

  afterAll(() => removeHome(scratch));

  test("a file of the folder is found under it", async () => {
    expect(await resolveSource({ path: root, rel: "sub/f.txt" })).toBe(join(root, "sub", "f.txt"));
    expect(await resolveSource({ path: join(root, "sub", "f.txt") })).toBe(join(root, "sub", "f.txt"));
  });

  test("`..`, a link, and a link swapped in since the walk are refused", async () => {
    expect(await code(resolveSource({ path: root, rel: "../elsewhere/secret.txt" }))).toBe("invalid");
    expect(await code(resolveSource({ path: root, rel: "sub/../../elsewhere/secret.txt" }))).toBe("invalid");
    link(outside, join(root, "swapped"));
    // the link itself, and a file through it
    expect(await code(resolveSource({ path: root, rel: "swapped" }))).toBe("denied");
    expect(await code(resolveSource({ path: root, rel: "swapped/secret.txt" }))).toBe("denied");
  });

  test("a confined node opens nothing outside what it shares", async () => {
    const require = (p: string) => {
      if (!p.startsWith(root)) throw new RpcError("denied", "outside");
    };
    expect(await code(resolveSource({ path: join(outside, "secret.txt") }, { require }))).toBe("denied");
    expect(await resolveSource({ path: root, rel: "sub/f.txt" }, { require })).toBe(join(root, "sub", "f.txt"));
  });
});

describe("where it lands", () => {
  let scratch: string;

  beforeAll(() => {
    scratch = tempHome();
    writeFileSync(join(scratch, "build.zip"), "1");
    writeFileSync(join(scratch, "build (1).zip"), "2");
    mkdirSync(join(scratch, "dist"));
    writeFileSync(join(scratch, "README"), "r");
  });

  afterAll(() => removeHome(scratch));

  test("the first free of name, name (1), …: a file's number before its extension, a folder's after its name", () => {
    expect(freeName(scratch, "build.zip", true)).toBe(join(scratch, "build (2).zip"));
    expect(freeName(scratch, "dist", false)).toBe(join(scratch, "dist (1)"));
    expect(freeName(scratch, "README", true)).toBe(join(scratch, "README (1)"));
    expect(freeName(scratch, ".env", true)).toBe(join(scratch, ".env"));
    expect(freeName(scratch, "new.txt", true)).toBe(join(scratch, "new.txt"));
  });

  test("a partial takes a name no other partial holds", () => {
    const held = new Set([join(scratch, `notes.txt${PART}`)]);
    expect(freeName(scratch, "notes.txt", true, (c) => held.has(c), PART)).toBe(join(scratch, `notes (1).txt${PART}`));
  });

  test("bytes as a person reads them", () => {
    expect(sizeText(512)).toBe("512 B");
    expect(sizeText(48 * 1024 * 1024)).toBe("48 MB");
    expect(sizeText(3.2 * 1024 ** 3)).toBe("3.2 GB");
    expect(sizeText(123 * 1024 + 7)).toBe("123 KB");
  });
});
