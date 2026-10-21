// What a transfer pulls, as the sending machine lists it (`files.tree`): a file as one entry,
// a folder as its folders and files, each folder before what is in it, by its path under the
// folder with `/` between the names, in name order. A link is never followed, a symbolic
// one, a junction or anything else that is neither a folder nor a plain file: it is left out
// and counted (`skipped`), so nothing outside the folder comes with it. The path itself may be
// a link, which is resolved once, to what is sent. A folder of more than TREE_MAX entries is
// refused. A listing comes a page at a time, from a walk kept a short while, so a long one
// fits what a relayed link carries in one message.

import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { RpcError } from "@cophyla/protocol";
import type { nodeLinkRequests, TreeEntry } from "@cophyla/protocol";
import type { z } from "zod";

/** Entries a folder may hold, all the way down. */
export const TREE_MAX = 100_000;
/** Entries per page of a listing. */
export const TREE_PAGE = 5000;
/** How long a walk is kept for its next pages. */
const KEEP_MS = 120_000;
/** Walks kept at once. */
const KEEP = 4;

export type TreePage = z.infer<(typeof nodeLinkRequests)["files.tree"]["result"]>;

/** A path walked: what it is, its name, and every entry under it. */
export interface Tree {
  kind: "file" | "folder";
  name: string;
  entries: TreeEntry[];
  /** Bytes of its files. */
  total: number;
  files: number;
  skipped: number;
}

export interface WalkOptions {
  max?: number;
  /** Refuses a path the walk may not reach: a confined node's, outside the folders it shares. */
  require?: (path: string) => void;
}

function fsError(path: string, e: unknown): RpcError {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return new RpcError("not_found", `${path}: no such file or folder`);
  if (code === "EACCES" || code === "EPERM") return new RpcError("denied", `${path}: not allowed to read it`);
  return new RpcError("unavailable", `${path}: ${e instanceof Error ? e.message : String(e)}`);
}

/** The time a file last changed, in whole milliseconds, as a pipe's answer gives it. */
export function mtimeOf(ms: number): number {
  return Math.max(0, Math.floor(ms));
}

/** Walks `path`: a file, or a folder and everything under it. */
export async function walk(path: string, opts: WalkOptions = {}): Promise<Tree> {
  if (!isAbsolute(path)) throw new RpcError("invalid", `${path}: not an absolute path`);
  opts.require?.(path);
  const name = basename(path.replace(/[\\/]+$/, ""));
  if (!name || /^[A-Za-z]:$/.test(name)) throw new RpcError("invalid", `${path}: a drive or the root is not sent whole: send a folder in it`);
  let real: string;
  try {
    real = await realpath(path);
  } catch (e) {
    throw fsError(path, e);
  }
  opts.require?.(real);
  let info;
  try {
    info = await stat(real);
  } catch (e) {
    throw fsError(path, e);
  }
  if (info.isFile()) return { kind: "file", name, entries: [{ rel: "", size: info.size, mtimeMs: mtimeOf(info.mtimeMs) }], total: info.size, files: 1, skipped: 0 };
  if (!info.isDirectory()) throw new RpcError("invalid", `${path}: neither a file nor a folder`);
  const max = opts.max ?? TREE_MAX;
  const tree: Tree = { kind: "folder", name, entries: [], total: 0, files: 0, skipped: 0 };
  const visit = async (dir: string, rel: string): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(dir)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    } catch (e) {
      // the folder itself could not be read: what it holds is left out, the folder kept
      if (rel === "") throw fsError(path, e);
      tree.skipped++;
      return;
    }
    for (const n of names) {
      const full = join(dir, n);
      const childRel = rel === "" ? n : `${rel}/${n}`;
      let l;
      try {
        // lstat, never stat: a link, a junction among them, is not followed
        l = await lstat(full);
      } catch {
        tree.skipped++;
        continue;
      }
      if (l.isSymbolicLink()) {
        tree.skipped++;
        continue;
      }
      if (l.isDirectory()) {
        tree.entries.push({ rel: childRel, dir: true });
        if (tree.entries.length > max) break;
        await visit(full, childRel);
      } else if (l.isFile()) {
        tree.entries.push({ rel: childRel, size: l.size, mtimeMs: mtimeOf(l.mtimeMs) });
        tree.total += l.size;
        tree.files++;
      } else tree.skipped++;
      if (tree.entries.length > max) break;
    }
  };
  await visit(real, "");
  if (tree.entries.length > max) throw new RpcError("invalid", `${name} holds more than ${max} files and folders: send a smaller folder, or an archive of it`);
  return tree;
}

/** A page of a tree, from entry `from`. */
export function page(tree: Tree, from = 0, size = TREE_PAGE): TreePage {
  const entries = tree.entries.slice(from, from + size);
  const next = from + entries.length;
  return {
    kind: tree.kind,
    name: tree.name,
    entries,
    total: tree.total,
    files: tree.files,
    count: tree.entries.length,
    skipped: tree.skipped,
    ...(next < tree.entries.length ? { next } : {}),
  };
}

/** The walks served lately, so a long listing's later pages are of the same walk. */
export class TreeCache {
  private kept = new Map<string, { tree: Tree; at: number }>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** A page of `path`'s listing: a fresh walk for the first page, the kept one for the rest. */
  async page(path: string, from: number | undefined, opts: WalkOptions = {}): Promise<TreePage> {
    const at = this.now();
    for (const [k, v] of this.kept) if (at - v.at > KEEP_MS) this.kept.delete(k);
    let kept = from ? this.kept.get(path) : undefined;
    if (!kept) {
      kept = { tree: await walk(path, opts), at };
      this.kept.delete(path);
      this.kept.set(path, kept);
      while (this.kept.size > KEEP) this.kept.delete(this.kept.keys().next().value!);
    }
    return page(kept.tree, from ?? 0);
  }
}
