// The role across networks, arbitrated by the server's registry, where only the user's
// choice moves it: the primary stops and the relayed backup takes nothing, the lease lapsed
// or not; the user's choice there is claimed as chosen and granted, and the old primary
// returns as a secondary through the relay; a claim refused while the role is held
// elsewhere, and nothing taken when that lease lapses; the server gone and a backup that
// keeps seeking; and a handover across the relay. The fake server plays the registry with
// the real one's rule and short timings.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { paths } from "../src/config/load.ts";
import { chosenPrimary } from "../src/nodes/index.ts";
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

function signedInHome(f: FakeServer): { home: string; toml: string; nodes: string } {
  const home = tempHome();
  const p = paths(home);
  mkdirSync(p.data, { recursive: true });
  writeFileSync(p.accountToken, f.mintToken() + "\n", { mode: 0o600 });
  return { home, toml: `[cloud]\nenabled = true\nurl = "${f.url}"\nallow_insecure = true\nreconnect_ms = 20\nreconnect_max_ms = 100\nhello_timeout_ms = 3000\n\n`, nodes: "registry_heartbeat_ms = 150\n" };
}

const cloudOf = (f: FakeServer) => ({ cloud: { keys: [f.publicKey] } });

describe("chosenPrimary", () => {
  test("the kept choice; else the node that minted the cluster, this one or the one that invited it", () => {
    const self = "node_self";
    expect(chosenPrimary({ kept: "node_k", self, via: "join", inviter: "node_inv" })).toBe("node_k");
    expect(chosenPrimary({ kept: self, self, via: "join", inviter: "node_inv" })).toBe(self);
    expect(chosenPrimary({ self, via: "self" })).toBe(self);
    // a joined node that held a higher epoch by its own failover is no one's choice: it seeks the one that invited it
    expect(chosenPrimary({ self, via: "join", inviter: "node_inv" })).toBe("node_inv");
  });
});

describe("the role through the registry", () => {
  test("the primary stops: the relayed backup takes nothing, the lease lapsed or not; the user's choice there is granted; the old primary returns as a secondary through the relay", async () => {
    fake = new FakeServer({ leaseMs: 2000, closeGraceMs: 200 });
    const ph = signedInHome(fake);
    primary = await startPrimary({ home: ph.home, toml: ph.toml, nodes: ph.nodes, daemon: cloudOf(fake), noLan: true });
    await waitFor(() => fake!.primaryOf()?.primary === primary!.d.identity.id, 5000);
    const epoch0 = primary.d.nodes.epoch();
    expect(fake.primaryOf()?.epoch).toBe(epoch0);
    // the primary renews its lease, and says the user chose it
    await waitFor(() => fake!.registryLog.some((r) => r.method === "registry.heartbeat" && r.node === primary!.d.identity.id), 3000);
    expect(fake.registryLog.find((r) => r.node === primary!.d.identity.id && r.method === "registry.claim")).toMatchObject({ chosen: true, answer: { granted: true } });
    const sh = signedInHome(fake);
    secondary = await startSecondary(primary, { noEndpoint: true, relayOnly: true, backup: true, home: sh.home, toml: sh.toml, nodes: sh.nodes, daemon: cloudOf(fake) });
    await linked(secondary, 10_000);
    expect(secondary.nodes.via()).toBe("relay");
    // the backup holds the replica, the grants with it: what lets it take the old primary back
    await waitFor(() => (secondary!.nodes.replicaState?.snapshots ?? 0) >= 1, 5000);
    const oldId = primary.d.identity.id;
    const oldHome = primary.d.home;
    // the primary is killed: its link closes, the lease shortens to the grace and lapses; the backup takes nothing
    await primary.d.stop();
    primary = undefined;
    await waitFor(() => !secondary!.nodes.linked(), 5000);
    await sleep(2500);
    expect(fake.primaryOf()).toBeUndefined();
    expect(secondary.nodes.roleOf()).toBe("secondary");
    expect(secondary.nodes.state()).toBe("seeking");
    expect(fake.registryLog.some((r) => r.method === "registry.claim" && r.node === secondary!.identity.id)).toBe(false);
    // the user makes it the primary from its own app: claimed as chosen, above every epoch known
    const c = await client(secondary);
    clients.push(c);
    await c.request("node.promote", { id: secondary.identity.id });
    await waitFor(() => secondary!.nodes.roleOf() === "primary", 10_000);
    expect(secondary.nodes.epoch()).toBeGreaterThan(epoch0);
    expect(fake.primaryOf()).toEqual({ primary: secondary.identity.id, epoch: secondary.nodes.epoch() });
    expect(fake.registryLog.filter((r) => r.method === "registry.claim" && r.node === secondary!.identity.id).at(-1)).toMatchObject({ chosen: true, answer: { granted: true } });
    // the old primary returns on its home: its claim is refused, it joins the new primary as a secondary — through the
    // relay, since here its registry rows are wiped first (on one machine the backup's LAN listener would be reachable and win)
    const store = new Store(paths(oldHome).db);
    store.migrate();
    for (const row of store.nodes.list()) store.nodes.delete(row.id);
    store.close();
    primary = await startPrimary({ home: oldHome, toml: ph.toml, nodes: ph.nodes, daemon: cloudOf(fake) });
    expect(primary.d.identity.id).toBe(oldId);
    await waitFor(() => primary!.d.nodes.linked(), 10_000);
    expect(primary.d.nodes.roleOf()).toBe("secondary");
    expect(primary.d.nodes.via()).toBe("relay");
    expect(primary.d.nodes.primaryId()).toBe(secondary.identity.id);
    expect(primary.d.nodes.epoch()).toBe(secondary.nodes.epoch());
    expect(primary.d.nodes.chosen()).toBe(secondary.identity.id);
    expect(fake.primaryOf()?.primary).toBe(secondary.identity.id);
    expect(fake.registryLog.filter((r) => r.node === oldId && r.method === "registry.claim").at(-1)?.answer).toMatchObject({ granted: false, primary: secondary.identity.id });
    // one brain: the new primary's role is the only primary role
    expect(secondary.nodes.linkedNodes()).toContain(oldId);
  }, 30_000);

  test("a role held elsewhere: the starting primary's claim is refused, it runs as a secondary with no brain, and takes nothing when that lease lapses", async () => {
    fake = new FakeServer({ leaseMs: 60_000 });
    fake.holdLease("node_01ARZ3NDEKTSV4RRFFQ69G5ZZZ", 7);
    const ph = signedInHome(fake);
    primary = await startPrimary({ home: ph.home, toml: ph.toml, nodes: ph.nodes + "reconnect_ms = 100\nreconnect_max_ms = 300\n", daemon: cloudOf(fake) });
    expect(primary.d.nodes.roleOf()).toBe("secondary");
    expect(primary.d.nodes.epoch()).toBe(7);
    expect(primary.d.brain).toBeUndefined();
    expect(fake.registryLog.filter((r) => r.method === "registry.claim").at(-1)?.answer).toMatchObject({ granted: false });
    expect(primary.d.nodes.chosen()).toBe("node_01ARZ3NDEKTSV4RRFFQ69G5ZZZ");
    // the lease lapses: the seek goes on, and nothing is claimed
    const claims = fake.registryLog.filter((r) => r.method === "registry.claim").length;
    fake.releaseLease();
    await sleep(1000);
    expect(primary.d.nodes.roleOf()).toBe("secondary");
    expect(primary.d.nodes.state()).toBe("seeking");
    expect(fake.registryLog.filter((r) => r.method === "registry.claim").length).toBe(claims);
    // the user chooses this machine: it lands above the old epoch
    const c = await client(primary.d);
    clients.push(c);
    await c.request("node.promote", { id: primary.d.identity.id });
    await waitFor(() => primary!.d.nodes.roleOf() === "primary", 10_000);
    expect(primary.d.nodes.epoch()).toBeGreaterThan(7);
    expect(fake.primaryOf()?.primary).toBe(primary.d.identity.id);
  });

  test("the user's choice while the role is held live elsewhere is claimed above the holder's epoch, and wins", async () => {
    fake = new FakeServer({ leaseMs: 60_000 });
    fake.holdLease("node_01ARZ3NDEKTSV4RRFFQ69G5ZZZ", 7);
    const ph = signedInHome(fake);
    primary = await startPrimary({ home: ph.home, toml: ph.toml, nodes: ph.nodes + "reconnect_ms = 100\nreconnect_max_ms = 300\n", daemon: cloudOf(fake) });
    expect(primary.d.nodes.roleOf()).toBe("secondary");
    const c = await client(primary.d);
    clients.push(c);
    await c.request("node.promote", { id: primary.d.identity.id });
    await waitFor(() => primary!.d.nodes.roleOf() === "primary", 10_000);
    expect(primary.d.nodes.epoch()).toBe(8);
    expect(fake.primaryOf()).toEqual({ primary: primary.d.identity.id, epoch: 8 });
  });

  test("the server gone: a backup whose link was a tunnel keeps seeking; the primary keeps its role", async () => {
    // (the link, the loss, the wait and a margin: past the default timeout)
    fake = new FakeServer({ leaseMs: 2000, closeGraceMs: 200 });
    const ph = signedInHome(fake);
    // the primary has no LAN listener: on one machine a listener would be reachable and the backup would simply relink there
    primary = await startPrimary({ home: ph.home, toml: ph.toml, nodes: ph.nodes, daemon: cloudOf(fake), noLan: true });
    await waitFor(() => fake!.primaryOf()?.primary === primary!.d.identity.id, 5000);
    const sh = signedInHome(fake);
    secondary = await startSecondary(primary, { noEndpoint: true, relayOnly: true, backup: true, home: sh.home, toml: sh.toml, nodes: sh.nodes, daemon: cloudOf(fake) });
    await linked(secondary, 10_000);
    expect(secondary.nodes.via()).toBe("relay");
    await fake.stop();
    await waitFor(() => !secondary!.nodes.linked(), 5000);
    await sleep(1200);
    expect(secondary.nodes.roleOf()).toBe("secondary");
    expect(secondary.nodes.state()).toBe("seeking");
    expect(primary.d.nodes.roleOf()).toBe("primary");
    fake = undefined;
  }, 20_000);

  test("a LAN backup that lost its primary with the server gone takes nothing on its own either", async () => {
    fake = new FakeServer({ leaseMs: 2000, closeGraceMs: 200 });
    const ph = signedInHome(fake);
    primary = await startPrimary({ home: ph.home, toml: ph.toml, nodes: ph.nodes, daemon: cloudOf(fake) });
    await waitFor(() => fake!.primaryOf()?.primary === primary!.d.identity.id, 5000);
    const sh = signedInHome(fake);
    secondary = await startSecondary(primary, { backup: true, home: sh.home, toml: sh.toml, nodes: sh.nodes, daemon: cloudOf(fake) });
    await linked(secondary, 10_000);
    expect(secondary.nodes.via()).toBe("direct");
    await fake.stop();
    fake = undefined;
    await primary.d.stop();
    primary = undefined;
    await waitFor(() => !secondary!.nodes.linked(), 5000);
    await sleep(1500);
    expect(secondary.nodes.roleOf()).toBe("secondary");
    expect(secondary.nodes.state()).toBe("seeking");
  });

  test("node.promote across the relay: the backup claims at the handed epoch, the old primary steps down and rejoins through the relay", async () => {
    fake = new FakeServer({ leaseMs: 60_000 });
    const ph = signedInHome(fake);
    primary = await startPrimary({ home: ph.home, toml: ph.toml, nodes: ph.nodes, daemon: cloudOf(fake), noLan: true });
    await waitFor(() => fake!.primaryOf()?.primary === primary!.d.identity.id, 5000);
    const sh = signedInHome(fake);
    secondary = await startSecondary(primary, { noEndpoint: true, relayOnly: true, backup: true, home: sh.home, toml: sh.toml, nodes: sh.nodes, daemon: cloudOf(fake) });
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
    expect(primary.d.nodes.chosen()).toBe(secondary.identity.id);
    // the new primary heartbeats the lease from now on
    await waitFor(() => fake!.registryLog.some((r) => r.method === "registry.heartbeat" && r.node === secondary!.identity.id), 3000);
  });
});
