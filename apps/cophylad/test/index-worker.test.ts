// The recall index on its worker: recall answered there on full text from its own connection,
// as the daemon's thread would answer it; with the shipped model (when this checkout has it),
// chunks embedded there, their vectors written here, and the vector leg answered there.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLogger, silentLogger } from "../src/log.ts";
import { Store } from "../src/store/index.ts";

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
/** The shipped model, where a checkout has it (the main checkout does; a fresh worktree may not). */
const MODEL = [resolve(import.meta.dir, "..", "models", "bge-small-en-v1.5"), "C:/D/orchestrator/apps/cophylad/models/bge-small-en-v1.5"].find((d) => existsSync(join(d, "manifest.json")));

function temp(): { store: Store; path: string; done(): void } {
  const dir = mkdtempSync(join(tmpdir(), "cophyla-test-index-"));
  const path = join(dir, "s.sqlite");
  const store = new Store(path);
  store.migrate();
  return { store, path, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function messages(store: Store): void {
  store.threads.insert({ id: "thr_01ARZ3NDEKTSV4RRFFQ69G5FB0", startedAt: 1, tags: [], sessions: [] });
  const say = (id: string, text: string, at: number) =>
    store.messages.insert({ id, thread: "thr_01ARZ3NDEKTSV4RRFFQ69G5FB0", at, role: "user", source: "chat", content: [{ type: "text", text }] } as never);
  say("msg_01ARZ3NDEKTSV4RRFFQ69G5FB1", "the deploy to staging failed on the migration", 10);
  say("msg_01ARZ3NDEKTSV4RRFFQ69G5FB2", "lunch was a sandwich", 20);
  say("msg_01ARZ3NDEKTSV4RRFFQ69G5FB3", "rolled the staging database back", 30);
}

describe("the index worker", () => {
  test("recall there answers as here, on full text", async () => {
    const t = temp();
    try {
      messages(t.store);
      const here = await t.store.index.recall({ query: "staging" });
      void t.store.index.start({ log: silentLogger, worker: { path: t.path, cacheKib: 1024 } });
      await t.store.index.settled();
      const there = await t.store.index.recall({ query: "staging" });
      expect(there.map((h) => h.source)).toEqual(here.map((h) => h.source));
      expect(there.length).toBe(2);
    } finally {
      await t.store.index.stop();
      t.store.close();
      t.done();
    }
  });

  test.skipIf(!MODEL)("with the model: embedded there, written here, the vector leg answered there", async () => {
    const t = temp();
    const lines: string[] = [];
    try {
      messages(t.store);
      void t.store.index.start({ log: createLogger("info", (l) => lines.push(l)), worker: { path: t.path, modelDir: MODEL!, cacheKib: 1024 } });
      await t.store.index.settled();
      expect(t.store.index.model).toStartWith("bge-small-en-v1.5@");
      const vectors = (t.store.db.query("SELECT COUNT(*) AS n FROM chunk_vectors /* scan-ok: the test's */").get() as { n: number }).n;
      expect(vectors).toBe(3);
      expect((t.store.db.query("SELECT COUNT(*) AS n FROM embed_queue /* scan-ok: the test's */").get() as { n: number }).n).toBe(0);
      // a word the full text has nowhere: only the vectors find the rollback
      const hits = await t.store.index.recall({ query: "database restore", limit: 1 });
      expect(hits[0]?.source).toEqual({ kind: "thread", thread: "thr_01ARZ3NDEKTSV4RRFFQ69G5FB0", message: "msg_01ARZ3NDEKTSV4RRFFQ69G5FB3" });
      void NODE;
    } finally {
      await t.store.index.stop();
      t.store.close();
      t.done();
    }
  }, 60_000);
});
