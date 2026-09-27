// A session's files, as a view's explorer shows them: the folders under its working
// directory, a level at a time, and the repository it is in as a status bar has it. The
// directory is the session's cwd, the path its access is checked by, so nothing above it is
// listed: a folder asked for through `..`, or one a link leads out to, is refused. What VS
// Code's explorer leaves out by default (`.git` and its kin) is left out here. Git is read
// with `status --porcelain=v2 --branch`, never fetching, and with GIT_OPTIONAL_LOCKS=0, so it
// takes no lock an agent's own git would trip on; one read runs per directory at a time.
// A file under the directory is read for a viewer by the same rule: its first MiB as text,
// decoded from UTF-8 or from UTF-16 by its byte order mark, or only that it is not text when
// a NUL shows in its first 8000 bytes, as git decides; a folder, a pipe or a device is
// refused before anything opens it, so a read never waits on a writer.

import { open, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { RpcError } from "@cophyla/protocol";
import type { ClientResult, FileEntry, FileText, FolderListing, GitState, Session } from "@cophyla/protocol";
import { isWithin } from "./paths.ts";

/** Entries listed per folder; the rest are left out, and the listing says so. */
export const FILES_MAX = 2000;
/** VS Code's `files.exclude` defaults. */
const HIDDEN = new Set([".git", ".svn", ".hg", "CVS", ".DS_Store", "Thumbs.db"]);
const GIT_TIMEOUT_MS = 10_000;
/** Bytes of a file a viewer is sent; a longer one comes cut short, and says so. */
export const FILE_TEXT_MAX = 1024 * 1024;
/** How far into a file a NUL is looked for: one there makes it binary, as git decides. */
const SNIFF_BYTES = 8000;

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
  platform?: string;
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
  return { path: r.path, size: r.size, ...(r.text !== undefined ? { chars: r.text.length } : {}), ...(r.truncated ? { truncated: true } : {}), ...(r.binary ? { binary: true } : {}) };
}

/** A listing as the audit row keeps it: the folders and how many entries each had, not the names. */
export function listingSummary(r: FilesResult): unknown {
  return { root: r.root, dirs: r.dirs.map((d) => ({ dir: d.dir, ...(d.entries ? { entries: d.entries.length } : {}), ...(d.truncated ? { truncated: true } : {}), ...(d.error ? { error: d.error } : {}) })) };
}

function spawnGit(args: string[], cwd: string) {
  try {
    return Bun.spawn(["git", ...args], { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }, stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
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

  /**
   * A file under the session's directory, by its path there: its text, the first `textMax`
   * bytes of a longer one, or that it is not text. One outside the directory, through `..` or
   * a link that leads out, is refused, and so is anything but a plain file.
   */
  async read(id: string, path: string): Promise<FileText> {
    const root = this.cwd(id);
    const platform = this.deps.platform ?? process.platform;
    const parts = folderParts(path, platform);
    if (!parts || parts.length === 0) throw new RpcError("invalid", `${path}: not a file under the session's folder`);
    let real: string;
    try {
      real = await realpath(root);
    } catch (e) {
      throw new RpcError("not_found", `${root}: ${why(e)}`);
    }
    let target: string;
    try {
      target = await realpath(join(root, ...parts));
    } catch (e) {
      throw readError(path, e);
    }
    // A link inside may lead anywhere: what it leads to must still be under the directory.
    if (!isWithin(target, real, platform)) throw new RpcError("denied", `${path}: outside the session's folder`);
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new RpcError("invalid", `${path}: ${info.isDirectory() ? "a folder" : "not a file"}`);
      const file = await open(target, "r");
      try {
        const bytes = new Uint8Array(Math.min(info.size, this.deps.textMax ?? FILE_TEXT_MAX));
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

  /** The repository the session's directory is in; undefined outside one, or without git. */
  git(id: string): Promise<GitState | undefined> {
    const cwd = this.cwd(id);
    let read = this.reading.get(cwd);
    if (!read) {
      read = this.readGit(cwd).finally(() => this.reading.delete(cwd));
      this.reading.set(cwd, read);
    }
    return read;
  }

  private async readGit(cwd: string): Promise<GitState | undefined> {
    const r = await (this.deps.git ?? runGit)(["status", "--porcelain=v2", "--branch"], cwd);
    return r && r.code === 0 ? parseGitStatus(r.out) : undefined;
  }
}
