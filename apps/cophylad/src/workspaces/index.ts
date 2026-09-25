// The registry of directories where work happens. Entries come from the node's scope, from
// `~/.cophyla` itself (the `cophyla` workspace, where agents write the editable layer), from the
// working directory of every discovered session resolved to its repository root, and from
// `workspace.put`. Every change is streamed as `workspace.state`.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { newId, RpcError } from "@cophyla/protocol";
import type { NodeId, NodeScope, Workspace, WorkspaceOrigin } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import type { Store } from "../store/index.ts";

export interface WorkspacesDeps {
  store: Store;
  nodeId: NodeId;
  bus: Bus;
  now?: () => number;
}

const TOUCH_COALESCE_MS = 1000;
/** What the `~/.cophyla` workspace is called: the brain names it in a spawn prompt. */
export const HOME_NAME = "cophyla";

/** Whether a path names a directory this node can see. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A path as the registry keys it: absolute, real where it exists, drive letter upper-cased. */
export function normalisePath(p: string): string {
  let out = resolve(p);
  try {
    out = realpathSync.native(out);
  } catch {
    // Not there (yet); keep the resolved form.
  }
  if (process.platform === "win32" && /^[a-z]:/.test(out)) out = out[0]!.toUpperCase() + out.slice(1);
  return out;
}

interface RepoInfo {
  root: string;
  remote?: string;
}

function gitDirOf(root: string): string | undefined {
  const dotGit = join(root, ".git");
  try {
    const st = statSync(dotGit);
    if (st.isDirectory()) return dotGit;
    if (st.isFile()) {
      // A worktree or submodule: `gitdir: <path>`, whose `commondir` names the shared directory.
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      if (!m) return undefined;
      const gitdir = resolve(root, m[1]!.trim());
      const common = join(gitdir, "commondir");
      if (existsSync(common)) return resolve(gitdir, readFileSync(common, "utf8").trim());
      return gitdir;
    }
  } catch {
    // no .git here
  }
  return undefined;
}

function originUrl(gitDir: string): string | undefined {
  try {
    const text = readFileSync(join(gitDir, "config"), "utf8");
    const section = /\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/.exec(text);
    if (!section) return undefined;
    const url = /^\s*url\s*=\s*(.+)$/m.exec(section[1]!);
    return url ? url[1]!.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Walks up from a directory to the nearest repository. */
export function findRepo(cwd: string): RepoInfo | undefined {
  let dir = normalisePath(cwd);
  for (;;) {
    const gitDir = gitDirOf(dir);
    if (gitDir) {
      const info: RepoInfo = { root: dir };
      const remote = originUrl(gitDir);
      if (remote) info.remote = remote;
      return info;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export class Workspaces {
  private deps: WorkspacesDeps;
  private touches = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();

  constructor(deps: WorkspacesDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Every workspace, or one node's. */
  list(filter: { node?: string } = {}): Workspace[] {
    const all = this.deps.store.workspaces.list();
    return filter.node === undefined ? all : all.filter((w) => w.node === filter.node);
  }

  get(id: string): Workspace | undefined {
    return this.deps.store.workspaces.get(id);
  }

  /** Adds or renames a workspace by hand. */
  put(input: { id?: string; node: NodeId; path: string; name: string }): Workspace {
    const path = normalisePath(input.path);
    if (!isDirectory(path)) throw new RpcError("not_found", `no directory at ${path}`);
    const existing = (input.id ? this.deps.store.workspaces.get(input.id) : undefined) ?? this.deps.store.workspaces.getByPath(input.node, path);
    const now = this.now();
    const w: Workspace = existing
      ? { ...existing, path, name: input.name, origin: "user", lastActivity: now }
      : { id: newId("workspace", now), node: input.node, path, name: input.name, origin: "user", tags: [], lastActivity: now };
    const repo = findRepo(path);
    if (repo && !w.repo) w.repo = repo;
    return this.save(w);
  }

  /** One workspace per path in a `workspaces` scope; nothing for a `machine` scope. */
  fromScope(scope: NodeScope): Workspace[] {
    if (scope.kind !== "workspaces") return [];
    return scope.paths.map((p) => this.upsertDiscovered(p, "scope"));
  }

  /**
   * `~/.cophyla` as a workspace named `cophyla`: where the brain starts an agent to write a tool, a
   * hook or a view. Registered like a scope path; an entry discovered earlier under the
   * directory's own name is renamed once, a name the user gave is kept.
   */
  home(path: string): Workspace {
    const w = this.upsertDiscovered(path, "scope");
    if (w.name === HOME_NAME || w.origin === "user") return w;
    return this.save({ ...w, name: HOME_NAME, lastActivity: this.now() });
  }

  /** The workspace a session's working directory belongs to: its repository root, or the directory itself. */
  /** On a node that shares some folders alone, the folder a session's workspace is recorded at when its repository reaches above them. */
  clampRoot?: (root: string, cwd: string) => string;

  fromSession(cwd: string): Workspace {
    const repo = findRepo(cwd);
    const root = repo ? repo.root : cwd;
    const at = this.clampRoot ? this.clampRoot(root, cwd) : root;
    return this.upsertDiscovered(at, "discovered", at === root ? repo : undefined);
  }

  private upsertDiscovered(path: string, origin: WorkspaceOrigin, repo?: RepoInfo): Workspace {
    const norm = normalisePath(path);
    const existing = this.deps.store.workspaces.getByPath(this.deps.nodeId, norm);
    const now = this.now();
    if (existing) {
      let changed = false;
      if (repo && !existing.repo) {
        existing.repo = repo;
        changed = true;
      }
      if (changed) return this.save({ ...existing, lastActivity: now });
      return existing;
    }
    const w: Workspace = {
      id: newId("workspace", now),
      node: this.deps.nodeId,
      path: norm,
      name: basename(norm) || norm,
      origin,
      tags: [],
      lastActivity: now,
    };
    const found = repo ?? findRepo(norm);
    if (found) w.repo = found;
    return this.save(w);
  }

  /** The one-line summary and the tags, written by the brain when it archives or by the user. */
  annotate(id: string, patch: { summary?: string; tags?: string[] }): Workspace {
    const w = this.deps.store.workspaces.get(id);
    if (!w) throw new RpcError("not_found", `no workspace ${id}`);
    const next: Workspace = { ...w };
    if (patch.summary !== undefined) next.summary = patch.summary;
    if (patch.tags !== undefined) next.tags = patch.tags;
    return this.save(next);
  }

  /** Bumps `lastActivity`, at most once a second per workspace. */
  touch(id: string, at = this.now()): void {
    const pending = this.touches.get(id);
    if (pending) {
      pending.at = Math.max(pending.at, at);
      return;
    }
    const timer = setTimeout(() => {
      const t = this.touches.get(id);
      this.touches.delete(id);
      const w = this.deps.store.workspaces.get(id);
      if (!w || !t) return;
      if (t.at > w.lastActivity) this.save({ ...w, lastActivity: t.at });
    }, TOUCH_COALESCE_MS);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    this.touches.set(id, { at, timer });
  }

  private save(w: Workspace): Workspace {
    const id = this.deps.store.workspaces.upsert(w);
    const stored = this.deps.store.workspaces.get(id)!;
    this.deps.bus.emit("workspace.state", stored);
    return stored;
  }

  dispose(): void {
    for (const t of this.touches.values()) clearTimeout(t.timer);
    this.touches.clear();
  }
}
