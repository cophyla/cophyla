// The store: every table from architecture.md exists, migration is idempotent, and rows
// round-trip as entities.

import { describe, expect, test } from "bun:test";
import { Ask as AskSchema, AuditEntry as AuditEntrySchema, Message as MessageSchema, MetricsSample as MetricsSampleSchema, NodeRecord as NodeRecordSchema, Session as SessionSchema, Task as TaskSchema, Thread as ThreadSchema, Workspace as WorkspaceSchema } from "@cophyla/protocol";
import type { Ask, AuditEntry, Message, MetricsSample, NodeRecord, Session, Task, Thread, Workspace } from "@cophyla/protocol";
import { EXCLUDED_KV_NS } from "../src/nodes/replication.ts";
import { Store } from "../src/store/index.ts";
import type { StoreWrite } from "../src/store/index.ts";
import { MIGRATIONS } from "../src/store/migrations.ts";

const open = () => {
  const s = new Store(":memory:");
  s.migrate();
  return s;
};

describe("store", () => {
  test("has the tables architecture.md names", () => {
    const s = open();
    const tables = s.tables();
    for (const t of ["threads", "messages", "harness_sessions", "session_events", "workspaces", "tasks", "asks", "events", "audit", "kv", "entitlement", "usage", "metrics", "policy", "meta", "nodes", "backup_sync"]) {
      expect(tables).toContain(t);
    }
    s.close();
  });

  test("migrate is idempotent", () => {
    const s = open();
    expect(s.version).toBe(MIGRATIONS.length);
    expect(s.migrate()).toBe(MIGRATIONS.length);
    s.close();
  });

  test("migration 2 upgrades a v1 database in place", () => {
    const s = new Store(":memory:");
    s.db.transaction(() => {
      s.db.exec(MIGRATIONS[0]!);
      s.db.exec("PRAGMA user_version = 1");
    })();
    s.db.exec("INSERT INTO harness_sessions (id, node, harness, native_id, native_transport, origin, cwd, status, started_at, last_activity) VALUES ('sess_01ARZ3NDEKTSV4RRFFQ69G5FB1', 'n', 'claude', 'x', 'pipe', 'user', '.', 'idle', 1, 1)");
    expect(s.version).toBe(1);
    expect(s.migrate()).toBe(MIGRATIONS.length);
    const row = s.db.query("SELECT profile FROM harness_sessions").get() as { profile: string };
    expect(row.profile).toBe("");
    const indexes = (s.db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name);
    expect(indexes).toContain("harness_sessions_profile");
    expect(indexes).toContain("session_events_session_at");
    s.close();
  });

  test("session rows round-trip as Session and list by filter", () => {
    const s = open();
    const a: Session = {
      id: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1",
      node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      harness: "claude",
      profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8",
      native: { id: "3f0c1b2a", pid: 41232, transport: "pipe" },
      origin: "user",
      workspace: "ws_01ARZ3NDEKTSV4RRFFQ69G5FB0",
      cwd: "C:\\D\\orchestrator",
      title: "fix the gate tests",
      tags: [],
      status: "needs_permission",
      ask: "ask_01ARZ3NDEKTSV4RRFFQ69G5FB5",
      startedAt: 1758196000000,
      lastActivity: 1758196800000,
      stats: { turns: 4, cost: 0, tokens: { in: 1200, out: 800, cacheRead: 45000, cacheWrite: 3000 }, context: { used: 51000, limit: 200000 } },
      transcript: { path: "C:\\Users\\me\\.claude\\projects\\C--D-orchestrator\\3f0c1b2a.jsonl" },
    };
    s.sessions.insert(a);
    expect(s.sessions.get(a.id)).toEqual(a);
    expect(SessionSchema.safeParse(s.sessions.get(a.id)).success).toBe(true);
    expect(s.sessions.getByNative("claude", "3f0c1b2a")?.id).toBe(a.id);
    expect(s.sessions.getByNative("codex", "3f0c1b2a")).toBeUndefined();

    const b: Session = { ...a, id: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB2", harness: "codex", native: { id: "019a", transport: "app-server" }, status: "ended", endedAt: 1758196900000, lastActivity: 1758196900000 };
    delete b.ask;
    delete b.stats;
    delete b.transcript;
    delete b.title;
    delete b.workspace;
    s.sessions.insert(b);
    expect(s.sessions.get(b.id)).toEqual(b);
    expect(Object.keys(s.sessions.get(b.id)!)).not.toContain("ask");

    expect(s.sessions.listLive().map((x) => x.id)).toEqual([a.id]);
    expect(s.sessions.list({ harness: "codex" }).map((x) => x.id)).toEqual([b.id]);
    expect(s.sessions.list({ status: ["ended", "idle"] }).map((x) => x.id)).toEqual([b.id]);
    expect(s.sessions.list({ profile: a.profile })).toHaveLength(2);
    expect(s.sessions.list({ workspace: "ws_01ARZ3NDEKTSV4RRFFQ69G5FB0" })).toHaveLength(1);

    a.status = "idle";
    delete a.ask;
    a.native.pid = 500;
    s.sessions.update(a);
    expect(s.sessions.get(a.id)).toEqual(a);
    s.close();
  });

  test("session events get distinct increasing seqs and a newest-first history window", () => {
    const s = open();
    const session = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1";
    s.sessions.insert({ id: session, node: "n", harness: "claude", profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8", native: { id: "x", transport: "pipe" }, origin: "user", cwd: ".", tags: [], status: "idle", startedAt: 1, lastActivity: 1 });
    const seqs = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const e = s.sessionEvents.append({ session, at: 1000 + i, kind: "status", payload: { i }, ...(i % 2 ? { raw: { row: i } } : {}) });
      expect(seqs.has(e.seq)).toBe(false);
      seqs.add(e.seq);
    }
    expect([...seqs]).toEqual([...Array(20).keys()]);
    expect(s.sessionEvents.count(session)).toBe(20);
    const page = s.sessionEvents.history(session, { limit: 5 });
    expect(page.map((e) => e.seq)).toEqual([15, 16, 17, 18, 19]);
    const earlier = s.sessionEvents.history(session, { before: 15, limit: 5 });
    expect(earlier.map((e) => e.seq)).toEqual([10, 11, 12, 13, 14]);
    expect(earlier[1]!.raw).toEqual({ row: 11 });
    expect(Object.keys(earlier[0]!)).not.toContain("raw");
    expect(s.sessionEvents.history("sess_01ARZ3NDEKTSV4RRFFQ69G5FB9")).toEqual([]);
    s.close();
  });

  test("workspaces upsert by node and path and round-trip", () => {
    const s = open();
    const w: Workspace = {
      id: "ws_01ARZ3NDEKTSV4RRFFQ69G5FB0",
      node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      path: "C:\\D\\orchestrator",
      name: "orchestrator",
      origin: "discovered",
      repo: { root: "C:\\D\\orchestrator", remote: "git@github.com:x/y.git" },
      tags: ["a"],
      lastActivity: 10,
    };
    expect(s.workspaces.upsert(w)).toBe(w.id);
    expect(s.workspaces.get(w.id)).toEqual(w);
    expect(WorkspaceSchema.safeParse(s.workspaces.get(w.id)).success).toBe(true);
    const again = { ...w, id: "ws_01ARZ3NDEKTSV4RRFFQ69G5FB1", name: "renamed", lastActivity: 20 };
    expect(s.workspaces.upsert(again)).toBe(w.id);
    expect(s.workspaces.list()).toHaveLength(1);
    expect(s.workspaces.getByPath(w.node, w.path)?.name).toBe("renamed");
    expect(s.workspaces.get(w.id)?.lastActivity).toBe(20);
    // The same id under a new path: the workspace moved, one row still.
    const moved = { ...w, path: "C:\\D\\elsewhere", name: "moved", lastActivity: 30 };
    expect(s.workspaces.upsert(moved)).toBe(w.id);
    expect(s.workspaces.list()).toHaveLength(1);
    expect(s.workspaces.get(w.id)?.path).toBe("C:\\D\\elsewhere");
    expect(s.workspaces.getByPath(w.node, w.path)).toBeUndefined();
    s.close();
  });

  test("open asks can be listed by the harness session that raised them", () => {
    const s = open();
    const base = { node: "n", type: "permission" as const, title: "x", options: [], answerableBy: ["user" as const], status: "open" as const, createdAt: 1 };
    s.asks.insert({ ...base, id: "ask_01ARZ3NDEKTSV4RRFFQ69G5FB1", source: { kind: "harness", session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1" } });
    s.asks.insert({ ...base, id: "ask_01ARZ3NDEKTSV4RRFFQ69G5FB2", source: { kind: "harness", session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB2" } });
    s.asks.insert({ ...base, id: "ask_01ARZ3NDEKTSV4RRFFQ69G5FB3", source: { kind: "brain" } });
    expect(s.asks.listOpenBySession("sess_01ARZ3NDEKTSV4RRFFQ69G5FB1").map((a) => a.id)).toEqual(["ask_01ARZ3NDEKTSV4RRFFQ69G5FB1"]);
    s.close();
  });

  test("kv round-trips JSON with prefix listing", () => {
    const s = open();
    s.kv.put("wake", "rules", { a: 1 });
    s.kv.put("wake", "other", [1, 2]);
    s.kv.put("gate", "rules", "no");
    expect(s.kv.get("wake", "rules")).toEqual({ a: 1 });
    expect(s.kv.list("wake")).toEqual(["other", "rules"]);
    expect(s.kv.list("wake", "ru")).toEqual(["rules"]);
    expect(s.kv.delete("wake", "rules")).toBe(true);
    expect(s.kv.get("wake", "rules")).toBeUndefined();
    s.close();
  });

  test("audit rows round-trip as AuditEntry, with optional fields absent rather than null", () => {
    const s = open();
    const e: AuditEntry = {
      id: "aud_01ARZ3NDEKTSV4RRFFQ69G5FB6",
      node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      at: 1758196800000,
      principal: { kind: "brain" },
      action: "session.send",
      target: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1",
      args: { text: "hi" },
      decision: "ask",
      ask: "ask_01ARZ3NDEKTSV4RRFFQ69G5FB5",
      correlation: "turn-1",
    };
    s.audit.insert(e);
    const back = s.audit.get(e.id)!;
    expect(back).toEqual(e);
    expect(AuditEntrySchema.safeParse(back).success).toBe(true);
    expect(Object.keys(back)).not.toContain("outcome");

    s.audit.complete(e.id, { outcome: "ok", durationMs: 12, result: { summary: "x", bytes: 1, sha256: "a".repeat(64), body: { ok: true } } });
    const done = s.audit.get(e.id)!;
    expect(done.outcome).toBe("ok");
    expect(done.durationMs).toBe(12);
    expect(done.result?.body).toEqual({ ok: true });
    expect(s.audit.list({ limit: 5 })).toHaveLength(1);
    expect(s.audit.count()).toBe(1);
    s.close();
  });

  test("ask rows round-trip as Ask", () => {
    const s = open();
    const a: Ask = {
      id: "ask_01ARZ3NDEKTSV4RRFFQ69G5FB5",
      node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      type: "choice",
      source: { kind: "brain", task: "task_01ARZ3NDEKTSV4RRFFQ69G5FB2" },
      title: "Which?",
      options: [{ id: "a", label: "A", description: "the first" }, { id: "b", label: "B" }],
      multiple: true,
      allowsText: true,
      answerableBy: ["user"],
      status: "open",
      createdAt: 1758196800000,
      expiresAt: 1758200400000,
    };
    s.asks.insert(a);
    expect(s.asks.get(a.id)).toEqual(a);
    expect(s.asks.listOpen()).toHaveLength(1);
    a.status = "answered";
    a.answer = { option: "a", options: ["a", "b"], text: "yes", by: { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" }, at: 1758196900000 };
    a.remember = "once";
    s.asks.update(a);
    const back = s.asks.get(a.id)!;
    expect(back).toEqual(a);
    expect(AskSchema.safeParse(back).success).toBe(true);
    expect(s.asks.listOpen()).toHaveLength(0);
    s.close();
  });

  test("policy rules upsert by key", () => {
    const s = open();
    const by = { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" } as const;
    s.policy.put({ key: "brain:session.send", principal: "brain", action: "session.send", decision: "allow", createdBy: by, createdAt: 1 });
    s.policy.put({ key: "brain:session.send", principal: "brain", action: "session.send", decision: "deny", createdBy: by, createdAt: 2 });
    expect(s.policy.list()).toHaveLength(1);
    expect(s.policy.list()[0]!.decision).toBe("deny");
    expect(s.policy.delete("brain:session.send")).toBe(true);
    expect(s.policy.list()).toHaveLength(0);
    s.close();
  });
});

describe("store: milestone 3 tables", () => {
  const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";

  test("migration 3 adds the thread and task indexes", () => {
    const s = open();
    const indexes = (s.db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name);
    expect(indexes).toContain("threads_started_at");
    expect(indexes).toContain("tasks_updated_at");
    s.close();
  });

  test("threads round-trip, page backwards oldest-first, and the latest open one is found", () => {
    const s = open();
    const t1: Thread = { id: "thr_01ARZ3NDEKTSV4RRFFQ69G5FB1", topic: "one", startedAt: 100, endedAt: 200, tags: ["a"], sessions: ["sess_01ARZ3NDEKTSV4RRFFQ69G5FB1"], workspace: "ws_01ARZ3NDEKTSV4RRFFQ69G5FB0", summary: "s" };
    const t2: Thread = { id: "thr_01ARZ3NDEKTSV4RRFFQ69G5FB2", startedAt: 200, tags: [], sessions: [] };
    const t3: Thread = { id: "thr_01ARZ3NDEKTSV4RRFFQ69G5FB3", startedAt: 300, tags: [], sessions: [] };
    for (const t of [t1, t2, t3]) s.threads.insert(t);
    expect(s.threads.get(t1.id)).toEqual(t1);
    expect(ThreadSchema.safeParse(s.threads.get(t1.id)).success).toBe(true);
    expect(Object.keys(s.threads.get(t2.id)!)).not.toContain("endedAt");
    expect(s.threads.latestOpen()?.id).toBe(t3.id);
    expect(s.threads.list({ open: true }).map((t) => t.id)).toEqual([t3.id, t2.id]);
    expect(s.threads.list({ open: false }).map((t) => t.id)).toEqual([t1.id]);
    // `since` counts a closed thread by when it ended: t1 ran until 200, so it is in the window from 200 and out from 201.
    expect(s.threads.list({ since: 200 }).map((t) => t.id)).toEqual([t3.id, t2.id, t1.id]);
    expect(s.threads.list({ since: 201 }).map((t) => t.id)).toEqual([t3.id]);
    expect(s.threads.list({ since: 150, open: false }).map((t) => t.id)).toEqual([t1.id]);
    expect(s.threads.list({ since: 201, open: false })).toEqual([]);
    expect(s.threads.list({ workspace: "ws_01ARZ3NDEKTSV4RRFFQ69G5FB0" }).map((t) => t.id)).toEqual([t1.id]);
    expect(s.threads.before(undefined, 1).map((t) => t.id)).toEqual([t3.id]);
    expect(s.threads.before(undefined, 2).map((t) => t.id)).toEqual([t2.id, t3.id]);
    expect(s.threads.before(t3.id, 1).map((t) => t.id)).toEqual([t2.id]);
    expect(s.threads.before(t2.id, 5).map((t) => t.id)).toEqual([t1.id]);
    expect(s.threads.before(t1.id, 5)).toEqual([]);
    expect(s.threads.before("thr_01ARZ3NDEKTSV4RRFFQ69G5FB9", 5)).toEqual([]);
    t2.endedAt = 250;
    t2.topic = "two";
    s.threads.update(t2);
    expect(s.threads.get(t2.id)).toEqual(t2);
    s.close();
  });

  test("messages round-trip and page by at, before or around", () => {
    const s = open();
    const thread = "thr_01ARZ3NDEKTSV4RRFFQ69G5FB1";
    s.threads.insert({ id: thread, startedAt: 1, tags: [], sessions: [] });
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = "msg_01ARZ3NDEKTSV4RRFFQ69G5FB" + i;
      ids.push(id);
      const m: Message = { id, thread, at: 1000 + i * 10, role: i % 2 ? "orchestrator" : "user", source: i % 2 ? "brain" : "ui", content: [{ type: "text", text: "m" + i }] };
      if (i === 9) m.streaming = true;
      s.messages.insert(m);
    }
    const first = s.messages.get(ids[0]!)!;
    expect(first.content).toEqual([{ type: "text", text: "m0" }]);
    expect(Object.keys(first)).not.toContain("streaming");
    expect(MessageSchema.safeParse(first).success).toBe(true);
    expect(s.messages.get(ids[9]!)?.streaming).toBe(true);
    expect(s.messages.byThread(thread).map((m) => m.id)).toEqual(ids);
    expect(s.messages.count(thread)).toBe(10);
    expect(s.messages.history(thread, { limit: 3 }).map((m) => m.at)).toEqual([1070, 1080, 1090]);
    expect(s.messages.history(thread, { before: 1070, limit: 3 }).map((m) => m.at)).toEqual([1040, 1050, 1060]);
    expect(s.messages.history(thread, { around: 1050, limit: 4 }).map((m) => m.at)).toEqual([1040, 1050, 1060, 1070]);
    expect(s.messages.history(thread, { around: 1000, limit: 4 }).map((m) => m.at)).toEqual([1000, 1010, 1020, 1030]);
    const m = s.messages.get(ids[9]!)!;
    delete m.streaming;
    m.content = [{ type: "quote", text: "q", source: { kind: "session", session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1", seq: [1, 2] } }];
    s.messages.update(m);
    expect(s.messages.get(ids[9]!)).toEqual(m);
    // A reply keeps the steps its turn took; one with none has no field.
    expect(Object.keys(first)).not.toContain("steps");
    m.steps = [{ text: "Checked agent sessions", status: "done" }, { text: "Reading notes.md", status: "failed" }];
    s.messages.update(m);
    expect(s.messages.get(ids[9]!)).toEqual(m);
    expect(MessageSchema.safeParse(s.messages.get(ids[9]!)).success).toBe(true);
    s.close();
  });

  test("tasks round-trip, list by filter, and are found by blocker", () => {
    const s = open();
    const a: Task = {
      id: "task_01ARZ3NDEKTSV4RRFFQ69G5FB1",
      title: "fix",
      detail: "the gate",
      workspace: "ws_01ARZ3NDEKTSV4RRFFQ69G5FB0",
      thread: "thr_01ARZ3NDEKTSV4RRFFQ69G5FB1",
      createdBy: { kind: "brain" },
      status: "blocked",
      priority: "high",
      blocker: { kind: "ask", ask: "ask_01ARZ3NDEKTSV4RRFFQ69G5FB5" },
      sessions: ["sess_01ARZ3NDEKTSV4RRFFQ69G5FB1"],
      createdAt: 1,
      updatedAt: 2,
    };
    const b: Task = { id: "task_01ARZ3NDEKTSV4RRFFQ69G5FB2", title: "later", createdBy: { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" }, status: "pending", priority: "normal", trigger: { kind: "at", at: 5 }, recurring: true, sessions: [], createdAt: 3, updatedAt: 3 };
    const c: Task = { id: "task_01ARZ3NDEKTSV4RRFFQ69G5FB3", title: "done", createdBy: { kind: "brain" }, status: "done", priority: "low", sessions: [], result: { summary: "ok" }, createdAt: 4, updatedAt: 9, completedAt: 9 };
    for (const t of [a, b, c]) s.tasks.insert(t);
    expect(s.tasks.get(a.id)).toEqual(a);
    expect(TaskSchema.safeParse(s.tasks.get(a.id)).success).toBe(true);
    expect(s.tasks.get(b.id)).toEqual(b);
    expect(Object.keys(s.tasks.get(c.id)!)).not.toContain("blocker");
    expect(s.tasks.list().map((t) => t.id)).toEqual([c.id, b.id, a.id]);
    expect(s.tasks.list({ status: ["blocked", "pending"] }).map((t) => t.id)).toEqual([b.id, a.id]);
    expect(s.tasks.list({ workspace: "ws_01ARZ3NDEKTSV4RRFFQ69G5FB0" }).map((t) => t.id)).toEqual([a.id]);
    expect(s.tasks.list({ blocker: "ask" }).map((t) => t.id)).toEqual([a.id]);
    expect(s.tasks.blockedOn("ask", "ask_01ARZ3NDEKTSV4RRFFQ69G5FB5").map((t) => t.id)).toEqual([a.id]);
    expect(s.tasks.blockedOn("ask", "ask_01ARZ3NDEKTSV4RRFFQ69G5FB6")).toEqual([]);
    expect(s.tasks.blockedOn("session", "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1")).toEqual([]);
    a.blocker = { kind: "session", session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1" };
    s.tasks.update(a);
    expect(s.tasks.blockedOn("session", "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1").map((t) => t.id)).toEqual([a.id]);
    s.close();
  });

  test("metrics rollups upsert by node and minute, range oldest-first, prune by minute", () => {
    const s = open();
    const sample = (minute: number, cpu: number): MetricsSample => ({
      node: NODE,
      at: minute,
      cpu,
      memory: { used: 1, total: 2 },
      processes: [{ pid: 1, parent: 0, name: "bun", cpu: 0.5, memory: 100, owner: { kind: "platform" } }],
      llm: { "gemini/flash": { in: 10, out: 2 } },
      profiles: { prof_01ARZ3NDEKTSV4RRFFQ69G5FB8: { in: 1, out: 2, cached: 3, cost: 0.01 } },
    });
    for (const m of [60000, 120000, 180000]) s.metrics.put(NODE, m, sample(m, m / 60000));
    expect(s.metrics.count(NODE)).toBe(3);
    expect(s.metrics.count()).toBe(3);
    expect(s.metrics.range(NODE).map((r) => r.cpu)).toEqual([1, 2, 3]);
    expect(MetricsSampleSchema.safeParse(s.metrics.range(NODE)[0]).success).toBe(true);
    expect(s.metrics.range(NODE)[0]).toEqual(sample(60000, 1));
    expect(s.metrics.range(NODE, { from: 120000 }).map((r) => r.cpu)).toEqual([2, 3]);
    expect(s.metrics.range(NODE, { to: 120000 }).map((r) => r.cpu)).toEqual([1, 2]);
    expect(s.metrics.range(NODE, { limit: 1 }).map((r) => r.cpu)).toEqual([1]);
    expect(s.metrics.latest(NODE, 2).map((r) => r.cpu)).toEqual([2, 3]);
    expect(s.metrics.range("node_01ARZ3NDEKTSV4RRFFQ69G5FAW")).toEqual([]);
    // The same minute again replaces the row: a rollup rewritten at the minute change is one row.
    s.metrics.put(NODE, 120000, sample(120000, 9));
    expect(s.metrics.count(NODE)).toBe(3);
    expect(s.metrics.range(NODE).map((r) => r.cpu)).toEqual([1, 9, 3]);
    expect(s.metrics.prune(150000)).toBe(2);
    expect(s.metrics.range(NODE).map((r) => r.cpu)).toEqual([3]);
    s.close();
  });

  test("node rows round-trip as NodeRecord and list by name", () => {
    const s = open();
    const a: NodeRecord = {
      id: "node_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      name: "laptop",
      role: "secondary",
      status: "online",
      backup: true,
      rank: 2,
      via: "direct",
      platform: "linux",
      scope: { kind: "machine" },
      capabilities: { harnesses: ["claude"], voice: { wake: false, stt: false, tts: false }, remote: false, brain: false },
      versions: { platform: "0.3.0", protocol: 1 },
      lastSeen: 5,
      endpoints: ["192.168.1.50:4818"],
      epoch: 3,
    };
    const b: NodeRecord = { ...a, id: NODE, name: "desk", role: "primary", endpoints: [] };
    delete b.backup;
    delete b.rank;
    delete b.epoch;
    s.nodes.upsert(a);
    s.nodes.upsert(b);
    expect(s.nodes.get(a.id)).toEqual(a);
    expect(NodeRecordSchema.safeParse(s.nodes.get(a.id)).success).toBe(true);
    expect(Object.keys(s.nodes.get(b.id)!)).not.toContain("rank");
    expect(s.nodes.list().map((n) => n.name)).toEqual(["desk", "laptop"]);
    s.nodes.upsert({ ...a, status: "offline", lastSeen: 9 });
    expect(s.nodes.get(a.id)!.status).toBe("offline");
    expect(s.nodes.delete(a.id)).toBe(true);
    expect(s.nodes.list().length).toBe(1);
    s.close();
  });

  test("every write to a primary-only table is announced, none while a replica write is applied", () => {
    const s = open();
    const seen: StoreWrite[] = [];
    s.onWrite = (w) => seen.push(w);
    const thread: Thread = { id: "thr_01ARZ3NDEKTSV4RRFFQ69G5FB3", startedAt: 1, tags: [], sessions: [] };
    s.threads.insert(thread);
    s.threads.update({ ...thread, topic: "t" });
    const message: Message = { id: "msg_01ARZ3NDEKTSV4RRFFQ69G5FB4", thread: thread.id, at: 2, role: "user", source: "ui", content: [{ type: "text", text: "hi" }] };
    s.messages.insert(message);
    s.messages.update({ ...message, streaming: true });
    const task: Task = { id: "task_01ARZ3NDEKTSV4RRFFQ69G5FB1", title: "x", createdBy: { kind: "brain" }, status: "pending", priority: "normal", sessions: [], createdAt: 1, updatedAt: 1 };
    s.tasks.insert(task);
    s.tasks.update({ ...task, status: "ready" });
    const ws: Workspace = { id: "ws_01ARZ3NDEKTSV4RRFFQ69G5FB0", node: NODE, path: "/w", name: "w", origin: "user", tags: [], lastActivity: 1 };
    s.workspaces.upsert(ws);
    s.kv.put("wake", "rules", { a: 1 }, 7);
    s.kv.delete("wake", "rules");
    s.kv.delete("wake", "rules");
    expect(seen.map((w) => `${w.table}:${w.op}`)).toEqual([
      "threads:upsert",
      "threads:upsert",
      "messages:upsert",
      "messages:upsert",
      "tasks:upsert",
      "tasks:upsert",
      "workspaces:upsert",
      "kv:upsert",
      "kv:delete",
    ]);
    expect(seen[1]!.row).toEqual({ ...thread, topic: "t" });
    expect(seen[7]!.row).toEqual({ ns: "wake", key: "rules", value: { a: 1 }, updatedAt: 7 });
    expect(seen[8]!.row).toEqual({ ns: "wake", key: "rules" });
    // What the replica applies is silent, and lands whole.
    seen.length = 0;
    s.applyReplica({ epoch: 1, seq: 1, table: "threads", op: "upsert", row: { ...thread, topic: "from the primary" } });
    s.applyReplica({ epoch: 1, seq: 2, table: "kv", op: "upsert", row: { ns: "wake", key: "rules", value: { b: 2 }, updatedAt: 8 } });
    s.applyReplica({ epoch: 1, seq: 3, table: "messages", op: "delete", row: { id: message.id } });
    expect(seen).toEqual([]);
    expect(s.threads.get(thread.id)!.topic).toBe("from the primary");
    expect(s.kv.get("wake", "rules")).toEqual({ b: 2 });
    expect(s.messages.get(message.id)).toBeUndefined();
    s.close();
  });

  test("a snapshot replaces the primary-only tables, keeps this node's workspaces and the excluded kv namespaces", () => {
    const primary = open();
    const backup = open();
    const OTHER = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
    const thread: Thread = { id: "thr_01ARZ3NDEKTSV4RRFFQ69G5FB3", startedAt: 1, tags: [], sessions: [] };
    primary.threads.insert(thread);
    primary.messages.insert({ id: "msg_01ARZ3NDEKTSV4RRFFQ69G5FB4", thread: thread.id, at: 2, role: "user", source: "ui", content: [{ type: "text", text: "replicated words" }] });
    primary.tasks.insert({ id: "task_01ARZ3NDEKTSV4RRFFQ69G5FB1", title: "x", createdBy: { kind: "brain" }, status: "pending", priority: "normal", sessions: [], createdAt: 1, updatedAt: 1 });
    primary.workspaces.upsert({ id: "ws_01ARZ3NDEKTSV4RRFFQ69G5FB0", node: NODE, path: "/p", name: "p", origin: "user", tags: [], lastActivity: 1 });
    primary.kv.put("wake", "rules", { a: 1 }, 3);
    primary.kv.put("profiles", "x", { secret: true }, 3);
    // The backup's own state: a thread of its own (dropped), its own workspace (kept), its own profiles (kept), a stale wake rule (replaced).
    backup.threads.insert({ id: "thr_01ARZ3NDEKTSV4RRFFQ69G5FB9", startedAt: 1, tags: [], sessions: [] });
    backup.workspaces.upsert({ id: "ws_01ARZ3NDEKTSV4RRFFQ69G5FB1", node: OTHER, path: "/mine", name: "mine", origin: "scope", tags: [], lastActivity: 1 });
    backup.kv.put("profiles", "y", { mine: true }, 1);
    backup.kv.put("wake", "rules", { old: true }, 1);
    const tables = primary.replicaSnapshot(["profiles"]);
    expect(tables.kv.map((r) => r.ns)).toEqual(["wake"]);
    backup.applySnapshot({ epoch: 2, seq: 10, tables, files: [] }, { selfNode: OTHER, keepKvNs: ["profiles"] });
    expect(backup.threads.dump()).toEqual(primary.threads.dump());
    expect(backup.messages.dump()).toEqual(primary.messages.dump());
    expect(backup.tasks.dump()).toEqual(primary.tasks.dump());
    expect(backup.workspaces.list().map((w) => w.path).sort()).toEqual(["/mine", "/p"]);
    expect(backup.kv.get("wake", "rules")).toEqual({ a: 1 });
    expect(backup.kv.get("profiles", "y")).toEqual({ mine: true });
    expect(backup.kv.get("profiles", "x")).toBeUndefined();
    // With the namespaces a node keeps for itself, the phones it paired itself survive the snapshot.
    backup.kv.put("grants.local", "ctl_mine", { name: "my phone" }, 4);
    backup.applySnapshot({ epoch: 2, seq: 11, tables: primary.replicaSnapshot(EXCLUDED_KV_NS), files: [] }, { selfNode: OTHER, keepKvNs: EXCLUDED_KV_NS });
    expect(backup.kv.get("grants.local", "ctl_mine")).toEqual({ name: "my phone" });
    expect(backup.kv.get("wake", "rules")).toEqual({ a: 1 });
    // The chunks came with the messages: the replicated words are findable.
    expect(backup.index.chunks.count()).toBe(1);
    primary.close();
    backup.close();
  });

  test("events insert and page by name, node and range", () => {
    const s = open();
    for (let i = 0; i < 5; i++) s.events.insert({ node: NODE, name: i % 2 ? "node.pressure" : "my.ci", at: 100 + i, payload: { i } });
    expect(s.events.history().map((e) => e.at)).toEqual([100, 101, 102, 103, 104]);
    expect(s.events.history({ name: "my.ci" }).map((e) => (e.payload as { i: number }).i)).toEqual([0, 2, 4]);
    expect(s.events.history({ from: 102, to: 103 }).map((e) => e.at)).toEqual([102, 103]);
    expect(s.events.history({ node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAW" })).toEqual([]);
    expect(s.events.history({ limit: 2 }).map((e) => e.at)).toEqual([103, 104]);
    s.close();
  });
  test("the entitlement row holds one token with its claims; usage counts per period and takes the server's cap", () => {
    const s = new Store(":memory:");
    s.migrate();
    expect(s.entitlement.get()).toBeUndefined();
    s.entitlement.put("a.b.c", { plan: "pro" }, 1000);
    expect(s.entitlement.get()).toEqual({ token: "a.b.c", claims: { plan: "pro" }, receivedAt: 1000 });
    s.entitlement.put("d.e.f", { plan: "free" }, 2000);
    expect(s.entitlement.get()).toEqual({ token: "d.e.f", claims: { plan: "free" }, receivedAt: 2000 });
    s.entitlement.clear();
    expect(s.entitlement.get()).toBeUndefined();
    expect(s.usage.add("2026-09", "llm_tokens_in", 10)).toBe(10);
    expect(s.usage.add("2026-09", "llm_tokens_in", 5.4)).toBe(15);
    expect(s.usage.get("2026-09")).toEqual({ llm_tokens_in: { used: 15 } });
    s.usage.setCap("2026-09", "llm_tokens_in", 1000, 2000000);
    s.usage.setCap("2026-09", "tts_chars", 0, 200000);
    expect(s.usage.get("2026-09")).toEqual({ llm_tokens_in: { used: 1000, cap: 2000000 }, tts_chars: { used: 0, cap: 200000 } });
    expect(s.usage.add("2026-09", "llm_tokens_in", 1)).toBe(1001);
    expect(s.usage.get("2026-10")).toEqual({});
    s.usage.clear();
    expect(s.usage.get("2026-09")).toEqual({});
    s.close();
  });
});
