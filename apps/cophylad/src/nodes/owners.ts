// Which node owns a folder on this machine. The machine's own node owns everything, but for
// the folders lent to workspace nodes: each of those owns one folder, and a path inside it is
// that node's. A path is resolved the way `Confinement` resolves it (`..`, links, junctions,
// 8.3 short names, case), and the deepest folder that holds it wins.
//
// The owner is decided once, when an item is made: a session, a workspace, a terminal, an
// ask. Everything after that goes by the item's node, never by its path again. What was a
// workspace node's before it was removed keeps its id, which is retired and private: no one's
// apps see it.
//
// `check` is what a folder must pass before it is lent: not the home folder or one holding it,
// not one holding the Cophyla home or the install, not a drive's root, not one overlapping a
// folder already lent, and no session of the machine's own running in it.

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute } from "node:path";
import { pathWithin, RpcError } from "@cophyla/protocol";
import { Confinement } from "./confine.ts";
import type { ConfinementOptions } from "./confine.ts";

export interface OwnersOptions extends ConfinementOptions {
  /** The workspace nodes and their folders. */
  guests?: { id: string; folder: string }[];
  /** The ids of the workspace nodes removed. */
  retired?: string[];
  /** The user's home folder; the OS's by default. */
  home?: string;
  /** The Cophyla home, `~/.cophyla`. */
  cophylaHome: string;
  /** Where the platform is installed, when it is. */
  installRoot?: string;
}

/** What `check` needs to know of the sessions running now. */
export interface CheckOptions {
  /** How many of the machine's own sessions, not ended, run inside a folder (resolved). */
  machineSessionsIn?: (contains: (path: string) => boolean) => number;
}

export class Owners {
  private opts: OwnersOptions;
  private folders = new Map<string, Confinement>();
  private retiredIds: Set<string>;
  /** Resolves a path the way the folders are resolved, for the checks. */
  private resolver: Confinement;

  constructor(opts: OwnersOptions) {
    this.opts = opts;
    this.retiredIds = new Set(opts.retired ?? []);
    this.resolver = new Confinement(undefined, opts);
    for (const g of opts.guests ?? []) this.add(g.id, g.folder);
  }

  /** The workspace node that owns `path`, when one does: the deepest folder holding it. The machine's otherwise. */
  ownerOf(path: string | undefined): string | undefined {
    if (path === undefined || !isAbsolute(path) || this.folders.size === 0) return undefined;
    let best: { id: string; depth: number } | undefined;
    for (const [id, c] of this.folders) {
      if (!c.contains(path)) continue;
      const depth = c.roots[0]!.length;
      if (!best || depth > best.depth) best = { id, depth };
    }
    return best?.id;
  }

  /** The folder a workspace node owns, resolved. */
  folderOf(id: string): string | undefined {
    return this.folders.get(id)?.roots[0];
  }

  /** A workspace node's folder as a confinement: what its other cluster may reach. */
  confinement(id: string): Confinement | undefined {
    return this.folders.get(id);
  }

  /** Whether an id is a workspace node's on this machine. */
  isGuest(id: string | undefined): boolean {
    return id !== undefined && this.folders.has(id);
  }

  /** Whether an id is a workspace node's, now or once: what the machine's own apps never see. */
  isPrivate(id: string | undefined): boolean {
    return id !== undefined && (this.folders.has(id) || this.retiredIds.has(id));
  }

  guests(): string[] {
    return [...this.folders.keys()];
  }

  retired(): string[] {
    return [...this.retiredIds];
  }

  add(id: string, folder: string): void {
    this.folders.set(id, new Confinement([folder], this.opts));
  }

  /** A workspace node that never came to be (its join failed): its folder is the machine's again, and its id is nobody's. */
  drop(id: string): void {
    this.folders.delete(id);
  }

  /** A workspace node removed: its folder is the machine's again, and its id stays private. */
  retire(id: string): void {
    this.folders.delete(id);
    this.retiredIds.add(id);
  }

  /**
   * Refuses a folder that may not be lent; answers it resolved. `except` is a workspace node
   * whose own folder it may be (a node joining again).
   */
  check(folder: string, opts: CheckOptions & { except?: string } = {}): string {
    if (!isAbsolute(folder)) throw new RpcError("invalid", `${folder}: give the folder's full path`);
    let isDir = false;
    try {
      isDir = statSync(folder).isDirectory();
    } catch {
      // not there
    }
    if (!isDir) throw new RpcError("invalid", `no folder ${folder}`);
    const real = this.resolver.resolve(folder, true);
    if (dirname(real) === real) throw new RpcError("invalid", `${real} is a drive's root: lend a folder inside it`);
    const home = this.resolver.resolve(this.opts.home ?? homedir(), true);
    if (pathWithin(home, real)) throw new RpcError("invalid", `${real} is your home folder or holds it: lend a folder inside it`);
    const cophyla = this.resolver.resolve(this.opts.cophylaHome, true);
    if (pathWithin(cophyla, real) || pathWithin(real, cophyla)) throw new RpcError("invalid", `${real} holds Cophyla's own files, or is inside them`);
    if (this.opts.installRoot !== undefined) {
      const install = this.resolver.resolve(this.opts.installRoot, true);
      if (pathWithin(install, real) || pathWithin(real, install)) throw new RpcError("invalid", `${real} holds the Cophyla install, or is inside it`);
    }
    for (const [id, c] of this.folders) {
      if (id === opts.except) continue;
      const other = c.roots[0]!;
      if (pathWithin(real, other) || pathWithin(other, real)) throw new RpcError("conflict", `${real} overlaps ${other}, which another workspace node owns`);
    }
    const inside = (path: string) => pathWithin(this.resolver.resolve(path), real);
    const live = opts.machineSessionsIn?.(inside) ?? 0;
    if (live > 0) throw new RpcError("conflict", `${live === 1 ? "a session of yours runs" : `${live} sessions of yours run`} in ${real}: end ${live === 1 ? "it" : "them"} first, since anything in the folder will belong to the other cluster`);
    return real;
  }
}
