// The grants store: phones' rows from before grants move in place with FULL access, into the
// primary's namespace or the node's own; a new row goes where the node's role says; a token
// authenticates only its own active, unexpired phone; a client sees no secret; a snapshot
// from the primary keeps what the node paired itself and brings nothing back the primary
// revoked, when the old primary rejoins as a backup.

import { describe, expect, test } from "bun:test";
import { FULL, SESSIONS } from "@cophyla/protocol";
import { GRANTS_NS, LEGACY_CONTROLLERS_NS, LOCAL_GRANTS_NS } from "../src/grants/namespaces.ts";
import { Grants, hashSecret } from "../src/grants/store.ts";
import { EXCLUDED_KV_NS } from "../src/nodes/replication.ts";
import { Store } from "../src/store/index.ts";

function open(): Store {
  const s = new Store(":memory:");
  s.migrate();
  return s;
}

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("grants", () => {
  test("rows from before grants move in place with FULL access, their relay key kept as the key", () => {
    const store = open();
    store.kv.put(LEGACY_CONTROLLERS_NS, "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC1", { id: "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC1", name: "Pixel", tokenHash: hashSecret("tok"), pairedAt: 5, relayKey: "ab".repeat(32), relay: true, push: { platform: "android", token: "fcm", registeredAt: 6 }, account: "octocat" });
    store.kv.put(LEGACY_CONTROLLERS_NS, "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC2", { id: "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC2", name: "iPad", tokenHash: hashSecret("tok2"), pairedAt: 7 });
    store.kv.put(LEGACY_CONTROLLERS_NS, "junk", { nope: true });
    const grants = new Grants({ store });
    expect(grants.migrate(GRANTS_NS)).toBe(2);
    expect(store.kv.list(LEGACY_CONTROLLERS_NS)).toEqual([]);
    const pixel = grants.get("ctl_01ARZ3NDEKTSV4RRFFQ69G5FC1")!;
    expect(pixel).toMatchObject({ kind: "controller", name: "Pixel", access: FULL, key: "ab".repeat(32), createdAt: 5, relay: true, account: "octocat" });
    expect(grants.status(pixel)).toBe("active");
    expect(grants.get("ctl_01ARZ3NDEKTSV4RRFFQ69G5FC2")!.key).toMatch(/^[0-9a-f]{64}$/);
    expect(grants.authenticate("tok")?.id).toBe("ctl_01ARZ3NDEKTSV4RRFFQ69G5FC1");
    expect(grants.pushOf("ctl_01ARZ3NDEKTSV4RRFFQ69G5FC1")).toMatchObject({ platform: "android", token: "fcm" });
    // Run again: nothing left to move.
    expect(grants.migrate(GRANTS_NS)).toBe(0);
    // A secondary's own phones go to its own namespace.
    const other = open();
    other.kv.put(LEGACY_CONTROLLERS_NS, "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC3", { id: "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC3", name: "Mine", tokenHash: hashSecret("t3"), pairedAt: 1 });
    const g2 = new Grants({ store: other });
    expect(g2.migrate(LOCAL_GRANTS_NS)).toBe(1);
    expect(other.kv.get(LOCAL_GRANTS_NS, "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC3")).toBeDefined();
    expect(g2.isLocal("ctl_01ARZ3NDEKTSV4RRFFQ69G5FC3")).toBe(true);
    expect(g2.list()[0]?.local).toBe(true);
  });

  test("a new phone goes where the role says; its token authenticates it until it expires; a client sees no secret", () => {
    const store = open();
    let local = false;
    let now = 1000;
    const grants = new Grants({ store, local: () => local, now: () => now });
    const a = grants.createController("Pixel");
    local = true;
    const b = grants.createController("Work phone", { access: SESSIONS, expiresAt: 5000 });
    expect(store.kv.get(GRANTS_NS, a.controller.id)).toBeDefined();
    expect(store.kv.get(LOCAL_GRANTS_NS, b.controller.id)).toBeDefined();
    expect(grants.authenticate(a.token)?.access).toEqual(FULL);
    expect(grants.authenticate(b.token)?.access).toEqual(SESSIONS);
    expect(grants.authenticate("wrong")).toBeUndefined();
    // An update keeps a row where it lives.
    grants.touch(a.controller.id, 2000);
    expect(store.kv.get(GRANTS_NS, a.controller.id)).toMatchObject({ lastSeen: 2000 });
    expect(store.kv.get(LOCAL_GRANTS_NS, a.controller.id)).toBeUndefined();
    // No secret in what a client sees.
    const seen = JSON.stringify([grants.list(), grants.controllers()]);
    for (const secret of [a.token, a.key, b.token, b.key, hashSecret(a.token)]) expect(seen).not.toContain(secret);
    // Expired, the token opens nothing.
    now = 6000;
    expect(grants.authenticate(b.token)).toBeUndefined();
    expect(grants.revoke(a.controller.id)?.id).toBe(a.controller.id);
    expect(grants.authenticate(a.token)).toBeUndefined();
    expect(grants.revoke(a.controller.id)).toBeUndefined();
  });

  test("a snapshot keeps the node's own grants, and brings back none the primary revoked when the old primary rejoins", () => {
    // The old primary: two phones of the cluster, and one of its own paired while it was away.
    const old = open();
    const oldGrants = new Grants({ store: old });
    const kept = oldGrants.createController("kept");
    const revoked = oldGrants.createController("revoked");
    const mine = new Grants({ store: old, local: () => true }).createController("mine");
    // The new primary took over with the replica, then the user revoked one phone there.
    const promoted = open();
    promoted.applySnapshot({ epoch: 1, seq: 1, tables: old.replicaSnapshot(EXCLUDED_KV_NS), files: [] }, { selfNode: NODE, keepKvNs: EXCLUDED_KV_NS });
    const promotedGrants = new Grants({ store: promoted });
    expect(promotedGrants.get(mine.controller.id)).toBeUndefined();
    promotedGrants.revoke(revoked.controller.id);
    // The old primary rejoins as its backup and takes a snapshot.
    old.applySnapshot({ epoch: 2, seq: 1, tables: promoted.replicaSnapshot(EXCLUDED_KV_NS), files: [] }, { selfNode: "node_01ARZ3NDEKTSV4RRFFQ69G5FAW", keepKvNs: EXCLUDED_KV_NS });
    expect(oldGrants.authenticate(revoked.token)).toBeUndefined();
    expect(oldGrants.authenticate(kept.token)?.id).toBe(kept.controller.id);
    expect(oldGrants.authenticate(mine.token)?.id).toBe(mine.controller.id);
  });
});
