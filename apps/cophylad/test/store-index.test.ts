// The recall index: chunks written with every message and session event, memory sections
// on request; full text from the first write, vectors once the embedder is up; filters
// through the owner rows; both legs fused deterministically; the backfill resumable.

import { describe, expect, test } from "bun:test";
import { Hit as HitSchema, RpcError } from "@cophyla/protocol";
import type { Hit, Memory, Message, Session, SessionEvent, Thread, Workspace } from "@cophyla/protocol";
import { silentLogger } from "../src/log.ts";
import { Store } from "../src/store/index.ts";
import { backfill, BACKFILL_META_KEY, reconcileMemory } from "../src/store/index/backfill.ts";
import { Chunks } from "../src/store/index/chunks.ts";
import { filterSql } from "../src/store/index/filters.ts";
import { ftsQuery, ftsTokens } from "../src/store/index/fts.ts";
import { clipSnippet, RECALL_MAX_LIMIT, SNIPPET_MAX_CHARS } from "../src/store/index/recall.ts";
import { splitSections } from "../src/store/index/sections.ts";
import { JsVectorIndex, quantise } from "../src/store/index/vectors.ts";
import { FakeEmbedder, fakeVector } from "./fakes/embedder.ts";

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NODE2 = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const WS_A = "ws_01ARZ3NDEKTSV4RRFFQ69G5FB0";
const WS_B = "ws_01ARZ3NDEKTSV4RRFFQ69G5FB1";
const THREAD = "thr_01ARZ3NDEKTSV4RRFFQ69G5FB3";
const THREAD2 = "thr_01ARZ3NDEKTSV4RRFFQ69G5FB4";
const SESSION = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1";
const SESSION2 = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB2";
const TASK = "task_01ARZ3NDEKTSV4RRFFQ69G5FB2";

const open = () => {
  const s = new Store(":memory:");
  s.migrate();
  return s;
};

let msgSeq = 0;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** A valid message id per call: the ULID's last two digits count up. */
const msgId = () => {
  const n = msgSeq++;
  return "msg_01ARZ3NDEKTSV4RRFFQ69G5F" + CROCKFORD[Math.floor(n / 32) % 32] + CROCKFORD[n % 32];
};

const workspace = (id: string, name: string, tags: string[] = []): Workspace => ({ id, node: NODE, path: `C:\\${name}`, name, origin: "user", tags, lastActivity: 1 });
const thread = (id: string, extra: Partial<Thread> = {}): Thread => ({ id, startedAt: 1, tags: [], sessions: [], ...extra });
const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  node: NODE,
  harness: "claude",
  profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8",
  native: { id: "x", transport: "pipe" },
  origin: "user",
  cwd: ".",
  tags: [],
  status: "idle",
  startedAt: 1,
  lastActivity: 1,
  ...extra,
});
const message = (threadId: string, text: string, at: number, role: Message["role"] = "user"): Message => ({
  id: msgId(),
  thread: threadId,
  at,
  role,
  source: role === "user" ? "ui" : "brain",
  content: [{ type: "text", text }],
});
const memory = (name: string, body: string, extra: Partial<Memory> = {}): Memory => ({ name, tags: [], body, updatedAt: 1, ...extra });

/** A store holding the same small world for the filter tests. */
function world() {
  const s = open();
  s.workspaces.upsert(workspace(WS_A, "alpha", ["frontend"]));
  s.workspaces.upsert(workspace(WS_B, "beta"));
  s.threads.insert(thread(THREAD, { workspace: WS_A, tags: ["gate"] }));
  s.threads.insert(thread(THREAD2, { workspace: WS_B }));
  s.sessions.insert(session(SESSION, { workspace: WS_B, node: NODE2, harness: "codex", task: TASK, tags: ["agent"] }));
  s.sessions.insert(session(SESSION2, { workspace: WS_A }));
  s.messages.insert(message(THREAD, "the deploy step runs after the gate tests pass", 100));
  s.messages.insert(message(THREAD2, "deploy notes for beta", 200));
  s.sessionEvents.append({ session: SESSION, at: 300, kind: "assistant_text", payload: { text: "I ran the deploy script" } });
  s.sessionEvents.append({ session: SESSION2, at: 400, kind: "user_turn", payload: { text: "deploy it" } });
  s.index.reindexMemory("deploy", memory("deploy", "# Deploy\nDeploy only after the tests pass.", { tags: ["decision"], updatedAt: 500 }));
  return s;
}

describe("store index: schema and chunks", () => {
  test("migration 5 adds the chunk tables, the FTS index and its triggers", () => {
    const s = open();
    expect(s.tables()).toContain("chunks");
    expect(s.tables()).toContain("chunk_vectors");
    const objects = (s.db.query("SELECT name, type FROM sqlite_master").all() as { name: string; type: string }[]).map((r) => `${r.type}:${r.name}`);
    expect(objects).toContain("table:chunks_fts");
    for (const t of ["chunks_ai", "chunks_ad", "chunks_au"]) expect(objects).toContain(`trigger:${t}`);
    for (const i of ["chunks_thread", "chunks_session_seq", "chunks_memory", "chunks_at"]) expect(objects).toContain(`index:${i}`);
    s.close();
  });

  test("a message is found by full text in the same call that stored it", async () => {
    const s = open();
    s.threads.insert(thread(THREAD));
    const m = message(THREAD, "the gate tests were flaky until the clock was mocked", 10);
    s.messages.insert(m);
    const hits = await s.index.recall({ query: "clock mocked" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.source).toEqual({ kind: "thread", thread: THREAD, message: m.id });
    expect(hits[0]!.corpus).toBe("thread");
    expect(hits[0]!.at).toBe(10);
    expect(HitSchema.safeParse(hits[0]).success).toBe(true);
    expect(await s.index.recall({ query: "something else entirely" })).toEqual([]);
    s.close();
  });

  test("session events: prose flags per kind, and a hit's source is the exact seq", async () => {
    const s = open();
    s.sessions.insert(session(SESSION));
    const kinds: [SessionEvent["kind"], unknown][] = [
      ["status", { status: "busy" }],
      ["user_turn", { text: "fix the gate tests" }],
      ["tool_call", { tool: "Read", args: { file_path: "gate.ts" } }],
      ["tool_result", { tool: "Read", result: "gate contents" }],
      ["assistant_text", { text: "The gate tests now pass." }],
      ["ask", { phase: "opened", tool: "Bash" }],
      ["notification", { type: "message", text: "gate done" }],
      ["ended", { reason: "exit" }],
    ];
    for (const [kind, payload] of kinds) s.sessionEvents.append({ session: SESSION, at: 1, kind, payload });
    const rows = s.db.query("SELECT kind, prose, seq FROM chunks ORDER BY seq").all() as { kind: string; prose: number; seq: number }[];
    expect(rows.map((r) => `${r.kind}:${r.prose}`)).toEqual(["status:0", "user_turn:1", "tool_call:0", "tool_result:0", "assistant_text:1", "ask:0", "notification:0", "ended:0"]);
    const hits = await s.index.recall({ query: "gate tests pass" });
    expect(hits[0]!.source).toEqual({ kind: "session", session: SESSION, seq: [4, 4] });
    // Tool calls are full-text searchable even though they carry no vector: the one event
    // holding both words comes first, the any-word pass fills in behind it.
    const tool = await s.index.recall({ query: "gate.ts" });
    expect((tool[0]!.source as { seq: [number, number] }).seq).toEqual([2, 2]);
    expect((await s.index.recall({ query: "gate.ts", limit: 1 })).map((h) => (h.source as { seq: [number, number] }).seq)).toEqual([[2, 2]]);
    s.close();
  });

  test("session history windows around a seq, half each side, at both edges", () => {
    const s = open();
    s.sessions.insert(session(SESSION));
    for (let i = 0; i < 10; i++) s.sessionEvents.append({ session: SESSION, at: i, kind: "status", payload: { i } });
    const seqs = (opts: { around: number; limit?: number }) => s.sessionEvents.history(SESSION, opts).map((e) => e.seq);
    expect(seqs({ around: 5, limit: 4 })).toEqual([4, 5, 6, 7]);
    expect(seqs({ around: 0, limit: 4 })).toEqual([0, 1, 2, 3]);
    expect(seqs({ around: 9, limit: 4 })).toEqual([8, 9]);
    expect(seqs({ around: 50, limit: 4 })).toEqual([8, 9]);
    expect(seqs({ around: 5, limit: 1 })).toEqual([5]);
    expect(seqs({ around: 5 })).toHaveLength(10);
    s.close();
  });

  test("memory sections carry 1-based body lines matching a memory.read quote", async () => {
    const s = open();
    const body = "intro line\n\n# One\nfirst section\n\n## Two\nsecond section\nmore";
    s.index.reindexMemory("notes", memory("notes", body, { tags: ["t"] }));
    const rows = s.db.query("SELECT line_from, line_to, text, tags, prose FROM chunks ORDER BY line_from").all() as { line_from: number; line_to: number; text: string; tags: string; prose: number }[];
    expect(rows.map((r) => [r.line_from, r.line_to])).toEqual([
      [1, 1],
      [3, 4],
      [6, 8],
    ]);
    expect(rows[1]!.text).toBe("# One\nfirst section");
    expect(rows.every((r) => r.prose === 1 && r.tags === '["t"]')).toBe(true);
    const hits = await s.index.recall({ query: "second section" });
    expect(hits[0]!.source).toEqual({ kind: "memory", name: "notes", lines: [6, 8] });
    expect(hits[0]!.corpus).toBe("memory");
    expect(hits[0]!.tags).toEqual(["t"]);
    expect(Object.keys(hits[0]!)).not.toContain("workspace");
    s.index.reindexMemory("notes", undefined);
    expect(await s.index.recall({ query: "second section" })).toEqual([]);
    s.close();
  });

  test("a message with no text has no chunk; an update re-indexes the text", async () => {
    const s = open();
    s.threads.insert(thread(THREAD));
    const m: Message = { id: msgId(), thread: THREAD, at: 1, role: "user", source: "ui", content: [] };
    s.messages.insert(m);
    expect(s.index.chunks.count()).toBe(0);
    m.content = [{ type: "text", text: "now with words" }];
    s.messages.update(m);
    expect((await s.index.recall({ query: "words" })).map((h) => h.at)).toEqual([1]);
    m.content = [{ type: "text", text: "changed entirely" }];
    s.messages.update(m);
    expect(await s.index.recall({ query: "words" })).toEqual([]);
    expect((await s.index.recall({ query: "changed" })).length).toBe(1);
    s.close();
  });
});

describe("store index: filters", () => {
  test("each filter narrows through the owner rows; memory ignores the ones that do not speak about it", async () => {
    const s = world();
    const name = (src: Hit["source"]) => (src.kind === "thread" ? src.thread : src.kind === "session" ? src.session : src.kind === "memory" ? src.name : src.path);
    const sources = async (params: Parameters<typeof s.index.recall>[0]) => (await s.index.recall(params)).map((h) => `${h.source.kind}:${name(h.source)}`);
    const all = await sources({ query: "deploy" });
    expect(all).toHaveLength(5);
    expect(await sources({ query: "deploy", in: ["memory"] })).toEqual(["memory:deploy"]);
    expect((await sources({ query: "deploy", workspace: WS_A })).sort()).toEqual([`memory:deploy`, `session:${SESSION2}`, `thread:${THREAD}`]);
    expect((await sources({ query: "deploy", node: NODE2 })).sort()).toEqual([`memory:deploy`, `session:${SESSION}`, `thread:${THREAD}`, `thread:${THREAD2}`]);
    expect((await sources({ query: "deploy", harness: "codex", in: ["session"] })).sort()).toEqual([`session:${SESSION}`]);
    expect((await sources({ query: "deploy", session: SESSION2, in: ["session"] })).sort()).toEqual([`session:${SESSION2}`]);
    expect((await sources({ query: "deploy", thread: THREAD2, in: ["thread"] })).sort()).toEqual([`thread:${THREAD2}`]);
    expect((await sources({ query: "deploy", task: TASK, in: ["session"] })).sort()).toEqual([`session:${SESSION}`]);
    expect((await sources({ query: "deploy", since: 250 })).sort()).toEqual([`memory:deploy`, `session:${SESSION}`, `session:${SESSION2}`]);
    expect((await sources({ query: "deploy", until: 250 })).sort()).toEqual([`thread:${THREAD}`, `thread:${THREAD2}`]);
    expect((await sources({ query: "deploy", since: 150, until: 350 })).sort()).toEqual([`session:${SESSION}`, `thread:${THREAD2}`]);
    // Tags: on the owner, on the memory file, or on the owner's workspace; every tag must match.
    expect((await sources({ query: "deploy", tags: ["gate"] })).sort()).toEqual([`thread:${THREAD}`]);
    expect((await sources({ query: "deploy", tags: ["decision"] })).sort()).toEqual([`memory:deploy`]);
    expect((await sources({ query: "deploy", tags: ["frontend"] })).sort()).toEqual([`session:${SESSION2}`, `thread:${THREAD}`]);
    expect((await sources({ query: "deploy", tags: ["frontend", "gate"] })).sort()).toEqual([`thread:${THREAD}`]);
    expect(await sources({ query: "deploy", tags: ["nope"] })).toEqual([]);
    // The hit carries the owner's workspace and tags.
    const hit = (await s.index.recall({ query: "deploy", in: ["session"], session: SESSION }))[0]!;
    expect(hit.workspace).toBe(WS_B);
    expect(hit.tags).toEqual(["agent"]);
    s.close();
  });

  test("a tag change on the owner is visible on the next query with no reindex", async () => {
    const s = world();
    expect(await s.index.recall({ query: "deploy", tags: ["urgent"] })).toEqual([]);
    const t = s.threads.get(THREAD2)!;
    t.tags = ["urgent"];
    s.threads.update(t);
    expect((await s.index.recall({ query: "deploy", tags: ["urgent"] })).map((h) => (h.source as { thread: string }).thread)).toEqual([THREAD2]);
    const w = s.workspaces.get(WS_B)!;
    w.tags = ["beta-tag"];
    s.workspaces.upsert(w);
    expect((await s.index.recall({ query: "deploy", tags: ["beta-tag"] })).length).toBe(2);
    s.close();
  });

  test("filterSql: no predicates for an empty filter, one per field otherwise", () => {
    expect(filterSql({}).where).toEqual([]);
    const f = filterSql({ in: ["thread", "memory"], workspace: WS_A, since: 1, until: 2, tags: ["a", "b"] });
    expect(f.where).toHaveLength(6);
    expect(f.params).toEqual({ in0: "thread", in1: "memory", workspace: WS_A, since: 1, until: 2, tag0: "a", tag1: "b" });
  });
});

describe("store index: queries", () => {
  test("the query is quoted tokens only: no input is a MATCH syntax error", async () => {
    expect(ftsTokens('a "quoted" AND (b) NEAR/2 c*')).toEqual(['"a"', '"quoted"', '"AND"', '"b"', '"NEAR"', '"2"', '"c"']);
    expect(ftsQuery("one")).toEqual({ and: '"one"' });
    expect(ftsQuery("one two")).toEqual({ and: '"one" "two"', or: '"one" OR "two"' });
    expect(ftsQuery("!!! ---")).toBeUndefined();
    const s = world();
    for (const q of ['"', "AND OR NOT", "( ) * ^ :", "deploy AND (", 'col:"x"', "—", "deploy*"]) {
      const hits = await s.index.recall({ query: q });
      expect(Array.isArray(hits)).toBe(true);
    }
    await expect(s.index.recall({ query: "   " })).rejects.toBeInstanceOf(RpcError);
    await expect(s.index.recall({ query: "\t\n" })).rejects.toMatchObject({ code: "invalid" });
    s.close();
  });

  test("every word first, then any word; the limit is clamped", async () => {
    const s = open();
    s.threads.insert(thread(THREAD));
    for (let i = 0; i < 60; i++) s.messages.insert(message(THREAD, i % 2 ? `alpha only number ${i}` : `alpha beta number ${i}`, i));
    const hits = await s.index.recall({ query: "alpha beta", limit: 500 });
    expect(hits).toHaveLength(RECALL_MAX_LIMIT);
    // The AND matches (both words) come first; with 30 of them, the OR pass fills the rest.
    expect(hits.slice(0, 30).every((h) => h.snippet.includes("beta"))).toBe(true);
    expect(hits.slice(30).every((h) => !h.snippet.includes("beta"))).toBe(true);
    expect((await s.index.recall({ query: "alpha" })).length).toBe(10);
    expect((await s.index.recall({ query: "alpha", limit: 3 })).length).toBe(3);
    s.close();
  });

  test("snippets are capped in code points and fifty CJK ones fit the audit cap", async () => {
    const long = "x".repeat(1000);
    expect(clipSnippet(long)).toHaveLength(SNIPPET_MAX_CHARS);
    expect(clipSnippet(long).endsWith("…")).toBe(true);
    expect(clipSnippet("a  b\n\nc")).toBe("a b c");
    const cjk = "漢字".repeat(300);
    expect(Array.from(clipSnippet(cjk))).toHaveLength(SNIPPET_MAX_CHARS);
    const s = open();
    s.threads.insert(thread(THREAD));
    // unicode61 keeps a run of CJK as one token, so the words are spaced.
    for (let i = 0; i < 60; i++) s.messages.insert(message(THREAD, `${"漢字 ".repeat(200)}marker${i} ${"表現 ".repeat(200)}`, i));
    expect(await s.index.recall({ query: "marker", limit: 50 })).toHaveLength(0);
    const shared = await s.index.recall({ query: "漢字", limit: 50 });
    expect(shared).toHaveLength(50);
    for (const h of shared) expect(Array.from(h.snippet).length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    expect(Buffer.byteLength(JSON.stringify({ hits: shared }), "utf8")).toBeLessThan(65536);
    const all = await s.index.recall({ query: Array.from({ length: 60 }, (_, i) => `marker${i}`).join(" "), limit: 50 });
    expect(all).toHaveLength(50);
    expect(Buffer.byteLength(JSON.stringify({ hits: all }), "utf8")).toBeLessThan(65536);
    s.close();
  });
});

describe("store index: vectors", () => {
  test("quantise round-trips within a byte, and the JS index ranks by cosine", () => {
    const v = fakeVector("gate tests pass");
    const { scale, q } = quantise(v);
    for (let i = 0; i < v.length; i++) expect(Math.abs(q[i]! * scale - v[i]!)).toBeLessThan(scale);
    const ix = new JsVectorIndex(v.length, 100);
    ix.put(1, fakeVector("gate tests pass"));
    ix.put(2, fakeVector("deploy the release"));
    ix.put(3, fakeVector("gate tests fail"));
    expect(ix.size).toBe(3);
    const hits = ix.search(fakeVector("gate tests"), 2);
    expect(hits.map((h) => h.id).sort()).toEqual([1, 3]);
    expect(hits[0]!.score).toBeGreaterThan(0.5);
    expect(ix.search(fakeVector("gate tests"), 2, new Set([2])).map((h) => h.id)).toEqual([2]);
    ix.remove(1);
    expect(ix.has(1)).toBe(false);
    expect(ix.size).toBe(2);
    expect(ix.search(fakeVector("gate tests pass"), 1)[0]!.id).toBe(3);
    ix.put(3, fakeVector("something else"));
    expect(ix.size).toBe(2);
    expect(ix.search(fakeVector("something else"), 1)[0]).toEqual({ id: 3, score: expect.closeTo(1, 2) });
  });

  test("at maxRows the oldest chunk ids are evicted; load takes the newest rows of the model", () => {
    const ix = new JsVectorIndex(4, 10);
    for (let i = 1; i <= 12; i++) ix.put(i, new Float32Array([i, 1, 0, 0]));
    expect(ix.size).toBeLessThanOrEqual(10);
    expect(ix.has(1)).toBe(false);
    expect(ix.has(12)).toBe(true);
    const s = open();
    s.threads.insert(thread(THREAD));
    for (let i = 0; i < 5; i++) s.messages.insert(message(THREAD, `m${i}`, i));
    const ids = (s.db.query("SELECT id FROM chunks ORDER BY id").all() as { id: number }[]).map((r) => r.id);
    for (const id of ids) {
      const { scale, q } = quantise(new Float32Array([id, 0, 0, 0]));
      s.db.query("INSERT INTO chunk_vectors (chunk, model, dim, scale, q) VALUES ($chunk, $model, 4, $scale, $q)").run({ chunk: id, model: id === ids[0] ? "other" : "m", scale, q: new Uint8Array(q.buffer) });
    }
    const loaded = new JsVectorIndex(4, 3);
    expect(loaded.load(s.db, "m")).toBe(3);
    expect(loaded.has(ids[4]!)).toBe(true);
    expect(loaded.has(ids[1]!)).toBe(false);
    s.close();
  });

  test("with an embedder, both legs fuse by reciprocal rank, deterministically, and a write is searchable within a second", async () => {
    const s = open();
    const embedder = new FakeEmbedder();
    s.threads.insert(thread(THREAD));
    // "gate tests" appears verbatim in one message; another shares only the vector's words.
    const both = message(THREAD, "the gate tests pass on the clock", 1);
    const vecOnly = message(THREAD, "clock gate", 2);
    const ftsOnly = message(THREAD, "tests of another kind pass", 3);
    for (const m of [both, vecOnly, ftsOnly]) s.messages.insert(m);
    await s.index.start({ embedder, log: silentLogger, config: { embed_batch: 2 } });
    await s.index.settled();
    expect(s.index.vectorCount).toBe(3);
    expect(s.db.query("SELECT COUNT(*) AS n FROM chunk_vectors").get()).toEqual({ n: 3 });
    const a = await s.index.recall({ query: "gate tests pass on the clock" });
    const b = await s.index.recall({ query: "gate tests pass on the clock" });
    expect(a).toEqual(b);
    expect(a[0]!.source).toEqual({ kind: "thread", thread: THREAD, message: both.id });
    expect(a[0]!.score).toBe(1);
    expect(a.every((h) => h.score > 0 && h.score <= 1)).toBe(true);
    const ids = a.map((h) => (h.source as { message: string }).message);
    expect(ids).toContain(vecOnly.id);
    expect(ids).toContain(ftsOnly.id);
    // A new message: chunk at once, vector after the queue runs.
    const late = message(THREAD, "clock gate again", 4);
    const t0 = Date.now();
    s.messages.insert(late);
    await s.index.settled();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(s.index.vectorCount).toBe(4);
    const c = await s.index.recall({ query: "clock gate", in: ["thread"] });
    expect(c.map((h) => (h.source as { message: string }).message)).toContain(late.id);
    // A filter that narrows masks the scan: only the eligible chunk comes back from the vector leg.
    const narrowed = await s.index.recall({ query: "clock gate", since: 4 });
    expect(narrowed.map((h) => (h.source as { message: string }).message)).toEqual([late.id]);
    await s.index.stop();
    expect(embedder.closed).toBe(true);
    s.close();
  });

  test("a workspace node's sessions: out of the machine's recall on both legs, its own alone for it; a hosted embedder never gets them", async () => {
    const GUEST = "node_01ARZ3NDEKTSV4RRFFQ69G5FC0";
    for (const hosted of [false, true]) {
      const s = open();
      s.privateNodes = () => [GUEST];
      const embedder = Object.assign(new FakeEmbedder(), hosted ? { hosted: true } : {});
      s.threads.insert(thread(THREAD));
      s.sessions.insert(session(SESSION, { node: GUEST }));
      s.sessions.insert(session(SESSION2, { node: NODE }));
      s.messages.insert(message(THREAD, "zebra crossing notes of the machine", 1));
      s.sessionEvents.append({ session: SESSION, at: 2, kind: "assistant_text", payload: { text: "zebra crossing secret of the guest" } });
      s.sessionEvents.append({ session: SESSION2, at: 3, kind: "assistant_text", payload: { text: "zebra crossing work of the machine" } });
      await s.index.start({ embedder, log: silentLogger });
      await s.index.settled();
      // the vector leg has what it may: everything with a local model, the machine's alone with a hosted one
      expect(s.index.vectorCount).toBe(hosted ? 2 : 3);
      expect(embedder.texts.some((t) => t.includes("guest"))).toBe(!hosted);
      const machine = await s.index.recall({ query: "zebra crossing" });
      expect(machine.length).toBe(2);
      expect(machine.some((h) => h.snippet.includes("guest"))).toBe(false);
      // a vector-only query, with nothing to match on full text, finds nothing of the guest either
      const vec = await s.index.recall({ query: "secret guest" });
      expect(vec.some((h) => h.source.kind === "session" && h.source.session === SESSION)).toBe(false);
      const calls = embedder.calls;
      const theirs = await s.index.recall({ query: "zebra crossing" }, { only: GUEST });
      expect(theirs.map((h) => h.source)).toEqual([{ kind: "session", session: SESSION, seq: [0, 0] }]);
      // its query goes to no hosted embedder
      expect(embedder.calls).toBe(hosted ? calls : calls + 1);
      await s.index.stop();
      s.close();
    }
  });

  test("messages.update drops the stale vector until the queue re-embeds it", async () => {
    const s = open();
    const embedder = new FakeEmbedder();
    s.threads.insert(thread(THREAD));
    const m = message(THREAD, "first text", 1);
    s.messages.insert(m);
    await s.index.start({ embedder, log: silentLogger });
    await s.index.settled();
    expect(s.db.query("SELECT COUNT(*) AS n FROM chunk_vectors").get()).toEqual({ n: 1 });
    const calls = embedder.calls;
    m.content = [{ type: "text", text: "second text" }];
    embedder.delayMs = 30;
    s.messages.update(m);
    // Right after the write: the old vector is gone from disk and from memory.
    expect(s.db.query("SELECT COUNT(*) AS n FROM chunk_vectors").get()).toEqual({ n: 0 });
    expect(s.index.vectorCount).toBe(0);
    await s.index.settled();
    expect(embedder.calls).toBe(calls + 1);
    expect(embedder.texts.at(-1)).toBe("second text");
    expect(s.index.vectorCount).toBe(1);
    // An unchanged update touches nothing.
    s.messages.update(m);
    await s.index.settled();
    expect(embedder.calls).toBe(calls + 1);
    await s.index.stop();
    s.close();
  });

  test("a memory re-split keeps the vectors of sections whose text is unchanged", async () => {
    const s = open();
    const embedder = new FakeEmbedder();
    s.index.reindexMemory("notes", memory("notes", "# A\nalpha body\n\n# B\nbeta body"));
    await s.index.start({ embedder, log: silentLogger });
    await s.index.settled();
    const before = s.db.query("SELECT chunk, text FROM chunk_vectors v JOIN chunks c ON c.id = v.chunk ORDER BY chunk").all() as { chunk: number; text: string }[];
    expect(before).toHaveLength(2);
    // A new section above moves B down and changes A; B's row and vector survive.
    s.index.reindexMemory("notes", memory("notes", "# Zero\nnew one\n\n# A\nalpha body changed\n\n# B\nbeta body", { updatedAt: 2 }));
    const kept = s.db.query("SELECT chunk FROM chunk_vectors ORDER BY chunk").all() as { chunk: number }[];
    expect(kept).toEqual([{ chunk: before[1]!.chunk }]);
    const b = s.db.query("SELECT line_from, line_to, at FROM chunks WHERE id = $id").get({ id: before[1]!.chunk }) as { line_from: number; line_to: number; at: number };
    expect([b.line_from, b.line_to, b.at]).toEqual([7, 8, 2]);
    await s.index.settled();
    expect(s.db.query("SELECT COUNT(*) AS n FROM chunk_vectors").get()).toEqual({ n: 3 });
    expect(embedder.texts.filter((t) => t === "# B\nbeta body")).toHaveLength(1);
    await s.index.stop();
    s.close();
  });
});

describe("store index: backfill and reconcile", () => {
  /** Rows written straight to the tables, as a pre-index database holds them. */
  function raw(s: Store, n: number) {
    s.threads.insert(thread(THREAD));
    s.sessions.insert(session(SESSION));
    for (let i = 0; i < n; i++) {
      s.db.query("INSERT INTO messages (id, thread, at, role, source, content, streaming) VALUES ($id, $thread, $at, 'user', 'ui', $content, 0)").run({ id: msgId(), thread: THREAD, at: i, content: JSON.stringify([{ type: "text", text: `old message ${i}` }]) });
      s.db.query("INSERT INTO session_events (session, seq, at, kind, payload) VALUES ($session, $seq, $at, 'assistant_text', $payload)").run({ session: SESSION, seq: i, at: i, payload: JSON.stringify({ text: `old event ${i}` }) });
    }
  }

  test("sweeps messages then events in batches, skips what is indexed, and is idempotent", async () => {
    const s = open();
    raw(s, 7);
    s.messages.insert(message(THREAD, "already indexed", 99));
    expect(s.index.chunks.count()).toBe(1);
    const chunks = new Chunks(s.db);
    expect(await backfill({ db: s.db, chunks, log: silentLogger, batch: 3, stopped: () => false })).toBe(true);
    expect(s.index.chunks.count()).toBe(15);
    expect(s.meta.get(BACKFILL_META_KEY)).toBe("done");
    expect((await s.index.recall({ query: "old event 3" }))[0]!.source).toEqual({ kind: "session", session: SESSION, seq: [3, 3] });
    // Again: nothing to do, nothing duplicated.
    expect(await backfill({ db: s.db, chunks, log: silentLogger, batch: 3, stopped: () => false })).toBe(true);
    expect(s.index.chunks.count()).toBe(15);
    s.close();
  });

  test("an aborted sweep leaves no mark and resumes where it stopped", async () => {
    const s = open();
    raw(s, 5);
    let calls = 0;
    const chunks = new Chunks(s.db);
    expect(await backfill({ db: s.db, chunks, log: silentLogger, batch: 2, stopped: () => ++calls > 2 })).toBe(false);
    expect(s.meta.get(BACKFILL_META_KEY)).toBeUndefined();
    const partial = s.index.chunks.count();
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(10);
    expect(await backfill({ db: s.db, chunks, log: silentLogger, batch: 2, stopped: () => false })).toBe(true);
    expect(s.index.chunks.count()).toBe(10);
    s.close();
  });

  test("start runs the sweep, then the embedder, and stop is clean", async () => {
    const s = open();
    raw(s, 4);
    const embedder = new FakeEmbedder();
    await s.index.start({ embedder, log: silentLogger, config: { embed_batch: 3 } });
    await s.index.settled();
    expect(s.index.chunks.count()).toBe(8);
    expect(s.index.vectorCount).toBe(8);
    expect(s.index.model).toBe(embedder.model);
    await s.index.stop();
    expect(s.index.model).toBeUndefined();
    s.close();
  });

  test("memory is reconciled by mtime at start: changed files re-split, missing ones dropped", () => {
    const s = open();
    const chunks = s.index.chunks;
    const a = memory("a", "# A\nalpha", { updatedAt: 10 });
    const b = memory("b", "# B\nbeta", { updatedAt: 20 });
    expect(reconcileMemory(chunks, [a, b])).toEqual({ updated: 2, removed: 0 });
    expect(reconcileMemory(chunks, [a, b])).toEqual({ updated: 0, removed: 0 });
    expect(reconcileMemory(chunks, [{ ...a, body: "# A\nalpha two", updatedAt: 11 }])).toEqual({ updated: 1, removed: 1 });
    expect(chunks.memoryNames()).toEqual(["a"]);
    expect((s.db.query("SELECT text FROM chunks").get() as { text: string }).text).toBe("# A\nalpha two");
    s.close();
  });
});

describe("store index: sections", () => {
  test("splits at headings, keeps the preamble, numbers body lines from 1, and cuts long sections at blank lines", () => {
    expect(splitSections("")).toEqual([]);
    expect(splitSections("\n\n")).toEqual([]);
    expect(splitSections("just text")).toEqual([{ from: 1, to: 1, text: "just text" }]);
    expect(splitSections("# H\nbody\n")).toEqual([{ from: 1, to: 2, text: "# H\nbody" }]);
    expect(splitSections("pre\r\n# One\r\na\r\n\r\n## Two\r\nb")).toEqual([
      { from: 1, to: 1, text: "pre" },
      { from: 2, to: 3, text: "# One\na" },
      { from: 5, to: 6, text: "## Two\nb" },
    ]);
    const para = "word ".repeat(100).trim();
    const long = ["# Big", para, "", para, "", para, "", para, "", para, "", para].join("\n");
    const parts = splitSections(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]!.text.startsWith("# Big\n")).toBe(true);
    expect(parts.every((p) => p.text.length <= 2048)).toBe(true);
    expect(parts.map((p) => p.from)).toEqual(parts.map((_, i, arr) => (i === 0 ? 1 : arr[i - 1]!.to + 2)));
    // A single overlong line cannot be cut and stays whole.
    expect(splitSections("x".repeat(5000))).toHaveLength(1);
  });
});
