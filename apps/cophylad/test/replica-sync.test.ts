// A backup's sync with writes still coming: what arrives while the snapshot is fetched is kept
// and applied after it, past its sequence, so the backup is in step at once rather than
// finding a gap and asking for another snapshot; too much of it does ask for one. The
// primary's snapshot goes out as JSON text read in one go.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReplicaSnapshot, ReplicaWrite, Thread } from "@cophyla/protocol";
import { InlineBackground } from "../src/background/client.ts";
import { silentLogger } from "../src/log.ts";
import { Replica, Replicator } from "../src/nodes/replication.ts";
import { Store } from "../src/store/index.ts";

const thread = (id: string, at: number): Thread => ({ id, startedAt: at, tags: [], sessions: [] });

function paths(home: string) {
  return { home, tools: join(home, "tools"), hooks: join(home, "hooks"), prompts: join(home, "prompts"), memory: join(home, "memory"), views: join(home, "views") };
}

describe("a backup's sync", () => {
  test("writes that come while the snapshot is fetched are applied after it, past its sequence", async () => {
    const home = mkdtempSync(join(tmpdir(), "cophyla-test-replica-"));
    const store = new Store(":memory:");
    store.migrate();
    let release!: (s: ReplicaSnapshot) => void;
    let fetched = 0;
    const replica = new Replica({
      store,
      paths: paths(home) as never,
      selfNode: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      rescan: async () => {},
      fetchSnapshot: () => {
        fetched++;
        return new Promise<ReplicaSnapshot>((resolve) => (release = resolve));
      },
      log: silentLogger,
    });
    try {
      const syncing = replica.sync();
      const w = (seq: number, t: Thread): ReplicaWrite => ({ epoch: 1, seq, table: "threads", op: "upsert", row: t });
      // seq 5 is in the snapshot already; 6 and 7 came after it was read
      replica.onWrite(w(5, thread("thr_01ARZ3NDEKTSV4RRFFQ69G5FB5", 5)));
      replica.onWrite(w(6, thread("thr_01ARZ3NDEKTSV4RRFFQ69G5FB6", 6)));
      replica.onWrite(w(7, thread("thr_01ARZ3NDEKTSV4RRFFQ69G5FB7", 7)));
      release({ epoch: 1, seq: 5, tables: { threads: [thread("thr_01ARZ3NDEKTSV4RRFFQ69G5FB5", 5)], messages: [], tasks: [], workspaces: [], kv: [] }, files: [] });
      await syncing;
      expect(replica.position).toEqual({ epoch: 1, seq: 7 });
      expect(store.threads.dump().map((t) => t.id)).toEqual(["thr_01ARZ3NDEKTSV4RRFFQ69G5FB5", "thr_01ARZ3NDEKTSV4RRFFQ69G5FB6", "thr_01ARZ3NDEKTSV4RRFFQ69G5FB7"]);
      expect(fetched).toBe(1);
      // the next write follows on: no gap, no snapshot
      replica.onWrite(w(8, thread("thr_01ARZ3NDEKTSV4RRFFQ69G5FB8", 8)));
      expect(replica.position.seq).toBe(8);
      expect(fetched).toBe(1);
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the primary's snapshot is the JSON of its tables, at the sequence of the request", async () => {
    const home = mkdtempSync(join(tmpdir(), "cophyla-test-replica-"));
    const store = new Store(":memory:");
    store.migrate();
    try {
      const replicator = new Replicator({ store, paths: paths(home) as never, epoch: () => 3, log: silentLogger, background: new InlineBackground(store.db) });
      replicator.start();
      store.threads.insert(thread("thr_01ARZ3NDEKTSV4RRFFQ69G5FB1", 1));
      const raw = await replicator.snapshotJson();
      const parsed = JSON.parse(raw.json) as ReplicaSnapshot;
      expect(parsed.epoch).toBe(3);
      expect(parsed.tables.threads.map((t) => (t as Thread).id)).toEqual(["thr_01ARZ3NDEKTSV4RRFFQ69G5FB1"]);
      expect(parsed.files).toEqual([]);
      replicator.stop();
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
