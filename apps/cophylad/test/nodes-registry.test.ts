// The role across networks, arbitrated by the server's registry: a failover through the
// lease, the old primary returning as a backup through the relay, a claim refused while
// the role is held elsewhere, no promotion without a grant when the link was a tunnel and
// the server is gone, milestone 9's rule kept for a LAN link, and a handover across the
// relay. The fake server plays the registry with the real one's rule and short timings.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { paths } from "../src/config/load.ts";
import { mayPromote } from "../src/nodes/index.ts";
import { Store } from "../src/store/index.ts";
import { FakeServer } from "./fakes/server.ts";
import { sleep, tempHome, waitFor } from "./helpers.ts";
import type { TestClient } from "./helpers.ts";
import { client, linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

let primary: Primary | undefined;
let secondary: Started | undefined;
let third: Started | undefined;
let fake: FakeServer | undefined;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  await stopAll(third, secondary, primary?.d);
  primary = secondary = third = undefined;
  await fake?.stop();
  fake = undefined;
});

function signedInHome(f: FakeServer): { home: string; toml: string } {
  const home = tempHome();
  const p = paths(home);
  mkdirSync(p.data, { recursive: true });
  writeFileSync(p.accountToken, f.mintToken() + "\n", { mode: 0o600 });
  return { home, toml: `[cloud]\nenabled = true\nurl = "${f.url}"\nallow_insecure = true\nreconnect_ms = 20\nreconnect_max_ms = 100\nhello_timeout_ms = 3000\n\n[nodes]\nregistry_heartbeat_ms = 150\n\n` };
}

const cloudOf = (f: FakeServer) => ({ cloud: { keys: [f.publicKey] } });

describe("mayPromote", () => {
  test("a tunnel says nothing about the primary once the server is gone; a LAN link keeps milestone 9's rule", () => {
    expect(mayPromote({ lostVia: "relay", arbiterActive: false })).toBe(false);
    expect(mayPromote({ lostVia: "relay", arbiterActive: true })).toBe(true);
    expect(mayPromote({ lostVia: "direct", arbiterActive: false })).toBe(true);
    expect(mayPromote({ lostVia: "direct", arbiterActive: true })).toBe(true);
    expect(mayPromote({ lostVia: undefined, arbiterActive: false })).toBe(true);
  });
});

describe("the role through the registry", () => {
  test("the primary dies: the relayed backup is granted the role after the lease; the old primary returns as a backup through the relay", async () => {
    fake = new FakeServer({ leaseMs: 2000, closeGraceMs: 200 });
    const ph = signedInHome(fake);
    primary = await startPrimary({ home: ph.home, toml: ph.toml, daemon: cloudOf(fake), noLan: true });
    await waitFor(() => fake!.primaryOf()?.primary === primary!.d.identity.id, 5000);
    const epoch0 = primary.d.nodes.epoch();
    expect(fake.primaryOf()?.epoch).toBe(epoch0);
    // the primary renews its lease
    await waitFor(() => fake!.registryLog.some((r) => r.method === "registry.heartbeat" && r.node === primary!.d.identity.id), 3000);
    const sh = signedInHome(fake);
    secondary = await startSecondary(primary, { noEndpoint: true, relayOnly: true, backup: true, home: sh.home, toml: sh.toml, daemon: cloudOf(fake), failoverMs: 300 });
    await linked(secondary, 10_000);
    expect(secondary.nodes.via()).toBe("relay");
    // the backup holds the replica, the grants with it: what lets it take the old primary back
    await waitFor(() => (secondary!.nodes.replicaState?.snapshots ?? 0) >= 1, 5000);
    const oldId = primary.d.identity.id;
    const oldHome = primary.d.home;
    // the primary is killed: its link closes, the lease shortens to the grace, the backup waits then claims
    const t0 = Date.now();
    await primary.d.stop();
    primary = undefined;
    await waitFor(() => secondary!.nodes.roleOf() === "primary", 10_000);
    const took = Date.now() - t0;
    expect(secondary.nodes.epoch()).toBeGreaterThan(epoch0);
    expect(fake.primaryOf()).toEqual({ primary: secondary.identity.id, epoch: secondary.nodes.epoch() });
    expect(fake.registryLog.some((r) => r.method === "registry.claim" && r.node === secondary!.identity.id && (r.answer as { granted: boolean }).granted)).toBe(true);
    expect(took).toBeLessThan(8000);
    // the old primary returns on its home: its register is refused, it joins the new primary as a backup — through the
    // relay, since here its registry rows are wiped first (on one machine the backup's LAN listener would be reachable and win)
    const store = new Store(paths(oldHome).db);
    store.migrate();
    for (const row of store.nodes.list()) store.nodes.delete(row.id);
    store.close();
    primary = await startPrimary({ home: oldHome, toml: ph.toml, daemon: cloudOf(fake) });
    expect(primary.d.identity.id).toBe(oldId);
    await waitFor(() => primary!.d.nodes.linked(), 10_000);
    expect(primary.d.nodes.roleOf()).toBe("secondary");
    expect(primary.d.nodes.via()).toBe("relay");
    expect(primary.d.nodes.primaryId()).toBe(secondary.identity.id);
    expect(primary.d.nodes.epoch()).toBe(secondary.nodes.epoch());
    expect(fake.primaryOf()?.primary).toBe(secondary.identity.id);

    expect(fake.registryLog.filter((r) => r.node === oldId && r.method === "registry.claim").at(-1)?.answer).toMatchObject({ granted: false, primary: secondary.identity.id });
    // one brain: the new primary's role is the only primary role
    expect(secondary.nodes.linkedNodes()).toContain(oldId);
  });

  test("a role held elsewhere: the starting primary's claim is refused, it runs as a backup with no brain until the lease is released", async () => {
    fake = new FakeServer({ leaseMs: 60_000 });
    fake.holdLease("node_01ARZ3NDEKTSV4RRFFQ69G5ZZZ", 7);
    const ph = signedInHome(fake);
    primary = await startPrimary({ home: ph.home, toml: ph.toml + "[nodes]\nreconnect_ms = 100\nreconnect_max_ms = 300\n", daemon: cloudOf(fake) });
    expect(primary.d.nodes.roleOf()).toBe("secondary");
    expect(primary.d.nodes.epoch()).toBe(7);
    expect(primary.d.brain).toBeUndefined();
    expect(fake.registryLog.filter((r) => r.method === "registry.claim").at(-1)?.answer).toMatchObject({ granted: false });
    await sleep(500);
    expect(primary.d.nodes.roleOf()).toBe("secondary");
    expect(["seeking", "waiting"]).toContain(primary.d.nodes.state());
    // the lease is released: the next claim after a fruitless seek is granted, above the old epoch
    fake.releaseLease();
    await waitFor(() => primary!.d.nodes.roleOf() === "primary", 10_000);
    expect(primary.d.nodes.epoch()).toBeGreaterThan(7);
    expect(fake.primaryOf()?.primary).toBe(primary.d.identity.id);
  });

  test("the server gone: a backup whose link was a tunnel keeps waiting; the primary keeps its role", async () => {
    // (the link, the loss, the wait and a margin: past the default timeout)
    fake = new FakeServer({ leaseMs: 2000, closeGraceMs: 200 });
    const ph = signedInHome(fake);
    // the primary has no LAN listener: on one machine a listener would be reachable and the backup would simply relink there
    primary = await startPrimary({ home: ph.home, toml: ph.toml, daemon: cloudOf(fake), noLan: true });
    await waitFor(() => fake!.primaryOf()?.primary === primary!.d.identity.id, 5000);
    const sh = signedInHome(fake);
    secondary = await startSecondary(primary, { noEndpoint: true, relayOnly: true, backup: true, home: sh.home, toml: sh.toml, daemon: cloudOf(fake), failoverMs: 300 });
    await linked(secondary, 10_000);
    expect(secondary.nodes.via()).toBe("relay");
    await fake.stop();
    await waitFor(() => !secondary!.nodes.linked(), 5000);
    await waitFor(() => secondary!.nodes.state() === "waiting", 5000);
    await sleep(1200);
    expect(secondary.nodes.roleOf()).toBe("secondary");
    expect(secondary.nodes.state()).toBe("waiting");
    expect(primary.d.nodes.roleOf()).toBe("primary");
    fake = undefined;
  }, 20_000);

  test("milestone 9 kept: a LAN backup that lost its primary with the server gone promotes on its own", async () => {
    fake = new FakeServer({ leaseMs: 2000, closeGraceMs: 200 });
    const ph = signedInHome(fake);
    primary = await startPrimary({ home: ph.home, toml: ph.toml, daemon: cloudOf(fake) });
    await waitFor(() => fake!.primaryOf()?.primary === primary!.d.identity.id, 5000);
    const sh = signedInHome(fake);
    secondary = await startSecondary(primary, { backup: true, home: sh.home, toml: sh.toml, daemon: cloudOf(fake), failoverMs: 300 });
    await linked(secondary, 10_000);
    expect(secondary.nodes.via()).toBe("direct");
    await fake.stop();
    fake = undefined;
    await primary.d.stop();
    primary = undefined;
    await waitFor(() => secondary!.nodes.roleOf() === "primary", 10_000);
  });

  test("node.promote across the relay: the backup claims at the handed epoch, the old primary steps down and rejoins through the relay", async () => {
    fake = new FakeServer({ leaseMs: 60_000 });
    const ph = signedInHome(fake);
    primary = await startPrimary({ home: ph.home, toml: ph.toml, daemon: cloudOf(fake), noLan: true });
    await waitFor(() => fake!.primaryOf()?.primary === primary!.d.identity.id, 5000);
    const sh = signedInHome(fake);
    secondary = await startSecondary(primary, { noEndpoint: true, relayOnly: true, backup: true, home: sh.home, toml: sh.toml, daemon: cloudOf(fake) });
    await linked(secondary, 10_000);
    const c = await client(primary.d);
    clients.push(c);
    const epoch0 = primary.d.nodes.epoch();
    await c.request("node.promote", { id: secondary.identity.id });
    await waitFor(() => secondary!.nodes.roleOf() === "primary", 10_000);
    expect(secondary.nodes.epoch()).toBe(epoch0 + 1);
    expect(fake.primaryOf()).toEqual({ primary: secondary.identity.id, epoch: epoch0 + 1 });
    await waitFor(() => primary!.d.nodes.linked(), 10_000);
    expect(primary.d.nodes.roleOf()).toBe("secondary");
    // on one machine the new primary's LAN listener is reachable, so the old one links there first; elsewhere it would be the relay
    expect(["direct", "relay"]).toContain(primary.d.nodes.via());
    expect(primary.d.nodes.primaryId()).toBe(secondary.identity.id);
    // the new primary heartbeats the lease from now on
    await waitFor(() => fake!.registryLog.some((r) => r.method === "registry.heartbeat" && r.node === secondary!.identity.id), 3000);
  });
});
