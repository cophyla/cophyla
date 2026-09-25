// What the primary may see and do on this node, when this node's owner said which folders:
// `cophylad join --workspace`, kept in data/link.json, or `[node.scope]`'s workspaces. The
// node's own apps are never confined; the primary's requests and what goes up the link are.
// A path counts as inside once it is resolved the way the file system would (`..`, links,
// junctions, 8.3 short names, case), so a link planted inside a folder does not lead out of
// it; the roots are resolved the same way. The rows the primary is sent are judged by the
// same `allows` the clients' access uses, against those roots.
//
// This is not a sandbox. It keeps the primary's requests and views to the folders named; a
// session the primary starts there runs as this machine's user, and what an agent does in
// it is the agent's business, as on any node.

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { allows, FULL, pathWithin, RpcError, sessionTarget, trimSample, workspaceTarget } from "@cophyla/protocol";
import type { Access, Ask, MetricsSample, Session, TargetLookup, Workspace } from "@cophyla/protocol";

/** How many resolved paths are remembered: what the rows and the samples ask about again and again. */
const CACHE = 512;

export interface ConfinementOptions {
  /** The file system's own resolution of an existing path; `realpathSync.native` by default. */
  realpath?: (path: string) => string;
  exists?: (path: string) => boolean;
}

export class Confinement {
  /** The folders, resolved; empty when the node is not confined. */
  readonly roots: string[];
  private realpath: (path: string) => string;
  private exists: (path: string) => boolean;
  private cache = new Map<string, string>();

  constructor(paths: readonly string[] | undefined, opts: ConfinementOptions = {}) {
    this.realpath = opts.realpath ?? ((p) => realpathSync.native(p));
    this.exists = opts.exists ?? existsSync;
    this.roots = (paths ?? []).map((p) => this.resolve(p));
  }

  /** Whether the primary is confined here at all. */
  get active(): boolean {
    return this.roots.length > 0;
  }

  /** The access the rows are judged by: every scope, these folders alone. */
  get access(): Access {
    return { ...FULL, paths: this.roots };
  }

  /**
   * A path as the file system would take it: absolute, `..` folded, and the longest part of
   * it that exists resolved through its links, junctions and short names, the rest appended.
   */
  resolve(path: string, fresh = false): string {
    const hit = fresh ? undefined : this.cache.get(path);
    if (hit !== undefined) return hit;
    let abs = resolve(path);
    const rest: string[] = [];
    let real: string | undefined;
    for (;;) {
      if (this.exists(abs)) {
        try {
          real = this.realpath(abs);
        } catch {
          real = abs;
        }
        break;
      }
      const up = dirname(abs);
      if (up === abs) break;
      rest.unshift(abs.slice(up.length).replace(/^[\\/]+/, ""));
      abs = up;
    }
    const out = real === undefined ? resolve(path) : rest.length > 0 ? join(real, ...rest) : real;
    if (this.cache.size >= CACHE) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(path, out);
    return out;
  }

  /**
   * Whether a path is inside one of the folders, resolved; every path is, when the node is not
   * confined. `fresh` resolves it again rather than trusting what was resolved before: what a
   * request acts on, where a link swapped in since would otherwise lead out.
   */
  contains(path: string | undefined, fresh = false): boolean {
    if (!this.active) return true;
    if (path === undefined || !isAbsolute(path)) return false;
    const real = this.resolve(path, fresh);
    return this.roots.some((root) => pathWithin(real, root));
  }

  /** Refuses a path outside the folders, resolved afresh, saying what it was for. */
  require(path: string | undefined, what: string): void {
    if (!this.contains(path, true)) throw new RpcError("denied", `${what} is outside the folders this node shares`);
  }

  session(s: Pick<Session, "cwd">): boolean {
    return this.contains(s.cwd);
  }

  workspace(w: Pick<Workspace, "path">): boolean {
    return this.contains(w.path);
  }

  /** A row as `allows` judges it, and its path resolved on top. */
  sessionRow(s: Pick<Session, "node" | "workspace" | "cwd">, look: TargetLookup): boolean {
    return !this.active || (allows(this.access, sessionTarget(s), look) && this.session(s));
  }

  workspaceRow(w: Pick<Workspace, "id" | "node" | "path">, look: TargetLookup): boolean {
    return !this.active || (allows(this.access, workspaceTarget(w), look) && this.workspace(w));
  }

  /**
   * An ask the primary may see: a harness's about a session inside, or one this node's gate
   * raised over a request the primary made; this node's own prompts about anything else stay here.
   */
  ask(a: Pick<Ask, "source">, sessionOf: (id: string) => Pick<Session, "cwd"> | undefined): boolean {
    if (!this.active) return true;
    if (a.source.kind === "harness") {
      const s = sessionOf(a.source.session);
      return s !== undefined && this.session(s);
    }
    return a.source.kind === "gate" && a.source.principal.kind === "node";
  }

  /** A sample with the processes of sessions outside folded into the row of the others. */
  sample(sample: MetricsSample, sessionOf: (id: string) => Pick<Session, "cwd"> | undefined): MetricsSample {
    if (!this.active) return sample;
    return trimSample(sample, (id) => {
      const s = sessionOf(id);
      return s !== undefined && this.session(s);
    });
  }

  /**
   * The folder a session's workspace should be recorded at: its repository's root, unless that
   * reaches above the folder the session is in, when the folder it is in stands for it.
   */
  clamp(root: string, cwd: string): string {
    if (!this.active || this.contains(root)) return root;
    const inside = this.roots.find((r) => pathWithin(this.resolve(cwd), r));
    return inside ?? root;
  }
}
