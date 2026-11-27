// The background worker and what moved onto it: a worker connection reads what the daemon's
// connection commits and cannot write, runs passive checkpoints, answers reads ahead of bulk
// work, and a worker that broke is made again for the next call. The store's new tables:
// clears kept as they are recorded and read in from older events once, the embed queue kept
// as chunks are written and emptied as they go, the audit kept to its retention in batches,
// stored minutes folded and their spend read apart. The daemon's log writer: buffered, in
// order, rotated by size.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MetricsSample } from "@cophyla/protocol";
import { InlineBackground, WorkerBackground } from "../src/background/client.ts";
import type { CompactedMinute } from "../src/background/jobs.ts";
import { Maintenance } from "../src/background/maintenance.ts";
import { Bus } from "../src/bus.ts";
import { fileSink, rotatedName, silentLogger } from "../src/log.ts";
import { foldForRollup } from "../src/metrics/owners.ts";
import type { SampleProcess } from "../src/metrics/owners.ts";
import { fillClears } from "../src/store/clears.ts";
import { Store } from "../src/store/index.ts";

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tempStore(): { store: Store; path: string; done(): void } {
  const dir = mkdtempSync(join(tmpdir(), "cophyla-test-bg-"));
  const path = join(dir, "s.sqlite");
  const store = new Store(path);
  store.migrate();
  return { store, path, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function session(store: Store, id: string): void {
  store.sessions.insert({
    id,
    node: NODE,
    harness: "claude",
    profile: "",
    native: { id: `native-${id}`, transport: "hooks" },
    origin: "user",
    cwd: "C:\\w",
    tags: [],
    status: "idle",
    startedAt: 1,
    lastActivity: 1,
  } as never);
}

/** The scheduler's context, for a fill driven by hand. */
const by = (bg: InlineBackground | WorkerBackground) => ({ read: bg.call.bind(bg), yield: async () => {}, stopping: false }) as never;

describe("the background worker", () => {
  test("it reads what the daemon commits, cannot write, checkpoints, and closes first", async () => {
    const t = tempStore();
    const bg = new WorkerBackground({ path: t.path, cacheKib: 1024, log: silentLogger });
    try {
      session(t.store, "sess_a");
      for (let i = 0; i < 50; i++) t.store.sessionEvents.append({ session: "sess_a", at: i, kind: "user_turn", payload: { text: `hello ${i}` } });
      expect(await bg.call<number>("rowid.max", { table: "session_events" })).toBe(50);
      const cp = await bg.call<{ busy: number; log: number; checkpointed: number }>("checkpoint");
      expect(cp.busy).toBe(0);
      expect(cp.checkpointed).toBe(cp.log);
      // (expect().rejects on a promise a worker message settles holds the test runner: caught by hand)
      const missing = await bg.call("no.such.job").then(() => "", (e: Error) => e.message);
      expect(missing).toBe("no job no.such.job");
    } finally {
      await bg.stop();
      t.store.close();
      t.done();
    }
  });

  test("a worker that broke fails what it held, and the next call has a fresh one", async () => {
    const t = tempStore();
    let made = 0;
    const real = () => new Worker(new URL("../src/background/worker.ts", import.meta.url).href);
    const fake = () => {
      const w = {
        onmessage: null as ((ev: MessageEvent) => void) | null,
        onerror: null as ((ev: ErrorEvent) => void) | null,
        postMessage(m: { kind: string }) {
          if (m.kind === "init") setTimeout(() => w.onmessage?.({ data: { kind: "ready" } } as MessageEvent), 1);
          else if (m.kind === "call") setTimeout(() => w.onerror?.({ message: "the worker fell over" } as ErrorEvent), 1);
        },
        terminate() {},
      };
      return w as unknown as Worker;
    };
    const bg = new WorkerBackground({ path: t.path, cacheKib: 1024, log: silentLogger, makeWorker: () => (made++ === 0 ? fake() : real()) });
    try {
      const failed = await bg.call("rowid.max", { table: "chunks" }).then(() => "", (e: Error) => e.message);
      expect(failed).toBe("the worker fell over");
      expect(await bg.call<number>("rowid.max", { table: "chunks" })).toBe(0);
      expect(made).toBe(2);
    } finally {
      await bg.stop();
      t.store.close();
      t.done();
    }
  });
});

describe("the clears", () => {
  test("a clear is kept as it is recorded; the later of two wins; older events are read in once", async () => {
    const t = tempStore();
    const bg = new WorkerBackground({ path: t.path, cacheKib: 1024, log: silentLogger });
    try {
      session(t.store, "sess_a");
      session(t.store, "sess_b");
      t.store.sessionEvents.append({ session: "sess_a", at: 10, kind: "notification", payload: { type: "context_cleared", from: "conv-1", to: "conv-2" } });
      expect(t.store.spend.clearedSession("conv-1")).toBe("sess_a");
      // one recorded before the table existed: in the events only
      t.store.db.exec("DELETE FROM session_clears");
      t.store.sessionEvents.append({ session: "sess_b", at: 20, kind: "notification", payload: { type: "context_cleared", from: "conv-9", to: "conv-10" } });
      t.store.db.exec("DELETE FROM session_clears");
      t.store.sessionEvents.append({ session: "sess_b", at: 5, kind: "notification", payload: { type: "something_else" } });
      t.store.meta.set("store.session_clears.v1", "filling");
      expect(t.store.spend.clearsFilled()).toBe(false);
      expect(await fillClears(t.store, by(bg))).toBe(true);
      expect(t.store.spend.clearedSession("conv-1")).toBe("sess_a");
      expect(t.store.spend.clearedSession("conv-9")).toBe("sess_b");
      expect(t.store.spend.clearsFilled()).toBe(true);
      // an older clear of a conversation read in late does not replace a newer one
      t.store.spend.putClear("conv-1", "sess_b", 1);
      expect(t.store.spend.clearedSession("conv-1")).toBe("sess_a");
    } finally {
      await bg.stop();
      t.store.close();
      t.done();
    }
  });

  test("a store with no events has none to read in", () => {
    const s = new Store(":memory:");
    s.migrate();
    expect(s.spend.clearsFilled()).toBe(true);
    s.close();
  });
});

describe("the embed queue's table", () => {
  test("a prose chunk is queued as it is written, again when its text changes, and goes with its chunk", () => {
    const s = new Store(":memory:");
    s.migrate();
    session(s, "sess_a");
    const queued = () => (s.db.query("SELECT chunk FROM embed_queue ORDER BY chunk").all() as { chunk: number }[]).map((r) => r.chunk);
    s.sessionEvents.append({ session: "sess_a", at: 1, kind: "user_turn", payload: { text: "a question" } });
    s.sessionEvents.append({ session: "sess_a", at: 2, kind: "tool_call", payload: { name: "Bash", input: { command: "ls" } } });
    expect(queued()).toHaveLength(1);
    // embedded: off the queue
    const [id] = queued();
    s.db.exec(`DELETE FROM embed_queue WHERE chunk = ${id}`);
    expect(queued()).toEqual([]);
    s.index.chunks.deleteSession("sess_a");
    expect(queued()).toEqual([]);
    s.sessionEvents.append({ session: "sess_a", at: 3, kind: "user_turn", payload: { text: "another" } });
    expect(queued()).toHaveLength(1);
    s.index.chunks.deleteSession("sess_a");
    // the cascade takes it with its chunk
    expect(queued()).toEqual([]);
    s.close();
  });
});

describe("the audit's retention", () => {
  test("the oldest rows go a batch at a time, the recent ones stay", async () => {
    const s = new Store(":memory:");
    s.migrate();
    const now = 400 * 86_400_000;
    for (let i = 0; i < 25; i++) s.audit.insert({ id: `aud_${i}`, node: NODE, at: (i < 20 ? 100 : 390) * 86_400_000 + i, principal: { kind: "brain" }, action: "x", args: null, decision: "allow" } as never);
    expect(s.audit.prune(now - 90 * 86_400_000, 7)).toBe(7);
    const m = new Maintenance({ store: s, background: new InlineBackground(s.db), bus: new Bus(), nodeId: NODE, log: silentLogger, auditRetentionDays: 90, now: () => now });
    await (m as unknown as { auditRetention(ctx: unknown): Promise<void> }).auditRetention({ yield: async () => {}, stopping: false });
    expect(s.audit.count()).toBe(5);
    await m.stop();
    s.close();
  });
});

describe("stored minutes", () => {
  const p = (pid: number, parent: number, owner: SampleProcess["owner"], cpu: number, memory: number): SampleProcess => ({ pid, parent, name: `p${pid}`, cpu, memory, owner });

  test("a session's or a sidecar's tree is one row; Cophyla's own stay; the busiest others by cpu and by memory", () => {
    const rows: SampleProcess[] = [
      p(1, 0, { kind: "platform" }, 1, 100),
      p(2, 1, { kind: "brain" }, 2, 100),
      p(10, 1, { kind: "session", session: "sess_a" }, 5, 1000),
      p(11, 10, { kind: "session", session: "sess_a" }, 3, 500),
      p(12, 11, { kind: "session", session: "sess_a" }, 1.5, 250),
      p(20, 1, { kind: "sidecar", name: "tether" }, 1, 10),
      p(21, 20, { kind: "sidecar", name: "tether" }, 1, 20),
      ...Array.from({ length: 30 }, (_, i) => p(100 + i, 4, { kind: "other" }, i, (30 - i) * 10)),
    ];
    const out = foldForRollup(rows, 3);
    const session = out.find((r) => r.owner.kind === "session")!;
    expect(session).toMatchObject({ pid: 10, cpu: 9.5, memory: 1750 });
    expect(out.filter((r) => r.owner.kind === "sidecar")).toEqual([{ pid: 20, parent: 1, name: "p20", cpu: 2, memory: 30, owner: { kind: "sidecar", name: "tether" } }]);
    expect(out.filter((r) => r.owner.kind === "platform" || r.owner.kind === "brain").map((r) => r.pid)).toEqual([1, 2]);
    // the three busiest by cpu (129, 128, 127) and by memory (100, 101, 102)
    expect(out.filter((r) => r.owner.kind === "other").map((r) => r.pid).sort((a, b) => a - b)).toEqual([100, 101, 102, 127, 128, 129]);
  });

  test("the minutes stored before the fold are folded, newest first, and their spend kept apart", async () => {
    const s = new Store(":memory:");
    s.migrate();
    const big = (minute: number): MetricsSample => ({
      node: NODE,
      at: minute,
      cpu: 1,
      memory: { used: 1, total: 2 },
      processes: [p(10, 1, { kind: "session", session: "sess_a" }, 1, 1), p(11, 10, { kind: "session", session: "sess_a" }, 1, 1)],
      llm: {},
      profiles: { prof_01ARZ3NDEKTSV4RRFFQ69G5FB8: { in: 1, out: 2, cached: 0 } },
    });
    // written as the old rollup did: the whole tree, the spend only inside the sample
    for (let m = 1; m <= 5; m++) s.db.query("INSERT INTO metrics (node, minute, sample) VALUES ($node, $minute, $sample)").run({ node: NODE, minute: m * 60_000, sample: JSON.stringify(big(m * 60_000)) });
    expect(s.metrics.profiles(NODE)).toEqual([]);
    const rows = await new InlineBackground(s.db).call<CompactedMinute[]>("metrics.compact", { node: NODE, before: Number.MAX_SAFE_INTEGER, limit: 2 });
    expect(rows.map((r) => r.minute)).toEqual([300_000, 240_000]);
    const m = new Maintenance({ store: s, background: new InlineBackground(s.db), bus: new Bus(), nodeId: NODE, log: silentLogger, auditRetentionDays: 90 });
    await (m as unknown as { compactMetrics(ctx: unknown): Promise<void> }).compactMetrics({ read: (job: string, args: unknown) => new InlineBackground(s.db).call(job, args), yield: async () => {}, stopping: false });
    expect(s.metrics.range(NODE).every((r) => r.processes.length === 1)).toBe(true);
    expect(s.metrics.profiles(NODE).map((r) => r.minute)).toEqual([60_000, 120_000, 180_000, 240_000, 300_000]);
    expect(s.meta.get("metrics.compact.v1")).toBe("done");
    await m.stop();
    s.close();
  });
});

describe("the log writer", () => {
  test("lines are written in order, a tenth of a second at a time, and the file rotates by size", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cophyla-test-log-"));
    const path = join(dir, "cophylad.log");
    try {
      writeFileSync(path, "x".repeat(995) + "\n");
      const sink = fileSink(path, { rotateBytes: 1000, keep: 3 });
      sink("one");
      sink("two");
      // buffered: nothing yet
      expect(readFileSync(path, "utf8")).not.toContain("one");
      await sleep(250);
      // past the size: the old file moved on, the new lines start a fresh one
      expect(readFileSync(path, "utf8")).toBe("one\ntwo\n");
      expect(readFileSync(rotatedName(path, 1), "utf8")).toStartWith("xxx");
      for (let i = 0; i < 3; i++) {
        sink("y".repeat(990));
        await sink.flush();
      }
      expect(existsSync(rotatedName(path, 2))).toBe(true);
      expect(existsSync(rotatedName(path, 3))).toBe(false);
      sink("last");
      sink.flushSync();
      expect(readFileSync(path, "utf8")).toEndWith("last\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
