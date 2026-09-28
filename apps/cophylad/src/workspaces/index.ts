// The registry of directories where work happens. Entries come from the node's scope, from
// `~/.cophyla` itself (the `cophyla` workspace, where agents write the editable layer), from the
// working directory of every discovered session resolved to its repository root, and from
// `workspace.put`. Every change is streamed as `workspace.state`.
//
// A workspace is the machine's or a workspace node's: a session's is its session's node's, a
// put one the node it names. What reads or writes one by id sees the machine's alone, and a
// workspace node's through `view`. A folder lent to a workspace node takes no workspace of
// the machine's.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { newId, RpcError } from "@cophyla/protocol";
import type { NodeId, NodeScope, Workspace, WorkspaceOrigin } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import { NotSettled, protectedFolders } from "../sessions/protected.ts";
import type { ProtectedFolders } from "../sessions/protected.ts";
import type { Store } from "../store/index.ts";

export interface WorkspacesDeps {
  store: Store;
  nodeId: NodeId;
  bus: Bus;
  now?: () => number;
  /** Which workspace node owns a folder, and whose items the machine's own apps never see; absent, every workspace is the machine's. */
  owners?: { ownerOf(path: string): string | undefined; isPrivate(node: string): boolean };
  /** macOS's protected folders: a directory in one is read only once its first read has settled (protected.ts). */
  guard?: ProtectedFolders;
}

/** One workspace node's workspaces: what its link lists and puts. */
export interface WorkspacesView {
  list(): Workspace[];
  get(id: string): Workspace | undefined;
  put(input: { id?: string; node: NodeId; path: string; name: string }): Workspace;
  annotate(id: string, patch: { summary?: string; tags?: string[] }): Workspace;
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

  private get guard(): ProtectedFolders {
    return this.deps.guard ?? protectedFolders;
  }

  /** Called with a macOS protected folder once it may be read: what `fromSession` refused there resolves now. */
  onSettled(fn: (root: string) => void): () => void {
    return this.guard.onSettled(fn);
  }

  /** Resolves once a directory can be read without waiting on the user (at once off macOS). */
  settle(dir: string): Promise<void> {
    return this.guard.settle(dir);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Whether a workspace is in a partition: a workspace node's own (`part`), or, unset, the machine's. */
  private inPart(w: Pick<Workspace, "node">, part?: string): boolean {
    return part === undefined ? !(this.deps.owners?.isPrivate(w.node) ?? false) : w.node === part;
  }

  /** Every workspace of a partition (the machine's unless named), or one node's of it. */
  list(filter: { node?: string } = {}, part?: string): Workspace[] {
    const all = this.deps.store.workspaces.list().filter((w) => this.inPart(w, part));
    return filter.node === undefined ? all : all.filter((w) => w.node === filter.node);
  }

  /** A workspace of the machine's, or of the partition named. */
  get(id: string, part?: string): Workspace | undefined {
    const w = this.deps.store.workspaces.get(id);
    return w && this.inPart(w, part) ? w : undefined;
  }

  /** A workspace of any partition: for what follows it wherever it is. */
  getAny(id: string): Workspace | undefined {
    return this.deps.store.workspaces.get(id);
  }

  /** One workspace node's workspaces. */
  view(node: string): WorkspacesView {
    return {
      list: () => this.list({}, node),
      get: (id) => this.get(id, node),
      put: (input) => this.put(input, node),
      annotate: (id, patch) => this.annotate(id, patch, node),
    };
  }

  /** Adds or renames a workspace by hand, in a partition: the machine's unless named. */
  put(input: { id?: string; node: NodeId; path: string; name: string }, part?: string): Workspace {
    const owners = this.deps.owners;
    if (part === undefined ? (owners?.isPrivate(input.node) ?? false) : input.node !== part) throw new RpcError("not_found", `no node ${input.node}`);
    if (!this.guard.settled(input.path)) throw new RpcError("unavailable", `macOS is asking whether Cophyla may read ${this.guard.rootOf(input.path)}; try again once it is answered`);
    const path = normalisePath(input.path);
    if (!isDirectory(path)) throw new RpcError("not_found", `no directory at ${path}`);
    const owner = owners?.ownerOf(path);
    // A lent folder is its workspace node's alone, and that node's workspaces are inside it.
    if (part === undefined && owner !== undefined) throw new RpcError("conflict", `${path} is lent to a workspace node`);
    if (part !== undefined && owner !== part) throw new RpcError("denied", `${path} is outside the folder this node owns`);
    const existing = (input.id ? this.get(input.id, part) : undefined) ?? this.deps.store.workspaces.getByPath(input.node, path);
    const now = this.now();
    const w: Workspace = existing
      ? { ...existing, path, name: input.name, origin: "user", lastActivity: now }
      : { id: newId("workspace", now), node: input.node, path, name: input.name, origin: "user", tags: [], lastActivity: now };
    const repo = this.allowedRepo(w.node, findRepo(path));
    if (repo && !w.repo) w.repo = repo;
    return this.save(w);
  }

  /** One workspace per path in a `workspaces` scope; nothing for a `machine` scope. */
  fromScope(scope: NodeScope): Workspace[] {
    if (scope.kind !== "workspaces") return [];
    const out: Workspace[] = [];
    for (const p of scope.paths) {
      if (this.guard.settled(p)) out.push(this.upsertDiscovered(p, "scope"));
      else void this.guard.settle(p).then(() => this.upsertDiscovered(p, "scope"));
    }
    return out;
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

  /** The folder a session's workspace is recorded at when its repository reaches above the folders its node may show: a confined node's, a workspace node's. */
  clampRoot?: (root: string, cwd: string, node: NodeId) => string;

  /**
   * Whether a repository may be recorded on a workspace of `node`: on a node that shares some
   * folders alone, one whose root is inside them. A repository above would tell the primary
   * its remote and, through its state, what is outside.
   */
  repoInside?: (node: NodeId, root: string) => boolean;

  private allowedRepo(node: NodeId, repo: RepoInfo | undefined): RepoInfo | undefined {
    return repo && (this.repoInside?.(node, repo.root) ?? true) ? repo : undefined;
  }

  /** The workspace a session's working directory belongs to, on the session's node: its repository root, or the directory itself. */
  fromSession(cwd: string, node: NodeId = this.deps.nodeId): Workspace {
    // A folder macOS has not been asked about yet: reading it now would wait on the user.
    if (!this.guard.settled(cwd)) throw new NotSettled(this.guard.rootOf(cwd)!);
    const repo = findRepo(cwd);
    const root = repo ? repo.root : cwd;
    const at = this.clampRoot ? this.clampRoot(root, cwd, node) : root;
    return this.upsertDiscovered(at, "discovered", at === root ? repo : undefined, node);
  }

  private upsertDiscovered(path: string, origin: WorkspaceOrigin, repo?: RepoInfo, node: NodeId = this.deps.nodeId): Workspace {
    const norm = normalisePath(path);
    const existing = this.deps.store.workspaces.getByPath(node, norm);
    const now = this.now();
    repo = this.allowedRepo(node, repo);
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
      node,
      path: norm,
      name: basename(norm) || norm,
      origin,
      tags: [],
      lastActivity: now,
    };
    const found = repo ?? this.allowedRepo(w.node, findRepo(norm));
    if (found) w.repo = found;
    return this.save(w);
  }

  /** The one-line summary and the tags, written by the brain when it archives or by the user. */
  annotate(id: string, patch: { summary?: string; tags?: string[] }, part?: string): Workspace {
    const w = this.get(id, part);
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
