// A session's files for the view's explorer: the folders under its directory, folders first
// and then files, by name as a person reads it, without `.git`; a folder above it, through
// `..`, a drive or a link that leads out, refused with an error of its own; a long folder cut
// short and said so. Its repository read from a real git: the branch, what it tracks, the
// commits to push and to pull as of the last fetch, and the files changed; nothing outside a
// repository or without git, and one read at a time. Through a daemon: gated and audited as a
// read, the audit row keeping how much was listed and not the names. A path under the directory
// shown in the computer's file manager by the same rule, with each platform's own program, and
// only for the desktop app on this node.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcError } from "@cophyla/protocol";
import type { GitState } from "@cophyla/protocol";
import { ConvertError, convertKind, systemConverter } from "../src/sessions/convert.ts";
import type { ImageConverter } from "../src/sessions/convert.ts";
import { decodeText, fileSummary, findGit, folderParts, imageMime, parseGitStatus, SessionFiles, WHOLE_CHUNK, wholeMime } from "../src/sessions/files.ts";
import type { GitRunner } from "../src/sessions/files.ts";
import { systemRevealer } from "../src/sessions/reveal.ts";
import type { Revealer } from "../src/sessions/reveal.ts";
import { stopDaemon, TestClient, testDaemon } from "./helpers.ts";

const WIN = process.platform === "win32";
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

function filesFor(cwd: string, opts: { max?: number; textMax?: number; imageMax?: number; git?: GitRunner; revealer?: Revealer; converter?: ImageConverter; wholeChunk?: number; wholeMax?: number } = {}): SessionFiles {
  return new SessionFiles({ session: (id) => (id === "s1" ? { cwd } : undefined), ...opts });
}

describe("the git a repository is read with", () => {
  const lookup = (platform: NodeJS.Platform, found: string | null, dev?: string, has: string[] = []) => ({
    platform,
    which: () => found,
    developerDir: () => dev,
    exists: (p: string) => has.includes(p),
  });

  test("the PATH's, except macOS's stub when the developer tools it stands for are not there", () => {
    expect(findGit(lookup("linux", "/usr/bin/git"))).toBe("/usr/bin/git");
    expect(findGit(lookup("darwin", "/opt/homebrew/bin/git"))).toBe("/opt/homebrew/bin/git");
    expect(findGit(lookup("darwin", "/usr/bin/git", "/Library/Developer/CommandLineTools", ["/Library/Developer/CommandLineTools/usr/bin/git"]))).toBe("/usr/bin/git");
    // no developer folder, or one without git: the stub would open the install dialog
    expect(findGit(lookup("darwin", "/usr/bin/git"))).toBeUndefined();
    expect(findGit(lookup("darwin", "/usr/bin/git", "/Library/Developer/CommandLineTools"))).toBeUndefined();
    expect(findGit(lookup("win32", null))).toBeUndefined();
  });
});

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
    for (const bad of ["..", "src/../..", "/", "src//x"]) expect(byDir.get(bad)).toEqual({ dir: bad, error: "not a folder under the session's" });
    // A drive is refused on Windows; elsewhere `C:` is a folder name like any other.
    expect(byDir.get("C:/Windows")).toEqual({ dir: "C:/Windows", error: WIN ? "not a folder under the session's" : "no such folder" });
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

  test("an image asked for as one comes whole as base64, up to a size; not asked, or not an image, it does not", async () => {
    const root = temp();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    writeFileSync(join(root, "Icon.PNG"), png);
    writeFileSync(join(root, "blob.bin"), png);
    writeFileSync(join(root, "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    const files = filesFor(root);
    expect(await files.read("s1", "Icon.PNG", { image: true })).toEqual({ path: "Icon.PNG", size: 10, modified: expect.any(Number), binary: true, mime: "image/png", base64: png.toString("base64") });
    expect((await files.read("s1", "Icon.PNG")).base64).toBeUndefined();
    expect(await files.read("s1", "blob.bin", { image: true })).toMatchObject({ binary: true });
    expect((await files.read("s1", "blob.bin", { image: true })).base64).toBeUndefined();
    // SVG is text: it comes as text, and the viewer draws it from that.
    expect(await files.read("s1", "logo.svg", { image: true })).toMatchObject({ text: "<svg xmlns='http://www.w3.org/2000/svg'/>" });
    const big = await filesFor(root, { imageMax: 9 }).read("s1", "Icon.PNG", { image: true });
    expect(big).toMatchObject({ size: 10, binary: true });
    expect(big.base64).toBeUndefined();
    expect(imageMime("a/b.JPG")).toBe("image/jpeg");
    expect(imageMime("a.png/readme")).toBeUndefined();
    expect(fileSummary({ path: "Icon.PNG", size: 10, modified: 1, binary: true, mime: "image/png", base64: "iVBORw0KGgoAAA==" })).toEqual({ path: "Icon.PNG", size: 10, binary: true, mime: "image/png", base64: 16 });
  });

  test("nothing above the directory, no folder, nothing missing; an unknown session is not found", async () => {
    const root = temp();
    const outside = temp();
    writeFileSync(join(outside, "secret.txt"), "the secret");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "x");
    linkDir(outside, join(root, "out"));
    const files = filesFor(root);
    for (const bad of ["..", "src/../../secret.txt", "/etc/passwd", "src//a.ts", "./src/a.ts"]) {
      expect((await refusal(files.read("s1", bad)))[0]).toBe("invalid");
    }
    expect((await refusal(files.read("s1", "C:/Windows/win.ini")))[0]).toBe(WIN ? "invalid" : "not_found");
    expect(await refusal(files.read("s1", "out/secret.txt"))).toEqual(["denied", "out/secret.txt: outside the folder"]);
    expect(await refusal(files.read("s1", "src"))).toEqual(["invalid", "src: a folder"]);
    expect(await refusal(files.read("s1", "src/b.ts"))).toEqual(["not_found", "src/b.ts: no such file"]);
    expect(await refusal(files.read("s1", "src/a.ts/x"))).toEqual(["not_found", "src/a.ts/x: no such file"]);
    expect((await refusal(filesFor(root).read("s2", "src/a.ts")))[0]).toBe("not_found");
  });
});

describe("a file read whole", () => {
  test("its bytes a piece at a time, whatever it is, the pieces' base64 joining as it is; past the most, nothing", async () => {
    const root = temp();
    const bytes = Buffer.from(Array.from({ length: 20 }, (_, i) => i * 7));
    writeFileSync(join(root, "guide.pdf"), bytes);
    writeFileSync(join(root, "notes.txt"), "plain words");
    const files = filesFor(root, { wholeChunk: 9, wholeMax: 20 });
    const first = await files.read("s1", "guide.pdf", { whole: true });
    expect(first).toEqual({ path: "guide.pdf", size: 20, modified: expect.any(Number), mime: "application/pdf", base64: bytes.subarray(0, 9).toString("base64"), at: 0, total: 20 });
    const pieces = [first.base64!];
    for (let at = 9; at < 20; at += 9) {
      const next = await files.read("s1", "guide.pdf", { whole: true, at });
      expect(next).toMatchObject({ at, total: 20, modified: first.modified, size: 20 });
      pieces.push(next.base64!);
    }
    expect(Buffer.from(pieces.join(""), "base64").equals(bytes)).toBe(true);
    // Text comes as bytes too, when asked for whole; the end itself is an empty piece; past it is refused.
    expect(await files.read("s1", "notes.txt", { whole: true })).toMatchObject({ mime: "application/octet-stream", base64: Buffer.from("plain wor").toString("base64"), total: 11 });
    expect(await files.read("s1", "guide.pdf", { whole: true, at: 20 })).toMatchObject({ base64: "", at: 20, total: 20 });
    expect((await refusal(files.read("s1", "guide.pdf", { whole: true, at: 21 })))[0]).toBe("invalid");
    // Past the most sent whole: that it is there, and how big.
    writeFileSync(join(root, "big.pdf"), Buffer.alloc(21));
    const big = await files.read("s1", "big.pdf", { whole: true });
    expect(big).toEqual({ path: "big.pdf", size: 21, modified: expect.any(Number), binary: true });
    // A folder is still refused.
    mkdirSync(join(root, "src"));
    expect(await refusal(files.read("s1", "src", { whole: true }))).toEqual(["invalid", "src: a folder"]);
    expect(WHOLE_CHUNK % 3).toBe(0);
    expect(fileSummary({ path: "guide.pdf", size: 20, modified: 1, mime: "application/pdf", base64: "AAAA", at: 9, total: 20 })).toEqual({ path: "guide.pdf", size: 20, mime: "application/pdf", base64: 4, at: 9, total: 20 });
    expect([wholeMime("a/b.PDF"), wholeMime("x.html"), wholeMime("s.css"), wholeMime("i.svg"), wholeMime("p.tiff"), wholeMime("README")]).toEqual(["application/pdf", "text/html", "text/css", "image/svg+xml", "application/octet-stream", "application/octet-stream"]);
  });

  test("a TIFF or a HEIC comes as the PNG its codecs make, made once for all its pieces; one no codec reads says why", async () => {
    const root = temp();
    writeFileSync(join(root, "scan.TIF"), "tiff bytes");
    writeFileSync(join(root, "photo.heic"), "heic bytes");
    const png = Buffer.from(Array.from({ length: 10 }, (_, i) => 200 + i));
    const asked: [string, string][] = [];
    const converter: ImageConverter = async (path, kind) => {
      asked.push([path, kind]);
      if (kind === "HEIC") throw new ConvertError("This computer has no decoder for HEIC images.");
      return new Uint8Array(png);
    };
    const files = filesFor(root, { converter, wholeChunk: 6 });
    const a = await files.read("s1", "scan.TIF", { whole: true });
    const b = await files.read("s1", "scan.TIF", { whole: true, at: 6 });
    expect(a).toMatchObject({ size: 10, mime: "image/png", at: 0, total: 10 });
    expect(Buffer.from(a.base64! + b.base64!, "base64").equals(png)).toBe(true);
    expect(asked).toEqual([[join(root, "scan.TIF"), "TIFF"]]);
    expect(await files.read("s1", "photo.heic", { whole: true })).toEqual({ path: "photo.heic", size: 10, modified: expect.any(Number), binary: true, note: "This computer has no decoder for HEIC images." });
    // Changed, it is made again.
    writeFileSync(join(root, "scan.TIF"), "other tiff bytes");
    await files.read("s1", "scan.TIF", { whole: true });
    expect(asked.filter(([, k]) => k === "TIFF").length).toBe(2);
    // Read as text, it is not converted.
    expect((await files.read("s1", "scan.TIF")).text).toBe("other tiff bytes");
    expect([convertKind("a/b.tiff"), convertKind("c.HEIF"), convertKind("d.png"), convertKind("tif")]).toEqual(["TIFF", "HEIF", undefined, undefined]);
  });

  test("each platform's codecs: WIC through PowerShell, sips, ImageMagick or heif-convert; none, and it says what to install", async () => {
    const ran: [string, string[], Record<string, string> | undefined][] = [];
    const deps = (platform: NodeJS.Platform, which: string[] = [], result = { code: 0 as number | null, err: "" }) => ({
      platform,
      which: (c: string) => (which.includes(c) ? `/usr/bin/${c}` : null),
      run: async (c: string, args: string[], env?: Record<string, string>) => {
        ran.push([c, args, env]);
        return result;
      },
    });
    // The program writes no PNG here, so each run ends unreadable: what it was asked is what counts.
    const tried = async (conv: ReturnType<typeof systemConverter>, kind = "TIFF") => (await conv("/in/scan.tif", kind).then(() => "made", (e: unknown) => (e as Error).message));
    expect(await tried(systemConverter(deps("win32")))).toBe("This TIFF image could not be read here.");
    const [win] = ran.splice(0);
    expect(win![0]).toBe("powershell.exe");
    expect(win![1].slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    expect(Buffer.from(win![1][5]!, "base64").toString("utf16le")).toContain("PngBitmapEncoder");
    expect(win![2]).toMatchObject({ COPHYLA_CONVERT_IN: "/in/scan.tif", COPHYLA_CONVERT_MAX: "4096" });
    expect(await tried(systemConverter(deps("win32", [], { code: 1, err: 'Exception calling "Create": "No imaging component suitable to complete this operation was found."' })), "HEIC")).toBe("This computer has no decoder for HEIC images: install the HEIF Image Extensions and the HEVC Video Extensions from the Microsoft Store.");
    ran.splice(0);
    await tried(systemConverter(deps("darwin")));
    expect(ran.splice(0).map(([c, a]) => [c, a.slice(0, 4)])).toEqual([["sips", ["-s", "format", "png", "-Z"]]]);
    await tried(systemConverter(deps("linux", ["convert", "heif-convert"])));
    expect(ran.splice(0).map(([c, a]) => [c, a.slice(0, 4)])).toEqual([["/usr/bin/convert", ["/in/scan.tif[0]", "-auto-orient", "-resize", "4096x4096>"]]]);
    await tried(systemConverter(deps("linux", ["heif-convert"])), "HEIC");
    expect(ran.splice(0).map(([c]) => c)).toEqual(["/usr/bin/heif-convert"]);
    expect(await tried(systemConverter(deps("linux", ["heif-convert"])))).toBe("This computer has no decoder for TIFF images: install ImageMagick.");
    expect(await tried(systemConverter(deps("linux", ["xdg-open"], { code: 1, err: "convert: no decode delegate\nmore" })))).toBe("This computer has no decoder for TIFF images: install ImageMagick.");
    expect(await tried(systemConverter(deps("linux", ["magick"], { code: 1, err: "magick: no decode delegate for this image format\nmore" })))).toBe("This TIFF image could not be read here: magick: no decode delegate for this image format");
  });
});

describe("a path shown in the file manager", () => {
  test("where a path leads: a file or a folder, the folder itself too; nothing above it, through a link or a climb", async () => {
    const root = temp();
    const outside = temp();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "x");
    linkDir(outside, join(root, "out"));
    const files = filesFor(root);
    expect(await files.resolveUnder(root, "src/a.ts")).toMatchObject({ path: join(root, "src", "a.ts"), real: join(root, "src", "a.ts"), kind: "file" });
    expect(await files.resolveUnder(root, "src")).toMatchObject({ kind: "dir" });
    expect(await files.resolveUnder(root, "")).toMatchObject({ path: root, kind: "dir" });
    expect(await refusal(files.resolveUnder(root, "out"))).toEqual(["denied", "out: outside the folder"]);
    expect((await refusal(files.resolveUnder(root, "src/../..")))[0]).toBe("invalid");
    expect((await refusal(files.resolveUnder(root, "src/gone.ts")))[0]).toBe("not_found");
  });

  test("the revealer is handed the path as the folder spells it, a file or a folder; refused as a read is; none, and it is unsupported", async () => {
    const root = temp();
    const outside = temp();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "x");
    linkDir(outside, join(root, "out"));
    const shown: [string, string][] = [];
    const files = filesFor(root, { revealer: async (path, kind) => void shown.push([path, kind]) });
    await files.reveal("s1", "src/a.ts");
    await files.reveal("s1", "src");
    await files.reveal("s1", "");
    expect(shown).toEqual([
      [join(root, "src", "a.ts"), "file"],
      [join(root, "src"), "dir"],
      [root, "dir"],
    ]);
    expect((await refusal(files.reveal("s1", "out")))[0]).toBe("denied");
    expect((await refusal(files.reveal("s1", "..")))[0]).toBe("invalid");
    expect((await refusal(files.reveal("s1", "src/b.ts")))[0]).toBe("not_found");
    expect((await refusal(files.reveal("s2", "src")))[0]).toBe("not_found");
    expect(shown.length).toBe(3);
    expect((await refusal(filesFor(root).reveal("s1", "src")))[0]).toBe("unsupported");
  });

  test("each platform's file manager: Explorer selecting a file, the Finder, a desktop's over D-Bus or else its folder opened; none without a display", async () => {
    const started: [string, string[], boolean][] = [];
    const ran: [string, string[]][] = [];
    const deps = (platform: NodeJS.Platform, over: { env?: Record<string, string>; which?: string[]; dbus?: boolean } = {}) => ({
      platform,
      env: over.env ?? {},
      which: (c: string) => ((over.which ?? []).includes(c) ? `/usr/bin/${c}` : null),
      detach: (c: string, args: string[], o: { verbatim?: boolean }) => void started.push([c, args, o.verbatim === true]),
      run: async (c: string, args: string[]) => {
        ran.push([c, args]);
        return over.dbus ?? false;
      },
    });
    await systemRevealer(deps("win32"))("C:\\D\\site\\a b.ts", "file");
    await systemRevealer(deps("win32"))("C:\\D\\site", "dir");
    await systemRevealer(deps("darwin"))("/Users/me/site/a.ts", "file");
    await systemRevealer(deps("darwin"))("/Users/me/site", "dir");
    expect(started.splice(0)).toEqual([
      ["explorer.exe", ['/select,"C:\\D\\site\\a b.ts"'], true],
      ["explorer.exe", ['"C:\\D\\site"'], true],
      ["open", ["-R", "/Users/me/site/a.ts"], false],
      ["open", ["/Users/me/site"], false],
    ]);
    const linux = { env: { DISPLAY: ":0" }, which: ["gdbus", "xdg-open"] };
    await systemRevealer(deps("linux", { ...linux, dbus: true }))("/home/me/it's.md", "file");
    expect(ran.splice(0)).toEqual([["/usr/bin/gdbus", ["call", "--session", "--dest", "org.freedesktop.FileManager1", "--object-path", "/org/freedesktop/FileManager1", "--method", "org.freedesktop.FileManager1.ShowItems", "['file:///home/me/it%27s.md']", ""]]]);
    expect(started.splice(0)).toEqual([]);
    // No file manager answers on D-Bus: the file's folder opens instead; a folder opens itself.
    await systemRevealer(deps("linux", linux))("/home/me/site/a.ts", "file");
    await systemRevealer(deps("linux", linux))("/home/me/site", "dir");
    expect(started.splice(0)).toEqual([
      ["/usr/bin/xdg-open", ["/home/me/site"], false],
      ["/usr/bin/xdg-open", ["/home/me/site"], false],
    ]);
    expect(ran.splice(0).length).toBe(1);
    expect((await refusal(systemRevealer(deps("linux", { which: ["xdg-open"] }))("/home/me/a.ts", "file")))).toEqual(["unsupported", "this computer has no desktop to show files on"]);
    expect((await refusal(systemRevealer(deps("linux", { env: { WAYLAND_DISPLAY: "wayland-0" } }))("/home/me", "dir")))[0]).toBe("unsupported");
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

  test("session.reveal: the desktop app on this node shows a path in the file manager, audited with the path; any other client is refused", async () => {
    const shown: [string, string][] = [];
    const d = await testDaemon("", { revealer: async (path, kind) => void shown.push([path, kind]) });
    const here = await TestClient.connect(d.api.url);
    const named = await TestClient.connect(d.api.url);
    try {
      await here.hello(d.token);
      // A ui that says it sits on another node is not this computer's.
      await named.hello(d.token, { node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAW" });
      const dir = temp();
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "a.ts"), "x");
      const s = d.sessions.ensure({ harness: "claude", nativeId: "reveal-1", profile: d.profiles.byHarness("claude")[0]?.id ?? "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8", cwd: dir, transport: "pipe" }).session;
      expect(await here.request<Record<string, unknown>>("session.reveal", { id: s.id, path: "src/a.ts" })).toEqual({});
      expect(await here.request<Record<string, unknown>>("session.reveal", { id: s.id, path: "" })).toEqual({});
      expect(shown).toEqual([
        [join(dir, "src", "a.ts"), "file"],
        [dir, "dir"],
      ]);
      const row = d.store.audit.list({ limit: 50 }).find((e) => e.action === "session.reveal")!;
      expect(row.outcome).toBe("ok");
      expect(row.target).toBe(s.id);
      expect(row.args).toMatchObject({ id: s.id, path: "" });
      const refused = await named.call("session.reveal", { id: s.id, path: "src/a.ts" });
      expect("error" in refused && refused.error.data).toMatchObject({ code: "unsupported" });
      expect("error" in refused && refused.error.message).toMatch(/only Cophyla on the computer that holds the file/);
      const outside = await here.call("session.reveal", { id: s.id, path: "../x" });
      expect("error" in outside && (outside.error.data as { code: string }).code).toBe("invalid");
      expect(shown.length).toBe(2);
    } finally {
      here.close();
      named.close();
      await stopDaemon(d);
    }
  }, 20_000);
});
