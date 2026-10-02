// SQLite in the user data directory. Rows go in and out as the protocol entities; JSON
// columns hold the nested parts. The tables only the primary writes (threads, messages,
// tasks, workspaces, kv) announce each write through `onWrite` and `onWrites`, which is how
// a backup node and the cloud backup get them; a backup applies them and a whole snapshot
// through the replica methods, which are silent and go through no module above the store.
//
// A workspace node's rows (`privateNodes`) are this machine's alone: its workspaces are never
// announced, so neither a backup node nor the cloud backup gets them, a snapshot applied
// here leaves them, recall answers the machine without them, and `purgePartition` takes
// them away, leaving its sessions' ids as tombstones.

import { Database } from "bun:sqlite";
import type { Ask, AuditEntry, Decision, Message, MetricsSample, NodeRecord, Outcome, Principal, ReplicaSnapshot, ReplicaTable, ReplicaWrite, Session, SessionEvent, SessionStatus, Task, TaskStatus, Thread, Workspace } from "@cophyla/protocol";
import { SearchIndex } from "./index/index.ts";
import { MIGRATIONS } from "./migrations.ts";

const json = (v: unknown): string => JSON.stringify(v);
const parse = <T>(s: string | null): T | undefined => (s === null ? undefined : (JSON.parse(s) as T));

export interface PolicyRule {
  key: string;
  principal: string;
  action: string;
  target?: string;
  decision: Decision;
  createdBy: Principal;
  createdAt: number;
}

/** A write to a primary-only table, as the replication stream carries it. */
export interface StoreWrite {
  table: ReplicaTable;
  op: "upsert" | "delete";
  row: unknown;
}

export interface KvRow {
  ns: string;
  key: string;
  value: unknown;
  updatedAt: number;
}

/** One object of the cloud backup as the sender last knew it. */
export interface BackupSyncRow {
  kind: string;
  /** The opaque name the server files it under. */
  key: string;
  /** The row or file it stands for: `thread:<id>`, `kv:<ns>/<key>`, a file's home-relative path. */
  id: string;
  version: number;
  hash: string;
  synced: boolean;
  /** The ciphertext's bytes, once acknowledged. */
  size: number;
}

interface BackupSyncDbRow {
  kind: string;
  key: string;
  id: string;
  version: number;
  hash: string;
  synced: number;
  size: number;
}
const backupSyncFromRow = (r: BackupSyncDbRow): BackupSyncRow => ({ kind: r.kind, key: r.key, id: r.id, version: r.version, hash: r.hash, synced: r.synced === 1, size: r.size });

/** One model's calls in a thread, summed: tokens as `llm.complete` reports them, `in` with the cached part among it. */
export interface ThreadSpendRow {
  model: string;
  calls: number;
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  since: number;
  last: number;
}

interface ThreadSpendDbRow {
  model: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  first_at: number;
  last_at: number;
}

export class Store {
  readonly db: Database;
  /** The recall index: chunks written alongside messages and session events, memory on request. */
  readonly index: SearchIndex;
  /** Hears every write to a primary-only table; silent while a replica write is being applied. */
  onWrite?: (w: StoreWrite) => void;
  private writeListeners = new Set<(w: StoreWrite) => void>();
  private applying = false;
  /** The workspace nodes' ids, now and once: rows of theirs never leave the machine. */
  privateNodes: () => readonly string[] = () => [];

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.index = new SearchIndex(this.db, () => this.privateNodes());
  }

  private isPrivate(node: string | undefined): boolean {
    return node !== undefined && this.privateNodes().includes(node);
  }

  /** Applies the migrations past `user_version`, each in its own transaction. */
  migrate(): number {
    let version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    for (let i = version; i < MIGRATIONS.length; i++) {
      const apply = this.db.transaction(() => {
        this.db.exec(MIGRATIONS[i]!);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
      });
      apply();
      version = i + 1;
    }
    return version;
  }

  get version(): number {
    return (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  }

  tables(): string[] {
    return (this.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  }

  close(): void {
    this.db.close();
  }

  // --- meta -------------------------------------------------------------------------------

  readonly meta = {
    get: (key: string): string | undefined => {
      const row = this.db.query("SELECT value FROM meta WHERE key = $key").get({ key }) as { value: string } | null;
      return row?.value;
    },
    set: (key: string, value: string): void => {
      this.db.query("INSERT INTO meta (key, value) VALUES ($key, $value) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run({ key, value });
    },
  };

  /** A second way to hear the writes, beside `onWrite`'s one slot: the cloud backup's. Returns the unsubscribe. */
  onWrites(fn: (w: StoreWrite) => void): () => void {
    this.writeListeners.add(fn);
    return () => this.writeListeners.delete(fn);
  }

  private wrote(table: ReplicaTable, op: "upsert" | "delete", row: unknown): void {
    if (this.applying) return;
    if (!this.onWrite && this.writeListeners.size === 0) return;
    // a workspace node's workspace is replicated and backed up nowhere
    if (table === "workspaces" && this.isPrivate((row as { node?: string }).node)) return;
    const w: StoreWrite = { table, op, row };
    this.onWrite?.(w);
    for (const fn of this.writeListeners) fn(w);
  }

  // --- kv ---------------------------------------------------------------------------------

  readonly kv = {
    get: (ns: string, key: string): unknown => {
      const row = this.db.query("SELECT value FROM kv WHERE ns = $ns AND key = $key").get({ ns, key }) as { value: string } | null;
      return row ? JSON.parse(row.value) : undefined;
    },
    /** The whole row, with its stamp: what the backup sends. */
    entry: (ns: string, key: string): KvRow | undefined => {
      const row = this.db.query("SELECT value, updated_at FROM kv WHERE ns = $ns AND key = $key").get({ ns, key }) as { value: string; updated_at: number } | null;
      return row ? { ns, key, value: JSON.parse(row.value) as unknown, updatedAt: row.updated_at } : undefined;
    },
    put: (ns: string, key: string, value: unknown, now = Date.now()): void => {
      this.db
        .query(
          "INSERT INTO kv (ns, key, value, updated_at) VALUES ($ns, $key, $value, $now) ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        )
        .run({ ns, key, value: json(value), now });
      this.wrote("kv", "upsert", { ns, key, value, updatedAt: now } satisfies KvRow);
    },
    delete: (ns: string, key: string): boolean => {
      const gone = this.db.query("DELETE FROM kv WHERE ns = $ns AND key = $key").run({ ns, key }).changes > 0;
      if (gone) this.wrote("kv", "delete", { ns, key });
      return gone;
    },
    list: (ns: string, prefix = ""): string[] => {
      const rows = this.db.query("SELECT key FROM kv WHERE ns = $ns AND key >= $prefix AND key < $end ORDER BY key").all({ ns, prefix, end: prefix + "￿" }) as { key: string }[];
      return rows.map((r) => r.key);
    },
    /** Every row outside the named namespaces, for a snapshot. */
    dump: (excludeNs: string[] = []): KvRow[] => {
      const rows = this.db.query("SELECT ns, key, value, updated_at FROM kv ORDER BY ns, key").all() as { ns: string; key: string; value: string; updated_at: number }[];
      return rows.filter((r) => !excludeNs.includes(r.ns)).map((r) => ({ ns: r.ns, key: r.key, value: JSON.parse(r.value) as unknown, updatedAt: r.updated_at }));
    },
  };

  // --- audit ------------------------------------------------------------------------------

  readonly audit = {
    insert: (e: AuditEntry): void => {
      this.db
        .query(
          `INSERT INTO audit (id, node, at, principal, via, action, target, args, decision, ask, outcome,
             result_summary, result_bytes, result_sha256, result_body, duration_ms, thread, task, correlation)
           VALUES ($id, $node, $at, $principal, $via, $action, $target, $args, $decision, $ask, $outcome,
             $result_summary, $result_bytes, $result_sha256, $result_body, $duration_ms, $thread, $task, $correlation)`,
        )
        .run({
          id: e.id,
          node: e.node,
          at: e.at,
          principal: json(e.principal),
          via: e.via ?? null,
          action: e.action,
          target: e.target ?? null,
          args: json(e.args ?? null),
          decision: e.decision,
          ask: e.ask ?? null,
          outcome: e.outcome ?? null,
          result_summary: e.result?.summary ?? null,
          result_bytes: e.result?.bytes ?? null,
          result_sha256: e.result?.sha256 ?? null,
          result_body: e.result && "body" in e.result ? json(e.result.body) : null,
          duration_ms: e.durationMs ?? null,
          thread: e.thread ?? null,
          task: e.task ?? null,
          correlation: e.correlation ?? null,
        });
    },
    complete: (id: string, patch: { outcome: Outcome; result?: AuditEntry["result"]; durationMs: number; ask?: string }): void => {
      this.db
        .query(
          `UPDATE audit SET outcome = $outcome, result_summary = $result_summary, result_bytes = $result_bytes,
             result_sha256 = $result_sha256, result_body = $result_body, duration_ms = $duration_ms,
             ask = COALESCE($ask, ask)
           WHERE id = $id`,
        )
        .run({
          id,
          outcome: patch.outcome,
          result_summary: patch.result?.summary ?? null,
          result_bytes: patch.result?.bytes ?? null,
          result_sha256: patch.result?.sha256 ?? null,
          result_body: patch.result && "body" in patch.result ? json(patch.result.body) : null,
          duration_ms: patch.durationMs,
          ask: patch.ask ?? null,
        });
    },
    get: (id: string): AuditEntry | undefined => {
      const row = this.db.query("SELECT * FROM audit WHERE id = $id").get({ id }) as AuditRow | null;
      return row ? auditFromRow(row) : undefined;
    },
    list: (opts: { limit?: number; before?: number } = {}): AuditEntry[] => {
      const rows = this.db
        .query("SELECT * FROM audit WHERE at < $before ORDER BY at DESC, id DESC LIMIT $limit")
        .all({ before: opts.before ?? Number.MAX_SAFE_INTEGER, limit: opts.limit ?? 100 }) as AuditRow[];
      return rows.map(auditFromRow);
    },
    count: (): number => (this.db.query("SELECT COUNT(*) AS n FROM audit").get() as { n: number }).n,
  };

  // --- asks -------------------------------------------------------------------------------

  readonly asks = {
    insert: (a: Ask): void => {
      this.db
        .query(
          `INSERT INTO asks (id, node, type, source, title, detail, options, multiple, allows_text, answerable_by, status, answer, remember, created_at, expires_at)
           VALUES ($id, $node, $type, $source, $title, $detail, $options, $multiple, $allows_text, $answerable_by, $status, $answer, $remember, $created_at, $expires_at)`,
        )
        .run(askParams(a));
    },
    update: (a: Ask): void => {
      this.db
        .query(
          `UPDATE asks SET status = $status, answer = $answer, remember = $remember, expires_at = $expires_at, title = $title, detail = $detail
           WHERE id = $id`,
        )
        .run({
          id: a.id,
          status: a.status,
          answer: a.answer ? json(a.answer) : null,
          remember: a.remember ?? null,
          expires_at: a.expiresAt ?? null,
          title: a.title,
          detail: a.detail ?? null,
        });
    },
    get: (id: string): Ask | undefined => {
      const row = this.db.query("SELECT * FROM asks WHERE id = $id").get({ id }) as AskRow | null;
      return row ? askFromRow(row) : undefined;
    },
    listOpen: (): Ask[] => {
      const rows = this.db.query("SELECT * FROM asks WHERE status = 'open' ORDER BY created_at").all() as AskRow[];
      return rows.map(askFromRow);
    },
    /** Open asks raised by one harness session, for reconciliation after a restart. */
    listOpenBySession: (session: string): Ask[] => {
      const rows = this.db
        .query(
          `SELECT * FROM asks WHERE status = 'open'
             AND json_extract(source, '$.kind') = 'harness' AND json_extract(source, '$.session') = $session
           ORDER BY created_at`,
        )
        .all({ session }) as AskRow[];
      return rows.map(askFromRow);
    },
  };

  // --- harness sessions -----------------------------------------------------------------

  readonly sessions = {
    insert: (s: Session): void => {
      this.db
        .query(
          `INSERT INTO harness_sessions (id, node, harness, profile, native_id, native_pid, native_transport, origin, workspace, task,
             cwd, title, intent, summary, tags, status, ask, started_at, last_activity, ended_at, stats, transcript_path)
           VALUES ($id, $node, $harness, $profile, $native_id, $native_pid, $native_transport, $origin, $workspace, $task,
             $cwd, $title, $intent, $summary, $tags, $status, $ask, $started_at, $last_activity, $ended_at, $stats, $transcript_path)`,
        )
        .run(sessionParams(s));
    },
    update: (s: Session): void => {
      this.db
        .query(
          `UPDATE harness_sessions SET node = $node, harness = $harness, profile = $profile, native_id = $native_id,
             native_pid = $native_pid, native_transport = $native_transport, origin = $origin, workspace = $workspace,
             task = $task, cwd = $cwd, title = $title, intent = $intent, summary = $summary, tags = $tags, status = $status,
             ask = $ask, started_at = $started_at, last_activity = $last_activity, ended_at = $ended_at, stats = $stats,
             transcript_path = $transcript_path
           WHERE id = $id`,
        )
        .run(sessionParams(s));
    },
    get: (id: string): Session | undefined => {
      const row = this.db.query("SELECT * FROM harness_sessions WHERE id = $id").get({ id }) as SessionRow | null;
      return row ? sessionFromRow(row) : undefined;
    },
    /** The session a harness knows by its own id, ended or not; the newest when several exist. */
    getByNative: (harness: string, nativeId: string): Session | undefined => {
      const row = this.db
        .query("SELECT * FROM harness_sessions WHERE harness = $harness AND native_id = $native_id ORDER BY started_at DESC LIMIT 1")
        .get({ harness, native_id: nativeId }) as SessionRow | null;
      return row ? sessionFromRow(row) : undefined;
    },
    list: (filter: SessionListFilter = {}): Session[] => {
      const where: string[] = [];
      const params: Record<string, string | number> = {};
      if (filter.node !== undefined) {
        where.push("node = $node");
        params["node"] = filter.node;
      }
      if (filter.harness !== undefined) {
        where.push("harness = $harness");
        params["harness"] = filter.harness;
      }
      if (filter.workspace !== undefined) {
        where.push("workspace = $workspace");
        params["workspace"] = filter.workspace;
      }
      if (filter.profile !== undefined) {
        where.push("profile = $profile");
        params["profile"] = filter.profile;
      }
      if (filter.status && filter.status.length > 0) {
        where.push(`status IN (${filter.status.map((_, i) => `$status${i}`).join(", ")})`);
        filter.status.forEach((s, i) => (params[`status${i}`] = s));
      }
      const sql = `SELECT * FROM harness_sessions${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY last_activity DESC, id DESC`;
      return (this.db.query(sql).all(params) as SessionRow[]).map(sessionFromRow);
    },
    /** The profiles the user's own sessions of a harness ran under on a node, the latest started first. */
    recentProfiles: (node: string, harness: string): string[] => {
      const rows = this.db
        .query("SELECT profile, MAX(started_at) AS at FROM harness_sessions WHERE node = $node AND harness = $harness AND origin = 'user' AND profile != '' GROUP BY profile ORDER BY at DESC")
        .all({ node, harness }) as { profile: string }[];
      return rows.map((r) => r.profile);
    },
    listLive: (): Session[] => {
      const rows = this.db.query("SELECT * FROM harness_sessions WHERE status != 'ended' ORDER BY last_activity DESC, id DESC").all() as SessionRow[];
      return rows.map(sessionFromRow);
    },
    /** Where the session's transcript was last recorded up to: the file, the offset its next line starts at, and a view's cursor (Muse). */
    tail: (id: string): { path: string; offset: number; cursor?: string } | undefined => {
      const row = this.db.query("SELECT path, offset, cursor FROM transcript_tails WHERE session = $session").get({ session: id }) as { path: string; offset: number; cursor: string | null } | null;
      if (!row) return undefined;
      return { path: row.path, offset: row.offset, ...(row.cursor !== null ? { cursor: row.cursor } : {}) };
    },
    setTail: (id: string, path: string, offset: number, cursor?: string): void => {
      this.db
        .query("INSERT INTO transcript_tails (session, path, offset, cursor) VALUES ($session, $path, $offset, $cursor) ON CONFLICT(session) DO UPDATE SET path = excluded.path, offset = excluded.offset, cursor = excluded.cursor")
        .run({ session: id, path, offset, cursor: cursor ?? null });
    },
  };

  // --- session events -------------------------------------------------------------------

  readonly sessionEvents = {
    /**
     * Assigns the next `seq` for the session and inserts, in one transaction. bun:sqlite is
     * synchronous, so the daemon is the single writer and two appends can never race.
     */
    append: (e: Omit<SessionEvent, "seq">): SessionEvent => {
      const tx = this.db.transaction((input: Omit<SessionEvent, "seq">): SessionEvent => {
        const next = this.db.query("SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM session_events WHERE session = $session").get({ session: input.session }) as { seq: number };
        this.db
          .query("INSERT INTO session_events (session, seq, at, kind, payload, raw) VALUES ($session, $seq, $at, $kind, $payload, $raw)")
          .run({
            session: input.session,
            seq: next.seq,
            at: input.at,
            kind: input.kind,
            payload: json(input.payload ?? null),
            raw: input.raw === undefined ? null : json(input.raw),
          });
        const out: SessionEvent = { session: input.session, seq: next.seq, at: input.at, kind: input.kind, payload: input.payload };
        if (input.raw !== undefined) out.raw = input.raw;
        this.index.chunks.putEvent(out);
        return out;
      });
      const out = tx(e);
      this.index.kick();
      return out;
    },
    /**
     * A window of a session's events by `seq`: the newest `limit` below `before`, or `limit`
     * around `around` (half each side), in seq order.
     */
    history: (session: string, opts: { before?: number; around?: number; limit?: number } = {}): SessionEvent[] => {
      const limit = opts.limit ?? 50;
      if (opts.around !== undefined) {
        const half = Math.max(1, Math.floor(limit / 2));
        const older = this.db
          .query("SELECT * FROM session_events WHERE session = $session AND seq <= $seq ORDER BY seq DESC LIMIT $limit")
          .all({ session, seq: opts.around, limit: half }) as SessionEventRow[];
        const newer = this.db
          .query("SELECT * FROM session_events WHERE session = $session AND seq > $seq ORDER BY seq LIMIT $limit")
          .all({ session, seq: opts.around, limit: limit - older.length }) as SessionEventRow[];
        return [...older.reverse(), ...newer].map(sessionEventFromRow);
      }
      const rows = this.db
        .query("SELECT * FROM session_events WHERE session = $session AND seq < $before ORDER BY seq DESC LIMIT $limit")
        .all({ session, before: opts.before ?? Number.MAX_SAFE_INTEGER, limit }) as SessionEventRow[];
      return rows.map(sessionEventFromRow).reverse();
    },
    count: (session: string): number =>
      (this.db.query("SELECT COUNT(*) AS n FROM session_events WHERE session = $session").get({ session }) as { n: number }).n,
  };

  // --- workspaces -------------------------------------------------------------------------

  readonly workspaces = {
    /** Inserts, or updates every column of the row that already holds this node and path, or this id (a workspace moved). Returns the stored id. */
    upsert: (w: Workspace): string => {
      const existing = this.workspaces.getByPath(w.node, w.path);
      const id = existing?.id ?? w.id;
      if (!existing && this.workspaces.get(id)) {
        this.db
          .query(
            `UPDATE workspaces SET node = $node, path = $path, name = $name, origin = $origin, repo = $repo,
               summary = $summary, tags = $tags, last_activity = $last_activity WHERE id = $id`,
          )
          .run({ id, node: w.node, path: w.path, name: w.name, origin: w.origin, repo: w.repo ? json(w.repo) : null, summary: w.summary ?? null, tags: json(w.tags), last_activity: w.lastActivity });
        this.wrote("workspaces", "upsert", { ...w, id });
        return id;
      }
      this.db
        .query(
          `INSERT INTO workspaces (id, node, path, name, origin, repo, summary, tags, last_activity)
           VALUES ($id, $node, $path, $name, $origin, $repo, $summary, $tags, $last_activity)
           ON CONFLICT(node, path) DO UPDATE SET name = excluded.name, origin = excluded.origin, repo = excluded.repo,
             summary = excluded.summary, tags = excluded.tags, last_activity = excluded.last_activity`,
        )
        .run({
          id,
          node: w.node,
          path: w.path,
          name: w.name,
          origin: w.origin,
          repo: w.repo ? json(w.repo) : null,
          summary: w.summary ?? null,
          tags: json(w.tags),
          last_activity: w.lastActivity,
        });
      this.wrote("workspaces", "upsert", { ...w, id });
      return id;
    },
    get: (id: string): Workspace | undefined => {
      const row = this.db.query("SELECT * FROM workspaces WHERE id = $id").get({ id }) as WorkspaceRow | null;
      return row ? workspaceFromRow(row) : undefined;
    },
    delete: (id: string): boolean => {
      const node = this.workspaces.get(id)?.node;
      const gone = this.db.query("DELETE FROM workspaces WHERE id = $id").run({ id }).changes > 0;
      if (gone) this.wrote("workspaces", "delete", { id, ...(node !== undefined ? { node } : {}) });
      return gone;
    },
    getByPath: (node: string, path: string): Workspace | undefined => {
      const row = this.db.query("SELECT * FROM workspaces WHERE node = $node AND path = $path").get({ node, path }) as WorkspaceRow | null;
      return row ? workspaceFromRow(row) : undefined;
    },
    list: (): Workspace[] => {
      const rows = this.db.query("SELECT * FROM workspaces ORDER BY last_activity DESC, id DESC").all() as WorkspaceRow[];
      return rows.map(workspaceFromRow);
    },
  };

  // --- threads and messages: the chat stream -------------------------------------------

  readonly threads = {
    insert: (t: Thread): void => {
      this.db
        .query(
          `INSERT INTO threads (id, topic, workspace, summary, tags, sessions, started_at, ended_at)
           VALUES ($id, $topic, $workspace, $summary, $tags, $sessions, $started_at, $ended_at)`,
        )
        .run(threadParams(t));
      this.wrote("threads", "upsert", t);
    },
    update: (t: Thread): void => {
      this.db
        .query(
          `UPDATE threads SET topic = $topic, workspace = $workspace, summary = $summary, tags = $tags, sessions = $sessions,
             started_at = $started_at, ended_at = $ended_at
           WHERE id = $id`,
        )
        .run(threadParams(t));
      this.wrote("threads", "upsert", t);
    },
    /** Inserts or replaces the whole row; the replica's way in. */
    upsert: (t: Thread): void => {
      this.db
        .query(
          `INSERT INTO threads (id, topic, workspace, summary, tags, sessions, started_at, ended_at)
           VALUES ($id, $topic, $workspace, $summary, $tags, $sessions, $started_at, $ended_at)
           ON CONFLICT(id) DO UPDATE SET topic = excluded.topic, workspace = excluded.workspace, summary = excluded.summary, tags = excluded.tags,
             sessions = excluded.sessions, started_at = excluded.started_at, ended_at = excluded.ended_at`,
        )
        .run(threadParams(t));
    },
    /** Every thread, oldest first, for a snapshot. */
    dump: (): Thread[] => (this.db.query("SELECT * FROM threads ORDER BY started_at, id").all() as ThreadRow[]).map(threadFromRow),
    get: (id: string): Thread | undefined => {
      const row = this.db.query("SELECT * FROM threads WHERE id = $id").get({ id }) as ThreadRow | null;
      return row ? threadFromRow(row) : undefined;
    },
    /** The newest thread still open. */
    latestOpen: (): Thread | undefined => {
      const row = this.db.query("SELECT * FROM threads WHERE ended_at IS NULL ORDER BY started_at DESC, id DESC LIMIT 1").get() as ThreadRow | null;
      return row ? threadFromRow(row) : undefined;
    },
    list: (filter: ThreadListFilter = {}): Thread[] => {
      const where: string[] = [];
      const params: Record<string, string | number> = {};
      if (filter.workspace !== undefined) {
        where.push("workspace = $workspace");
        params["workspace"] = filter.workspace;
      }
      if (filter.since !== undefined) {
        // A thread that ran on into the window counts: by its end when closed, its start while open.
        where.push("COALESCE(ended_at, started_at) >= $since");
        params["since"] = filter.since;
      }
      if (filter.open === true) where.push("ended_at IS NULL");
      if (filter.open === false) where.push("ended_at IS NOT NULL");
      const sql = `SELECT * FROM threads${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY started_at DESC, id DESC LIMIT $limit`;
      params["limit"] = filter.limit ?? 100;
      return (this.db.query(sql).all(params) as ThreadRow[]).map(threadFromRow);
    },
    /** The `limit` threads started before `before` (the newest when absent), oldest first. */
    before: (before: string | undefined, limit: number): Thread[] => {
      let rows: ThreadRow[];
      if (before === undefined) {
        rows = this.db.query("SELECT * FROM threads ORDER BY started_at DESC, id DESC LIMIT $limit").all({ limit }) as ThreadRow[];
      } else {
        const anchor = this.threads.get(before);
        if (!anchor) return [];
        rows = this.db
          .query("SELECT * FROM threads WHERE started_at < $at OR (started_at = $at AND id < $id) ORDER BY started_at DESC, id DESC LIMIT $limit")
          .all({ at: anchor.startedAt, id: anchor.id, limit }) as ThreadRow[];
      }
      return rows.map(threadFromRow).reverse();
    },
  };

  readonly messages = {
    /** Stores the message and its chunk in one transaction, so recall never sees one without the other. */
    insert: (m: Message): void => {
      this.db.transaction(() => {
        this.db
          .query("INSERT INTO messages (id, thread, at, role, source, content, streaming, steps) VALUES ($id, $thread, $at, $role, $source, $content, $streaming, $steps)")
          .run(messageParams(m));
        this.index.chunks.putMessage(m);
      })();
      this.index.kick();
      this.wrote("messages", "upsert", m);
    },
    update: (m: Message): void => {
      this.db.transaction(() => {
        this.db.query("UPDATE messages SET thread = $thread, at = $at, role = $role, source = $source, content = $content, streaming = $streaming, steps = $steps WHERE id = $id").run(messageParams(m));
        this.index.chunks.putMessage(m);
      })();
      this.index.kick();
      this.wrote("messages", "upsert", m);
    },
    /** Inserts or replaces the whole row with its chunk; the replica's way in. */
    upsert: (m: Message): void => {
      this.db.transaction(() => {
        this.db
          .query(
            `INSERT INTO messages (id, thread, at, role, source, content, streaming, steps) VALUES ($id, $thread, $at, $role, $source, $content, $streaming, $steps)
             ON CONFLICT(id) DO UPDATE SET thread = excluded.thread, at = excluded.at, role = excluded.role, source = excluded.source, content = excluded.content, streaming = excluded.streaming, steps = excluded.steps`,
          )
          .run(messageParams(m));
        this.index.chunks.putMessage(m);
      })();
      this.index.kick();
    },
    /** Every message, oldest first, for a snapshot. */
    dump: (): Message[] => (this.db.query("SELECT * FROM messages ORDER BY at, id").all() as MessageRow[]).map(messageFromRow),
    get: (id: string): Message | undefined => {
      const row = this.db.query("SELECT * FROM messages WHERE id = $id").get({ id }) as MessageRow | null;
      return row ? messageFromRow(row) : undefined;
    },
    /** Every message of a thread, oldest first. */
    byThread: (thread: string): Message[] => {
      const rows = this.db.query("SELECT * FROM messages WHERE thread = $thread ORDER BY at, id").all({ thread }) as MessageRow[];
      return rows.map(messageFromRow);
    },
    /**
     * A window of a thread's messages by `at`: the newest `limit` before `before`, or `limit`
     * around `around` (half each side), oldest first.
     */
    history: (thread: string, opts: { before?: number; around?: number; limit?: number } = {}): Message[] => {
      const limit = opts.limit ?? 50;
      if (opts.around !== undefined) {
        const half = Math.max(1, Math.floor(limit / 2));
        const older = this.db
          .query("SELECT * FROM messages WHERE thread = $thread AND at <= $at ORDER BY at DESC, id DESC LIMIT $limit")
          .all({ thread, at: opts.around, limit: half }) as MessageRow[];
        const newer = this.db
          .query("SELECT * FROM messages WHERE thread = $thread AND at > $at ORDER BY at, id LIMIT $limit")
          .all({ thread, at: opts.around, limit: limit - older.length }) as MessageRow[];
        return [...older.reverse(), ...newer].map(messageFromRow);
      }
      const rows = this.db
        .query("SELECT * FROM messages WHERE thread = $thread AND at < $before ORDER BY at DESC, id DESC LIMIT $limit")
        .all({ thread, before: opts.before ?? Number.MAX_SAFE_INTEGER, limit }) as MessageRow[];
      return rows.map(messageFromRow).reverse();
    },
    count: (thread: string): number => (this.db.query("SELECT COUNT(*) AS n FROM messages WHERE thread = $thread").get({ thread }) as { n: number }).n,
  };

  // --- tasks --------------------------------------------------------------------------

  readonly tasks = {
    insert: (t: Task): void => {
      this.db
        .query(
          `INSERT INTO tasks (id, title, detail, workspace, thread, parent, created_by, status, priority, trigger, recurring, blocker, sessions, result, created_at, updated_at, completed_at)
           VALUES ($id, $title, $detail, $workspace, $thread, $parent, $created_by, $status, $priority, $trigger, $recurring, $blocker, $sessions, $result, $created_at, $updated_at, $completed_at)`,
        )
        .run(taskParams(t));
      this.wrote("tasks", "upsert", t);
    },
    update: (t: Task): void => {
      this.db
        .query(
          `UPDATE tasks SET title = $title, detail = $detail, workspace = $workspace, thread = $thread, parent = $parent, created_by = $created_by,
             status = $status, priority = $priority, trigger = $trigger, recurring = $recurring, blocker = $blocker, sessions = $sessions,
             result = $result, created_at = $created_at, updated_at = $updated_at, completed_at = $completed_at
           WHERE id = $id`,
        )
        .run(taskParams(t));
      this.wrote("tasks", "upsert", t);
    },
    /** Inserts or replaces the whole row; the replica's way in. */
    upsert: (t: Task): void => {
      this.db
        .query(
          `INSERT INTO tasks (id, title, detail, workspace, thread, parent, created_by, status, priority, trigger, recurring, blocker, sessions, result, created_at, updated_at, completed_at)
           VALUES ($id, $title, $detail, $workspace, $thread, $parent, $created_by, $status, $priority, $trigger, $recurring, $blocker, $sessions, $result, $created_at, $updated_at, $completed_at)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, detail = excluded.detail, workspace = excluded.workspace, thread = excluded.thread, parent = excluded.parent,
             created_by = excluded.created_by, status = excluded.status, priority = excluded.priority, trigger = excluded.trigger, recurring = excluded.recurring,
             blocker = excluded.blocker, sessions = excluded.sessions, result = excluded.result, created_at = excluded.created_at, updated_at = excluded.updated_at, completed_at = excluded.completed_at`,
        )
        .run(taskParams(t));
    },
    /** Every task, oldest first, for a snapshot. */
    dump: (): Task[] => (this.db.query("SELECT * FROM tasks ORDER BY created_at, id").all() as TaskRow[]).map(taskFromRow),
    get: (id: string): Task | undefined => {
      const row = this.db.query("SELECT * FROM tasks WHERE id = $id").get({ id }) as TaskRow | null;
      return row ? taskFromRow(row) : undefined;
    },
    list: (filter: TaskListFilter = {}): Task[] => {
      const where: string[] = [];
      const params: Record<string, string | number> = {};
      if (filter.status && filter.status.length > 0) {
        where.push(`status IN (${filter.status.map((_, i) => `$status${i}`).join(", ")})`);
        filter.status.forEach((s, i) => (params[`status${i}`] = s));
      }
      if (filter.workspace !== undefined) {
        where.push("workspace = $workspace");
        params["workspace"] = filter.workspace;
      }
      if (filter.blocker !== undefined) {
        where.push("json_extract(blocker, '$.kind') = $blocker");
        params["blocker"] = filter.blocker;
      }
      if (filter.parent !== undefined) {
        where.push("parent = $parent");
        params["parent"] = filter.parent;
      }
      const sql = `SELECT * FROM tasks${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC, id DESC`;
      return (this.db.query(sql).all(params) as TaskRow[]).map(taskFromRow);
    },
    /** Tasks blocked on one ask, task or session. */
    blockedOn: (kind: "ask" | "task" | "session", id: string): Task[] => {
      const rows = this.db
        .query(`SELECT * FROM tasks WHERE status = 'blocked' AND json_extract(blocker, '$.kind') = $kind AND json_extract(blocker, '$.' || $kind) = $id ORDER BY updated_at`)
        .all({ kind, id }) as TaskRow[];
      return rows.map(taskFromRow);
    },
  };

  // --- events: node and custom events ---------------------------------------------------

  readonly events = {
    insert: (e: { node: string; name: string; at: number; payload: unknown }): number => {
      const r = this.db.query("INSERT INTO events (node, name, at, payload) VALUES ($node, $name, $at, $payload)").run({ node: e.node, name: e.name, at: e.at, payload: json(e.payload ?? null) });
      return Number(r.lastInsertRowid);
    },
    history: (opts: { name?: string; node?: string; from?: number; to?: number; limit?: number } = {}): { name: string; node: string; at: number; payload: unknown }[] => {
      const where: string[] = [];
      const params: Record<string, string | number> = {};
      if (opts.name !== undefined) {
        where.push("name = $name");
        params["name"] = opts.name;
      }
      if (opts.node !== undefined) {
        where.push("node = $node");
        params["node"] = opts.node;
      }
      if (opts.from !== undefined) {
        where.push("at >= $from");
        params["from"] = opts.from;
      }
      if (opts.to !== undefined) {
        where.push("at <= $to");
        params["to"] = opts.to;
      }
      params["limit"] = opts.limit ?? 200;
      const sql = `SELECT name, node, at, payload FROM events${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY at DESC, id DESC LIMIT $limit`;
      return (this.db.query(sql).all(params) as { name: string; node: string; at: number; payload: string }[])
        .map((r) => ({ name: r.name, node: r.node, at: r.at, payload: JSON.parse(r.payload) as unknown }))
        .reverse();
    },
    /** Keeps the newest `keep` rows; returns how many went. */
    prune: (keep: number): number => {
      const r = this.db.query("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY at DESC, id DESC LIMIT $keep)").run({ keep });
      return Number(r.changes);
    },
    count: (): number => (this.db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
  };

  // --- metrics: per-minute rollups ---------------------------------------------------------

  readonly metrics = {
    /** Stores a minute's rollup; a second put for the same minute replaces it. */
    put: (node: string, minute: number, sample: MetricsSample): void => {
      this.db.query("INSERT INTO metrics (node, minute, sample) VALUES ($node, $minute, $sample) ON CONFLICT(node, minute) DO UPDATE SET sample = excluded.sample").run({ node, minute, sample: json(sample) });
    },
    /** The rollups of one node within `[from, to]` (minute starts, epoch ms), oldest first, at most `limit`. */
    range: (node: string, opts: { from?: number; to?: number; limit?: number } = {}): MetricsSample[] => {
      const rows = this.db
        .query("SELECT sample FROM metrics WHERE node = $node AND minute >= $from AND minute <= $to ORDER BY minute LIMIT $limit")
        .all({ node, from: opts.from ?? 0, to: opts.to ?? Number.MAX_SAFE_INTEGER, limit: opts.limit ?? 1440 }) as { sample: string }[];
      return rows.map((r) => JSON.parse(r.sample) as MetricsSample);
    },
    /** The per-profile spend of each rollup of one node within `[from, to]` that has any, oldest first: only that field is read out of the row. */
    profiles: (node: string, opts: { from?: number; to?: number } = {}): { minute: number; profiles: NonNullable<MetricsSample["profiles"]> }[] => {
      const rows = this.db
        .query("SELECT minute, json_extract(sample, '$.profiles') AS profiles FROM metrics WHERE node = $node AND minute >= $from AND minute <= $to AND json_extract(sample, '$.profiles') IS NOT NULL ORDER BY minute")
        .all({ node, from: opts.from ?? 0, to: opts.to ?? Number.MAX_SAFE_INTEGER }) as { minute: number; profiles: string }[];
      return rows.map((r) => ({ minute: r.minute, profiles: JSON.parse(r.profiles) as NonNullable<MetricsSample["profiles"]> }));
    },
    /** The newest `limit` rollups of one node, oldest first. */
    latest: (node: string, limit: number): MetricsSample[] => {
      const rows = this.db.query("SELECT sample FROM metrics WHERE node = $node ORDER BY minute DESC LIMIT $limit").all({ node, limit }) as { sample: string }[];
      return rows.map((r) => JSON.parse(r.sample) as MetricsSample).reverse();
    },
    /** Drops every rollup before `before`; returns how many went. */
    prune: (before: number): number => Number(this.db.query("DELETE FROM metrics WHERE minute < $before").run({ before }).changes),
    count: (node?: string): number =>
      node === undefined
        ? (this.db.query("SELECT COUNT(*) AS n FROM metrics").get() as { n: number }).n
        : (this.db.query("SELECT COUNT(*) AS n FROM metrics WHERE node = $node").get({ node }) as { n: number }).n,
  };

  // --- entitlement and usage: the account's plan and the local counters --------------------

  readonly entitlement = {
    /** The stored token and its claims as they were verified when it arrived. */
    get: (): { token: string; claims: unknown; receivedAt: number } | undefined => {
      const r = this.db.query("SELECT token, claims, received_at FROM entitlement WHERE id = 1").get() as { token: string; claims: string; received_at: number } | null;
      return r ? { token: r.token, claims: JSON.parse(r.claims) as unknown, receivedAt: r.received_at } : undefined;
    },
    put: (token: string, claims: unknown, receivedAt: number): void => {
      this.db
        .query("INSERT INTO entitlement (id, token, claims, received_at) VALUES (1, $token, $claims, $receivedAt) ON CONFLICT(id) DO UPDATE SET token = excluded.token, claims = excluded.claims, received_at = excluded.received_at")
        .run({ token, claims: json(claims), receivedAt });
    },
    clear: (): void => {
      this.db.query("DELETE FROM entitlement WHERE id = 1").run();
    },
  };

  readonly usage = {
    /** Adds to a period's counter; the cap is kept as it was. */
    add: (period: string, metric: string, amount: number): number => {
      this.db
        .query("INSERT INTO usage (period, metric, used) VALUES ($period, $metric, $amount) ON CONFLICT(period, metric) DO UPDATE SET used = used + excluded.used")
        .run({ period, metric, amount: Math.round(amount) });
      return this.usage.get(period)[metric]?.used ?? 0;
    },
    /** Every metric of a period: what was counted here and the cap the server last reported. */
    get: (period: string): Record<string, { used: number; cap?: number }> => {
      const out: Record<string, { used: number; cap?: number }> = {};
      for (const r of this.db.query("SELECT metric, used, cap FROM usage WHERE period = $period").all({ period }) as { metric: string; used: number; cap: number | null }[]) {
        out[r.metric] = { used: r.used, ...(r.cap !== null ? { cap: r.cap } : {}) };
      }
      return out;
    },
    /** What the server reported: replaces the counter, since the server's count is the one that is billed. */
    setCap: (period: string, metric: string, used: number, cap: number): void => {
      this.db
        .query("INSERT INTO usage (period, metric, used, cap) VALUES ($period, $metric, $used, $cap) ON CONFLICT(period, metric) DO UPDATE SET used = excluded.used, cap = excluded.cap")
        .run({ period, metric, used: Math.round(used), cap: Math.round(cap) });
    },
    clear: (): void => {
      this.db.query("DELETE FROM usage").run();
    },
  };

  // --- what the brain's model calls cost each conversation ----------------------------------

  readonly threadSpend = {
    /** Adds one call's tokens to its thread's row for the model that answered. */
    add: (thread: string, model: string, usage: { in: number; out: number; cacheRead?: number; cacheWrite?: number }, at: number): void => {
      this.db
        .query(
          `INSERT INTO thread_spend (thread, model, calls, tokens_in, tokens_out, cache_read, cache_write, first_at, last_at)
           VALUES ($thread, $model, 1, $in, $out, $cacheRead, $cacheWrite, $at, $at)
           ON CONFLICT(thread, model) DO UPDATE SET calls = calls + 1, tokens_in = tokens_in + excluded.tokens_in,
             tokens_out = tokens_out + excluded.tokens_out, cache_read = cache_read + excluded.cache_read,
             cache_write = cache_write + excluded.cache_write, first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at)`,
        )
        .run({ thread, model, in: Math.round(usage.in), out: Math.round(usage.out), cacheRead: Math.round(usage.cacheRead ?? 0), cacheWrite: Math.round(usage.cacheWrite ?? 0), at });
    },
    /** A thread's rows, the model called most first. */
    of: (thread: string): ThreadSpendRow[] => {
      const rows = this.db.query("SELECT model, calls, tokens_in, tokens_out, cache_read, cache_write, first_at, last_at FROM thread_spend WHERE thread = $thread ORDER BY calls DESC, model").all({ thread }) as ThreadSpendDbRow[];
      return rows.map((r) => ({ model: r.model, calls: r.calls, in: r.tokens_in, out: r.tokens_out, cacheRead: r.cache_read, cacheWrite: r.cache_write, since: r.first_at, last: r.last_at }));
    },
  };

  // --- the cloud backup's ledger -------------------------------------------------------------

  readonly backupSync = {
    get: (kind: string, key: string): BackupSyncRow | undefined => {
      const r = this.db.query("SELECT * FROM backup_sync WHERE kind = $kind AND key = $key").get({ kind, key }) as BackupSyncDbRow | null;
      return r ? backupSyncFromRow(r) : undefined;
    },
    put: (row: BackupSyncRow): void => {
      this.db
        .query(
          `INSERT INTO backup_sync (kind, key, id, version, hash, synced, size) VALUES ($kind, $key, $id, $version, $hash, $synced, $size)
           ON CONFLICT(kind, key) DO UPDATE SET id = excluded.id, version = excluded.version, hash = excluded.hash, synced = excluded.synced, size = excluded.size`,
        )
        .run({ kind: row.kind, key: row.key, id: row.id, version: row.version, hash: row.hash, synced: row.synced ? 1 : 0, size: row.size });
    },
    delete: (kind: string, key: string): boolean => this.db.query("DELETE FROM backup_sync WHERE kind = $kind AND key = $key").run({ kind, key }).changes > 0,
    list: (): BackupSyncRow[] => (this.db.query("SELECT * FROM backup_sync ORDER BY kind, key").all() as BackupSyncDbRow[]).map(backupSyncFromRow),
    /** The rows the server has not acknowledged. */
    pending: (): number => (this.db.query("SELECT COUNT(*) AS n FROM backup_sync WHERE synced = 0").get() as { n: number }).n,
    /** The ciphertext bytes the server holds, as acknowledged. */
    bytes: (): number => (this.db.query("SELECT COALESCE(SUM(size), 0) AS n FROM backup_sync WHERE synced = 1").get() as { n: number }).n,
    clear: (): void => {
      this.db.query("DELETE FROM backup_sync").run();
    },
  };

  // --- nodes: the registry ------------------------------------------------------------------

  readonly nodes = {
    upsert: (n: NodeRecord): void => {
      this.db
        .query(
          `INSERT INTO nodes (id, name, role, backup, rank, platform, scope, capabilities, versions, endpoints, epoch, last_seen, status)
           VALUES ($id, $name, $role, $backup, $rank, $platform, $scope, $capabilities, $versions, $endpoints, $epoch, $last_seen, $status)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, backup = excluded.backup, rank = excluded.rank, platform = excluded.platform,
             scope = excluded.scope, capabilities = excluded.capabilities, versions = excluded.versions, endpoints = excluded.endpoints, epoch = excluded.epoch,
             last_seen = excluded.last_seen, status = excluded.status`,
        )
        .run({
          id: n.id,
          name: n.name,
          role: n.role,
          backup: n.backup ? 1 : 0,
          rank: n.rank ?? null,
          platform: n.platform,
          scope: json(n.scope),
          capabilities: json(n.capabilities),
          versions: json(n.versions),
          endpoints: json(n.endpoints),
          epoch: n.epoch ?? null,
          last_seen: n.lastSeen,
          status: n.status,
        });
    },
    get: (id: string): NodeRecord | undefined => {
      const row = this.db.query("SELECT * FROM nodes WHERE id = $id").get({ id }) as NodeRow | null;
      return row ? nodeFromRow(row) : undefined;
    },
    list: (): NodeRecord[] => (this.db.query("SELECT * FROM nodes ORDER BY name, id").all() as NodeRow[]).map(nodeFromRow),
    delete: (id: string): boolean => this.db.query("DELETE FROM nodes WHERE id = $id").run({ id }).changes > 0,
  };

  // --- replication: the backup's way in ---------------------------------------------------

  /** Applies one replicated write, silently. */
  applyReplica(w: ReplicaWrite): void {
    this.applying = true;
    try {
      switch (w.table) {
        case "threads":
          if (w.op === "upsert") this.threads.upsert(w.row as Thread);
          else this.db.query("DELETE FROM threads WHERE id = $id").run({ id: (w.row as { id: string }).id });
          break;
        case "messages":
          if (w.op === "upsert") this.messages.upsert(w.row as Message);
          else this.db.query("DELETE FROM messages WHERE id = $id").run({ id: (w.row as { id: string }).id });
          break;
        case "tasks":
          if (w.op === "upsert") this.tasks.upsert(w.row as Task);
          else this.db.query("DELETE FROM tasks WHERE id = $id").run({ id: (w.row as { id: string }).id });
          break;
        case "workspaces":
          if (w.op === "upsert") this.replicaWorkspace(w.row as Workspace);
          else this.db.query("DELETE FROM workspaces WHERE id = $id").run({ id: (w.row as { id: string }).id });
          break;
        case "kv": {
          const row = w.row as KvRow;
          if (w.op === "upsert") this.kv.put(row.ns, row.key, row.value, row.updatedAt);
          else this.kv.delete(row.ns, row.key);
          break;
        }
      }
    } finally {
      this.applying = false;
    }
  }

  /** A workspace row as the primary holds it, id and all; the (node, path) key may already be there under another id. */
  private replicaWorkspace(w: Workspace): void {
    this.db.query("DELETE FROM workspaces WHERE node = $node AND path = $path AND id != $id").run({ node: w.node, path: w.path, id: w.id });
    this.db
      .query(
        `INSERT INTO workspaces (id, node, path, name, origin, repo, summary, tags, last_activity)
         VALUES ($id, $node, $path, $name, $origin, $repo, $summary, $tags, $last_activity)
         ON CONFLICT(id) DO UPDATE SET node = excluded.node, path = excluded.path, name = excluded.name, origin = excluded.origin, repo = excluded.repo,
           summary = excluded.summary, tags = excluded.tags, last_activity = excluded.last_activity`,
      )
      .run({ id: w.id, node: w.node, path: w.path, name: w.name, origin: w.origin, repo: w.repo ? json(w.repo) : null, summary: w.summary ?? null, tags: json(w.tags), last_activity: w.lastActivity });
  }

  /**
   * Replaces the primary-only tables with a snapshot, in one transaction: threads, messages
   * and tasks whole (their chunks with them); `kv` outside `keepKvNs`; workspaces of every
   * node but this one. Silent: nothing above the store hears it. With `rehome`, the
   * workspaces of that node (the primary the snapshot was taken from) become this node's:
   * a restore onto a fresh install, where the restored threads and tasks must still find
   * them. A re-homed row replaces the one this node discovered at the same path and keeps
   * the id the snapshot's threads and tasks name.
   */
  applySnapshot(snapshot: ReplicaSnapshot, opts: { selfNode: string; keepKvNs: string[]; rehome?: string }): void {
    this.applying = true;
    try {
      this.db.transaction(() => {
        this.index.chunks.deleteCorpus("thread");
        this.db.exec("DELETE FROM messages");
        this.db.exec("DELETE FROM threads");
        this.db.exec("DELETE FROM tasks");
        // this node's own workspaces stay, and so do its workspace nodes', which no snapshot holds
        const kept = [opts.selfNode, ...this.privateNodes()];
        this.db.query(`DELETE FROM workspaces WHERE node NOT IN (${kept.map((_, i) => `$n${i}`).join(", ")})`).run(Object.fromEntries(kept.map((n, i) => [`n${i}`, n])));
        const keep = opts.keepKvNs;
        if (keep.length === 0) this.db.exec("DELETE FROM kv");
        else this.db.query(`DELETE FROM kv WHERE ns NOT IN (${keep.map((_, i) => `$ns${i}`).join(", ")})`).run(Object.fromEntries(keep.map((ns, i) => [`ns${i}`, ns])));
        for (const t of snapshot.tables.threads as Thread[]) this.threads.upsert(t);
        for (const m of snapshot.tables.messages as Message[]) this.messages.upsert(m);
        for (const t of snapshot.tables.tasks as Task[]) this.tasks.upsert(t);
        for (const w of snapshot.tables.workspaces as Workspace[]) {
          if (this.isPrivate(w.node)) continue;
          if (opts.rehome !== undefined && opts.rehome !== opts.selfNode && w.node === opts.rehome) this.replicaWorkspace({ ...w, node: opts.selfNode });
          else if (w.node !== opts.selfNode) this.replicaWorkspace(w);
        }
        for (const r of snapshot.tables.kv) if (!keep.includes(r.ns)) this.kv.put(r.ns, r.key, r.value, r.updatedAt);
      })();
      this.index.kick();
    } finally {
      this.applying = false;
    }
  }

  /** The primary-only tables as a snapshot, `kv` without the named namespaces. Files are the caller's. */
  replicaSnapshot(excludeKvNs: string[]): ReplicaSnapshot["tables"] {
    return {
      threads: this.threads.dump(),
      messages: this.messages.dump(),
      tasks: this.tasks.dump(),
      workspaces: this.workspaces.list().filter((w) => !this.isPrivate(w.node)),
      kv: this.kv.dump(excludeKvNs),
    };
  }

  // --- a workspace node removed ------------------------------------------------------------

  /**
   * Takes away what a workspace node left in this store, in one transaction: its sessions'
   * events, chunks (their full-text rows and vectors with them) and transcript marks, its
   * asks, its audit rows and its workspaces. Its sessions stay as tombstones: ended, their
   * words gone, their ids and harness ids kept, so one met again stays the node's, which is
   * retired and private.
   */
  purgePartition(node: string, now = Date.now()): { sessions: number; events: number; asks: number; audit: number; workspaces: number } {
    const ids = (this.db.query("SELECT id FROM harness_sessions WHERE node = $node").all({ node }) as { id: string }[]).map((r) => r.id);
    let events = 0;
    const out = this.db.transaction(() => {
      for (const id of ids) {
        this.index.chunks.deleteSession(id);
        events += this.db.query("DELETE FROM session_events WHERE session = $id").run({ id }).changes;
        this.db.query("DELETE FROM transcript_tails WHERE session = $id").run({ id });
      }
      const asks = this.db.query("DELETE FROM asks WHERE node = $node").run({ node }).changes;
      const audit = this.db.query("DELETE FROM audit WHERE node = $node").run({ node }).changes;
      const workspaces = this.db.query("DELETE FROM workspaces WHERE node = $node").run({ node }).changes;
      this.db
        .query(
          `UPDATE harness_sessions SET title = NULL, intent = NULL, summary = NULL, tags = '[]', ask = NULL, stats = NULL,
             transcript_path = NULL, workspace = NULL, task = NULL, native_pid = NULL, status = 'ended',
             ended_at = COALESCE(ended_at, $now) WHERE node = $node`,
        )
        .run({ node, now });
      return { sessions: ids.length, events, asks: Number(asks), audit: Number(audit), workspaces: Number(workspaces) };
    })();
    this.index.kick();
    return out;
  }

  // --- policy: remembered gate answers ------------------------------------------------------

  readonly policy = {
    list: (): PolicyRule[] => {
      const rows = this.db.query("SELECT * FROM policy ORDER BY created_at").all() as PolicyRow[];
      return rows.map((r) => ({
        key: r.key,
        principal: r.principal,
        action: r.action,
        ...(r.target === null ? {} : { target: r.target }),
        decision: r.decision as Decision,
        createdBy: JSON.parse(r.created_by) as Principal,
        createdAt: r.created_at,
      }));
    },
    put: (rule: PolicyRule): void => {
      this.db
        .query(
          `INSERT INTO policy (key, principal, action, target, decision, created_by, created_at)
           VALUES ($key, $principal, $action, $target, $decision, $created_by, $created_at)
           ON CONFLICT(key) DO UPDATE SET decision = excluded.decision, created_by = excluded.created_by, created_at = excluded.created_at`,
        )
        .run({
          key: rule.key,
          principal: rule.principal,
          action: rule.action,
          target: rule.target ?? null,
          decision: rule.decision,
          created_by: json(rule.createdBy),
          created_at: rule.createdAt,
        });
    },
    delete: (key: string): boolean => this.db.query("DELETE FROM policy WHERE key = $key").run({ key }).changes > 0,
  };
}

// --- row shapes ---------------------------------------------------------------------------

interface AuditRow {
  id: string;
  node: string;
  at: number;
  principal: string;
  via: string | null;
  action: string;
  target: string | null;
  args: string;
  decision: string;
  ask: string | null;
  outcome: string | null;
  result_summary: string | null;
  result_bytes: number | null;
  result_sha256: string | null;
  result_body: string | null;
  duration_ms: number | null;
  thread: string | null;
  task: string | null;
  correlation: string | null;
}

function auditFromRow(r: AuditRow): AuditEntry {
  const e: AuditEntry = {
    id: r.id,
    node: r.node,
    at: r.at,
    principal: JSON.parse(r.principal) as Principal,
    action: r.action,
    args: JSON.parse(r.args) as unknown,
    decision: r.decision as Decision,
  };
  if (r.via !== null) e.via = r.via;
  if (r.target !== null) e.target = r.target;
  if (r.ask !== null) e.ask = r.ask;
  if (r.outcome !== null) e.outcome = r.outcome as Outcome;
  if (r.result_summary !== null && r.result_bytes !== null && r.result_sha256 !== null) {
    e.result = { summary: r.result_summary, bytes: r.result_bytes, sha256: r.result_sha256 };
    if (r.result_body !== null) e.result.body = JSON.parse(r.result_body) as unknown;
  }
  if (r.duration_ms !== null) e.durationMs = r.duration_ms;
  if (r.thread !== null) e.thread = r.thread;
  if (r.task !== null) e.task = r.task;
  if (r.correlation !== null) e.correlation = r.correlation;
  return e;
}

interface AskRow {
  id: string;
  node: string;
  type: string;
  source: string;
  title: string;
  detail: string | null;
  options: string;
  multiple: number;
  allows_text: number;
  answerable_by: string;
  status: string;
  answer: string | null;
  remember: string | null;
  created_at: number;
  expires_at: number | null;
}

function askParams(a: Ask) {
  return {
    id: a.id,
    node: a.node,
    type: a.type,
    source: json(a.source),
    title: a.title,
    detail: a.detail ?? null,
    options: json(a.options),
    multiple: a.multiple ? 1 : 0,
    allows_text: a.allowsText ? 1 : 0,
    answerable_by: json(a.answerableBy),
    status: a.status,
    answer: a.answer ? json(a.answer) : null,
    remember: a.remember ?? null,
    created_at: a.createdAt,
    expires_at: a.expiresAt ?? null,
  };
}

function askFromRow(r: AskRow): Ask {
  const a: Ask = {
    id: r.id,
    node: r.node,
    type: r.type as Ask["type"],
    source: JSON.parse(r.source) as Ask["source"],
    title: r.title,
    options: JSON.parse(r.options) as Ask["options"],
    answerableBy: JSON.parse(r.answerable_by) as Ask["answerableBy"],
    status: r.status as Ask["status"],
    createdAt: r.created_at,
  };
  if (r.detail !== null) a.detail = r.detail;
  if (r.multiple) a.multiple = true;
  if (r.allows_text) a.allowsText = true;
  const answer = parse<Ask["answer"]>(r.answer);
  if (answer) a.answer = answer;
  if (r.remember !== null) a.remember = r.remember as Ask["remember"];
  if (r.expires_at !== null) a.expiresAt = r.expires_at;
  return a;
}

interface PolicyRow {
  key: string;
  principal: string;
  action: string;
  target: string | null;
  decision: string;
  created_by: string;
  created_at: number;
}

export interface SessionListFilter {
  node?: string;
  harness?: string;
  status?: SessionStatus[];
  workspace?: string;
  profile?: string;
}

interface SessionRow {
  id: string;
  node: string;
  harness: string;
  profile: string;
  native_id: string;
  native_pid: number | null;
  native_transport: string;
  origin: string;
  workspace: string | null;
  task: string | null;
  cwd: string;
  title: string | null;
  intent: string | null;
  summary: string | null;
  tags: string;
  status: string;
  ask: string | null;
  started_at: number;
  last_activity: number;
  ended_at: number | null;
  stats: string | null;
  transcript_path: string | null;
}

function sessionParams(s: Session) {
  return {
    id: s.id,
    node: s.node,
    harness: s.harness,
    profile: s.profile,
    native_id: s.native.id,
    native_pid: s.native.pid ?? null,
    native_transport: s.native.transport,
    origin: s.origin,
    workspace: s.workspace ?? null,
    task: s.task ?? null,
    cwd: s.cwd,
    title: s.title ?? null,
    intent: s.intent ?? null,
    summary: s.summary ?? null,
    tags: json(s.tags),
    status: s.status,
    ask: s.ask ?? null,
    started_at: s.startedAt,
    last_activity: s.lastActivity,
    ended_at: s.endedAt ?? null,
    stats: s.stats ? json(s.stats) : null,
    transcript_path: s.transcript?.path ?? null,
  };
}

function sessionFromRow(r: SessionRow): Session {
  const s: Session = {
    id: r.id,
    node: r.node,
    harness: r.harness as Session["harness"],
    profile: r.profile,
    native: { id: r.native_id, transport: r.native_transport as Session["native"]["transport"] },
    origin: r.origin as Session["origin"],
    cwd: r.cwd,
    tags: JSON.parse(r.tags) as string[],
    status: r.status as Session["status"],
    startedAt: r.started_at,
    lastActivity: r.last_activity,
  };
  if (r.native_pid !== null) s.native.pid = r.native_pid;
  if (r.workspace !== null) s.workspace = r.workspace;
  if (r.task !== null) s.task = r.task;
  if (r.title !== null) s.title = r.title;
  if (r.intent !== null) s.intent = r.intent;
  if (r.summary !== null) s.summary = r.summary;
  if (r.ask !== null) s.ask = r.ask;
  if (r.ended_at !== null) s.endedAt = r.ended_at;
  const stats = parse<Session["stats"]>(r.stats);
  if (stats) s.stats = stats;
  if (r.transcript_path !== null) s.transcript = { path: r.transcript_path };
  return s;
}

interface SessionEventRow {
  session: string;
  seq: number;
  at: number;
  kind: string;
  payload: string;
  raw: string | null;
}

function sessionEventFromRow(r: SessionEventRow): SessionEvent {
  const e: SessionEvent = { session: r.session, seq: r.seq, at: r.at, kind: r.kind as SessionEvent["kind"], payload: JSON.parse(r.payload) as unknown };
  if (r.raw !== null) e.raw = JSON.parse(r.raw) as unknown;
  return e;
}

export interface ThreadListFilter {
  workspace?: string;
  since?: number;
  open?: boolean;
  limit?: number;
}

interface ThreadRow {
  id: string;
  topic: string | null;
  workspace: string | null;
  summary: string | null;
  tags: string;
  sessions: string;
  started_at: number;
  ended_at: number | null;
}

function threadParams(t: Thread) {
  return {
    id: t.id,
    topic: t.topic ?? null,
    workspace: t.workspace ?? null,
    summary: t.summary ?? null,
    tags: json(t.tags),
    sessions: json(t.sessions),
    started_at: t.startedAt,
    ended_at: t.endedAt ?? null,
  };
}

function threadFromRow(r: ThreadRow): Thread {
  const t: Thread = { id: r.id, startedAt: r.started_at, tags: JSON.parse(r.tags) as string[], sessions: JSON.parse(r.sessions) as string[] };
  if (r.topic !== null) t.topic = r.topic;
  if (r.workspace !== null) t.workspace = r.workspace;
  if (r.summary !== null) t.summary = r.summary;
  if (r.ended_at !== null) t.endedAt = r.ended_at;
  return t;
}

interface MessageRow {
  id: string;
  thread: string;
  at: number;
  role: string;
  source: string;
  content: string;
  streaming: number;
  steps: string | null;
}

function messageParams(m: Message) {
  return { id: m.id, thread: m.thread, at: m.at, role: m.role, source: m.source, content: json(m.content), streaming: m.streaming ? 1 : 0, steps: m.steps?.length ? json(m.steps) : null };
}

function messageFromRow(r: MessageRow): Message {
  const m: Message = { id: r.id, thread: r.thread, at: r.at, role: r.role as Message["role"], source: r.source as Message["source"], content: JSON.parse(r.content) as Message["content"] };
  if (r.streaming) m.streaming = true;
  if (r.steps) m.steps = JSON.parse(r.steps) as NonNullable<Message["steps"]>;
  return m;
}

export interface TaskListFilter {
  status?: TaskStatus[];
  workspace?: string;
  blocker?: "user" | "ask" | "task" | "session";
  /** A plan's steps. */
  parent?: string;
}

interface TaskRow {
  id: string;
  title: string;
  detail: string | null;
  workspace: string | null;
  thread: string | null;
  parent: string | null;
  created_by: string;
  status: string;
  priority: string;
  trigger: string | null;
  recurring: number;
  blocker: string | null;
  sessions: string;
  result: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

function taskParams(t: Task) {
  return {
    id: t.id,
    title: t.title,
    detail: t.detail ?? null,
    workspace: t.workspace ?? null,
    thread: t.thread ?? null,
    parent: t.parent ?? null,
    created_by: json(t.createdBy),
    status: t.status,
    priority: t.priority,
    trigger: t.trigger ? json(t.trigger) : null,
    recurring: t.recurring ? 1 : 0,
    blocker: t.blocker ? json(t.blocker) : null,
    sessions: json(t.sessions),
    result: t.result ? json(t.result) : null,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    completed_at: t.completedAt ?? null,
  };
}

function taskFromRow(r: TaskRow): Task {
  const t: Task = {
    id: r.id,
    title: r.title,
    createdBy: JSON.parse(r.created_by) as Principal,
    status: r.status as Task["status"],
    priority: r.priority as Task["priority"],
    sessions: JSON.parse(r.sessions) as string[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.detail !== null) t.detail = r.detail;
  if (r.workspace !== null) t.workspace = r.workspace;
  if (r.thread !== null) t.thread = r.thread;
  if (r.parent !== null) t.parent = r.parent;
  const trigger = parse<Task["trigger"]>(r.trigger);
  if (trigger) t.trigger = trigger;
  if (r.recurring) t.recurring = true;
  const blocker = parse<Task["blocker"]>(r.blocker);
  if (blocker) t.blocker = blocker;
  const result = parse<Task["result"]>(r.result);
  if (result) t.result = result;
  if (r.completed_at !== null) t.completedAt = r.completed_at;
  return t;
}

interface NodeRow {
  id: string;
  name: string;
  role: string;
  backup: number;
  rank: number | null;
  platform: string;
  scope: string;
  capabilities: string;
  versions: string;
  endpoints: string;
  epoch: number | null;
  last_seen: number;
  status: string;
}

function nodeFromRow(r: NodeRow): NodeRecord {
  const n: NodeRecord = {
    id: r.id,
    name: r.name,
    role: r.role as NodeRecord["role"],
    status: r.status as NodeRecord["status"],
    via: "direct",
    platform: r.platform as NodeRecord["platform"],
    scope: JSON.parse(r.scope) as NodeRecord["scope"],
    capabilities: JSON.parse(r.capabilities) as NodeRecord["capabilities"],
    versions: JSON.parse(r.versions) as NodeRecord["versions"],
    lastSeen: r.last_seen,
    endpoints: JSON.parse(r.endpoints) as string[],
  };
  if (r.backup) n.backup = true;
  if (r.rank !== null) n.rank = r.rank;
  if (r.epoch !== null) n.epoch = r.epoch;
  return n;
}

interface WorkspaceRow {
  id: string;
  node: string;
  path: string;
  name: string;
  origin: string;
  repo: string | null;
  summary: string | null;
  tags: string;
  last_activity: number;
}

function workspaceFromRow(r: WorkspaceRow): Workspace {
  const w: Workspace = {
    id: r.id,
    node: r.node,
    path: r.path,
    name: r.name,
    origin: r.origin as Workspace["origin"],
    tags: JSON.parse(r.tags) as string[],
    lastActivity: r.last_activity,
  };
  const repo = parse<Workspace["repo"]>(r.repo);
  if (repo) w.repo = repo;
  if (r.summary !== null) w.summary = r.summary;
  return w;
}
