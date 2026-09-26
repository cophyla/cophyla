// Replication of what only the primary writes: the threads, messages, tasks, workspaces
// and kv tables, and the files of the editable layer. The primary's `Replicator` hears
// every store write through `Store.onWrite` and every editable file change, numbers them
// and streams them to each backup; a backup asks for a whole snapshot when it joins and
// again whenever the sequence breaks. The backup's `Replica` applies at the store level, so
// nothing above the store hears a replicated row: no `task.ready`, no `chat.message`, no
// hook fires on a backup for work the primary is doing. Four kv namespaces stay local:
// `profiles` (this node's own harness installations), `update` (this node's own staging),
// `grants.local` (the phones paired on this node while it was not the primary) and `voice`
// (the speech engine picked for this machine), which a snapshot keeps rather than wipes.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ReplicaFile, ReplicaSnapshot, ReplicaWrite } from "@cophyla/protocol";
import type { Paths } from "../config/load.ts";
import { snapshotFiles, snapshotTree } from "../editable/watcher.ts";
import type { Logger } from "../log.ts";
import type { Store, StoreWrite } from "../store/index.ts";
import { PROFILE_KV_NS } from "../sessions/profiles.ts";
import { GRANTS_NS, LOCAL_GRANTS_NS } from "../grants/namespaces.ts";
import { VOICE_KV_NS } from "../voice/prefs.ts";

/** The kv namespaces that are a node's own and never replicated: its profiles (their ids, usual accounts and launches), its updates, its own grants and its speech engine. */
export const EXCLUDED_KV_NS = [...PROFILE_KV_NS, "update", LOCAL_GRANTS_NS, VOICE_KV_NS];

const TEXT_EXT = new Set([".ts", ".js", ".mjs", ".md", ".json", ".html", ".css", ".txt", ".toml", ".svg"]);

type EditablePaths = Pick<Paths, "home" | "tools" | "hooks" | "prompts" | "memory" | "views">;

/** A file's wire form: text for source and markdown, base64 for the rest. */
export function fileRecord(home: string, abs: string): ReplicaFile | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(abs);
  } catch {
    return undefined;
  }
  const path = relative(home, abs).split(sep).join("/");
  const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
  return TEXT_EXT.has(ext) ? { path, text: bytes.toString("utf8") } : { path, base64: bytes.toString("base64") };
}

/** Every file of the five editable directories: the flat module and markdown files, and the whole view trees. */
export function editableFiles(paths: EditablePaths): ReplicaFile[] {
  const out: ReplicaFile[] = [];
  const isModule = (n: string) => /^[^._][^/\\]*\.(ts|js|mjs)$/.test(n);
  const isMarkdown = (n: string) => /^[^/\\]+\.md$/.test(n);
  for (const [dir, keep] of [
    [paths.tools, isModule],
    [paths.hooks, isModule],
    [paths.prompts, isMarkdown],
    [paths.memory, isMarkdown],
  ] as const) {
    for (const abs of snapshotFiles(dir, keep).keys()) {
      const f = fileRecord(paths.home, abs);
      if (f) out.push(f);
    }
  }
  for (const abs of snapshotTree(paths.views).keys()) {
    const f = fileRecord(paths.home, abs);
    if (f) out.push(f);
  }
  return out;
}

/** The absolute path a relative one names, refused when it climbs out of the home. */
export function safePath(home: string, rel: string): string | undefined {
  if (rel.includes("\0")) return undefined;
  const abs = resolve(home, rel);
  const root = resolve(home);
  if (abs !== root && !abs.startsWith(root + sep)) return undefined;
  const top = relative(root, abs).split(sep)[0];
  return top && ["tools", "hooks", "prompts", "memory", "views"].includes(top) ? abs : undefined;
}

export interface Backup {
  id: string;
  notify(method: string, params: unknown): boolean;
}

export interface ReplicatorDeps {
  store: Store;
  paths: EditablePaths;
  epoch: () => number;
  log: Logger;
}

/** The primary's side: numbers each write and file change and sends them to every backup. */
export class Replicator {
  private deps: ReplicatorDeps;
  private backups = new Map<string, Backup>();
  private seqValue = 0;

  constructor(deps: ReplicatorDeps) {
    this.deps = deps;
  }

  get seq(): number {
    return this.seqValue;
  }

  /** How many backups are attached now. */
  get attached(): number {
    return this.backups.size;
  }

  /** Hooks the store; call once on becoming primary. */
  start(): void {
    this.deps.store.onWrite = (w) => this.write(w);
  }

  stop(): void {
    this.deps.store.onWrite = undefined;
    this.backups.clear();
  }

  attach(backup: Backup): void {
    this.backups.set(backup.id, backup);
  }

  detach(id: string): void {
    this.backups.delete(id);
  }

  private write(w: StoreWrite): void {
    if (w.table === "kv" && EXCLUDED_KV_NS.includes((w.row as { ns: string }).ns)) return;
    if (this.backups.size === 0) return;
    const frame: ReplicaWrite = { epoch: this.deps.epoch(), seq: ++this.seqValue, table: w.table, op: w.op, row: w.row };
    for (const b of this.backups.values()) b.notify("replicate.write", frame);
  }

  /** An editable file changed or went: sent to every backup as it is now. */
  file(rel: string, kind: "changed" | "removed"): void {
    if (this.backups.size === 0) return;
    const path = rel.split(sep).join("/");
    const frame: ReplicaFile = kind === "removed" ? { path } : (fileRecord(this.deps.paths.home, join(this.deps.paths.home, rel)) ?? { path });
    for (const b of this.backups.values()) b.notify("replicate.file", frame);
  }

  /** Everything a backup needs, at the current sequence. */
  snapshot(): ReplicaSnapshot {
    return { epoch: this.deps.epoch(), seq: this.seqValue, tables: this.deps.store.replicaSnapshot(EXCLUDED_KV_NS), files: editableFiles(this.deps.paths) };
  }
}

export interface ReplicaDeps {
  store: Store;
  paths: EditablePaths;
  selfNode: string;
  /** Reloads the editable layer after files landed. */
  rescan: () => Promise<void>;
  /** Asks the primary for a snapshot. */
  fetchSnapshot: () => Promise<ReplicaSnapshot>;
  /** The primary's grants changed here, by a write or a snapshot: whatever a grant that went held on this node is closed. */
  onGrantsChanged?: () => void;
  log: Logger;
}

/** The backup's side: takes the snapshot, then each write in order; a gap means another snapshot. */
export class Replica {
  private deps: ReplicaDeps;
  private epoch = -1;
  private seq = -1;
  private syncing?: Promise<void>;
  private rescanTimer?: ReturnType<typeof setTimeout>;
  /** Snapshots taken, for the tests. */
  snapshots = 0;

  constructor(deps: ReplicaDeps) {
    this.deps = deps;
    const saved = deps.store.meta.get("replica");
    if (saved) {
      try {
        const r = JSON.parse(saved) as { epoch: number; seq: number };
        this.epoch = r.epoch;
        this.seq = r.seq;
      } catch {
        // start over
      }
    }
  }

  get position(): { epoch: number; seq: number } {
    return { epoch: this.epoch, seq: this.seq };
  }

  private remember(): void {
    this.deps.store.meta.set("replica", JSON.stringify({ epoch: this.epoch, seq: this.seq }));
  }

  /** Fetches and applies a snapshot; concurrent calls share one. */
  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const snapshot = await this.deps.fetchSnapshot();
      await this.applySnapshot(snapshot);
    })().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  async applySnapshot(snapshot: ReplicaSnapshot): Promise<void> {
    this.snapshots++;
    // Files first, then the tables, so a hook file and the kv row it reads land in that order.
    const dirs = [this.deps.paths.tools, this.deps.paths.hooks, this.deps.paths.prompts, this.deps.paths.memory, this.deps.paths.views];
    const keep = new Set<string>();
    for (const f of snapshot.files) {
      const abs = this.writeFile(f);
      if (abs) keep.add(abs);
    }
    // What the primary does not have goes: the backup's own editable files are the primary's copy.
    for (const dir of dirs) for (const abs of snapshotTree(dir).keys()) if (!keep.has(abs)) this.remove(abs);
    this.deps.store.applySnapshot(snapshot, { selfNode: this.deps.selfNode, keepKvNs: EXCLUDED_KV_NS });
    this.epoch = snapshot.epoch;
    this.seq = snapshot.seq;
    this.remember();
    this.deps.onGrantsChanged?.();
    await this.deps.rescan();
    this.deps.log.info("replica synced", { epoch: this.epoch, seq: this.seq, files: snapshot.files.length, threads: snapshot.tables.threads.length, tasks: snapshot.tables.tasks.length });
  }

  /** One write from the primary: applied in order, or the whole thing again on a gap or a new epoch. */
  onWrite(w: ReplicaWrite): void {
    if (this.syncing) return;
    if (w.epoch !== this.epoch || w.seq !== this.seq + 1) {
      this.deps.log.info("replica behind; taking a snapshot", { have: this.position, got: { epoch: w.epoch, seq: w.seq } });
      void this.sync().catch((e: unknown) => this.deps.log.warn("replica sync failed", { error: e instanceof Error ? e.message : String(e) }));
      return;
    }
    this.deps.store.applyReplica(w);
    this.seq = w.seq;
    this.remember();
    if (w.table === "kv" && (w.row as { ns?: unknown } | null)?.ns === GRANTS_NS) this.deps.onGrantsChanged?.();
  }

  onFile(f: ReplicaFile): void {
    if (this.syncing) return;
    this.writeFile(f);
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => void this.deps.rescan(), 50);
    if (typeof this.rescanTimer === "object" && "unref" in this.rescanTimer) this.rescanTimer.unref();
  }

  /** Writes or removes the file the record names; returns the absolute path written. */
  private writeFile(f: ReplicaFile): string | undefined {
    const abs = safePath(this.deps.paths.home, f.path);
    if (!abs) {
      this.deps.log.warn("replicated file refused: outside the editable layer", { path: f.path });
      return undefined;
    }
    if (f.text === undefined && f.base64 === undefined) {
      this.remove(abs);
      return undefined;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.text !== undefined ? f.text : Buffer.from(f.base64!, "base64"));
    return abs;
  }

  private remove(abs: string): void {
    if (existsSync(abs)) rmSync(abs, { force: true });
  }

  dispose(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
  }
}
