// A session's files for the view's explorer: the folders under its directory, folders first
// and then files, by name as a person reads it, without `.git`; a folder above it, through
// `..`, a drive or a link that leads out, refused with an error of its own; a long folder cut
// short and said so. Its repository read from a real git: the branch, what it tracks, the
// commits to push and to pull as of the last fetch, and the files changed; nothing outside a
// repository or without git, and one read at a time. Through a daemon: gated and audited as a
// read, the audit row keeping how much was listed and not the names.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcError } from "@cophyla/protocol";
import type { GitState } from "@cophyla/protocol";
import { decodeText, folderParts, parseGitStatus, SessionFiles } from "../src/sessions/files.ts";
import type { GitRunner } from "../src/sessions/files.ts";
import { stopDaemon, TestClient, testDaemon } from "./helpers.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cophyla-files-")));
  scratch.push(dir);
  return dir;
}

/** A link to a folder: a junction on Windows, which needs no privilege. */
function linkDir(target: string, at: string): void {
  symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
}

function filesFor(cwd: string, opts: { max?: number; textMax?: number; git?: GitRunner } = {}): SessionFiles {
  return new SessionFiles({ session: (id) => (id === "s1" ? { cwd } : undefined), ...opts });
}

describe("a session's folders", () => {
  test("folders first, then files, by name as read; .git left out; a folder a level at a time", async () => {
    const root = temp();
    for (const d of ["src", "Lib", ".git", "src/deep"]) mkdirSync(join(root, d), { recursive: true });
    for (const f of ["b.txt", "A.md", "file10.txt", "file2.txt", ".env", "src/index.ts"]) writeFileSync(join(root, f), "x");
    const files = filesFor(root);
    const r = await files.list("s1");
    expect(r.root).toBe(root);
    expect(r.dirs).toEqual([
      {
        dir: "",
        entries: [
          { name: "Lib", kind: "dir" },
          { name: "src", kind: "dir" },
          { name: ".env", kind: "file" },
          { name: "A.md", kind: "file" },
          { name: "b.txt", kind: "file" },
          { name: "file2.txt", kind: "file" },
          { name: "file10.txt", kind: "file" },
        ],
      },
    ]);
    const nested = await files.list("s1", ["src", "src/deep", "src"]);
    expect(nested.dirs).toEqual([
      { dir: "src", entries: [{ name: "deep", kind: "dir" }, { name: "index.ts", kind: "file" }] },
      { dir: "src/deep", entries: [] },
    ]);
  });

  test("nothing above the directory: `..`, a drive, an empty name, a link that leads out; a link inside is followed", async () => {
    const root = temp();
    const outside = temp();
    writeFileSync(join(outside, "secret.txt"), "x");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "x");
    linkDir(outside, join(root, "out"));
    linkDir(join(root, "src"), join(root, "same"));
    const files = filesFor(root);
    const top = await files.list("s1");
    expect(top.dirs[0]!.entries).toEqual([
      { name: "out", kind: "dir" },
      { name: "same", kind: "dir" },
      { name: "src", kind: "dir" },
    ]);
    const r = await files.list("s1", ["..", "src/../..", "/", "C:/Windows", "src//x", "out", "same", "missing", "src/a.ts"]);
    const byDir = new Map(r.dirs.map((d) => [d.dir, d]));
    for (const bad of ["..", "src/../..", "/", "C:/Windows", "src//x"]) expect(byDir.get(bad)).toEqual({ dir: bad, error: "not a folder under the session's" });
    expect(byDir.get("out")).toEqual({ dir: "out", error: "outside the session's folder" });
    expect(byDir.get("same")).toEqual({ dir: "same", entries: [{ name: "a.ts", kind: "file" }] });
    expect(byDir.get("missing")).toEqual({ dir: "missing", error: "no such folder" });
    expect(byDir.get("src/a.ts")?.error).toBe("not a folder");
    expect(JSON.stringify(r)).not.toContain("secret.txt");
  });

  test("a long folder is cut short and says so; an unknown session is not found", async () => {
    const root = temp();
    for (const f of ["c", "a", "b"]) writeFileSync(join(root, f), "x");
    const r = await filesFor(root, { max: 2 }).list("s1");
    expect(r.dirs).toEqual([{ dir: "", entries: [{ name: "a", kind: "file" }, { name: "b", kind: "file" }], truncated: true }]);
    const e = await filesFor(root).list("s2").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RpcError);
    expect((e as RpcError).error.code).toBe("not_found");
  });

  test("a folder's path is its names between slashes, and never climbs", () => {
    expect(folderParts("")).toEqual([]);
    expect(folderParts("a/b c/d")).toEqual(["a", "b c", "d"]);
    expect(folderParts("a/../b")).toBeUndefined();
    expect(folderParts("./a")).toBeUndefined();
    expect(folderParts("a/")).toBeUndefined();
    expect(folderParts("a\\..", "win32")).toBeUndefined();
    expect(folderParts("C:", "win32")).toBeUndefined();
    // a backslash is a name's own character where it is no separator
    expect(folderParts("a\\b", "linux")).toEqual(["a\\b"]);
  });
});

/** What a read was refused with: its code and words. */
async function refusal(p: Promise<unknown>): Promise<[string, string]> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(RpcError);
  return [(e as RpcError).error.code, (e as RpcError).error.message];
}

describe("a session's file", () => {
  test("its text, by its path under the directory; its size and when it changed", async () => {
    const root = temp();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "main.py"), "def main():\n    print('h\u00e9')\n");
    writeFileSync(join(root, "empty.txt"), "");
    const files = filesFor(root);
    const r = await files.read("s1", "src/main.py");
    expect(r).toMatchObject({ path: "src/main.py", size: 29, text: "def main():\n    print('h\u00e9')\n" });
    expect(r.modified).toBeGreaterThan(Date.now() - 60_000);
    expect(r.truncated).toBeUndefined();
    expect(await files.read("s1", "empty.txt")).toMatchObject({ size: 0, text: "" });
  });

  test("UTF-16 by its mark, a UTF-8 mark dropped, a NUL is binary, a long file cut short where a character ends", async () => {
    const root = temp();
    writeFileSync(join(root, "wide.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("PowerShell wrote this", "utf16le")]));
    writeFileSync(join(root, "marked.md"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Title")]));
    writeFileSync(join(root, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));
    // "a\u00e9z" is four bytes: cut at two, the \u00e9 is left out rather than shown broken
    writeFileSync(join(root, "long.txt"), "a\u00e9z");
    const files = filesFor(root);
    expect((await files.read("s1", "wide.txt")).text).toBe("PowerShell wrote this");
    expect((await files.read("s1", "marked.md")).text).toBe("# Title");
    const png = await files.read("s1", "icon.png");
    expect(png).toMatchObject({ path: "icon.png", size: 10, binary: true });
    expect(png.text).toBeUndefined();
    expect(await filesFor(root, { textMax: 2 }).read("s1", "long.txt")).toEqual({ path: "long.txt", size: 4, modified: expect.any(Number), text: "a", truncated: true });
    expect(decodeText(new Uint8Array([0x61, 0x00, 0x62]), false)).toBeUndefined();
    expect(decodeText(new TextEncoder().encode("ok"), false)).toBe("ok");
  });

  test("nothing above the directory, no folder, nothing missing; an unknown session is not found", async () => {
    const root = temp();
    const outside = temp();
    writeFileSync(join(outside, "secret.txt"), "the secret");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "x");
    linkDir(outside, join(root, "out"));
    const files = filesFor(root);
    for (const bad of ["..", "src/../../secret.txt", "/etc/passwd", "C:/Windows/win.ini", "src//a.ts", "./src/a.ts"]) {
      expect((await refusal(files.read("s1", bad)))[0]).toBe("invalid");
    }
    expect(await refusal(files.read("s1", "out/secret.txt"))).toEqual(["denied", "out/secret.txt: outside the session's folder"]);
    expect(await refusal(files.read("s1", "src"))).toEqual(["invalid", "src: a folder"]);
    expect(await refusal(files.read("s1", "src/b.ts"))).toEqual(["not_found", "src/b.ts: no such file"]);
    expect(await refusal(files.read("s1", "src/a.ts/x"))).toEqual(["not_found", "src/a.ts/x: no such file"]);
    expect((await refusal(filesFor(root).read("s2", "src/a.ts")))[0]).toBe("not_found");
  });
});

describe("a session's repository", () => {
  test("git's porcelain read: branch, commit, upstream, ahead and behind, changed files", () => {
    const out = ["# branch.oid 1e0d3291aa5b6c7d8e9f", "# branch.head master", "# branch.upstream origin/master", "# branch.ab +2 -1", "1 .M N... 100644 100644 100644 a b apps/x.ts", "2 R. N... 100644 100644 100644 a b R100 new.ts\told.ts", "u UU N... 1 2 3 4 a b c conflict.ts", "? notes.txt", ""].join("\n");
    expect(parseGitStatus(out)).toEqual({ branch: "master", commit: "1e0d3291", upstream: "origin/master", ahead: 2, behind: 1, changes: 4 });
    // detached, before the first commit, with no upstream
    expect(parseGitStatus("# branch.oid a8d9def0123\r\n# branch.head (detached)\r\n")).toEqual({ commit: "a8d9def0", changes: 0 });
    expect(parseGitStatus("# branch.oid (initial)\n# branch.head main\n? a\n")).toEqual({ branch: "main", changes: 1 });
    // an upstream that is gone says no counts
    expect(parseGitStatus("# branch.oid abcdef12\n# branch.head feat\n# branch.upstream origin/feat\n")).toEqual({ branch: "feat", commit: "abcdef12", upstream: "origin/feat", changes: 0 });
  });

  test("from a real git: commits to push and to pull as of the last fetch, from a folder inside", async () => {
    const base = temp();
    const git = (cwd: string, ...args: string[]) => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    };
    git(base, "init", "-q", "--bare", "-b", "main", "origin.git");
    git(base, "clone", "-q", "origin.git", "one");
    const one = join(base, "one");
    writeFileSync(join(one, "a.txt"), "1");
    git(one, "add", "a.txt");
    git(one, "commit", "-q", "-m", "first");
    git(one, "push", "-q", "origin", "main");
    git(base, "clone", "-q", "origin.git", "two");
    const two = join(base, "two");
    writeFileSync(join(one, "b.txt"), "2");
    git(one, "add", "b.txt");
    git(one, "commit", "-q", "-m", "second");
    git(one, "push", "-q", "origin", "main");
    git(two, "fetch", "-q");
    writeFileSync(join(two, "c.txt"), "3");
    git(two, "add", "c.txt");
    git(two, "commit", "-q", "-m", "mine");
    mkdirSync(join(two, "sub"));
    writeFileSync(join(two, "sub", "new.txt"), "4");
    const state = await filesFor(join(two, "sub")).git("s1");
    expect(state).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 1, behind: 1, changes: 1 });
    expect(state!.commit).toMatch(/^[0-9a-f]{8}$/);
    // outside any repository there is none
    expect(await filesFor(temp()).git("s1")).toBeUndefined();
  }, 30_000);

  test("without git there is none; reads at once share one run", async () => {
    expect(await filesFor(temp(), { git: async () => undefined }).git("s1")).toBeUndefined();
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const files = filesFor(temp(), {
      git: async () => {
        runs++;
        await gate;
        return { code: 0, out: "# branch.oid abcdef12\n# branch.head main\n" };
      },
    });
    const both = Promise.all([files.git("s1"), files.git("s1")]);
    release();
    const [a, b] = await both;
    expect(runs).toBe(1);
    expect(a).toEqual({ branch: "main", commit: "abcdef12", changes: 0 } satisfies GitState);
    expect(b).toEqual(a);
    await files.git("s1");
    expect(runs).toBe(2);
  });
});

describe("through a daemon", () => {
  test("session.files, session.git and session.file are reads, gated and audited; the audit keeps the counts, not the names nor the text", async () => {
    const d = await testDaemon();
    const c = await TestClient.connect(d.api.url);
    try {
      await c.hello(d.token);
      const dir = temp();
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "private-name.txt"), "x");
      const s = d.sessions.ensure({ harness: "claude", nativeId: "files-1", profile: d.profiles.byHarness("claude")[0]?.id ?? "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8", cwd: dir, transport: "pipe" }).session;
      const listed = await c.request<{ root: string; dirs: { dir: string; entries?: unknown[] }[] }>("session.files", { id: s.id, dirs: ["", "src"] });
      expect(listed.root).toBe(dir);
      expect(listed.dirs.map((x) => [x.dir, x.entries?.length])).toEqual([
        ["", 2],
        ["src", 0],
      ]);
      expect(await c.request<Record<string, unknown>>("session.git", { id: s.id })).toEqual({});
      const rows = d.store.audit.list({ limit: 50 });
      const row = rows.find((e) => e.action === "session.files")!;
      expect(row.outcome).toBe("ok");
      expect(row.target).toBe(s.id);
      expect(row.result?.body).toEqual({ root: dir, dirs: [{ dir: "", entries: 2 }, { dir: "src", entries: 0 }] });
      expect(JSON.stringify(row)).not.toContain("private-name");
      expect(rows.find((e) => e.action === "session.git")?.outcome).toBe("ok");
      const secret = "the file's own words";
      writeFileSync(join(dir, "src", "notes.md"), secret);
      expect(await c.request<{ text?: string }>("session.file", { id: s.id, path: "src/notes.md" })).toMatchObject({ path: "src/notes.md", text: secret });
      const read = d.store.audit.list({ limit: 50 }).find((e) => e.action === "session.file")!;
      expect(read.outcome).toBe("ok");
      expect(read.target).toBe(s.id);
      expect(read.result?.body).toEqual({ path: "src/notes.md", size: secret.length, chars: secret.length });
      expect(JSON.stringify(read)).not.toContain(secret);
      const missing = await c.call("session.files", { id: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1" });
      expect("error" in missing && (missing.error.data as { code: string }).code).toBe("not_found");
    } finally {
      c.close();
      await stopDaemon(d);
    }
  }, 20_000);
});
