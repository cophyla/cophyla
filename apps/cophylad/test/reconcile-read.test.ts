// The cloud backup's whole read as the background worker answers it: every table object named
// and hashed as the sender would, the ledger beside it, and ids with tabs or line breaks in them
// coming back as they were.

import { expect, test } from "bun:test";
import { InlineBackground } from "../src/background/client.ts";
import { objectKey } from "../src/cloud/backup-crypto.ts";
import { hashPlain, objectOf, rowOf } from "../src/cloud/reconcile.ts";
import type { ObjectsRead } from "../src/cloud/reconcile.ts";
import { Store } from "../src/store/index.ts";

test("the objects and the ledger, as lines that read back", async () => {
  const s = new Store(":memory:");
  s.migrate();
  const odd = "a\tkey\nwith\\breaks";
  s.kv.put("notes", odd, { v: 1 }, 5);
  s.kv.put("update", "staged", { v: 2 }, 6);
  s.threads.insert({ id: "thr_01ARZ3NDEKTSV4RRFFQ69G5FB0", startedAt: 1, tags: [], sessions: [] });
  s.backupSync.put({ kind: "state", key: "k1", id: `kv:notes/${odd}`, version: 2, hash: "h", synced: true, size: 40 });
  const mac = Buffer.alloc(32, 7);
  const read = await new InlineBackground(s.db).call<ObjectsRead>("backup.objects", { mac: new Uint8Array(mac), excludeKvNs: ["update"], privateNodes: [] });
  const objects = read.objects.split("\n").map(objectOf);
  expect(objects.map((o) => o.id).sort()).toEqual([`kv:notes/${odd}`, "thread:thr_01ARZ3NDEKTSV4RRFFQ69G5FB0"]);
  const kv = objects.find((o) => o.kind === "state")!;
  expect(kv.key).toBe(objectKey(mac, "state", `kv:notes/${odd}`));
  expect(kv.hash).toBe(hashPlain({ id: `kv:notes/${odd}`, table: "kv", row: { ns: "notes", key: odd, value: { v: 1 }, updatedAt: 5 } }));
  expect(read.rows.split("\n").map(rowOf)).toEqual([{ kind: "state", key: "k1", id: `kv:notes/${odd}`, version: 2, hash: "h", synced: true, size: 40 }]);
  s.close();
});
