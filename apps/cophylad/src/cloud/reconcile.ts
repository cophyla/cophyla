// The cloud backup's whole read, off the daemon's thread. A reconcile compares every object
// the store holds with the backup's ledger and the server's list: every thread, message, task,
// workspace and kv row, each hashed. On a store with tens of thousands of kv rows that was a
// second and more of reading, parsing and hashing on the thread that answers the user, so the
// background worker does it (`backup.objects`): in one read transaction it reads the tables and
// the ledger, names and hashes each object, and answers both as tab-separated lines, which
// cross the thread boundary as one string each. The daemon's thread reads the lines a slice at a
// time and decides what to send.

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { BackupKind, Message, ReplicaFile, ReplicaSnapshot, Task, Thread, Workspace } from "@cophyla/protocol";
import { readSnapshot } from "../store/index.ts";
import type { BackupSyncRow, KvRow } from "../store/index.ts";
import { objectKey } from "./backup-crypto.ts";

/** A backed-up object's plaintext: a row with its table, or a file with its content. */
export type RowObject = { id: string; table: "threads" | "messages" | "tasks" | "workspaces" | "kv"; row: unknown };
export type Plain = RowObject | ReplicaFile;

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/** An id in a line: its tabs, line breaks and backslashes escaped (a kv key may hold anything). */
const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
const unesc = (s: string): string => s.replace(/\\(\\|t|n)/g, (_, c: string) => (c === "t" ? "\t" : c === "n" ? "\n" : "\\"));

/**
 * What is hashed: the plaintext, with a workspace's activity stamp and a kv row's update stamp
 * left out, so a session's every second and a value written again as it was do not move the object.
 */
export function hashPlain(plain: Plain): string {
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

/** The objects a snapshot's tables hold, each with its kind and id. */
export function tableObjects(t: ReplicaSnapshot["tables"]): { kind: BackupKind; id: string; plain: Plain }[] {
  const out: { kind: BackupKind; id: string; plain: Plain }[] = [];
  for (const row of t.threads as Thread[]) out.push({ kind: "chat", id: `thread:${row.id}`, plain: { id: `thread:${row.id}`, table: "threads", row } });
  for (const row of t.messages as Message[]) out.push({ kind: "chat", id: `message:${row.id}`, plain: { id: `message:${row.id}`, table: "messages", row } });
  for (const row of t.tasks as Task[]) out.push({ kind: "tasks", id: `task:${row.id}`, plain: { id: `task:${row.id}`, table: "tasks", row } });
  for (const row of t.workspaces as Workspace[]) out.push({ kind: "workspaces", id: `workspace:${row.id}`, plain: { id: `workspace:${row.id}`, table: "workspaces", row } });
  for (const row of t.kv as KvRow[]) out.push({ kind: "state", id: `kv:${row.ns}/${row.key}`, plain: { id: `kv:${row.ns}/${row.key}`, table: "kv", row } });
  return out;
}

export interface ObjectsRead {
  /** `kind \t id \t key \t hash` a line, one per object of the tables. */
  objects: string;
  /** `kind \t key \t id \t version \t hash \t synced \t size` a line, one per ledger row. */
  rows: string;
}

/** The background worker's job: the tables' objects named and hashed, and the ledger, read in one transaction. */
export function backupObjects(db: Database, args: { mac: Uint8Array; excludeKvNs: string[]; privateNodes: string[] }): ObjectsRead {
  const mac = Buffer.from(args.mac);
  return db.transaction(() => {
    const objects: string[] = [];
    for (const o of tableObjects(readSnapshot(db, args.excludeKvNs, args.privateNodes))) objects.push(`${o.kind}\t${esc(o.id)}\t${objectKey(mac, o.kind, o.id)}\t${hashPlain(o.plain)}`);
    const rows: string[] = [];
    for (const r of db.query("SELECT kind, key, id, version, hash, synced, size FROM backup_sync /* scan-ok: the reconcile's whole read, on the background worker */").all() as {
      kind: string;
      key: string;
      id: string;
      version: number;
      hash: string;
      synced: number;
      size: number;
    }[])
      rows.push(`${r.kind}\t${r.key}\t${esc(r.id)}\t${r.version}\t${r.hash}\t${r.synced}\t${r.size}`);
    return { objects: objects.join("\n"), rows: rows.join("\n") };
  })();
}

/** One object line back as fields. */
export function objectOf(line: string): { kind: BackupKind; id: string; key: string; hash: string } {
  const [kind, id, key, hash] = line.split("\t") as [BackupKind, string, string, string];
  return { kind, id: unesc(id), key, hash };
}

/** One ledger line back as a row. */
export function rowOf(line: string): BackupSyncRow {
  const [kind, key, id, version, hash, synced, size] = line.split("\t") as [string, string, string, string, string, string, string];
  return { kind, key, id: unesc(id), version: Number(version), hash, synced: synced === "1", size: Number(size) };
}
