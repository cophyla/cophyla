// A session's files, as a view's explorer shows them: the folders under its working
// directory, a level at a time, and the repository it is in as a status bar has it. The
// directory is the session's cwd, the path its access is checked by, so nothing above it is
// listed: a folder asked for through `..`, or one a link leads out to, is refused. What VS
// Code's explorer leaves out by default (`.git` and its kin) is left out here. Git is read
// with `status --porcelain=v2 --branch`, never fetching, and with GIT_OPTIONAL_LOCKS=0, so it
// takes no lock an agent's own git would trip on; one read runs per directory at a time.
// A file under the directory is read for a viewer by the same rule: its first MiB as text,
// decoded from UTF-8 or from UTF-16 by its byte order mark, or only that it is not text when
// a NUL shows in its first 8000 bytes, as git decides; an image asked for as one comes whole,
// as base64, up to 5 MiB. A file asked for whole comes as its bytes, whatever it is, a piece of
// WHOLE_CHUNK at a time up to WHOLE_MAX, for a viewer that draws it (an image, a PDF, what a
// page loads): a TIFF or a HEIC image as the PNG the computer's own codecs make of it
// (convert.ts), kept a while so every piece is of the same PNG. A folder, a pipe or a device is
// refused before anything opens it, so a read never waits on a writer. The folder a bare terminal started in is read the same way.
// A file or a folder under the directory is shown in the computer's own file manager by the
// same rule (`reveal`, reveal.ts).
// On a Mac without the developer tools `/usr/bin/git` is Apple's stub, which opens the tools'
// install dialog every time it runs: that git is used only when the active developer folder
// (`xcode-select -p`) has a git in it, and a Mac with neither reads no repository.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Stats } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { RpcError } from "@cophyla/protocol";
import type { ClientResult, FileEntry, FileText, FolderListing, GitCommit, GitState, Session } from "@cophyla/protocol";
import { ConvertError, convertKind, systemConverter } from "./convert.ts";
import type { ImageConverter } from "./convert.ts";
import { isWithin } from "./paths.ts";
import type { Revealer } from "./reveal.ts";

/** Entries listed per folder; the rest are left out, and the listing says so. */
export const FILES_MAX = 2000;
/** VS Code's `files.exclude` defaults. */
const HIDDEN = new Set([".git", ".svn", ".hg", "CVS", ".DS_Store", "Thumbs.db"]);
const GIT_TIMEOUT_MS = 10_000;
/** Bytes of a file a viewer is sent; a longer one comes cut short, and says so. */
export const FILE_TEXT_MAX = 1024 * 1024;
/** How far into a file a NUL is looked for: one there makes it binary, as git decides. */
const SNIFF_BYTES = 8000;
/** Bytes of an image a viewer is sent whole; a bigger one comes as binary, with nothing to show. */
export const IMAGE_MAX = 5 * 1024 * 1024;
/**
 * Bytes of a file read whole per answer: a multiple of three, so the pieces' base64 joins as
 * it is, and small enough that an answer sealed for the relay (base64 twice over) stays under
 * the relay server's 4 MiB message.
 */
export const WHOLE_CHUNK = 1.5 * 1024 * 1024;
/** Bytes of a file sent whole at most; a bigger one comes as binary, with nothing to show. */
export const WHOLE_MAX = 64 * 1024 * 1024;
/** Converted images kept, so a PNG sent a piece at a time is made once. */
const CONVERTED_KEEP = 3;

/** The images a viewer draws, by extension: what a browser shows in an `img`, SVG aside (it is text, and comes as text). */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

/** What else a viewer reads whole, by extension: a PDF it draws, the page it runs, and what a page loads beside it. */
const WHOLE_TYPES: Readonly<Record<string, string>> = {
  ...IMAGE_TYPES,
  apng: "image/apng",
  jfif: "image/jpeg",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  html: "text/html",
  htm: "text/html",
  xhtml: "application/xhtml+xml",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
};

function extension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") ? path.slice(dot + 1).toLowerCase() : "";
}

/** An image's type by its path's extension, or undefined for a path that names none. */
export function imageMime(path: string): string | undefined {
  const ext = extension(path);
  return Object.hasOwn(IMAGE_TYPES, ext) ? IMAGE_TYPES[ext] : undefined;
}

/** A file's type as a whole read sends it, by its path's extension; bytes of no known kind otherwise. */
export function wholeMime(path: string): string {
  const ext = extension(path);
  return Object.hasOwn(WHOLE_TYPES, ext) ? WHOLE_TYPES[ext]! : "application/octet-stream";
}

export interface ReadOptions {
  /** An image is to come whole, as base64, when it is small enough. */
  image?: boolean;
  /** The file is to come as its bytes, the piece starting `at` bytes in. */
  whole?: boolean;
  at?: number;
}

/** Runs git with `args` in `cwd`: its exit code and output, or undefined when there is no git to run. */
export type GitRunner = (args: string[], cwd: string) => Promise<{ code: number; out: string } | undefined>;

export interface SessionFilesDeps {
  /** A session this node holds. */
  session(id: string): Pick<Session, "cwd"> | undefined;
  git?: GitRunner;
  /** Entries per folder; FILES_MAX unless a test says. */
  max?: number;
  /** Bytes of a file read for a viewer; FILE_TEXT_MAX unless a test says. */
  textMax?: number;
  /** Bytes of an image sent whole; IMAGE_MAX unless a test says. */
  imageMax?: number;
  platform?: string;
  /** Shows a path in this computer's file manager; none where the daemon may open no window (a test). */
  revealer?: Revealer;
  /** Makes a TIFF or a HEIC a PNG; the computer's own codecs unless a test says. */
  converter?: ImageConverter;
  /** Bytes per piece of a whole read, and the most sent whole; WHOLE_CHUNK and WHOLE_MAX unless a test says. */
  wholeChunk?: number;
  wholeMax?: number;
}

/** Where a path under a folder leads: the path as the folder spells it, the real one past any link, what is there, and its stat. */
export interface Resolved {
  path: string;
  real: string;
  kind: "file" | "dir";
  info: Stats;
}

export type FilesResult = ClientResult<"session.files">;

const names = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folders first, then files, each by name as a person reads it (`file2` before `file10`, case aside). */
export function byExplorer(a: FileEntry, b: FileEntry): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return names.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/**
 * A folder's path under the directory, as its names: `/` between them. Undefined for one that
 * would leave the directory or names no folder: an absolute path, an empty name, `.` or `..`,
 * and on Windows a name with a separator or a drive's colon in it.
 */
export function folderParts(dir: string, platform: string = process.platform): string[] | undefined {
  if (dir === "") return [];
  const parts = dir.split("/");
  const bad = platform === "win32" ? /[\\:\0]/ : /\0/;
  if (parts.some((p) => p === "" || p === "." || p === ".." || bad.test(p))) return undefined;
  return parts;
}

/** What `git status --porcelain=v2 --branch` says of the branch and how many files changed. */
export function parseGitStatus(out: string): GitState {
  const git: GitState = { changes: 0 };
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice("# branch.oid ".length).trim();
      if (oid !== "(initial)") git.commit = oid.slice(0, 8);
    } else if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      if (head !== "(detached)") git.branch = head;
    } else if (line.startsWith("# branch.upstream ")) {
      git.upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const m = /^\+(\d+) -(\d+)$/.exec(line.slice("# branch.ab ".length).trim());
      if (m) {
        git.ahead = Number(m[1]);
        git.behind = Number(m[2]);
      }
    } else if (/^[12u?] /.test(line)) {
      git.changes++;
    }
  }
  return git;
}

/** What `git log --format=%h%x09%ct%x09%s` says: a commit a line, its hash, time in seconds and subject apart by tabs. */
export function parseGitLog(out: string): GitCommit[] {
  const log: GitCommit[] = [];
  for (const line of out.split(/\r?\n/)) {
    const [commit, seconds, ...subject] = line.split("\t");
    const at = Number(seconds);
    if (!commit || !Number.isFinite(at) || seconds === undefined || seconds === "") continue;
    log.push({ commit, subject: subject.join("\t"), at: at * 1000 });
  }
  return log;
}

/**
 * A file's bytes as text: UTF-16 by its byte order mark, else UTF-8, the mark dropped either
 * way; undefined for bytes with a NUL in their first 8000 and no UTF-16 mark. Bytes `cut` short
 * lose the character they end in the middle of, rather than show it broken.
 */
export function decodeText(bytes: Uint8Array, cut: boolean): string | undefined {
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : undefined;
  if (!utf16 && bytes.subarray(0, SNIFF_BYTES).includes(0)) return undefined;
  return new TextDecoder(utf16 ?? "utf-8").decode(bytes, { stream: cut });
}

/** A file as the audit row keeps it: which, how big, and how much of it was sent, never the text. */
export function fileSummary(r: FileText): unknown {
  return {
    path: r.path,
    size: r.size,
    ...(r.text !== undefined ? { chars: r.text.length } : {}),
    ...(r.truncated ? { truncated: true } : {}),
    ...(r.binary ? { binary: true } : {}),
    ...(r.base64 !== undefined ? { mime: r.mime, base64: r.base64.length } : {}),
    ...(r.at !== undefined ? { at: r.at } : {}),
    ...(r.total !== undefined ? { total: r.total } : {}),
  };
}

/** A listing as the audit row keeps it: the folders and how many entries each had, not the names. */
export function listingSummary(r: FilesResult): unknown {
  return { root: r.root, dirs: r.dirs.map((d) => ({ dir: d.dir, ...(d.entries ? { entries: d.entries.length } : {}), ...(d.truncated ? { truncated: true } : {}), ...(d.error ? { error: d.error } : {}) })) };
}

export interface GitLookup {
  platform: NodeJS.Platform;
  which: (name: string) => string | null;
  /** The active developer folder, as `xcode-select -p` prints it; undefined when there is none. */
  developerDir: () => string | undefined;
  exists: (path: string) => boolean;
}

const lookupDefaults: GitLookup = {
  platform: process.platform,
  which: (name) => Bun.which(name),
  developerDir: () => {
    const r = spawnSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8", timeout: 5000 });
    return r.status === 0 ? r.stdout.trim() || undefined : undefined;
  },
  exists: existsSync,
};

/** The git to run: the PATH's, except macOS's stub when the developer tools it stands for are not installed. */
export function findGit(deps: GitLookup = lookupDefaults): string | undefined {
  const found = deps.which("git");
  if (!found) return undefined;
  if (deps.platform !== "darwin" || found !== "/usr/bin/git") return found;
  const dev = deps.developerDir();
  return dev && deps.exists(`${dev}/usr/bin/git`) ? found : undefined;
}

let git: string | null | undefined;

function spawnGit(args: string[], cwd: string) {
  git ??= findGit() ?? null;
  if (!git) return undefined; // no git on this machine
  try {
    return Bun.spawn([git, ...args], { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }, stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
  } catch {
    return undefined; // no git on this machine
  }
}

async function runGit(args: string[], cwd: string): Promise<{ code: number; out: string } | undefined> {
  const p = spawnGit(args, cwd);
  if (!p) return undefined;
  const timer = setTimeout(() => p.kill(), GIT_TIMEOUT_MS);
  try {
    const out = await new Response(p.stdout).text();
    return { code: await p.exited, out };
  } finally {
    clearTimeout(timer);
  }
}

function why(e: unknown, what = "folder"): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "ENOENT") return `no such ${what}`;
  if (code === "ENOTDIR") return what === "file" ? "no such file" : "not a folder";
  if (code === "EACCES" || code === "EPERM") return "not allowed to read it";
  return e instanceof Error ? e.message : String(e);
}

/** Why a file could not be read, as the error a viewer gets: refused, or not there. */
function readError(path: string, e: unknown): RpcError {
  const code = (e as { code?: unknown } | null)?.code;
  return new RpcError(code === "EACCES" || code === "EPERM" ? "denied" : "not_found", `${path}: ${why(e, "file")}`);
}

export class SessionFiles {
  private deps: SessionFilesDeps;
  private reading = new Map<string, Promise<GitState | undefined>>();
  /** Converted images by their real path, time and size, the newest last. */
  private converted = new Map<string, Promise<Uint8Array | ConvertError>>();

  constructor(deps: SessionFilesDeps) {
    this.deps = deps;
  }

  private cwd(id: string): string {
    const s = this.deps.session(id);
    if (!s) throw new RpcError("not_found", `no session ${id}`);
    return s.cwd;
  }

  /** The folders asked for under the session's directory, the directory itself when none is. */
  async list(id: string, dirs: string[] = [""]): Promise<FilesResult> {
    const root = this.cwd(id);
    let real: string;
    try {
      real = await realpath(root);
    } catch (e) {
      throw new RpcError("not_found", `${root}: ${why(e)}`);
    }
    const unique = [...new Set(dirs)];
    return { root, dirs: await Promise.all(unique.map((dir) => this.folder(root, real, dir))) };
  }

  private async folder(root: string, real: string, dir: string): Promise<FolderListing> {
    const platform = this.deps.platform ?? process.platform;
    const parts = folderParts(dir, platform);
    if (!parts) return { dir, error: "not a folder under the session's" };
    const path = join(root, ...parts);
    try {
      // A link inside may lead anywhere: what it leads to must still be under the directory.
      if (!isWithin(await realpath(path), real, platform)) return { dir, error: "outside the session's folder" };
      const dirents = await readdir(path, { withFileTypes: true });
      const entries = await Promise.all(
        dirents
          .filter((d) => !HIDDEN.has(d.name))
          .map(async (d): Promise<FileEntry> => {
            if (d.isDirectory()) return { name: d.name, kind: "dir" };
            if (!d.isSymbolicLink()) return { name: d.name, kind: "file" };
            try {
              return { name: d.name, kind: (await stat(join(path, d.name))).isDirectory() ? "dir" : "file" };
            } catch {
              return { name: d.name, kind: "file" }; // a link to nothing
            }
          }),
      );
      entries.sort(byExplorer);
      const max = this.deps.max ?? FILES_MAX;
      return entries.length > max ? { dir, entries: entries.slice(0, max), truncated: true } : { dir, entries };
    } catch (e) {
      return { dir, error: why(e) };
    }
  }

  /** A file under the session's directory, by its path there, as `readUnder` reads one. */
  async read(id: string, path: string, opts: ReadOptions = {}): Promise<FileText> {
    return this.readUnder(this.cwd(id), path, opts);
  }

  /**
   * Where a path under a folder (a session's directory, or the folder a terminal started in)
   * leads, by its path there, `""` the folder itself: a plain file or a folder, once its stat
   * says which. One outside the folder, through `..` or a link that leads out, is refused, and
   * so is anything else there (a pipe, a device), before anything opens it.
   */
  async resolveUnder(root: string, path: string): Promise<Resolved> {
    const platform = this.deps.platform ?? process.platform;
    const parts = folderParts(path, platform);
    if (!parts) throw new RpcError("invalid", `${path}: not a path under the folder`);
    let real: string;
    try {
      real = await realpath(root);
    } catch (e) {
      throw new RpcError("not_found", `${root}: ${why(e)}`);
    }
    const joined = join(root, ...parts);
    let target: string;
    try {
      target = await realpath(joined);
    } catch (e) {
      throw readError(path, e);
    }
    // A link inside may lead anywhere: what it leads to must still be under the directory.
    if (!isWithin(target, real, platform)) throw new RpcError("denied", `${path}: outside the folder`);
    let info: Stats;
    try {
      info = await stat(target);
    } catch (e) {
      throw readError(path, e);
    }
    if (!info.isFile() && !info.isDirectory()) throw new RpcError("invalid", `${path}: not a file`);
    return { path: joined, real: target, kind: info.isDirectory() ? "dir" : "file", info };
  }

  /**
   * A file under a folder (a session's directory, or the folder a terminal started in), by its
   * path there: its text, the first `textMax` bytes of a longer one, or that it is not text; an
   * image asked for as one comes whole, as base64, up to `imageMax`. One outside the folder,
   * through `..` or a link that leads out, is refused, and so is anything but a plain file.
   */
  async readUnder(root: string, path: string, opts: ReadOptions = {}): Promise<FileText> {
    const parts = folderParts(path, this.deps.platform ?? process.platform);
    if (!parts || parts.length === 0) throw new RpcError("invalid", `${path}: not a file under the folder`);
    const { real: target, kind, info } = await this.resolveUnder(root, path);
    if (kind === "dir") throw new RpcError("invalid", `${path}: a folder`);
    if (opts.whole) return this.readWhole(path, target, info, opts.at ?? 0);
    try {
      const mime = opts.image ? imageMime(path) : undefined;
      const whole = mime !== undefined && info.size <= (this.deps.imageMax ?? IMAGE_MAX);
      const file = await open(target, "r");
      try {
        const bytes = new Uint8Array(whole ? info.size : Math.min(info.size, this.deps.textMax ?? FILE_TEXT_MAX));
        let got = 0;
        while (got < bytes.length) {
          const { bytesRead } = await file.read(bytes, got, bytes.length - got, got);
          if (bytesRead === 0) break;
          got += bytesRead;
        }
        // The size as read, should the file have changed between the look and the read.
        const size = Math.max(info.size, got);
        const cut = got < size;
        const base = { path, size, modified: Math.max(0, Math.round(info.mtimeMs)) };
        if (whole && !cut) return { ...base, binary: true, mime, base64: Buffer.from(bytes.buffer, bytes.byteOffset, got).toString("base64") };
        const text = decodeText(bytes.subarray(0, got), cut);
        if (text === undefined) return { ...base, binary: true };
        return { ...base, text, ...(cut ? { truncated: true } : {}) };
      } finally {
        await file.close();
      }
    } catch (e) {
      throw e instanceof RpcError ? e : readError(path, e);
    }
  }

  /**
   * A file's bytes from `at`, a piece of `wholeChunk`, for a viewer that draws the file: `total`
   * says how many there are in all. A TIFF or a HEIC comes as the PNG its codecs make of it, or
   * as `binary` with a note when none can; a file past `wholeMax` comes as `binary` alone.
   */
  private async readWhole(path: string, target: string, info: Stats, at: number): Promise<FileText> {
    const base = { path, size: info.size, modified: Math.max(0, Math.round(info.mtimeMs)) };
    const chunk = this.deps.wholeChunk ?? WHOLE_CHUNK;
    const kind = convertKind(path);
    if (kind !== undefined) {
      const png = await this.convert(target, info, kind);
      if (png instanceof ConvertError) return { ...base, binary: true, note: png.message };
      if (at > png.length) throw new RpcError("invalid", `${path}: ${at} is past its end`);
      const piece = png.subarray(at, at + chunk);
      return { ...base, mime: "image/png", base64: Buffer.from(piece.buffer, piece.byteOffset, piece.length).toString("base64"), at, total: png.length };
    }
    if (info.size > (this.deps.wholeMax ?? WHOLE_MAX)) return { ...base, binary: true };
    if (at > info.size) throw new RpcError("invalid", `${path}: ${at} is past its end`);
    try {
      const file = await open(target, "r");
      try {
        const bytes = new Uint8Array(Math.min(chunk, info.size - at));
        let got = 0;
        while (got < bytes.length) {
          const { bytesRead } = await file.read(bytes, got, bytes.length - got, at + got);
          if (bytesRead === 0) break;
          got += bytesRead;
        }
        return { ...base, mime: wholeMime(path), base64: Buffer.from(bytes.buffer, bytes.byteOffset, got).toString("base64"), at, total: info.size };
      } finally {
        await file.close();
      }
    } catch (e) {
      throw e instanceof RpcError ? e : readError(path, e);
    }
  }

  /** A TIFF or a HEIC as a PNG, made once per version of the file and kept for its next pieces; why not, when it cannot be. */
  private convert(real: string, info: Stats, kind: string): Promise<Uint8Array | ConvertError> {
    const key = `${real}\n${info.mtimeMs}\n${info.size}`;
    let made = this.converted.get(key);
    if (made) {
      this.converted.delete(key);
    } else {
      const converter = (this.deps.converter ??= systemConverter());
      made = converter(real, kind).catch((e: unknown) => (e instanceof ConvertError ? e : new ConvertError(`This ${kind} image could not be read here: ${e instanceof Error ? e.message : String(e)}`)));
    }
    this.converted.set(key, made);
    for (const old of this.converted.keys()) {
      if (this.converted.size <= CONVERTED_KEEP) break;
      this.converted.delete(old);
    }
    return made;
  }

  /**
   * Shows a path under the session's directory, `""` the directory itself, in this computer's
   * file manager: a file selected in its folder, a folder opened. Refused as a read is refused;
   * `unsupported` where the daemon has no file manager to open.
   */
  async reveal(id: string, path: string): Promise<void> {
    const at = await this.resolveUnder(this.cwd(id), path);
    if (!this.deps.revealer) throw new RpcError("unsupported", "this computer has no file manager to show files in");
    // The path as the explorer lists it: a link shows as itself, in its own folder.
    await this.deps.revealer(at.path, at.kind);
  }

  /**
   * The repository the session's directory is in, with its last `log` commits when asked for;
   * undefined outside one, or without git. Reads of one directory at once share one run.
   */
  git(id: string, log?: number): Promise<GitState | undefined> {
    const cwd = this.cwd(id);
    const key = `${cwd}\0${log ?? 0}`;
    let read = this.reading.get(key);
    if (!read) {
      read = this.readGit(cwd, log).finally(() => this.reading.delete(key));
      this.reading.set(key, read);
    }
    return read;
  }

  private async readGit(cwd: string, log?: number): Promise<GitState | undefined> {
    const run = this.deps.git ?? runGit;
    const r = await run(["status", "--porcelain=v2", "--branch"], cwd);
    if (!r || r.code !== 0) return undefined;
    const git = parseGitStatus(r.out);
    // A number, never an option: nothing from the request reaches git's arguments but it.
    if (log !== undefined && log > 0 && git.commit !== undefined) {
      const l = await run(["log", "-n", String(Math.floor(log)), "--format=%h%x09%ct%x09%s"], cwd);
      if (l && l.code === 0) git.log = parseGitLog(l.out);
    }
    return git;
  }
}
