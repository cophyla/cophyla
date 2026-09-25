// The cloud backup: the replica set (threads, messages, tasks, workspaces, the brain's kv
// state, and the editable files) kept on the server as objects this node encrypts under a
// key its passphrase derives, one per row and per file, under names the server cannot
// resolve. The sender hears every store write and every editable file change, and acts
// only on the primary with backup on: it reads the row or file again, hashes it, and sends
// nothing when the hash is what the server already holds (which is also how the file burst
// of every rescan costs nothing), else seals it at the next version and puts it, a few in
// flight at a time. The ledger (`backup_sync`) is the truth about what was sent; there is no
// outbox: a put that fails leaves its row unacknowledged, and the reconcile at the next
// link-up sends what moved and drops what the server has that this node no longer does.
// A `conflict` means another node owns the account's backup and pauses the sender; so does
// a full quota, a plan without backup, and a sign-out. Restore is the other direction: the
// objects pulled, opened, and applied as a backup node applies a snapshot, with the brain
// stopped around it and every client closed after, so each view reloads its picture.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RpcError } from "@cophyla/protocol";
import type { BackupHeader, BackupKind, BackupState, Message, ReplicaFile, ReplicaSnapshot, Task, Thread, Workspace } from "@cophyla/protocol";
import { CLOSE_ROLE_CHANGED } from "../api/server.ts";
import type { ClientRegistry } from "../api/clients.ts";
import { snapshotTree } from "../editable/watcher.ts";
import type { Logger } from "../log.ts";
import { RESERVED_KV_NS } from "../grants/namespaces.ts";
import { EXCLUDED_KV_NS, editableFiles, fileRecord, safePath } from "../nodes/replication.ts";
import type { KvRow, Store, StoreWrite } from "../store/index.ts";
import { BackupKeyFile, MAX_PLAINTEXT_BYTES, deriveKeys, newKdf, objectKey, open, sameKeyId, seal } from "./backup-crypto.ts";
import type { BackupKeys } from "./backup-crypto.ts";
import type { LinkRequestOptions } from "./link.ts";

/** The kv namespaces the backup leaves out: a node's own harness installs and staging, and every grant with its keys, and the cluster they make. */
export const BACKUP_EXCLUDED_KV_NS: readonly string[] = [...EXCLUDED_KV_NS, ...RESERVED_KV_NS.filter((ns) => !EXCLUDED_KV_NS.includes(ns))];
/** The kv namespaces a restore keeps from the fresh install: the same ones, which are this machine's. */
export const RESTORE_KEEP_KV_NS: readonly string[] = BACKUP_EXCLUDED_KV_NS;

export const DEBOUNCE_MS = 250;
/** Every session touches its workspace row once a second; the row is sent no more often than this. */
export const WORKSPACE_DEBOUNCE_MS = 10_000;
export const MAX_IN_FLIGHT = 4;
export const REQUEST_TIMEOUT_MS = 30_000;
/** How often the state is broadcast while a sync runs. */
const PROGRESS_EVERY_MS = 1000;
const PROGRESS_EVERY_OBJECTS = 20;

const FILE_KINDS: Record<string, BackupKind> = { memory: "memory", prompts: "prompts", tools: "tools", hooks: "hooks", views: "views" };
export const BACKUP_KINDS: readonly BackupKind[] = ["memory", "prompts", "chat", "tasks", "workspaces", "state", "tools", "hooks", "views"];

/** A backed-up object's plaintext: a row with its table, or a file with its content. */
type RowObject = { id: string; table: "threads" | "messages" | "tasks" | "workspaces" | "kv"; row: unknown };
type Plain = RowObject | ReplicaFile;

interface Built {
  kind: BackupKind;
  id: string;
  key: string;
  plaintext: Buffer;
  hash: string;
}

interface Pending {
  kind: BackupKind;
  id: string;
  timer?: ReturnType<typeof setTimeout>;
}

export interface BackupPaths {
  home: string;
  tools: string;
  hooks: string;
  prompts: string;
  memory: string;
  views: string;
  backupKey: string;
}

export interface BackupSyncDeps {
  store: Store;
  paths: BackupPaths;
  log: Logger;
  nodeId: string;
  link: { request(method: string, params: unknown, opts?: LinkRequestOptions): Promise<unknown>; readonly connected: boolean };
  /** Why the backup cannot be used now (the cloud off, signed out, the plan, the link), or nothing. */
  allowed: () => RpcError | undefined;
  /** Whether the plan in force has the backup at all. */
  planHasBackup: () => boolean;
  /** The plan's bytes, when it names them. */
  planBytes: () => number | undefined;
  isPrimary: () => boolean;
  /** How many backup nodes are linked to this primary: a restore with one is refused. */
  linkedBackups: () => number;
  stopBrain: () => Promise<void>;
  startBrain: () => Promise<void>;
  scheduler: { start(): void; stop(): void };
  tasks: { releaseUnknownAsks(isOpen: (ask: string) => boolean): number };
  asks: { get(id: string): { status: string } | undefined };
  editable: { rescan(): Promise<void> };
  clients: Pick<ClientRegistry, "closeOn">;
  /** The state changed: the cloud module broadcasts `account.state`. */
  onChange: () => void;
  now?: () => number;
  debounceMs?: number;
  workspaceDebounceMs?: number;
}

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/** The kind of an editable file from its home-relative path; nothing for a path outside the five directories. */
export function fileKind(rel: string): BackupKind | undefined {
  const top = rel.split("/")[0] ?? "";
  return FILE_KINDS[top];
}

export class BackupSync {
  private deps: BackupSyncDeps;
  private log: Logger;
  private file: BackupKeyFile;
  private keys?: BackupKeys;
  private stateValue: BackupState["state"] = "idle";
  private pauseReason?: string;
  private pending = new Map<string, Pending>();
  private inflight = 0;
  private queue: (() => Promise<void>)[] = [];
  private queued = new Set<string>();
  /** The server's versions, from the last list and every acknowledged put, so a takeover continues the count. */
  private remoteVersions = new Map<string, number>();
  private remote?: BackupState["remote"] & { keyId: string };
  private lastSyncAt?: number;
  private error?: string;
  private reconciling?: Promise<void>;
  private restoring?: { done: number; total: number };
  private lastProgressAt = 0;
  private sinceProgress = 0;
  private stopped = false;
  /** Bumped by enable, disable and restore: an acknowledgement from before is not written to the ledger after. */
  private generation = 0;
  private offWrites: () => void;

  constructor(deps: BackupSyncDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.file = new BackupKeyFile(deps.paths.backupKey);
    this.keys = this.file.read();
    if (this.keys) this.log.info("backup on", { keyId: this.keys.keyId });
    this.offWrites = deps.store.onWrites((w) => this.onWrite(w));
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  get enabled(): boolean {
    return this.keys !== undefined;
  }

  /** Whether the sender acts now: backup on, this node the primary, nothing pausing it. */
  private active(): boolean {
    return !this.stopped && this.keys !== undefined && this.deps.isPrimary() && this.stateValue !== "restoring" && this.stateValue !== "conflict" && this.stateValue !== "full";
  }

  // --- state ------------------------------------------------------------------------------

  state(): BackupState {
    const s: BackupState = { enabled: this.keys !== undefined, state: this.stateValue };
    if (this.keys) s.keyId = this.keys.keyId;
    if (this.keys) {
      const pending = this.deps.store.backupSync.pending() + this.pending.size;
      if (pending > 0) s.pending = pending;
      s.bytes = this.deps.store.backupSync.bytes();
    }
    const limit = this.deps.planBytes();
    if (limit !== undefined) s.limit = limit;
    if (this.lastSyncAt !== undefined) s.lastSyncAt = this.lastSyncAt;
    if (this.remote) {
      const { keyId, ...remote } = this.remote;
      void keyId;
      s.remote = remote;
    }
    if (this.restoring) s.progress = { ...this.restoring };
    if (this.error) s.error = this.error;
    if (this.pauseReason && this.stateValue === "paused") s.error = this.pauseReason;
    return s;
  }

  private setState(state: BackupState["state"], error?: string): void {
    const changed = this.stateValue !== state || this.error !== error;
    this.stateValue = state;
    this.error = error;
    if (changed) this.deps.onChange();
  }

  private progress(): void {
    this.sinceProgress++;
    const at = this.now();
    if (this.sinceProgress >= PROGRESS_EVERY_OBJECTS || at - this.lastProgressAt >= PROGRESS_EVERY_MS) {
      this.sinceProgress = 0;
      this.lastProgressAt = at;
      this.deps.onChange();
    }
  }

  // --- what the sender hears --------------------------------------------------------------

  private onWrite(w: StoreWrite): void {
    if (!this.active()) return;
    let kind: BackupKind;
    let id: string;
    const row = w.row as { id?: string; ns?: string; key?: string };
    switch (w.table) {
      case "threads":
        kind = "chat";
        id = `thread:${row.id}`;
        break;
      case "messages":
        kind = "chat";
        id = `message:${row.id}`;
        break;
      case "tasks":
        kind = "tasks";
        id = `task:${row.id}`;
        break;
      case "workspaces":
        kind = "workspaces";
        id = `workspace:${row.id}`;
        break;
      case "kv":
        if (BACKUP_EXCLUDED_KV_NS.includes(row.ns ?? "")) return;
        kind = "state";
        id = `kv:${row.ns}/${row.key}`;
        break;
      default:
        return;
    }
    this.schedule(kind, id, w.table === "workspaces" ? (this.deps.workspaceDebounceMs ?? WORKSPACE_DEBOUNCE_MS) : (this.deps.debounceMs ?? DEBOUNCE_MS));
  }

  /** An editable file changed or went, relative to the home. */
  onFile(rel: string, kind: "changed" | "removed"): void {
    void kind;
    if (!this.active()) return;
    const path = rel.split("\\").join("/");
    const k = fileKind(path);
    if (!k) return;
    this.schedule(k, path, this.deps.debounceMs ?? DEBOUNCE_MS);
  }

  /** The link came up with the plan known. */
  onUp(): void {
    void this.status().then(() => {
      if (this.keys && this.deps.isPrimary()) this.reconcile();
    });
  }

  /** The role settled or changed. */
  onRole(primary: boolean): void {
    if (primary) {
      if (this.keys) this.reconcile();
      return;
    }
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer);
    this.pending.clear();
    if (this.keys && this.stateValue !== "restoring") this.setState("paused", "this node is not the primary");
  }

  /** The plan changed or the account was signed out: the sender pauses, the key stays. */
  onPlan(): void {
    if (!this.keys) return;
    if (!this.deps.planHasBackup()) this.pause("the plan has no backup");
    else if (this.stateValue === "paused" && this.deps.isPrimary()) this.reconcile();
  }

  private pause(reason: string): void {
    this.pauseReason = reason;
    this.setState("paused", reason);
  }

  private schedule(kind: BackupKind, id: string, delayMs: number): void {
    const k = `${kind}\0${id}`;
    const have = this.pending.get(k);
    if (have) return;
    const p: Pending = { kind, id };
    p.timer = setTimeout(() => {
      this.pending.delete(k);
      this.enqueue(kind, id);
    }, delayMs);
    if (typeof p.timer === "object" && "unref" in p.timer) p.timer.unref();
    this.pending.set(k, p);
  }

  // --- building objects ----------------------------------------------------------------------

  /** The plaintext an object stands for, read afresh; nothing when the row or file is gone. */
  private read(kind: BackupKind, id: string): Plain | undefined {
    const store = this.deps.store;
    if (kind === "chat" && id.startsWith("thread:")) {
      const row = store.threads.get(id.slice(7));
      return row ? { id, table: "threads", row } : undefined;
    }
    if (kind === "chat" && id.startsWith("message:")) {
      const row = store.messages.get(id.slice(8));
      return row ? { id, table: "messages", row } : undefined;
    }
    if (kind === "tasks" && id.startsWith("task:")) {
      const row = store.tasks.get(id.slice(5));
      return row ? { id, table: "tasks", row } : undefined;
    }
    if (kind === "workspaces" && id.startsWith("workspace:")) {
      const row = store.workspaces.get(id.slice(10));
      return row ? { id, table: "workspaces", row } : undefined;
    }
    if (kind === "state" && id.startsWith("kv:")) {
      const slash = id.indexOf("/", 3);
      if (slash < 0) return undefined;
      const row = store.kv.entry(id.slice(3, slash), id.slice(slash + 1));
      return row ? { id, table: "kv", row } : undefined;
    }
    if (fileKind(id) === kind) {
      const abs = safePath(this.deps.paths.home, id);
      return abs ? fileRecord(this.deps.paths.home, abs) : undefined;
    }
    return undefined;
  }

  /**
   * What is hashed: the plaintext, with a workspace's activity stamp and a kv row's update
   * stamp left out, so a session's every second and a value written again as it was do not
   * move the object.
   */
  private hashOf(plain: Plain): string {
    if ("table" in plain && plain.table === "workspaces") {
      const { lastActivity, ...rest } = plain.row as Workspace;
      void lastActivity;
      return sha256(JSON.stringify({ ...plain, row: rest }));
    }
    if ("table" in plain && plain.table === "kv") {
      const { updatedAt, ...rest } = plain.row as KvRow;
      void updatedAt;
      return sha256(JSON.stringify({ ...plain, row: rest }));
    }
    return sha256(JSON.stringify(plain));
  }

  private build(keys: BackupKeys, kind: BackupKind, id: string, plain: Plain): Built | undefined {
    const plaintext = Buffer.from(JSON.stringify(plain), "utf8");
    if (plaintext.length > MAX_PLAINTEXT_BYTES) {
      this.log.warn("backup object skipped: over the size the link carries", { kind, id, bytes: plaintext.length });
      return undefined;
    }
    return { kind, id, key: objectKey(keys.mac, kind, id), plaintext, hash: this.hashOf(plain) };
  }

  /** Every object the store and the editable layer hold now. */
  private all(): { kind: BackupKind; id: string; plain: Plain }[] {
    const out: { kind: BackupKind; id: string; plain: Plain }[] = [];
    const t = this.deps.store.replicaSnapshot([...BACKUP_EXCLUDED_KV_NS]);
    for (const row of t.threads as Thread[]) out.push({ kind: "chat", id: `thread:${row.id}`, plain: { id: `thread:${row.id}`, table: "threads", row } });
    for (const row of t.messages as Message[]) out.push({ kind: "chat", id: `message:${row.id}`, plain: { id: `message:${row.id}`, table: "messages", row } });
    for (const row of t.tasks as Task[]) out.push({ kind: "tasks", id: `task:${row.id}`, plain: { id: `task:${row.id}`, table: "tasks", row } });
    for (const row of t.workspaces as Workspace[]) out.push({ kind: "workspaces", id: `workspace:${row.id}`, plain: { id: `workspace:${row.id}`, table: "workspaces", row } });
    for (const row of t.kv as KvRow[]) out.push({ kind: "state", id: `kv:${row.ns}/${row.key}`, plain: { id: `kv:${row.ns}/${row.key}`, table: "kv", row } });
    for (const f of editableFiles(this.deps.paths)) {
      const kind = fileKind(f.path);
      if (kind) out.push({ kind, id: f.path, plain: f });
    }
    return out;
  }

  // --- sending ---------------------------------------------------------------------------------

  private enqueue(kind: BackupKind, id: string): void {
    const k = `${kind}\0${id}`;
    if (this.queued.has(k)) return;
    this.queued.add(k);
    this.queue.push(() => this.send(kind, id).finally(() => this.queued.delete(k)));
    this.pump();
  }

  private pump(): void {
    while (this.inflight < MAX_IN_FLIGHT && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.inflight++;
      if (this.stateValue === "idle" || this.stateValue === "paused") this.setState("syncing");
      void job().finally(() => {
        this.inflight--;
        this.progress();
        if (this.queue.length > 0) this.pump();
        else if (this.inflight === 0 && !this.reconciling) this.settle();
      });
    }
  }

  /** The queue drained: idle when everything is acknowledged, else paused with the reason the last put gave. */
  private settle(): void {
    if (this.stateValue === "conflict" || this.stateValue === "full" || this.stateValue === "restoring") {
      this.deps.onChange();
      return;
    }
    if (!this.keys) return;
    if (this.deps.store.backupSync.pending() === 0) this.setState("idle");
    else this.setState("paused", this.pauseReason ?? "some objects are not on the server yet");
  }

  /** One object: read again, hashed, skipped when the server has it, else sealed and put (or deleted). */
  private async send(kind: BackupKind, id: string): Promise<void> {
    const keys = this.keys;
    if (!keys || !this.active()) return;
    const store = this.deps.store.backupSync;
    const plain = this.read(kind, id);
    const key = objectKey(keys.mac, kind, id);
    const have = store.get(kind, key);
    if (!plain) {
      if (!have) return;
      await this.request(kind, key, "backup.delete", { kind, key }, () => {
        store.delete(kind, key);
        this.remoteVersions.delete(`${kind}/${key}`);
      });
      return;
    }
    const built = this.build(keys, kind, id, plain);
    if (!built) return;
    if (have && have.hash === built.hash && have.synced) return;
    const remote = this.remoteVersions.get(`${kind}/${key}`) ?? 0;
    const version = have && have.hash === built.hash ? Math.max(have.version, remote) : Math.max(have?.version ?? 0, remote) + 1;
    const ciphertext = seal(keys.enc, kind, key, version, built.plaintext);
    const size = Buffer.byteLength(ciphertext, "base64");
    store.put({ kind, key, id, version, hash: built.hash, synced: false, size: have?.synced ? have.size : 0 });
    await this.request(kind, key, "backup.put", { kind, key, ciphertext, version }, () => {
      store.put({ kind, key, id, version, hash: built.hash, synced: true, size });
      this.remoteVersions.set(`${kind}/${key}`, version);
    });
  }

  /** A put or a delete on the link; `onOk` records the acknowledgement. A refusal sets the state the sender pauses in. */
  private async request(kind: BackupKind, key: string, method: "backup.put" | "backup.delete", params: unknown, onOk: () => void): Promise<void> {
    if (!this.deps.link.connected) return;
    const generation = this.generation;
    try {
      await this.deps.link.request(method, params, { timeoutMs: REQUEST_TIMEOUT_MS });
      if (generation !== this.generation) return;
      onOk();
      this.lastSyncAt = this.now();
      this.pauseReason = undefined;
    } catch (e) {
      if (generation !== this.generation) return;
      const code = e instanceof RpcError ? e.code : "unavailable";
      const message = e instanceof Error ? e.message : String(e);
      if (code === "conflict") {
        this.log.warn("backup paused: another node owns the account's backup", { kind, message });
        this.setState("conflict", "another node owns the backup");
      } else if (code === "quota_exceeded") {
        this.log.warn("backup paused: the plan's bytes are used up", { message });
        this.setState("full", "the plan's backup space is full");
      } else if (code === "denied") {
        this.pause("the plan has no backup");
      } else if (code === "unavailable") {
        this.pauseReason = "the server link is down";
      } else {
        this.log.warn("backup object refused", { method, kind, code, message });
        this.pauseReason = message;
      }
    }
  }

  // --- the server's picture ---------------------------------------------------------------------

  /** `backup.status`: what the server holds, for the card and for a fresh install's Restore. */
  async status(): Promise<{ header?: BackupHeader; objects?: number; bytes?: number; updatedAt?: number } | undefined> {
    if (!this.deps.link.connected || !this.deps.planHasBackup()) return undefined;
    try {
      const r = (await this.deps.link.request("backup.status", {}, { timeoutMs: REQUEST_TIMEOUT_MS })) as { header?: BackupHeader; objects?: number; bytes?: number; updatedAt?: number } | undefined;
      if (r?.header) {
        this.remote = { keyId: r.header.keyId, objects: r.objects ?? 0, bytes: r.bytes ?? 0, ...(r.updatedAt !== undefined ? { updatedAt: r.updatedAt } : {}), node: r.header.node };
        // this node's key is not the server's backup any more: someone started over elsewhere
        if (this.keys && !sameKeyId(this.keys.keyId, r.header.keyId) && this.stateValue !== "restoring") this.setState("conflict", "the server's backup is under another passphrase");
        else if (this.keys && r.header.node !== this.deps.nodeId && this.deps.isPrimary() && this.stateValue !== "restoring") this.setState("conflict", "another node owns the backup");
      } else {
        this.remote = undefined;
      }
      this.deps.onChange();
      return r ?? {};
    } catch (e) {
      this.log.debug("backup.status failed", { error: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  }

  /**
   * The ledger against the store and the server: what moved is sent, what this node no
   * longer has is deleted on the server, what the server has and the ledger does not is
   * deleted too. The one time the whole set is read.
   */
  reconcile(): Promise<void> {
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.doReconcile()
      .catch((e: unknown) => this.log.warn("backup reconcile failed", { error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        this.reconciling = undefined;
        if (this.inflight === 0 && this.queue.length === 0) this.settle();
      });
    return this.reconciling;
  }

  private async doReconcile(): Promise<void> {
    const keys = this.keys;
    if (!keys || !this.deps.isPrimary() || !this.deps.link.connected) return;
    if (this.stateValue === "restoring") return;
    const refused = this.deps.allowed();
    if (refused) {
      this.pause(refused.message);
      return;
    }
    if (this.stateValue === "conflict" || this.stateValue === "full") {
      // a link-up is the moment to ask again whether the server still refuses
      const s = await this.status();
      if (s?.header && (!sameKeyId(keys.keyId, s.header.keyId) || s.header.node !== this.deps.nodeId)) return;
      if (this.stateValue === "conflict") this.setState("syncing");
    }
    let listed: { kind: string; key: string; version: number; size: number }[];
    try {
      listed = ((await this.deps.link.request("backup.list", {}, { timeoutMs: REQUEST_TIMEOUT_MS })) as { entries?: { kind: string; key: string; version: number; size: number }[] })?.entries ?? [];
    } catch (e) {
      this.log.debug("backup.list failed; the reconcile waits for the next link-up", { error: e instanceof Error ? e.message : String(e) });
      return;
    }
    this.setState("syncing");
    const store = this.deps.store.backupSync;
    const onServer = new Map<string, { version: number; size: number }>();
    for (const e of listed) {
      onServer.set(`${e.kind}/${e.key}`, { version: e.version, size: e.size });
      this.remoteVersions.set(`${e.kind}/${e.key}`, e.version);
    }
    const rows = new Map(store.list().map((r) => [`${r.kind}/${r.key}`, r]));
    const present = new Set<string>();
    let sent = 0;
    for (const { kind, id, plain } of this.all()) {
      const key = objectKey(keys.mac, kind, id);
      const k = `${kind}/${key}`;
      present.add(k);
      const have = rows.get(k);
      const server = onServer.get(k);
      const hash = this.hashOf(plain);
      if (have && have.synced && have.hash === hash && server) continue;
      if (have && have.synced && server === undefined) store.put({ ...have, synced: false });
      this.enqueue(kind, id);
      sent++;
    }
    // ledger rows for what is gone here: the server's copy goes with them
    for (const [k, row] of rows) {
      if (present.has(k)) continue;
      if (onServer.has(k)) this.enqueueDelete(row.kind as BackupKind, row.key);
      else store.delete(row.kind, row.key);
    }
    // the server's extras: objects that no ledger row and no row here explain
    for (const k of onServer.keys()) {
      if (present.has(k) || rows.has(k)) continue;
      const slash = k.indexOf("/");
      this.enqueueDelete(k.slice(0, slash) as BackupKind, k.slice(slash + 1));
    }
    this.log.info("backup reconciled", { objects: present.size, sent, onServer: onServer.size });
    if (this.queue.length === 0 && this.inflight === 0) this.deps.onChange();
  }

  private enqueueDelete(kind: BackupKind, key: string): void {
    const k = `${kind}\0delete:${key}`;
    if (this.queued.has(k)) return;
    this.queued.add(k);
    this.queue.push(() =>
      this.request(kind, key, "backup.delete", { kind, key }, () => {
        this.deps.store.backupSync.delete(kind, key);
        this.remoteVersions.delete(`${kind}/${key}`);
      }).finally(() => this.queued.delete(k)),
    );
    this.pump();
  }

  // --- turning it on and off ------------------------------------------------------------------

  private refuse(): void {
    if (!this.deps.planHasBackup()) throw new RpcError("denied", "the plan has no backup");
    const why = this.deps.allowed();
    if (why) throw why;
  }

  /**
   * Backup on: the key derived from the passphrase under the server's header when it has
   * one (a different passphrase is refused unless `replace` starts over), a fresh header
   * otherwise; this node takes the backup with `backup.begin`, keeps the key, and sends
   * the whole set.
   */
  async enable(passphrase: string, replace = false): Promise<void> {
    if (!this.deps.isPrimary()) throw new RpcError("conflict", "only the primary keeps the backup; turn it on there");
    this.refuse();
    if (this.stateValue === "restoring") throw new RpcError("conflict", "a restore is running");
    const s = await this.status();
    if (s === undefined) throw new RpcError("unavailable", "the server did not answer", { provider: "server" });
    let keys: BackupKeys;
    let header: BackupHeader;
    if (s.header && !replace) {
      keys = deriveKeys(passphrase, s.header.kdf);
      if (!sameKeyId(keys.keyId, s.header.keyId)) throw new RpcError("denied", "wrong passphrase: the server's backup is under another one; enable with replace to start over");
      header = { ...s.header, node: this.deps.nodeId };
    } else {
      const kdf = newKdf();
      keys = deriveKeys(passphrase, kdf);
      header = { v: 1, kdf, keyId: keys.keyId, node: this.deps.nodeId };
    }
    await this.deps.link.request("backup.begin", { header, ...(replace ? { replace: true } : {}) }, { timeoutMs: REQUEST_TIMEOUT_MS });
    const carriedOn = s.header !== undefined && !replace;
    this.generation++;
    this.file.write(keys);
    this.keys = keys;
    this.remoteVersions.clear();
    this.deps.store.backupSync.clear();
    this.pauseReason = undefined;
    this.remote = { keyId: keys.keyId, objects: carriedOn ? (s.objects ?? 0) : 0, bytes: carriedOn ? (s.bytes ?? 0) : 0, node: this.deps.nodeId };
    this.log.info("backup enabled", { keyId: keys.keyId, replaced: replace, carriedOn });
    this.setState("syncing");
    this.reconcile();
  }

  /** Backup off: the sender stops and the key is gone from this node; `forget` drops the server's copy too. */
  async disable(forget = false): Promise<void> {
    if (this.stateValue === "restoring") throw new RpcError("conflict", "a restore is running");
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer);
    this.pending.clear();
    this.queue.length = 0;
    const had = this.keys !== undefined;
    this.generation++;
    this.keys = undefined;
    this.file.delete();
    this.deps.store.backupSync.clear();
    this.remoteVersions.clear();
    this.pauseReason = undefined;
    if (forget) {
      this.refuse();
      await this.deps.link.request("backup.clear", {}, { timeoutMs: REQUEST_TIMEOUT_MS });
      this.remote = undefined;
    }
    this.log.info("backup disabled", { had, forgot: forget });
    this.setState("idle");
  }

  // --- restore -----------------------------------------------------------------------------------

  /**
   * The server's backup applied here: every kind pulled and opened, then, with the brain
   * stopped, the files written, the tables replaced (the backed-up primary's workspaces
   * re-homed to this node), the ledger filled so nothing is sent back, the editable layer
   * rescanned, the brain started, every client closed to reload. This node then owns the
   * backup and keeps its key. Refused off the primary, with a backup node linked, and for
   * a wrong passphrase, in which case nothing here has moved.
   */
  async restore(passphrase: string): Promise<void> {
    if (!this.deps.isPrimary()) throw new RpcError("conflict", "only the primary can be restored");
    this.refuse();
    if (this.deps.linkedBackups() > 0) throw new RpcError("conflict", "a backup node is linked; unlink it before restoring");
    if (this.stateValue === "restoring") throw new RpcError("conflict", "a restore is already running");
    const s = await this.status();
    if (s === undefined) throw new RpcError("unavailable", "the server did not answer", { provider: "server" });
    if (!s.header) throw new RpcError("not_found", "the account has no backup on the server");
    const header = s.header;
    const keys = deriveKeys(passphrase, header.kdf);
    if (!sameKeyId(keys.keyId, header.keyId)) throw new RpcError("denied", "wrong passphrase");
    const total = s.objects ?? 0;
    this.restoring = { done: 0, total };
    this.generation++;
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer);
    this.pending.clear();
    this.queue.length = 0;
    this.setState("restoring");
    try {
      const pulled = await this.pull(keys, total);
      // this node takes the backup before anything here moves: a refusal leaves the install as it was
      await this.deps.link.request("backup.begin", { header: { ...header, node: this.deps.nodeId } }, { timeoutMs: REQUEST_TIMEOUT_MS });
      await this.apply(keys, header, pulled);
    } catch (e) {
      this.restoring = undefined;
      this.setState(this.keys ? "paused" : "idle", `restore failed: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
    this.restoring = undefined;
    this.log.info("backup restored", { from: header.node, objects: total });
    this.setState("syncing");
    this.reconcile();
  }

  private async pull(keys: BackupKeys, total: number): Promise<{ kind: BackupKind; key: string; version: number; plain: Plain; size: number; hash: string }[]> {
    const out: { kind: BackupKind; key: string; version: number; plain: Plain; size: number; hash: string }[] = [];
    for (const kind of BACKUP_KINDS) {
      let after: string | undefined;
      for (;;) {
        const page = (await this.deps.link.request("backup.pull", { kind, ...(after !== undefined ? { after } : {}) }, { timeoutMs: REQUEST_TIMEOUT_MS })) as {
          entries: { key: string; version: number; ciphertext: string }[];
          next?: string;
        };
        for (const e of page.entries) {
          let plain: Plain;
          try {
            plain = JSON.parse(open(keys.enc, kind, e.key, e.version, e.ciphertext).toString("utf8")) as Plain;
          } catch (err) {
            throw new RpcError("invalid", `a ${kind} object of the backup did not open: ${err instanceof Error ? err.message : String(err)}`);
          }
          out.push({ kind, key: e.key, version: e.version, plain, size: Buffer.byteLength(e.ciphertext, "base64"), hash: this.hashOf(plain) });
          if (this.restoring) this.restoring.done = Math.min(total, this.restoring.done + 1);
          this.progress();
        }
        if (!page.next || page.entries.length === 0) break;
        after = page.next;
      }
    }
    return out;
  }

  private async apply(keys: BackupKeys, header: BackupHeader, pulled: { kind: BackupKind; key: string; version: number; plain: Plain; size: number; hash: string }[]): Promise<void> {
    const tables: ReplicaSnapshot["tables"] = { threads: [], messages: [], tasks: [], workspaces: [], kv: [] };
    const files: ReplicaFile[] = [];
    for (const o of pulled) {
      const p = o.plain;
      if ("path" in p) {
        files.push(p);
        continue;
      }
      switch (p.table) {
        case "threads":
          tables.threads.push(p.row as Thread);
          break;
        case "messages":
          tables.messages.push(p.row as Message);
          break;
        case "tasks":
          tables.tasks.push(p.row as Task);
          break;
        case "workspaces":
          tables.workspaces.push(p.row as Workspace);
          break;
        case "kv":
          tables.kv.push(p.row as KvRow);
          break;
      }
    }
    await this.deps.stopBrain();
    this.deps.scheduler.stop();
    // files first, as a backup node applies a snapshot; what the backup does not have goes
    const paths = this.deps.paths;
    const keep = new Set<string>();
    for (const f of files) {
      const abs = safePath(paths.home, f.path);
      if (!abs) {
        this.log.warn("restored file refused: outside the editable layer", { path: f.path });
        continue;
      }
      if (f.text === undefined && f.base64 === undefined) continue;
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.text !== undefined ? f.text : Buffer.from(f.base64!, "base64"));
      keep.add(abs);
    }
    for (const dir of [paths.tools, paths.hooks, paths.prompts, paths.memory, paths.views]) {
      for (const abs of snapshotTree(dir).keys()) if (!keep.has(abs) && existsSync(abs)) rmSync(abs, { force: true });
    }
    this.deps.store.applySnapshot({ epoch: 0, seq: 0, tables, files: [] }, { selfNode: this.deps.nodeId, keepKvNs: [...RESTORE_KEEP_KV_NS], rehome: header.node });
    // the ledger says every pulled object is on the server as it was pulled: the rescan's burst then sends nothing
    const ledger = this.deps.store.backupSync;
    ledger.clear();
    this.remoteVersions.clear();
    for (const o of pulled) {
      const id = "path" in o.plain ? o.plain.path : o.plain.id;
      ledger.put({ kind: o.kind, key: o.key, id, version: o.version, hash: o.hash, synced: true, size: o.size });
      this.remoteVersions.set(`${o.kind}/${o.key}`, o.version);
    }
    // the key is this node's now, and so is the backup
    this.file.write(keys);
    this.keys = keys;
    this.pauseReason = undefined;
    this.remote = { keyId: keys.keyId, objects: pulled.length, bytes: pulled.reduce((n, o) => n + o.size, 0), node: this.deps.nodeId };
    await this.deps.editable.rescan();
    const released = this.deps.tasks.releaseUnknownAsks((id) => this.deps.asks.get(id)?.status === "open");
    if (released > 0) this.log.info("restored tasks released from asks the old install held", { count: released });
    this.deps.scheduler.start();
    await this.deps.startBrain();
    // after the answer to the request that asked: every view reloads its picture
    const t = setTimeout(() => {
      const n = this.deps.clients.closeOn(CLOSE_ROLE_CHANGED, "restored", ["loopback", "controller", "cloud"]);
      if (n > 0) this.log.info("clients closed to reload after the restore", { count: n });
    }, 0);
    if (typeof t === "object" && "unref" in t) t.unref();
  }

  stop(): void {
    this.stopped = true;
    this.offWrites();
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer);
    this.pending.clear();
    this.queue.length = 0;
  }
}

