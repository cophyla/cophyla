// Noticing edits under `~/.cophyla`: a snapshot of a directory's files by `(mtimeMs, size)`,
// the diff between two, and a watcher that debounces `fs.watch` on each directory into one
// callback and runs a slow safety poll behind it, for the platforms and mounts where
// `fs.watch` says nothing. Module files are `.ts`, `.js` and `.mjs` not prefixed with `.`
// or `_` (a `_helper.ts` is import space, not a tool); markdown files follow the name rule.

import { readdirSync, realpathSync, statSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../log.ts";
import { NAME } from "./files.ts";

export type Snapshot = Map<string, { mtimeMs: number; size: number }>;

export interface Diff {
  added: string[];
  changed: string[];
  removed: string[];
}

export const MODULE_FILE = /^[^._][^/\\]*\.(ts|js|mjs)$/;
export const MARKDOWN_FILE = /^[^/\\]+\.md$/;

export const isModuleFile = (name: string): boolean => MODULE_FILE.test(name);
export const isMarkdownFile = (name: string): boolean => MARKDOWN_FILE.test(name) && NAME.test(name.slice(0, -3));

/** The files directly under `dir` that `keep` accepts, as absolute paths with their stamps. */
export function snapshotFiles(dir: string, keep: (name: string) => boolean): Snapshot {
  const out: Snapshot = new Map();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!keep(name)) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (st.isFile()) out.set(path, { mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // gone between readdir and stat
    }
  }
  return out;
}

/** Every regular file under `dir`, recursively, dotfiles and `node_modules` left out. */
export function snapshotTree(dir: string): Snapshot {
  const out: Snapshot = new Map();
  const visit = (abs: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(abs, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const st = statSync(path);
        out.set(path, { mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // gone
      }
    }
  };
  visit(dir);
  return out;
}

export function diff(before: Snapshot, after: Snapshot): Diff {
  const d: Diff = { added: [], changed: [], removed: [] };
  for (const [path, stamp] of after) {
    const old = before.get(path);
    if (!old) d.added.push(path);
    else if (old.mtimeMs !== stamp.mtimeMs || old.size !== stamp.size) d.changed.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) d.removed.push(path);
  d.added.sort();
  d.changed.sort();
  d.removed.sort();
  return d;
}

export interface DirWatcherDeps {
  /** The directories to watch now; asked again at every `refresh`. */
  dirs: () => string[];
  onChange: () => void;
  log: Logger;
  /** Milliseconds between safety polls; 0 turns the poll off. */
  pollMs: number;
  debounceMs?: number;
}

const DEBOUNCE_MS = 150;

export class DirWatcher {
  private deps: DirWatcherDeps;
  private watchers = new Map<string, FSWatcher>();
  private debounce?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private stopped = true;

  constructor(deps: DirWatcherDeps) {
    this.deps = deps;
  }

  start(): void {
    this.stopped = false;
    this.refresh();
    if (this.deps.pollMs > 0) {
      this.poll = setInterval(() => this.deps.onChange(), this.deps.pollMs);
      if (typeof this.poll === "object" && "unref" in this.poll) this.poll.unref();
    }
  }

  /** Watches the directories that exist now and drops the ones that went. */
  refresh(): void {
    if (this.stopped) return;
    const wanted = new Set<string>();
    for (const dir of this.deps.dirs()) {
      let key: string;
      try {
        key = realpathSync(dir);
      } catch {
        continue;
      }
      wanted.add(key);
      if (this.watchers.has(key)) continue;
      try {
        const w = watch(key, { persistent: false }, () => this.schedule());
        w.on("error", () => {
          this.watchers.delete(key);
        });
        this.watchers.set(key, w);
      } catch (e) {
        this.deps.log.debug("watch failed", { dir: key, error: e instanceof Error ? e.message : String(e) });
      }
    }
    for (const [key, w] of this.watchers) {
      if (wanted.has(key)) continue;
      w.close();
      this.watchers.delete(key);
    }
  }

  private schedule(): void {
    if (this.debounce || this.stopped) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      this.deps.onChange();
    }, this.deps.debounceMs ?? DEBOUNCE_MS);
    if (typeof this.debounce === "object" && "unref" in this.debounce) this.debounce.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = undefined;
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }
}
