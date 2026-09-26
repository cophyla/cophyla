// A session's files, as a view's explorer shows them: the folders under its working
// directory, a level at a time, and the repository it is in as a status bar has it. The
// directory is the session's cwd, the path its access is checked by, so nothing above it is
// listed: a folder asked for through `..`, or one a link leads out to, is refused. What VS
// Code's explorer leaves out by default (`.git` and its kin) is left out here. Git is read
// with `status --porcelain=v2 --branch`, never fetching, and with GIT_OPTIONAL_LOCKS=0, so it
// takes no lock an agent's own git would trip on; one read runs per directory at a time.

import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { RpcError } from "@cophyla/protocol";
import type { ClientResult, FileEntry, FolderListing, GitState, Session } from "@cophyla/protocol";
import { isWithin } from "./paths.ts";

/** Entries listed per folder; the rest are left out, and the listing says so. */
export const FILES_MAX = 2000;
/** VS Code's `files.exclude` defaults. */
const HIDDEN = new Set([".git", ".svn", ".hg", "CVS", ".DS_Store", "Thumbs.db"]);
const GIT_TIMEOUT_MS = 10_000;

/** Runs git with `args` in `cwd`: its exit code and output, or undefined when there is no git to run. */
export type GitRunner = (args: string[], cwd: string) => Promise<{ code: number; out: string } | undefined>;

export interface SessionFilesDeps {
  /** A session this node holds. */
  session(id: string): Pick<Session, "cwd"> | undefined;
  git?: GitRunner;
  /** Entries per folder; FILES_MAX unless a test says. */
  max?: number;
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

function why(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "ENOENT") return "no such folder";
  if (code === "ENOTDIR") return "not a folder";
  if (code === "EACCES" || code === "EPERM") return "not allowed to read it";
  return e instanceof Error ? e.message : String(e);
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
