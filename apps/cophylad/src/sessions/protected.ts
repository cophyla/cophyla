// macOS keeps some folders behind a question to the user (TCC): Desktop, Documents, Downloads,
// iCloud Drive, and every removable or network volume. The first time an app reads inside one,
// the read waits for the user's answer to the system's prompt, and cophylad's reads of a
// session's folder (its workspace, its repository) are synchronous, on its one thread: a session
// in ~/Desktop would hold every client, hook and ask until someone clicked. So the first read of
// each such folder is made off the thread, an async readdir in the runtime's pool, and until it
// has settled a synchronous caller leaves the folder alone (`settled` is false) and an
// asynchronous one waits for it (`settle`). Once it has, a synchronous read returns at once:
// it works, or fails with EPERM, which every caller already takes as "not there". Nothing is
// ever asked on another platform, or for a folder outside these.

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isWithin } from "./paths.ts";

export interface ProtectedDeps {
  platform?: NodeJS.Platform;
  home?: string;
  /** The first read of a folder: it resolves or rejects once the user has answered (or at once). */
  firstRead?: (dir: string) => Promise<unknown>;
}

export class ProtectedFolders {
  private platform: NodeJS.Platform;
  private home: string;
  private firstRead: (dir: string) => Promise<unknown>;
  private done = new Set<string>();
  private reads = new Map<string, Promise<void>>();
  private listeners: ((root: string) => void)[] = [];

  constructor(deps: ProtectedDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    this.home = deps.home ?? homedir();
    this.firstRead = deps.firstRead ?? ((dir) => readdir(dir));
  }

  /** The protected folder a path lies in: one of the home's four, or a volume under `/Volumes`; none off macOS. */
  rootOf(path: string): string | undefined {
    if (this.platform !== "darwin") return undefined;
    const p = resolve(path);
    for (const dir of [join(this.home, "Desktop"), join(this.home, "Documents"), join(this.home, "Downloads"), join(this.home, "Library", "Mobile Documents")]) {
      if (isWithin(p, dir, this.platform)) return dir;
    }
    const volume = /^\/Volumes\/[^/]+/.exec(p);
    return volume ? volume[0] : undefined;
  }

  /** Whether a synchronous read under `path` returns at once; if not, its folder's first read is started. */
  settled(path: string): boolean {
    const root = this.rootOf(path);
    if (root === undefined || this.done.has(root)) return true;
    void this.read(root);
    return false;
  }

  /** Resolves once a synchronous read under `path` returns at once. */
  settle(path: string): Promise<void> {
    const root = this.rootOf(path);
    if (root === undefined || this.done.has(root)) return Promise.resolve();
    return this.read(root);
  }

  /** Called with a folder once its first read has settled, so what waited on it is done now. */
  onSettled(fn: (root: string) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private read(root: string): Promise<void> {
    let pending = this.reads.get(root);
    if (!pending) {
      pending = this.firstRead(root).then(
        () => undefined,
        () => undefined,
      ).then(() => {
        this.done.add(root);
        this.reads.delete(root);
        for (const l of this.listeners) l(root);
      });
      this.reads.set(root, pending);
    }
    return pending;
  }
}

/** The process's own: the answers macOS keeps are the process's. */
export const protectedFolders = new ProtectedFolders();

/** Thrown where a synchronous lookup would wait on the user's answer: try again once the folder settles. */
export class NotSettled extends Error {
  readonly root: string;
  constructor(root: string) {
    super(`waiting for macOS to allow access to ${root}`);
    this.name = "NotSettled";
    this.root = root;
  }
}
